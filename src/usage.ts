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
    cappedUntil: cappedUntilFrom(windows),
  };
}

/**
 * If the 5h session or the 7d weekly window is maxed out (100%) and we know when it
 * resets, returns the earliest such reset time (epoch ms). Polling pauses until then
 * because usage can't grow past 100% before it resets. Model-specific weekly windows
 * (Opus/Sonnet) are ignored — hitting one doesn't make the account unusable.
 */
export function cappedUntilFrom(windows: UsageWindow[]): number | undefined {
  const resets: number[] = [];
  for (const w of windows) {
    const tracked = w.kind === "session" || w.kind === "weekly_all";
    if (tracked && w.percent >= 100 && w.resetsAt) {
      const t = Date.parse(w.resetsAt);
      if (!isNaN(t)) {
        resets.push(t);
      }
    }
  }
  return resets.length ? Math.min(...resets) : undefined;
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
  // Maxed-out window: nothing changes until it resets — pause auto-polling until then.
  const cappedUntil = usage?.snapshot?.cappedUntil ?? 0;
  if (cappedUntil > now) {
    return false;
  }
  const fetchedAt = usage?.snapshot?.fetchedAt ?? 0;
  const lastAttempt = usage?.lastAttemptAt ?? 0;
  return now - Math.max(fetchedAt, lastAttempt) >= intervalMs;
}

/** All usable (not invalid, not freshly leased) parked credentials, in pool order. */
export function usableCredentials(file: AccountFile, now: number): CredentialRef[] {
  return file.credentials.filter(
    (c) => !c.invalid && (!c.lease || now - c.lease.at > LEASE_STALE_MS)
  );
}

/** First usable (present, not invalid, not freshly leased) parked credential. */
export function pickFreeCredential(file: AccountFile, now: number): CredentialRef | undefined {
  return usableCredentials(file, now)[0];
}

/** Validity verdict for a parked credential being tested. */
export type Verdict = "valid" | "invalid" | "transient";

/** Verdict from a refresh attempt: ok = valid, terminal (invalid_grant/400/401) = invalid. */
export function verdictFromRefresh(r: { ok: boolean; terminal?: boolean }): Verdict {
  if (r.ok) {
    return "valid";
  }
  return r.terminal ? "invalid" : "transient";
}

/** Verdict from an authenticated GET status: 401/403 = invalid, 200 = valid, else transient. */
export function verdictFromStatus(status: number): Verdict {
  if (status === 401 || status === 403) {
    return "invalid";
  }
  if (status === 200) {
    return "valid";
  }
  return "transient";
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
    // Keep any maxed-out cap so a failed manual poll doesn't resume auto-polling early.
    cappedUntil: prev?.cappedUntil && prev.cappedUntil > now ? prev.cappedUntil : undefined,
  };
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
    private readonly onUpdate: () => void,
    /** Registers the locally logged-in account if it isn't in the store yet. */
    private readonly ensureLocalRegistered: () => Promise<boolean>
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

      // Auto-register the account logged in locally (if its identity is known and it
      // isn't stored yet) so its usage is polled and it shows up everywhere.
      const registered = await this.ensureLocalRegistered();
      const changed = this.accountStore.reload(now);
      if (registered) {
        // The account now exists in the map, so active detection can match it even
        // though the credentials file's mtime didn't change.
        this.accountStore.recomputeActive();
      }
      if (changed || registered) {
        this.onUpdate();
      }

      if (!force && this.store.cooldownUntil() > now) {
        return;
      }

      for (const uuid of this.store.listAccountUuids()) {
        await this.pollAccount(uuid, force);
      }

      // Identity-unknown fallback: a local login we couldn't name gets no account
      // file, so poll it directly into the ephemeral local-usage cache.
      if (this.credentials.readCurrent() && !this.accountStore.activeAccountUuid()) {
        await this.pollLocalOnly(force);
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
        return { kind: "lease", credId: ref.id, unverified: !!ref.unverified };
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
    await this.runLease(uuid, plan.credId, plan.unverified, now);
  }

  private async runLease(uuid: string, credId: string, unverified: boolean, now: number): Promise<void> {
    if (!this.store) {
      return;
    }
    // Trust the stored blob (don't gate on a possibly-stale ref-hash).
    const creds = await this.vault.get(credId);
    if (!creds) {
      // Orphaned ref — leave it for the "Test parked credentials" cleanup; just release.
      await this.clearLease(uuid, credId);
      return;
    }
    if (TokenRefresher.isExpired(creds)) {
      // Do NOT refresh/rotate an idle spare merely to poll usage — that churns the
      // ref/blob pair and spends a single-use refresh token. Skip this cycle.
      await this.clearLease(uuid, credId);
      return;
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

  /** Removes a parked credential (reference + secret blob). Keeps the account entry. */
  private async dropParkedCredential(uuid: string, credId: string): Promise<void> {
    if (!this.store) {
      return;
    }
    await this.store.withAccountLock(uuid, () => {
      const file = this.store!.readAccount(uuid);
      if (!file) {
        return;
      }
      file.credentials = file.credentials.filter((c) => c.id !== credId);
      this.store!.writeAccount(file);
    });
    await this.vault.remove(credId);
  }

  /**
   * Probes every parked credential and drops the ones that are definitively invalid
   * (401/403 on use, or invalid_grant on refresh). Transient failures (429/network/5xx)
   * never drop. Never touches the credential currently deployed locally. Stops early on
   * a 429 to respect the rate limit.
   */
  async validateParkedCredentials(): Promise<{
    tested: number;
    dropped: number;
    invalid: number;
    orphaned: number;
    kept: number;
    transient: number;
    rateLimited: boolean;
  }> {
    const result = { tested: 0, dropped: 0, invalid: 0, orphaned: 0, kept: 0, transient: 0, rateLimited: false };
    if (!this.store) {
      return result;
    }
    const local = this.credentials.readCurrent();
    const localHash = local ? refreshTokenHash(local) : undefined;

    for (const account of this.store.listAccounts()) {
      const uuid = account.account.uuid;
      // Snapshot the ids to test; re-read live state under the lock when claiming.
      for (const credId of account.credentials.map((c) => c.id)) {
        if (result.rateLimited) {
          break;
        }
        const now = Date.now();
        const claim = await this.store.withAccountLock(uuid, () => {
          const file = this.store!.readAccount(uuid);
          const ref = file?.credentials.find((c) => c.id === credId);
          if (!file || !ref) {
            return undefined;
          }
          if (ref.lease && now - ref.lease.at <= LEASE_STALE_MS) {
            return undefined; // in use elsewhere
          }
          if (localHash && ref.refreshTokenHash === localHash) {
            return undefined; // never probe the live grant
          }
          ref.lease = { instanceId: this.instanceId, at: now };
          this.store!.writeAccount(file);
          return true;
        });
        if (!claim) {
          continue;
        }

        result.tested++;
        const verdict = await this.probeCredential(uuid, credId);
        if (verdict === "invalid" || verdict === "orphaned") {
          await this.dropParkedCredential(uuid, credId);
          result.dropped++;
          if (verdict === "orphaned") {
            result.orphaned++;
          } else {
            result.invalid++;
          }
        } else if (verdict === "valid") {
          await this.clearLease(uuid, credId);
          result.kept++;
        } else {
          await this.clearLease(uuid, credId);
          result.transient++;
          if (verdict === "transient-429") {
            result.rateLimited = true;
          }
        }
      }
      if (result.rateLimited) {
        break;
      }
    }
    this.onUpdate();
    return result;
  }

  /**
   * Probes one leased parked credential against its actual stored blob (not a
   * hash-gated read), so a stale ref-hash never masquerades as a failure. Returns:
   * `orphaned` (blob gone), `invalid` (dead grant), `valid`, `transient`, or
   * `transient-429`. On success it heals any ref/blob hash divergence.
   */
  private async probeCredential(uuid: string, credId: string): Promise<Verdict | "orphaned" | "transient-429"> {
    const creds = await this.vault.get(credId);
    if (!creds) {
      return "orphaned"; // ref points at a token that no longer exists
    }
    if (TokenRefresher.isExpired(creds)) {
      const r = await this.refresher.refresh(creds);
      const verdict = verdictFromRefresh(r);
      if (verdict === "valid" && r.creds) {
        await this.vault.put(credId, r.creds); // persist the rotated token
        await this.updateRefTokens(uuid, credId, r.creds);
      }
      return verdict;
    }
    const res = await fetchUsage(creds);
    if (res.status === 429) {
      return "transient-429";
    }
    const verdict = verdictFromStatus(res.status);
    if (verdict === "valid") {
      await this.updateRefTokens(uuid, credId, creds); // reconcile a drifted ref-hash
    }
    return verdict;
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
    if (!force && prev?.cappedUntil && prev.cappedUntil > now) {
      return; // maxed out — wait for reset (manual refresh still works)
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
  | { kind: "lease"; credId: string; unverified: boolean };
