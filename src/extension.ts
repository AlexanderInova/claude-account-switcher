import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { CredentialsManager } from "./credentials";
import { claudeJsonPathFrom, IdentityManager } from "./identity";
import { migrateIfNeeded } from "./migrate";
import { TokenRefresher } from "./oauth";
import { refreshTokenHash, SecretVault } from "./secretVault";
import { SharedStore } from "./store";
import { SwitchService } from "./switchService";
import { fmtAgo, fmtExpiry } from "./timeFmt";
import { AccountView, CredentialRef } from "./types";
import { AccountsViewProvider } from "./ui/accountsView";
import { StatusBarController } from "./ui/statusBar";
import { UsagePoller, usableCredentials } from "./usage";

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolves the shared-store directory (or null when sync is off / unavailable). */
function resolveStoreDir(credentials: CredentialsManager): string | null {
  const cfg = vscode.workspace.getConfiguration("claudeSwitcher");
  if (cfg.get<boolean>("sync.enabled", true) === false) {
    return null;
  }
  const explicit = cfg.get<string>("sync.folder", "").trim();
  if (explicit) {
    return realpathSafe(explicit);
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const f of folders) {
      const p = path.join(f.uri.fsPath, ".claude-account-switcher");
      try {
        if (fs.existsSync(p)) {
          return realpathSafe(p);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return path.join(path.dirname(credentials.getCredentialsPath()), "account-switcher");
}

export function activate(context: vscode.ExtensionContext): void {
  const credentials = new CredentialsManager();
  const identity = new IdentityManager(() => claudeJsonPathFrom(credentials.getCredentialsPath()));
  const vault = new SecretVault(context.secrets);
  const refresher = new TokenRefresher();
  const instanceId = crypto.randomUUID();

  let store: SharedStore | null = null;
  const dir = resolveStoreDir(credentials);
  if (dir) {
    try {
      const s = new SharedStore(dir);
      s.ensureLayout();
      store = s;
    } catch {
      store = null; // directory not writable — degrade to local-only mode
    }
  }

  const getWorkspaceName = () =>
    vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? "window";

  const accountStore = new AccountStore(
    store,
    credentials,
    identity,
    context.workspaceState,
    instanceId
  );
  const switchService = new SwitchService(
    store,
    vault,
    credentials,
    identity,
    accountStore,
    context.workspaceState
  );
  const statusBar = new StatusBarController(accountStore);
  const viewProvider = new AccountsViewProvider(context.extensionUri, accountStore);

  const refreshUI = () => {
    statusBar.refresh();
    viewProvider.refresh();
  };

  const poller = new UsagePoller(
    store,
    vault,
    refresher,
    credentials,
    accountStore,
    instanceId,
    getWorkspaceName,
    () => vscode.workspace.getConfiguration("claudeSwitcher").get<number>("pollIntervalSeconds", 240),
    () => vscode.workspace.getConfiguration("claudeSwitcher").get<boolean>("autoSuspend", true),
    refreshUI,
    () => switchService.ensureLocalAccountRegistered()
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AccountsViewProvider.viewType, viewProvider),
    statusBar,
    { dispose: () => poller.stop() },
    { dispose: () => poller.disposeInstance() }
  );

  // Watch the store folder so other instances' changes reflect quickly.
  if (store) {
    let debounce: NodeJS.Timeout | undefined;
    const onChange = () => {
      if (debounce) {
        clearTimeout(debounce);
      }
      debounce = setTimeout(() => {
        if (accountStore.reload(Date.now())) {
          refreshUI();
        }
      }, 300);
    };
    const watchers = store.watch(onChange);
    context.subscriptions.push({ dispose: () => watchers.forEach((w) => w.close()) });
  }

  // Startup: migrate, recover an interrupted deploy, render, then poll.
  void (async () => {
    try {
      if (store) {
        await migrateIfNeeded(context, store, vault, credentials, identity);
        await switchService.recoverPendingDeploy();
        await switchService.ensureLocalAccountRegistered();
      }
    } catch (e) {
      console.error("claudeSwitcher: startup migration/recovery failed", e);
    }
    accountStore.reload(Date.now());
    accountStore.recomputeActive();
    refreshUI();
    poller.start();
  })();

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.addCurrentAccount", async () => {
      const res = await switchService.park();
      if (!res.ok) {
        vscode.window.showWarningMessage(res.message);
        refreshUI();
        return;
      }
      refreshUI();
      const choice = await vscode.window.showInformationMessage(
        res.message,
        "Switch account…",
        "Reload window"
      );
      if (choice === "Switch account…") {
        await vscode.commands.executeCommand("claudeSwitcher.switchAccount");
      } else if (choice === "Reload window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.switchAccount", async (id?: string) => {
      try {
        const targetId = id ?? (await pickAccount(accountStore, "Switch to account…"));
        if (!targetId) {
          return;
        }
        // When the target has several parked credentials, let the user pick which one.
        let credId: string | undefined;
        if (store) {
          const label = accountStore.listViews().find((v) => v.uuid === targetId)?.label ?? "account";
          const chosen = await pickCredentialToDeploy(store, vault, targetId, label);
          if (chosen === null) {
            return; // cancelled the credential chooser
          }
          credId = chosen;
        }
        const res = await switchService.switchTo(targetId, credId);
        refreshUI();
        if (!res.ok) {
          vscode.window.showWarningMessage(res.message);
        } else if (res.needsReload) {
          await switchService.maybeReload(res.message);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("claudeSwitcher: switchAccount failed", e);
        void vscode.window.showErrorMessage("Claude Account Switcher: switch failed — " + msg);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.refreshUsage", async (id?: string) => {
      if (id) {
        await poller.refreshAccount(id);
      } else {
        await poller.refreshAll();
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.removeAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(accountStore, "Remove account profile…"));
      if (!targetId) {
        return;
      }
      const view = accountStore.listViews().find((v) => v.uuid === targetId);
      const label = view?.label ?? targetId;
      const stored = (view?.parkedCount ?? 0) + (view?.invalidCount ?? 0);

      const confirmDelete = async (detail: string): Promise<boolean> =>
        (await vscode.window.showWarningMessage(detail, { modal: true }, "Delete")) === "Delete";

      // Active account: distinguish the credential live in this window from the pooled ones.
      if (view?.isActive) {
        let deleteLocal = true;
        if (stored > 0) {
          const localPick = `Local credential (sign out here)`;
          const parkedPick = `Parked credentials (${stored})`;
          const pick = await vscode.window.showQuickPick(
            [
              { label: localPick, detail: `Removes the credential in use in this window; keeps the ${stored} parked.` },
              { label: parkedPick, detail: "Deletes the pooled credentials; this window stays logged in." },
            ],
            { title: `Delete for "${label}"`, placeHolder: "What do you want to delete?" }
          );
          if (!pick) {
            return;
          }
          deleteLocal = pick.label === localPick;
        }

        let res;
        if (deleteLocal) {
          if (!(await confirmDelete(`Delete the local credential for "${label}" and sign out of Claude Code in this window?`))) {
            return;
          }
          res = await switchService.deleteLocalCredential(targetId);
        } else {
          // Which parked credential(s)? Always shown — it doubles as the confirmation.
          const parkedRefs = store?.readAccount(targetId)?.credentials ?? [];
          let ids: string[] | undefined; // undefined => all parked
          if (parkedRefs.length >= 1) {
            const chosen = await pickCredentialsToDelete(store!, vault, targetId, label);
            if (!chosen) {
              return;
            }
            ids = chosen.length === parkedRefs.length ? undefined : chosen;
          }
          const count = ids ? ids.length : parkedRefs.length;
          if (!(await confirmDelete(`Delete ${count} parked credential${count === 1 ? "" : "s"} for "${label}"? This window stays logged in.`))) {
            return;
          }
          res = await switchService.deleteParked(targetId, ids);
        }
        refreshUI();
        if (res && !res.ok) {
          vscode.window.showWarningMessage(res.message);
        } else if (res?.needsReload) {
          await switchService.maybeReload(res.message);
        }
        return;
      }

      // Not active here. The multi-select always shows (it doubles as the confirmation);
      // deleting a subset keeps the profile, ticking all removes the whole profile.
      const parkedRefs = store?.readAccount(targetId)?.credentials ?? [];
      if (parkedRefs.length >= 1) {
        const chosen = await pickCredentialsToDelete(store!, vault, targetId, label);
        if (!chosen) {
          return;
        }
        if (chosen.length < parkedRefs.length) {
          if (
            await confirmDelete(
              `Delete ${chosen.length} of ${parkedRefs.length} parked credentials for "${label}"? The profile and the remaining credentials are kept.`
            )
          ) {
            const res = await switchService.deleteParked(targetId, chosen);
            refreshUI();
            if (res && !res.ok) {
              vscode.window.showWarningMessage(res.message);
            }
          }
          return;
        }
        // All ticked → fall through to whole-profile deletion.
      }

      // Delete the whole profile (account entry + parked credentials).
      if (
        await confirmDelete(
          `Remove the profile "${label}"? Its ${stored} parked credential${stored === 1 ? "" : "s"} ${stored === 1 ? "is" : "are"} deleted; accounts deployed in other windows are untouched.`
        )
      ) {
        await switchService.remove(targetId);
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.renameAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(accountStore, "Rename profile…"));
      if (!targetId) {
        return;
      }
      const view = accountStore.listViews().find((v) => v.uuid === targetId);
      const label = await vscode.window.showInputBox({
        title: "New profile name",
        value: view?.label,
        validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
      });
      if (label) {
        await switchService.rename(targetId, label.trim());
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.toggleAccountUpdates", async (id?: string) => {
      const targetId = id ?? (await pickAccount(accountStore, "Pause/resume usage updates…"));
      if (!targetId) {
        return;
      }
      const enabled = await switchService.toggleUpdates(targetId);
      const view = accountStore.listViews().find((v) => v.uuid === targetId);
      vscode.window.showInformationMessage(
        `Usage updates ${enabled ? "resumed" : "paused"} for "${view?.label ?? targetId}".`
      );
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.validateParked", async () => {
      if (!store) {
        vscode.window.showWarningMessage(
          "Testing parked credentials needs a shared store. Enable claudeSwitcher.sync.enabled or set claudeSwitcher.sync.folder."
        );
        return;
      }
      const parked = accountStore.listViews().reduce((n, v) => n + v.parkedCount + v.invalidCount, 0);
      if (parked === 0) {
        vscode.window.showInformationMessage("No parked credentials to test.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Test all ${parked} parked credential${parked === 1 ? "" : "s"}? Invalid (revoked) and orphaned (missing token) ones are permanently removed. This makes a network request per credential.`,
        { modal: true },
        "Test"
      );
      if (confirm !== "Test") {
        return;
      }
      const res = await vscode.window.withProgress(
        { location: { viewId: AccountsViewProvider.viewType }, title: "Testing parked credentials…" },
        () => poller.validateParkedCredentials()
      );
      refreshUI();
      const dropDetail: string[] = [];
      if (res.invalid) dropDetail.push(`${res.invalid} invalid`);
      if (res.orphaned) dropDetail.push(`${res.orphaned} orphaned/missing token`);
      const bits = [
        `tested ${res.tested}`,
        `dropped ${res.dropped}${dropDetail.length ? ` (${dropDetail.join(", ")})` : ""}`,
        `kept ${res.kept}`,
      ];
      if (res.transient) bits.push(`${res.transient} inconclusive`);
      if (res.rateLimited) bits.push("stopped early (rate limit)");
      vscode.window.showInformationMessage("Parked credentials: " + bits.join(", ") + ".");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.undoSwitch", async () => {
      const res = await switchService.undoSwitch();
      refreshUI();
      if (!res.ok) {
        vscode.window.showWarningMessage(res.message);
      } else if (res.needsReload) {
        await switchService.maybeReload(res.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.openPanel", () => {
      void vscode.commands.executeCommand("claudeSwitcher.accountsView.focus");
    })
  );

  // Diagnostic: prove whether VS Code SecretStorage is shared across containers.
  // Run "Write" in one container, then "Read" in another.
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.debugSecretSharing", async () => {
      const KEY = "claudeSwitcher.debug.shareTest";
      const host = os.hostname();
      const pick = await vscode.window.showQuickPick(
        [
          { label: "1 · Write a test secret", detail: "Run this in the FIRST container", action: "write" },
          { label: "2 · Read the test secret", detail: "Then run this in ANOTHER container", action: "read" },
          { label: "Inspect parked credentials", detail: "Show each parked ref: is its token blob present + does the hash match?", action: "inspect" },
        ] as (vscode.QuickPickItem & { action: string })[],
        { title: "SecretStorage sharing test", placeHolder: "Step 1 in one container, step 2 in another" }
      );
      if (!pick) {
        return;
      }
      try {
        if (pick.action === "inspect") {
          if (!store) {
            void vscode.window.showWarningMessage("No shared store — nothing to inspect.");
            return;
          }
          const lines: string[] = [];
          for (const f of store.listAccounts()) {
            for (const ref of f.credentials) {
              const blob = await vault.get(ref.id);
              const blobHash = blob ? refreshTokenHash(blob) : null;
              const state = !blob
                ? "ORPHANED (blob missing)"
                : blobHash === ref.refreshTokenHash
                  ? "ok (hash matches)"
                  : `HASH MISMATCH (ref ${ref.refreshTokenHash} vs blob ${blobHash})`;
              lines.push(
                `${f.account.label} · ${ref.id.slice(0, 8)} · ${state}${ref.invalid ? " · marked-invalid" : ""}`
              );
            }
          }
          void vscode.window.showInformationMessage(
            lines.length ? `Parked credentials (${lines.length}):` : "No parked credentials.",
            { modal: true, detail: lines.join("\n") }
          );
          return;
        }
        if (pick.action === "write") {
          const marker = { host, at: new Date().toISOString(), nonce: crypto.randomBytes(4).toString("hex") };
          await context.secrets.store(KEY, JSON.stringify(marker));
          void vscode.window.showInformationMessage(
            `Wrote SecretStorage marker: host=${host} nonce=${marker.nonce}. Now run step 2 in a DIFFERENT container.`
          );
        } else {
          const raw = await context.secrets.get(KEY);
          if (!raw) {
            void vscode.window.showWarningMessage(
              `No marker in this container's SecretStorage (host=${host}). → SecretStorage is NOT shared. (Did you run step 1 in the other container first?)`
            );
            return;
          }
          const m = JSON.parse(raw) as { host?: string; nonce?: string; at?: string };
          const shared = m.host && m.host !== host;
          void vscode.window[shared ? "showInformationMessage" : "showWarningMessage"](
            `Found marker host=${m.host} nonce=${m.nonce} at=${m.at}; this container=${host}. ` +
              (shared
                ? "→ DIFFERENT host from the writer: SecretStorage IS shared across your containers."
                : "→ Same host as the writer: run step 1 in a DIFFERENT container to prove cross-container sharing.")
          );
        }
      } catch (e) {
        void vscode.window.showErrorMessage("SecretStorage test failed: " + (e instanceof Error ? e.message : String(e)));
      }
    })
  );

  // React to setting changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSwitcher.pollIntervalSeconds")) {
        poller.restart();
      }
      if (e.affectsConfiguration("claudeSwitcher.warnThresholdPercent")) {
        refreshUI();
      }
      if (
        e.affectsConfiguration("claudeSwitcher.sync.enabled") ||
        e.affectsConfiguration("claudeSwitcher.sync.folder") ||
        e.affectsConfiguration("claudeSwitcher.credentialsPath")
      ) {
        void vscode.window.showInformationMessage(
          "Claude Account Switcher: reload the window to apply the storage/sync change.",
          "Reload window"
        ).then((c) => {
          if (c === "Reload window") {
            void vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });
      }
    })
  );

  // When this window regains focus, reconcile immediately: a backgrounded window's
  // tick may have been throttled, so its cached view (and the store) can be stale.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        return;
      }
      if (accountStore.reload(Date.now())) {
        refreshUI();
      }
      void poller.tick(false);
    })
  );
}

export function deactivate(): void {
  /* resources are released via context.subscriptions */
}

/** Shared account-picker QuickPick with a usage + availability preview. */
async function pickAccount(store: AccountStore, title: string): Promise<string | undefined> {
  const accounts = store.listViews();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      'No saved accounts. Use "Park current credential" first.'
    );
    return undefined;
  }

  const items = accounts.map((v: AccountView) => {
    const parts: string[] = [];
    const u = v.lastUsage;
    if (typeof u?.sessionPercent === "number") parts.push(`5h: ${u.sessionPercent}%`);
    if (typeof u?.weeklyPercent === "number") parts.push(`7d: ${u.weeklyPercent}%`);
    if (v.suspended) parts.push(v.suspended.reason === "rate-limit" ? "⚠ rate-limited" : "⚠ token invalid");
    if (!v.updatesEnabled) parts.push("⏸ paused");
    parts.push(`${v.parkedCount} parked`);
    if (v.inUseByOthers.length) parts.push(`in use: ${v.inUseByOthers.join(", ")}`);
    return {
      label: (v.isActive ? "$(check) " : "$(account) ") + v.label,
      description: [v.subscriptionType, parts.join("  ·  ")].filter(Boolean).join("  ·  "),
      id: v.uuid,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select an account",
    matchOnDescription: true,
  });
  return picked?.id;
}

interface CredPick extends vscode.QuickPickItem {
  id: string;
}

/**
 * QuickPick items for credential refs, showing when each was parked, when it was last
 * used to fetch usage, its expiry, and whether its token is present in the shared secret
 * store (an instant local check — not a network probe).
 */
async function credItems(vault: SecretVault, refs: CredentialRef[]): Promise<CredPick[]> {
  const now = Date.now();
  return Promise.all(
    refs.map(async (ref) => {
      const reachable = (await vault.get(ref.id)) !== null;
      const parts = [
        `parked ${fmtAgo(ref.addedAt, now)}`,
        `last used ${fmtAgo(ref.lastUsedAt, now)}`,
        fmtExpiry(ref.expiresAt, now),
        reachable ? "✓ available" : "⚠ token unreachable",
      ];
      if (ref.invalid) {
        parts.push("⚠ revoked");
      }
      return {
        label: `$(key) Credential ${ref.id.slice(0, 7)}`,
        description: parts.join("  ·  "),
        id: ref.id,
      };
    })
  );
}

/**
 * Chooses which parked credential to deploy for an account. Always prompts (even for a
 * single credential — the picker doubles as the switch confirmation, guarding against
 * accidental clicks). Returns the chosen id, `undefined` to let the service use its
 * default pick (no candidates), or `null` if the user cancelled the chooser.
 */
async function pickCredentialToDeploy(
  store: SharedStore,
  vault: SecretVault,
  uuid: string,
  label: string
): Promise<string | undefined | null> {
  const file = store.readAccount(uuid);
  if (!file) {
    return undefined;
  }
  const usable = usableCredentials(file, Date.now());
  if (usable.length === 0) {
    return undefined;
  }
  const single = usable.length === 1;
  const picked = await vscode.window.showQuickPick(await credItems(vault, usable), {
    title: single
      ? `Switch to "${label}" — confirm credential`
      : `Switch to "${label}" — choose a credential`,
    placeHolder: single
      ? "Press Enter to switch, Esc to cancel"
      : "Select which parked credential to use",
    matchOnDescription: true,
  });
  return picked ? picked.id : null;
}

/**
 * Multi-select chooser for which parked credentials to delete. Returns the ticked ids,
 * or `null` if the user cancelled or ticked nothing.
 */
async function pickCredentialsToDelete(
  store: SharedStore,
  vault: SecretVault,
  uuid: string,
  label: string
): Promise<string[] | null> {
  const refs = store.readAccount(uuid)?.credentials ?? [];
  const picked = await vscode.window.showQuickPick(await credItems(vault, refs), {
    title: `Delete parked credentials for "${label}"`,
    placeHolder: "Tick the credential(s) to delete, then press OK",
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picked || picked.length === 0) {
    return null;
  }
  return picked.map((p) => p.id);
}
