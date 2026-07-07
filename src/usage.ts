import * as os from "os";
import { AccountStore } from "./accountStore";
import { CredentialsManager } from "./credentials";
import { TokenRefresher } from "./oauth";
import { SecretVault, refreshTokenHash } from "./secretVault";
import { SharedStore } from "./store";
import { AccountFile, CredentialRef, OAuthCreds, UsageFile, UsageSnapshot, UsageWindow } from "./types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT = "claude-code/2.0.14";
const BACKOFF_429_MS = 300_000; // 5 min after hitting the request rate limit
const TICK_MS = 20_000; // coordinator tick; the real per-account interval is pollIntervalSeconds
const LEASE_STALE_MS = 120_000; // a lease older than this is reclaimable

interface RawWindow {
  utilization?: number;
  resets_at?: string | null;
}
interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  is_active?: boolean;
}
interface RawUsage {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  limits?: RawLimit[];
}

function labelFor(kind: string, group: string): string {
  switch (kind) {
    case "session":
      return "Session (5h)";
    case "weekly_all":
      return "Weekly (7d)";
    case "weekly_opus":
      return "Weekly (Opus)";
    case "weekly_sonnet":
      return "Weekly (Sonnet)";
    default:
      if (group === "session") return "Session (5h)";
      if (group === "weekly") return "Weekly Fable";
      return kind || group || "Limit";
  }
}

/** Maps the raw endpoint response to a normalized snapshot. */
export function parseUsage(raw: RawUsage): UsageSnapshot {
  const windows: UsageWindow[] = [];

  if (Array.isArray(raw.limits) && raw.limits.length > 0) {
    for (const l of raw.limits) {
      const percent = typeof l.percent === "number" ? l.percent : 0;
      windows.push({
        kind: l.kind ?? l.group ?? "limit",
        label: labelFor(l.kind ?? "", l.group ?? ""),
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        severity: l.severity ?? "normal",
        resetsAt: l.resets_at ?? null,
      });
    }
  } else {
    // Fall back to the five_hour / seven_day fields.
    if (raw.five_hour) {
      windows.push({
        kind: "session",
        label: "Session (5h)",
        percent: Math.round(raw.five_hour.utilization ?? 0),
        severity: "normal",
        resetsAt: raw.five_hour.resets_at ?? null,
      });
    }
    if (raw.seven_day) {
      windows.push({
        kind: "weekly_all",
        label: "Weekly (7d)",
        percent: Math.round(raw.seven_day.utilization ?? 0),
        severity: "normal",
        resetsAt: raw.seven_day.resets_at ?? null,
      });
    }
  }

  const session = windows.find((w) => w.kind === "session");
  const weekly = windows.find((w) => w.kind === "weekly_all" || w.kind.startsWith("weekly"));

  return {
    fetchedAt: Date.now(),
    windows,
    sessionPercent: session ? session.percent : null,
    weeklyPercent: weekly ? weekly.percent : null,
  };
}

export interface FetchResult {
  snapshot?: UsageSnapshot;
  status: number;
  retryAfter?: number;
  error?: string;
}

/** A single call to the usage endpoint for the given token. */
export async function fetchUsage(creds: OAuthCreds): Promise<FetchResult> {
  try {
    const res = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + creds.accessToken,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    if (res.status === 429) {
      return { status: 429, retryAfter: Date.now() + BACKOFF_429_MS, error: "Rate limit (429)" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
    }
    const data = (await res.json()) as RawUsage;
    return { status: 200, snapshot: parseUsage(data) };
  } catch (e) {
    return { status: 0, error: (e as Error).message };
  }
}

/** Whether an account is due for a scheduled poll (group-wide freshness target). */
export function isDue(now: number, intervalMs: number, usage: UsageFile | null | undefined): boolean {
  const retryAfter = usage?.snapshot?.retryAfter ?? 0;
  if (retryAfter > now) {
    return false;
  }
  const fetchedAt = usage?.snapshot?.fetchedAt ?? 0;
  const lastAttempt = usage?.lastAttemptAt ?? 0;
  return now - Math.max(fetchedAt, lastAttempt) >= intervalMs;
}

/** First usable (present, not invalid, not freshly leased) parked credential. */
export function pickFreeCredential(file: AccountFile, now: number): CredentialRef | undefined {
  return file.credentials.find(
    (c) => !c.invalid && (!c.lease || now - c.lease.at > LEASE_STALE_MS)
  );
}

/** Builds an error snapshot that preserves the previous data and its fetch time. */
export function errorSnapshot(
  prev: UsageSnapshot | undefined,
  result: { error?: string; status?: number; retryAfter?: number },
  now: number
): UsageSnapshot {
  const is429 = result.status === 429;
  let retryAfter: number | undefined;
  if (is429) {
    retryAfter = result.retryAfter ?? now + BACKOFF_429_MS;
  } else if (prev?.retryAfter && prev.retryAfter > now) {
    retryAfter = prev.retryAfter;
  }
  return {
    fetchedAt: prev?.fetchedAt ?? 0,
    windows: prev?.windows ?? [],
    sessionPercent: prev?.sessionPercent ?? null,
    weeklyPercent: prev?.weeklyPercent ?? null,
    error: result.error ?? "Failed to fetch usage",
    errorAt: now,
    retryAfter,
  };
}

function short(s: string | undefined): string {
  return (s ?? "").slice(0, 160);
}

function emptyUsage(): UsageFile {
  return {
    rev: 0,
    updatedAt: 0,
    lastAttemptAt: 0,
    snapshot: { fetchedAt: 0, windows: [], sessionPercent: null, weeklyPercent: null },
  };
}

/**
 * Coordinates usage polling across all instances. A short tick checks which
 * accounts are due (using shared timestamps), and a per-account lock ensures only
 * one instance actually polls each account per interval — collapsing N instances
 * into ~1 request per account per interval. Never refreshes the local live token.
 */
export class UsagePoller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: SharedStore | null,
    private readonly vault: SecretVault,
    private readonly refresher: TokenRefresher,
    private readonly credentials: CredentialsManager,
    private readonly accountStore: AccountStore,
    private readonly instanceId: string,
    private readonly getWorkspaceName: () => string,
    private readonly getIntervalSeconds: () => number,
    private readonly getAutoSuspend: () => boolean,
    private readonly onUpdate: () => void
  ) {}

  start(): void {
    this.stop();
    void this.tick(false).finally(() => this.schedule());
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  restart(): void {
    this.start();
  }

  private schedule(): void {
    const jitter = TICK_MS * 0.2 * (Math.random() * 2 - 1);
    this.timer = setTimeout(() => {
      void this.tick(false).finally(() => this.schedule());
    }, TICK_MS + jitter);
  }

  private intervalMs(): number {
    return Math.max(180, this.getIntervalSeconds()) * 1000;
  }

  /** One coordinator pass. `force` bypasses dueness/pause/suspension/cooldown. */
  async tick(force: boolean): Promise<void> {
    if (this.running && !force) {
      return;
    }
    this.running = true;
    try {
      if (!this.store) {
        await this.pollLocalOnly(force);
        return;
      }
      const now = Date.now();
      this.heartbeat(now);

      if (this.accountStore.reload(now)) {
        this.onUpdate();
      }

      if (!force && this.store.cooldownUntil() > now) {
        return;
      }

      for (const uuid of this.store.listAccountUuids()) {
        await this.pollAccount(uuid, force);
      }
      this.onUpdate();
    } finally {
      this.running = false;
    }
  }

  async refreshAll(): Promise<void> {
    await this.tick(true);
  }

  /** Manual retry for one account: clears suspension + backoff, then force-polls. */
  async refreshAccount(uuid: string): Promise<void> {
    if (!this.store) {
      await this.pollLocalOnly(true);
      this.onUpdate();
      return;
    }
    await this.store.withAccountLock(uuid, () => {
      const f = this.store!.readAccount(uuid);
      if (f?.account.suspended) {
        f.account.suspended = undefined;
        this.store!.writeAccount(f);
      }
      const u = this.store!.readUsage(uuid);
      if (u?.snapshot?.retryAfter) {
        u.snapshot.retryAfter = undefined;
        this.store!.writeUsage(uuid, u);
      }
    });
    await this.pollAccount(uuid, true);
    this.onUpdate();
  }

  private heartbeat(now: number): void {
    if (!this.store) {
      return;
    }
    this.store.writeInstance({
      instanceId: this.instanceId,
      hostname: os.hostname(),
      pid: process.pid,
      workspaceName: this.getWorkspaceName(),
      activeAccountUuid: this.accountStore.activeAccountUuid(),
      startedAt: now,
      heartbeatAt: now,
    });
  }

  disposeInstance(): void {
    this.store?.removeInstance(this.instanceId);
  }

  // --- per-account polling ---

  private async pollAccount(uuid: string, force: boolean): Promise<void> {
    if (!this.store) {
      return;
    }
    const now = Date.now();
    const activeHere = this.accountStore.activeAccountUuid() === uuid;
    const othersActive = this.accountStore
      .liveInstances()
      .some((i) => i.instanceId !== this.instanceId && i.activeAccountUuid === uuid);

    // If some *other* live instance has this account deployed, let it poll (it holds
    // the freshest local token). Instances where it is active here still contend.
    if (!force && !activeHere && othersActive) {
      return;
    }

    const localCreds = activeHere ? this.credentials.readCurrent() : null;
    const localUsable = localCreds !== null && !TokenRefresher.isExpired(localCreds);

    // Claim under the account lock: recheck dueness, stamp lastAttemptAt, and if we
    // will use a parked credential, mark the lease — all atomically.
    const plan = await this.store.withAccountLock(uuid, (): PollPlan => {
      const file = this.store!.readAccount(uuid);
      if (!file) {
        return { kind: "skip" };
      }
      if (!force && (!file.account.updatesEnabled || file.account.suspended)) {
        return { kind: "skip" };
      }
      const usage = this.store!.readUsage(uuid);
      if (!force && !isDue(now, this.intervalMs(), usage)) {
        return { kind: "skip" };
      }
      // Only claim (stamp lastAttemptAt) when we will actually hit the network, so a
      // "waiting for the token" account re-checks cheaply next tick instead of being
      // locked out for a whole interval.
      if (localUsable) {
        this.store!.writeUsage(uuid, { ...(usage ?? emptyUsage()), lastAttemptAt: now });
        return { kind: "local" };
      }
      const ref = pickFreeCredential(file, now);
      if (ref) {
        ref.lease = { instanceId: this.instanceId, at: now };
        this.store!.writeAccount(file);
        this.store!.writeUsage(uuid, { ...(usage ?? emptyUsage()), lastAttemptAt: now });
        return { kind: "lease", credId: ref.id, hash: ref.refreshTokenHash, unverified: !!ref.unverified };
      }
      return activeHere ? { kind: "waiting" } : { kind: "none" };
    });

    if (!plan || plan.kind === "skip" || plan.kind === "none") {
      return;
    }
    if (plan.kind === "waiting") {
      await this.writeError(uuid, { error: "Waiting for Claude Code to refresh the token" }, now);
      return;
    }
    if (plan.kind === "local") {
      const result = await fetchUsage(localCreds as OAuthCreds);
      await this.applyResult(uuid, result, now, null);
      return;
    }
    await this.runLease(uuid, plan.credId, plan.hash, plan.unverified, now);
  }

  private async runLease(
    uuid: string,
    credId: string,
    hash: string,
    unverified: boolean,
    now: number
  ): Promise<void> {
    if (!this.store) {
      return;
    }
    let creds = await this.vault.getVerified(credId, hash);
    if (!creds) {
      // Secret not propagated yet or hash drifted — transient; release and retry later.
      await this.clearLease(uuid, credId);
      return;
    }

    if (TokenRefresher.isExpired(creds)) {
      const r = await this.refresher.refresh(creds);
      if (r.ok && r.creds) {
        creds = r.creds;
        await this.vault.put(credId, creds); // write-back BEFORE the usage GET
        await this.updateRefTokens(uuid, credId, creds);
      } else if (r.terminal) {
        await this.handleInvalidGrant(uuid, credId, r.error ?? "invalid_grant", now);
        return;
      } else {
        await this.clearLease(uuid, credId);
        await this.writeError(uuid, { error: "Token refresh failed: " + short(r.error) }, now);
        return;
      }
    }

    const result = await fetchUsage(creds);
    await this.applyResult(uuid, result, now, credId, unverified);
  }

  // --- result application (all under the account lock) ---

  private async applyResult(
    uuid: string,
    result: FetchResult,
    now: number,
    credId: string | null,
    unverified = false
  ): Promise<void> {
    if (!this.store) {
      return;
    }
    let hitCooldown = false;
    await this.store.withAccountLock(uuid, () => {
      const file = this.store!.readAccount(uuid);
      const usage = this.store!.readUsage(uuid) ?? emptyUsage();
      const prev = usage.snapshot;

      if (result.snapshot) {
        this.store!.writeUsage(uuid, {
          ...usage,
          snapshot: result.snapshot,
          lastAttemptAt: now,
        });
        if (file) {
          if (file.account.suspended) {
            file.account.suspended = undefined;
          }
          if (credId) {
            const ref = file.credentials.find((c) => c.id === credId);
            if (ref) {
              ref.lastUsedAt = now;
              if (unverified) {
                ref.unverified = false;
              }
              delete ref.lease;
            }
          }
          this.store!.writeAccount(file);
        }
        return;
      }

      // Error: preserve previous data, annotate.
      this.store!.writeUsage(uuid, {
        ...usage,
        snapshot: errorSnapshot(prev, result, now),
        lastAttemptAt: now,
      });
      if (result.status === 429) {
        hitCooldown = true;
      }
      if (file) {
        if (credId) {
          const ref = file.credentials.find((c) => c.id === credId);
          if (ref) {
            delete ref.lease;
          }
        }
        if (result.status === 429 && this.getAutoSuspend()) {
          file.account.suspended = { at: now, reason: "rate-limit" };
        }
        this.store!.writeAccount(file);
      }
    });
    if (hitCooldown) {
      this.store.setCooldownUntil(result.retryAfter ?? now + BACKOFF_429_MS);
    }
  }

  private async writeError(
    uuid: string,
    result: { error?: string; status?: number; retryAfter?: number },
    now: number
  ): Promise<void> {
    if (!this.store) {
      return;
    }
    await this.store.withAccountLock(uuid, () => {
      const usage = this.store!.readUsage(uuid) ?? emptyUsage();
      this.store!.writeUsage(uuid, {
        ...usage,
        snapshot: errorSnapshot(usage.snapshot, result, now),
        lastAttemptAt: now,
      });
    });
  }

  private async handleInvalidGrant(
    uuid: string,
    credId: string,
    detail: string,
    now: number
  ): Promise<void> {
    if (!this.store) {
      return;
    }
    await this.store.withAccountLock(uuid, () => {
      const file = this.store!.readAccount(uuid);
      if (file) {
        const ref = file.credentials.find((c) => c.id === credId);
        if (ref) {
          ref.invalid = { at: now, detail: short(detail) };
          delete ref.lease;
        }
        const usable = file.credentials.filter((c) => !c.invalid).length;
        const activeHere = this.accountStore.activeAccountUuid() === uuid;
        const activeElsewhere = this.accountStore
          .liveInstances()
          .some((i) => i.instanceId !== this.instanceId && i.activeAccountUuid === uuid);
        if (this.getAutoSuspend() && usable === 0 && !activeHere && !activeElsewhere) {
          file.account.suspended = { at: now, reason: "invalid-grant", detail: short(detail) };
        }
        this.store!.writeAccount(file);
      }
      const usage = this.store!.readUsage(uuid) ?? emptyUsage();
      this.store!.writeUsage(uuid, {
        ...usage,
        snapshot: errorSnapshot(usage.snapshot, { error: "Refresh token invalid" }, now),
        lastAttemptAt: now,
      });
    });
    await this.vault.remove(credId);
  }

  private async updateRefTokens(uuid: string, credId: string, creds: OAuthCreds): Promise<void> {
    if (!this.store) {
      return;
    }
    await this.store.withAccountLock(uuid, () => {
      const file = this.store!.readAccount(uuid);
      if (!file) {
        return;
      }
      const ref = file.credentials.find((c) => c.id === credId);
      if (ref) {
        ref.expiresAt = creds.expiresAt;
        ref.refreshTokenHash = refreshTokenHash(creds);
      }
      this.store!.writeAccount(file);
    });
  }

  private async clearLease(uuid: string, credId: string): Promise<void> {
    if (!this.store) {
      return;
    }
    await this.store.withAccountLock(uuid, () => {
      const file = this.store!.readAccount(uuid);
      if (!file) {
        return;
      }
      const ref = file.credentials.find((c) => c.id === credId);
      if (ref) {
        delete ref.lease;
      }
      this.store!.writeAccount(file);
    });
  }

  // --- no-store fallback ---

  private async pollLocalOnly(force: boolean): Promise<void> {
    const now = Date.now();
    this.accountStore.refreshActiveIfChanged();
    const creds = this.credentials.readCurrent();
    if (!creds) {
      this.onUpdate();
      return;
    }
    const prev = this.accountStore.localUsage();
    if (TokenRefresher.isExpired(creds)) {
      await this.accountStore.setLocalUsage(
        errorSnapshot(prev, { error: "Waiting for Claude Code to refresh the token" }, now)
      );
      this.onUpdate();
      return;
    }
    if (!force && prev && now - prev.fetchedAt < this.intervalMs()) {
      return;
    }
    const result = await fetchUsage(creds);
    await this.accountStore.setLocalUsage(
      result.snapshot ?? errorSnapshot(prev, result, now)
    );
    this.onUpdate();
  }
}

type PollPlan =
  | { kind: "skip" }
  | { kind: "none" }
  | { kind: "waiting" }
  | { kind: "local" }
  | { kind: "lease"; credId: string; hash: string; unverified: boolean };
