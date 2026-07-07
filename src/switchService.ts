import * as crypto from "crypto";
import * as vscode from "vscode";
import { AccountStore, KeyValueStore } from "./accountStore";
import { CredentialsManager } from "./credentials";
import { IdentityManager } from "./identity";
import { SecretVault, refreshTokenHash } from "./secretVault";
import { SharedStore } from "./store";
import { AccountFile, CredentialRef, OAuthAccountInfo, OAuthCreds } from "./types";
import { usableCredentials } from "./usage";

const PENDING_DEPLOY_KEY = "claudeSwitcher.pendingDeploy";
const PREV_ACTIVE_KEY = "claudeSwitcher.prevActive";

export interface OpResult {
  ok: boolean;
  message: string;
  needsReload?: boolean;
}

interface PendingDeploy {
  credId: string;
  accountUuid: string;
  hash: string;
}

function newAccountFile(
  uuid: string,
  label: string,
  ident: OAuthAccountInfo | undefined,
  creds: OAuthCreds,
  order: number
): AccountFile {
  return {
    version: 1,
    rev: 0,
    updatedAt: 0,
    account: {
      uuid,
      email: ident?.emailAddress,
      label,
      order,
      addedAt: Date.now(),
      subscriptionType: creds.subscriptionType,
      updatesEnabled: true,
    },
    credentials: [],
  };
}

/**
 * Orchestrates the credential-pool operations: park (move the live credential into
 * the pool + sign out locally), deploy (move a parked credential to the live file),
 * switch (park + deploy), undo, and crash recovery — plus account admin.
 */
export class SwitchService {
  constructor(
    private readonly store: SharedStore | null,
    private readonly vault: SecretVault,
    private readonly credentials: CredentialsManager,
    private readonly identity: IdentityManager,
    private readonly accountStore: AccountStore,
    private readonly memento: KeyValueStore
  ) {}

  private noStore(): OpResult {
    return {
      ok: false,
      message:
        "Account switching needs a shared store. Enable it (claudeSwitcher.sync.enabled) or set claudeSwitcher.sync.folder.",
    };
  }

  /** Determines the account identity of the current live credential. */
  private async identify(creds: OAuthCreds): Promise<OAuthAccountInfo | undefined> {
    const local = this.identity.readLocalIdentity();
    if (local) {
      return local;
    }
    return (await this.identity.fetchProfile(creds.accessToken)) ?? undefined;
  }

  /**
   * Ensures the account currently logged in *locally* has a metadata entry in the
   * store (with zero parked credentials — the live credential stays in the file),
   * so its usage is polled and it shows up as a card. No-op if there is no local
   * login, its identity can't be resolved, or it is already registered.
   *
   * Returns true if it created a new entry (caller should reload + refresh the UI).
   */
  async ensureLocalAccountRegistered(): Promise<boolean> {
    if (!this.store) {
      return false;
    }
    const creds = this.credentials.readCurrent();
    if (!creds) {
      return false;
    }
    const ident = await this.identify(creds);
    const uuid = ident?.accountUuid;
    if (!uuid || this.store.readAccount(uuid)) {
      return false;
    }
    const label = ident?.emailAddress ?? (creds.subscriptionType ? `${creds.subscriptionType} account` : "Current account");
    const order = this.store.listAccounts().length;
    const created = await this.store.withAccountLock(uuid, () => {
      if (this.store!.readAccount(uuid)) {
        return false; // another window registered it first
      }
      this.store!.writeAccount(newAccountFile(uuid, label, ident, creds, order));
      return true;
    });
    return created === true;
  }

  /**
   * Parks the current live credential into the pool and signs the local Claude
   * Code out. `silent` auto-labels a new account instead of prompting.
   */
  async park(silent = false): Promise<OpResult> {
    if (!this.store) {
      return this.noStore();
    }
    const creds = this.credentials.readCurrent();
    if (!creds) {
      return {
        ok: false,
        message: "No logged-in account found in .credentials.json.",
      };
    }
    const ident = await this.identify(creds);
    const uuid = ident?.accountUuid;
    if (!uuid) {
      return {
        ok: false,
        message: "Could not determine which Claude account is logged in.",
      };
    }

    const existing = this.store.readAccount(uuid);
    let label = existing?.account.label;
    if (!existing) {
      const suggested = ident?.emailAddress ?? (creds.subscriptionType ? `${creds.subscriptionType} account` : "New account");
      if (silent) {
        label = suggested;
      } else {
        const input = await vscode.window.showInputBox({
          title: "Park current Claude credential",
          prompt: "Profile name (e.g. Work, Personal, Max #1)",
          value: suggested,
          validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
        });
        if (input === undefined) {
          return { ok: false, message: "Cancelled." };
        }
        label = input.trim();
      }
    }

    const hash = refreshTokenHash(creds);
    const credId = crypto.randomUUID();
    await this.vault.put(credId, creds); // secret first (orphan blob on crash is harmless)

    const order = this.store.listAccounts().length;
    const res = await this.store.withAccountLock(uuid, () => {
      let file = this.store!.readAccount(uuid);
      if (!file) {
        file = newAccountFile(uuid, label!, ident, creds, order);
      }
      if (file.credentials.some((c) => c.refreshTokenHash === hash && !c.invalid)) {
        return { dup: true };
      }
      file.credentials.push({
        id: credId,
        addedAt: Date.now(),
        expiresAt: creds.expiresAt,
        refreshTokenHash: hash,
      });
      // A fresh credential heals a dead-token suspension.
      if (file.account.suspended?.reason === "invalid-grant") {
        file.account.suspended = undefined;
      }
      if (ident?.emailAddress && !file.account.email) {
        file.account.email = ident.emailAddress;
      }
      if (creds.subscriptionType) {
        file.account.subscriptionType = creds.subscriptionType;
      }
      this.store!.writeAccount(file);
      return { dup: false };
    });

    if (res?.dup) {
      await this.vault.remove(credId); // already parked elsewhere
    }

    // Sign out locally.
    this.credentials.clearLocal();
    this.identity.writeLocalIdentity(null);
    await this.accountStore.clearActive();
    this.accountStore.reload(Date.now());

    return {
      ok: true,
      message: `Parked "${label}". Signed out of Claude Code in this window.`,
      needsReload: true,
    };
  }

  /**
   * Switches to an account: parks the current credential, then deploys a parked one.
   * `credId` selects a specific parked credential; when omitted the first usable one
   * is used (`pickFreeCredential`).
   */
  async switchTo(uuid: string, credId?: string): Promise<OpResult> {
    if (!this.store) {
      return this.noStore();
    }
    const target = this.store.readAccount(uuid);
    if (!target) {
      return { ok: false, message: "Account not found." };
    }
    if (this.accountStore.activeAccountUuid() === uuid) {
      return { ok: false, message: `"${target.account.label}" is already active.` };
    }
    // Verify the target is deployable BEFORE we sign the current account out, so a
    // failed switch never leaves the window signed out for nothing.
    const usable = usableCredentials(target, Date.now());
    if (usable.length === 0) {
      return { ok: false, message: this.noCredMessage(target) };
    }
    // A requested credential that's no longer usable (raced by another window) falls
    // back to the default pick rather than failing the switch.
    if (credId && !usable.some((c) => c.id === credId)) {
      credId = undefined;
    }

    const prevUuid = this.accountStore.activeAccountUuid();

    // Park whatever is live now (best-effort; ignore "nothing to park").
    if (this.credentials.readCurrent()) {
      const parked = await this.park(true);
      if (!parked.ok && parked.message !== "Cancelled.") {
        // Parking failed for a real reason (e.g. cannot identify) — refuse to clobber it.
        return { ok: false, message: "Could not park the current account: " + parked.message };
      }
    }

    const res = await this.deploy(uuid, prevUuid, credId);
    if (!res.ok && prevUuid && this.store.readAccount(prevUuid)) {
      // Lost the target credential to another window between the check and the deploy —
      // restore the account we just parked so the window isn't left signed out.
      await this.deploy(prevUuid, undefined);
    }
    return res;
  }

  private noCredMessage(file: AccountFile): string {
    const inUse = this.accountStore.liveInstances().filter((i) => i.activeAccountUuid === file.account.uuid).length;
    return `No parked credential for "${file.account.label}"${
      inUse ? ` (${inUse} in use elsewhere)` : ""
    }. Log in to it in this window, or park one from another window.`;
  }

  private async deploy(
    uuid: string,
    prevUuid: string | undefined,
    credId?: string
  ): Promise<OpResult> {
    const store = this.store!;
    const now = Date.now();
    const file = store.readAccount(uuid);
    if (!file) {
      return { ok: false, message: "Account not found." };
    }
    const usable = usableCredentials(file, now);
    // Deploy the requested credential when it's still usable; otherwise (not given or
    // consumed by another window) fall back to the first usable one.
    const ref = (credId && usable.find((c) => c.id === credId)) || usable[0];
    if (!ref) {
      return { ok: false, message: this.noCredMessage(file) };
    }
    // Trust the stored blob: it is written before the ref-hash, so if the two ever
    // diverge the blob is the newer, authoritative token. A stale ref-hash must not
    // block a deploy (that was the "stored credential is unavailable" bug). Only a
    // genuinely missing blob is fatal — then the ref is an orphan; drop it.
    const creds = await this.vault.get(ref.id);
    if (!creds) {
      await this.dropRef(uuid, ref.id);
      return {
        ok: false,
        message: `The parked credential for "${file.account.label}" is no longer available and was removed. Re-park it from a window where it's logged in.`,
      };
    }

    // Remove the reference first (crash-safe: the blob still exists for recovery).
    await store.withAccountLock(uuid, () => {
      const f = store.readAccount(uuid);
      if (f) {
        f.credentials = f.credentials.filter((c) => c.id !== ref.id);
        store.writeAccount(f);
      }
    });
    const pending: PendingDeploy = { credId: ref.id, accountUuid: uuid, hash: ref.refreshTokenHash };
    await this.memento.update(PENDING_DEPLOY_KEY, pending);

    try {
      this.credentials.writeCreds(creds);
    } catch (e) {
      await this.reinsert(uuid, ref);
      await this.memento.update(PENDING_DEPLOY_KEY, undefined);
      return { ok: false, message: "Failed to write credentials file: " + (e as Error).message };
    }

    this.identity.writeLocalIdentity({ accountUuid: uuid, emailAddress: file.account.email });
    await this.vault.remove(ref.id);
    await this.memento.update(PENDING_DEPLOY_KEY, undefined);
    await this.memento.update(PREV_ACTIVE_KEY, prevUuid);
    await this.accountStore.setActiveDeployed(uuid, {
      accountUuid: uuid,
      emailAddress: file.account.email,
    });
    this.accountStore.reload(now);

    return { ok: true, message: `Switched to "${file.account.label}".`, needsReload: true };
  }

  async undoSwitch(): Promise<OpResult> {
    if (!this.store) {
      return this.noStore();
    }
    const prev = this.memento.get<string>(PREV_ACTIVE_KEY);
    if (!prev || !this.store.readAccount(prev)) {
      return { ok: false, message: "Nothing to undo." };
    }
    return this.switchTo(prev);
  }

  /** Recovers a deploy that was interrupted by a crash/reload. */
  async recoverPendingDeploy(): Promise<void> {
    if (!this.store) {
      return;
    }
    const pd = this.memento.get<PendingDeploy>(PENDING_DEPLOY_KEY);
    if (!pd) {
      return;
    }
    const local = this.credentials.readCurrent();
    if (local && refreshTokenHash(local) === pd.hash) {
      // The write landed before the crash — just finish cleanup.
      await this.vault.remove(pd.credId);
    } else {
      // The write did not land — return the credential to the pool.
      const creds = await this.vault.get(pd.credId);
      if (creds) {
        await this.reinsert(pd.accountUuid, {
          id: pd.credId,
          addedAt: Date.now(),
          expiresAt: creds.expiresAt,
          refreshTokenHash: pd.hash,
        });
      }
    }
    await this.memento.update(PENDING_DEPLOY_KEY, undefined);
  }

  private async reinsert(uuid: string, ref: CredentialRef): Promise<void> {
    const store = this.store!;
    await store.withAccountLock(uuid, () => {
      const f = store.readAccount(uuid);
      if (!f) {
        return;
      }
      if (!f.credentials.some((c) => c.id === ref.id || c.refreshTokenHash === ref.refreshTokenHash)) {
        f.credentials.push(ref);
        store.writeAccount(f);
      }
    });
  }

  /** Removes an orphaned credential reference (its token blob is gone). */
  private async dropRef(uuid: string, credId: string): Promise<void> {
    const store = this.store!;
    await store.withAccountLock(uuid, () => {
      const f = store.readAccount(uuid);
      if (f) {
        f.credentials = f.credentials.filter((c) => c.id !== credId);
        store.writeAccount(f);
      }
    });
    this.accountStore.reload(Date.now());
  }

  // --- account admin ---

  async rename(uuid: string, label: string): Promise<void> {
    if (!this.store) {
      return;
    }
    await this.store.withAccountLock(uuid, () => {
      const f = this.store!.readAccount(uuid);
      if (f) {
        f.account.label = label;
        this.store!.writeAccount(f);
      }
    });
    this.accountStore.reload(Date.now());
  }

  async remove(uuid: string): Promise<void> {
    if (!this.store) {
      return;
    }
    const file = this.store.readAccount(uuid);
    if (file) {
      for (const c of file.credentials) {
        await this.vault.remove(c.id);
      }
    }
    this.store.deleteAccount(uuid);
    if (this.accountStore.activeAccountUuid() === uuid) {
      await this.accountStore.clearActive();
    }
    this.accountStore.reload(Date.now());
  }

  /**
   * Deletes the credential live in *this* window (signs Claude Code out here). Leaves
   * any parked credentials for the account intact; if none remain, removes the now-empty
   * account entry. No live credential is left, so auto-register won't recreate it.
   */
  async deleteLocalCredential(uuid: string): Promise<OpResult> {
    if (!this.store) {
      return this.noStore();
    }
    if (this.accountStore.activeAccountUuid() !== uuid) {
      return { ok: false, message: "That account is not active in this window." };
    }
    this.credentials.clearLocal();
    this.identity.writeLocalIdentity(null);
    await this.accountStore.clearActive();

    const file = this.store.readAccount(uuid);
    const label = file?.account.label ?? uuid;
    if (file && file.credentials.length === 0) {
      this.store.deleteAccount(uuid);
    }
    this.accountStore.reload(Date.now());
    return {
      ok: true,
      message: `Deleted the local credential for "${label}". Signed out of Claude Code in this window.`,
      needsReload: true,
    };
  }

  /**
   * Deletes parked (pooled) credentials for the account, keeping it logged in locally.
   * `credIds` restricts the deletion to those references; when omitted, all parked
   * credentials are removed. The account entry is kept (it may still be active here).
   */
  async deleteParked(uuid: string, credIds?: string[]): Promise<OpResult> {
    if (!this.store) {
      return this.noStore();
    }
    const label = this.store.readAccount(uuid)?.account.label ?? uuid;
    const only = credIds ? new Set(credIds) : undefined;
    let ids: string[] = [];
    await this.store.withAccountLock(uuid, () => {
      const f = this.store!.readAccount(uuid);
      if (!f) {
        return;
      }
      ids = f.credentials.filter((c) => !only || only.has(c.id)).map((c) => c.id);
      f.credentials = only ? f.credentials.filter((c) => !only.has(c.id)) : [];
      // Clearing a dead-token suspension only makes sense once no parked credential remains.
      if (f.credentials.length === 0 && f.account.suspended?.reason === "invalid-grant") {
        f.account.suspended = undefined;
      }
      this.store!.writeAccount(f);
    });
    // Refs are cleared first, so no poller will lease a vanishing blob.
    for (const id of ids) {
      await this.vault.remove(id);
    }
    this.accountStore.reload(Date.now());
    return { ok: true, message: `Deleted ${ids.length} parked credential${ids.length === 1 ? "" : "s"} for "${label}".` };
  }

  async toggleUpdates(uuid: string): Promise<boolean> {
    if (!this.store) {
      return true;
    }
    let enabled = true;
    await this.store.withAccountLock(uuid, () => {
      const f = this.store!.readAccount(uuid);
      if (f) {
        f.account.updatesEnabled = !f.account.updatesEnabled;
        enabled = f.account.updatesEnabled;
        this.store!.writeAccount(f);
      }
    });
    this.accountStore.reload(Date.now());
    return enabled;
  }

  /** Reload the window automatically or after confirmation (per setting). */
  async maybeReload(context: string): Promise<void> {
    const auto = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<boolean>("autoReloadAfterSwitch", false);
    if (auto) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `${context} Reload the VS Code window so Claude Code uses the new account.`,
      "Reload now",
      "Later"
    );
    if (choice === "Reload now") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
}
