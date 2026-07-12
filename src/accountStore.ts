import { CredentialsManager } from "./credentials";
import { IdentityManager } from "./identity";
import { SharedStore } from "./store";
import { AccountFile, AccountView, InstanceInfo, OAuthAccountInfo, UsageFile, UsageSnapshot } from "./types";

const ACTIVE_MEMO_KEY = "claudeSwitcher.activeMemo";
const LOCAL_USAGE_KEY = "claudeSwitcher.localUsage";

/** Minimal subset of vscode.Memento (so this module needs no vscode types). */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/**
 * Read-mostly, UI-facing cache over the shared store. It also owns *active-account
 * detection*, which is derived locally (from ~/.claude.json + the credentials file),
 * never stored globally — so one instance can never set another's "active" marker.
 *
 * Mutations (park/deploy/lease/poll writes) live in SwitchService / UsagePoller and
 * go straight to SharedStore under per-account locks; this class just reflects them.
 */
export class AccountStore {
  private accounts = new Map<string, AccountFile>();
  private usage = new Map<string, UsageFile>();
  private instances: InstanceInfo[] = [];

  private activeUuid?: string;
  private activeIdent?: OAuthAccountInfo;

  private lastSignature = "";
  private lastCredMtime = -1;
  private lastClaudeJsonMtime = -1;

  constructor(
    private readonly store: SharedStore | null,
    private readonly credentials: CredentialsManager,
    private readonly identity: IdentityManager,
    private readonly memento: KeyValueStore,
    private readonly instanceId: string
  ) {}

  hasStore(): boolean {
    return this.store !== null;
  }

  storeDir(): string | undefined {
    return this.store?.root;
  }

  // --- reload from disk ---

  /** Reloads account/usage/instance state if anything changed. Returns true if it did. */
  reload(now: number): boolean {
    if (!this.store) {
      // No shared store: the only "account" is whatever is logged in locally.
      return this.refreshActiveIfChanged();
    }
    const sig = this.store.revSignature();
    const changed = sig !== this.lastSignature;
    if (changed) {
      this.lastSignature = sig;
      this.accounts = new Map(this.store.listAccounts().map((f) => [f.account.uuid, f]));
      this.usage = new Map();
      for (const uuid of this.accounts.keys()) {
        const u = this.store.readUsage(uuid);
        if (u) {
          this.usage.set(uuid, u);
        }
      }
    }
    this.instances = this.store.listLiveInstances(now);
    const activeChanged = this.refreshActiveIfChanged();
    return changed || activeChanged;
  }

  /** Recomputes the active account if the credentials or ~/.claude.json changed. */
  refreshActiveIfChanged(): boolean {
    const credMtime = this.credentials.mtimeMs();
    const claudeJsonMtime = this.identity.mtimeMs();
    if (credMtime === this.lastCredMtime && claudeJsonMtime === this.lastClaudeJsonMtime) {
      return false;
    }
    this.lastCredMtime = credMtime;
    this.lastClaudeJsonMtime = claudeJsonMtime;
    this.recomputeActive();
    return true;
  }

  recomputeActive(): void {
    const creds = this.credentials.readCurrent();
    if (!creds) {
      this.activeUuid = undefined;
      this.activeIdent = undefined;
      return;
    }
    const ident = this.identity.readLocalIdentity();
    this.activeIdent = ident ?? undefined;

    if (ident && this.accounts.has(ident.accountUuid)) {
      this.activeUuid = ident.accountUuid;
      return;
    }
    // Right after our own deploy, ~/.claude.json may still lag; trust the memo only
    // while the credentials file is exactly the one we wrote.
    const memo = this.memento.get<{ uuid?: string; credMtime?: number }>(ACTIVE_MEMO_KEY);
    if (
      memo?.uuid &&
      this.accounts.has(memo.uuid) &&
      memo.credMtime === this.credentials.mtimeMs()
    ) {
      this.activeUuid = memo.uuid;
      return;
    }
    this.activeUuid = undefined;
  }

  /** Records the account we just deployed so the UI is correct before the reload. */
  async setActiveDeployed(uuid: string, ident: OAuthAccountInfo | undefined): Promise<void> {
    this.activeUuid = uuid;
    this.activeIdent = ident;
    this.lastCredMtime = this.credentials.mtimeMs();
    await this.memento.update(ACTIVE_MEMO_KEY, {
      uuid,
      credMtime: this.lastCredMtime,
    });
  }

  async clearActive(): Promise<void> {
    this.activeUuid = undefined;
    this.activeIdent = undefined;
    this.lastCredMtime = this.credentials.mtimeMs();
    await this.memento.update(ACTIVE_MEMO_KEY, undefined);
  }

  activeAccountUuid(): string | undefined {
    return this.activeUuid;
  }

  activeIdentity(): OAuthAccountInfo | undefined {
    return this.activeIdent;
  }

  liveInstances(): InstanceInfo[] {
    return this.instances;
  }

  // --- no-store fallback: cache the local account's usage in workspace state ---

  localUsage(): UsageSnapshot | undefined {
    return this.memento.get<UsageSnapshot>(LOCAL_USAGE_KEY);
  }

  async setLocalUsage(snapshot: UsageSnapshot): Promise<void> {
    await this.memento.update(LOCAL_USAGE_KEY, snapshot);
  }

  // --- views for the UI ---

  getUsageSnapshot(uuid: string): UsageSnapshot | undefined {
    return this.usage.get(uuid)?.snapshot;
  }

  listViews(): AccountView[] {
    if (!this.store) {
      return this.localOnlyViews();
    }
    const now = Date.now();
    const others = this.instances.filter((i) => i.instanceId !== this.instanceId);
    const views = [...this.accounts.values()].map((f) => this.toView(f, others, now));
    // A local login we couldn't register (identity unknown) still shows its usage.
    if (!this.activeUuid && this.credentials.readCurrent()) {
      views.push(this.ephemeralView());
    }
    views.sort((a, b) => compareViews(a, b, now));
    return views;
  }

  private toView(f: AccountFile, others: InstanceInfo[], now: number): AccountView {
    const usable = f.credentials.filter((c) => !c.invalid);
    const invalid = f.credentials.filter((c) => c.invalid);
    const isActive = this.activeUuid === f.account.uuid;
    const inUseByOthers = others
      .filter((i) => i.activeAccountUuid === f.account.uuid)
      .map((i) => i.workspaceName);
    const deployedSomewhere = isActive || inUseByOthers.length > 0;
    return {
      uuid: f.account.uuid,
      email: f.account.email,
      label: f.account.label,
      order: f.account.order,
      subscriptionType: f.account.subscriptionType,
      updatesEnabled: f.account.updatesEnabled,
      suspended: f.account.suspended,
      parkedCount: usable.length,
      invalidCount: invalid.length,
      lastUsage: this.usage.get(f.account.uuid)?.snapshot,
      isActive,
      inUseByOthers,
      // Idle everywhere and every usable token has expired: auto-polling can't update
      // this account (idle spares are never rotated) — only a manual ⟳ will.
      autoStale:
        !deployedSomewhere &&
        usable.length > 0 &&
        usable.every((c) => c.expiresAt - 60_000 <= now),
      // Paused/suspended/failed accounts collapse to the bottom (unless active here).
      bottomGroup:
        !isActive &&
        (!f.account.updatesEnabled ||
          !!f.account.suspended ||
          (!deployedSomewhere && usable.length === 0)),
    };
  }

  /** In no-store mode, surface just the locally logged-in account (if any). */
  private localOnlyViews(): AccountView[] {
    return this.credentials.readCurrent() ? [this.ephemeralView()] : [];
  }

  /** A display-only card for the current local login (used by both modes). */
  private ephemeralView(): AccountView {
    const ident = this.activeIdent;
    return {
      uuid: ident?.accountUuid ?? "__local__",
      email: ident?.emailAddress,
      label: ident?.emailAddress ?? "Current account (unsaved)",
      order: Number.MAX_SAFE_INTEGER,
      subscriptionType: undefined,
      updatesEnabled: true,
      suspended: undefined,
      parkedCount: 0,
      invalidCount: 0,
      lastUsage: this.localUsage(),
      isActive: true,
      inUseByOthers: [],
      ephemeral: true,
    };
  }
}

// --- panel ordering ---

/**
 * Sort rank for the panel (lower = higher up):
 *   0 active in this window (always first, even if paused)
 *   1 active in another window, limit not reached
 *   2 active in another window, limit reached (capped)
 *   3 inactive, session limit not reached
 *   4 inactive, session limit reached
 *   5 paused / suspended / failed (the collapsible bottom section)
 */
export function viewRank(v: AccountView, now: number): number {
  if (v.isActive) {
    return 0;
  }
  if (v.bottomGroup) {
    return 5;
  }
  if (v.inUseByOthers.length > 0) {
    return (v.lastUsage?.cappedUntil ?? 0) > now ? 2 : 1;
  }
  const sessionReached = v.lastUsage?.sessionPercent != null && v.lastUsage.sessionPercent >= 100;
  return sessionReached ? 4 : 3;
}

/** Earliest weekly reset (epoch ms) among the usage windows; MAX_SAFE_INTEGER when unknown. */
export function nextWeeklyReset(v: AccountView): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const w of v.lastUsage?.windows ?? []) {
    if (w.kind.startsWith("weekly") && w.resetsAt) {
      const t = Date.parse(w.resetsAt);
      if (!isNaN(t) && t < min) {
        min = t;
      }
    }
  }
  return min;
}

/** Tier rank, then soonest weekly reset, then the explicit account order. */
export function compareViews(a: AccountView, b: AccountView, now: number): number {
  return (
    viewRank(a, now) - viewRank(b, now) ||
    nextWeeklyReset(a) - nextWeeklyReset(b) ||
    a.order - b.order
  );
}
