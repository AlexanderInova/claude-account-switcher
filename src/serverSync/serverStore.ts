import { AccountFile, InstanceInfo, UsageFile } from "../types";
import { StoreWatcher, SyncStore } from "../syncStore";
import { RETRY_NONE, RETRY_STANDARD, SyncHttp } from "./http";

const POLL_MS = 5_000;
// Pure heartbeats don't bump the pool revision (that would make N windows pull
// N×(N−1) snapshots per heartbeat round), so presence is refreshed by forcing a
// full snapshot at least this often. Must stay well below the 90s instance
// staleness window.
const FULL_SYNC_MS = 60_000;
const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_MS = 250;
const LOCK_MAX_WAIT_MS = 2_000;

interface Snapshot {
  rev: number;
  now: number;
  accounts: AccountFile[];
  usage: Record<string, UsageFile>;
  instances: InstanceInfo[];
  cooldownUntil: number;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/**
 * SyncStore backed by the sync server.
 *
 * Reads are synchronous against a client-side cache that a 5s rev-poll keeps
 * fresh (GET /rev is a single integer; the full snapshot is fetched only when it
 * changed). Freshness inside a lock is guaranteed differently: the lock-acquire
 * response carries the current account+usage docs, which are installed into the
 * cache before the callback runs — so the synchronous reads every existing lock
 * callback does are never stale where it matters.
 *
 * An unreachable server degrades to serving the last-known cache (the UI shows
 * how stale it is); mutations inside lock scopes throw so the cycle is skipped,
 * best-effort mutations (presence, cooldown) are swallowed like the folder
 * backend's try/ignore writes.
 */
export class ServerStore implements SyncStore {
  private accounts = new Map<string, AccountFile>();
  private usage = new Map<string, UsageFile>();
  private instances: InstanceInfo[] = [];
  private cooldownUntilMs = 0;
  private poolRev = -1;
  private lastSyncAt = 0;
  private lastSnapshotAt = 0;
  private reachable = false;
  private needSnapshot = false;
  private readonly callbacks = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(
    private readonly http: SyncHttp,
    private readonly ownerId: string,
    private readonly displayRoot: string,
    private readonly pollMs: number = POLL_MS
  ) {}

  get root(): string {
    return this.displayRoot;
  }

  /** For the panel footer: is the server answering, and how old is the cache. */
  status(): { reachable: boolean; lastSyncAt: number } {
    return { reachable: this.reachable, lastSyncAt: this.lastSyncAt };
  }

  /** Never rejects on an unreachable server — the poll loop keeps trying. */
  async init(): Promise<void> {
    try {
      await this.refreshSnapshot();
    } catch {
      this.setReachable(false);
    }
    this.timer = setInterval(() => void this.pollOnce(), this.pollMs);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // --- cache maintenance ---

  private async refreshSnapshot(): Promise<void> {
    const res = await this.http.request("GET", "/v1/pool/snapshot", { retry: RETRY_NONE });
    if (res.status !== 200) {
      throw new Error(`snapshot HTTP ${res.status}`);
    }
    const snap = res.json as Snapshot;
    // The server prunes stale (>90s) instances before answering, so everything in a
    // snapshot is alive *now*. Stamp them with the install time instead of trying to
    // rebase server-clock heartbeats: keep-alive heartbeats don't bump the pool rev,
    // so cached timestamps would otherwise age past the staleness cutoff between
    // snapshots even though the windows are alive. The periodic full sync
    // (FULL_SYNC_MS) refreshes or removes them long before the 90s filter fires.
    const installedAt = Date.now();
    this.accounts = new Map(snap.accounts.map((a) => [a.account.uuid, a]));
    this.usage = new Map(Object.entries(snap.usage ?? {}));
    this.instances = (snap.instances ?? []).map((i) => ({
      ...i,
      heartbeatAt: installedAt,
    }));
    this.cooldownUntilMs = snap.cooldownUntil ?? 0;
    this.poolRev = snap.rev;
    this.needSnapshot = false;
    this.lastSnapshotAt = installedAt;
    this.markSynced();
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const res = await this.http.request("GET", "/v1/pool/rev", {
        retry: RETRY_NONE,
        timeoutMs: Math.max(this.pollMs, 5_000),
      });
      if (res.status !== 200) {
        this.setReachable(false);
        return;
      }
      const rev = (res.json as { rev: number }).rev;
      const presenceDue = Date.now() - this.lastSnapshotAt > FULL_SYNC_MS;
      if (rev !== this.poolRev || this.needSnapshot || presenceDue) {
        await this.refreshSnapshot();
        this.fireChange();
      } else {
        this.markSynced();
      }
    } catch {
      this.setReachable(false);
    } finally {
      this.polling = false;
    }
  }

  private markSynced(): void {
    this.setReachable(true);
    this.lastSyncAt = Date.now();
  }

  /** Reachability transitions fire the watch, so the UI's ⚠/⇄ indicator stays live. */
  private setReachable(r: boolean): void {
    if (this.reachable !== r) {
      this.reachable = r;
      this.fireChange();
    }
  }

  private fireChange(): void {
    for (const cb of this.callbacks) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Applies a mutation response. The server returns the pool revision after our
   * write; if it advanced by more than one, someone else wrote in between and the
   * cache misses their change — flag a full snapshot for the next poll.
   */
  private applyPoolRev(poolRev: number): void {
    if (poolRev > this.poolRev + 1) {
      this.needSnapshot = true;
    }
    this.poolRev = Math.max(this.poolRev, poolRev);
    this.markSynced();
  }

  // --- reads (cache, deep clones — callers mutate what they read) ---

  listAccountUuids(): string[] {
    return [...this.accounts.keys()];
  }

  listAccounts(): AccountFile[] {
    return [...this.accounts.values()].map(clone);
  }

  readAccount(uuid: string): AccountFile | null {
    const f = this.accounts.get(uuid);
    return f ? clone(f) : null;
  }

  readUsage(uuid: string): UsageFile | null {
    const f = this.usage.get(uuid);
    return f ? clone(f) : null;
  }

  cooldownUntil(): number {
    return this.cooldownUntilMs;
  }

  listLiveInstances(now: number): InstanceInfo[] {
    // Staleness is enforced server-side too; this local filter matches the folder impl.
    return this.instances.filter((i) => now - i.heartbeatAt <= 90_000).map(clone);
  }

  revSignature(): string {
    return `srv:${this.poolRev}`;
  }

  // --- mutations ---

  async writeAccount(file: AccountFile): Promise<void> {
    const res = await this.http.request("PUT", `/v1/pool/accounts/${file.account.uuid}`, {
      body: file,
      retry: RETRY_STANDARD,
    });
    if (res.status !== 200) {
      throw new Error(`Account write failed (HTTP ${res.status})`);
    }
    const { poolRev, doc } = res.json as { poolRev: number; doc: AccountFile };
    this.accounts.set(file.account.uuid, doc);
    // The server owns rev/updatedAt; reflect them into the caller's object the way
    // the folder backend's writeAccount mutates its argument.
    file.rev = doc.rev;
    file.updatedAt = doc.updatedAt;
    this.applyPoolRev(poolRev);
  }

  async deleteAccount(uuid: string): Promise<void> {
    const res = await this.http.request("DELETE", `/v1/pool/accounts/${uuid}`, {
      retry: RETRY_STANDARD,
    });
    if (res.status !== 200) {
      throw new Error(`Account delete failed (HTTP ${res.status})`);
    }
    this.accounts.delete(uuid);
    this.usage.delete(uuid);
    this.applyPoolRev((res.json as { poolRev: number }).poolRev);
  }

  async writeUsage(uuid: string, file: UsageFile): Promise<void> {
    const res = await this.http.request("PUT", `/v1/pool/usage/${uuid}`, {
      body: file,
      retry: RETRY_STANDARD,
    });
    if (res.status !== 200) {
      throw new Error(`Usage write failed (HTTP ${res.status})`);
    }
    const { poolRev, doc } = res.json as { poolRev: number; doc: UsageFile };
    this.usage.set(uuid, doc); // the server's monotonic merge result, not our input
    this.applyPoolRev(poolRev);
  }

  async setCooldownUntil(until: number): Promise<void> {
    try {
      const res = await this.http.request("PUT", "/v1/pool/cooldown", {
        body: { cooldownUntil: until },
        retry: RETRY_NONE,
      });
      if (res.status === 200) {
        this.cooldownUntilMs = until;
        this.applyPoolRev((res.json as { poolRev: number }).poolRev);
      }
    } catch {
      /* best-effort, like the folder backend */
    }
  }

  async writeInstance(info: InstanceInfo): Promise<void> {
    try {
      const res = await this.http.request("PUT", `/v1/pool/instances/${info.instanceId}`, {
        body: info,
        retry: RETRY_NONE,
      });
      if (res.status === 200) {
        const others = this.instances.filter((i) => i.instanceId !== info.instanceId);
        this.instances = [...others, { ...info, heartbeatAt: Date.now() }];
        this.applyPoolRev((res.json as { poolRev: number }).poolRev);
      }
    } catch {
      /* best-effort */
    }
  }

  async removeInstance(instanceId: string): Promise<void> {
    try {
      await this.http.request("DELETE", `/v1/pool/instances/${instanceId}`, {
        retry: RETRY_NONE,
      });
      this.instances = this.instances.filter((i) => i.instanceId !== instanceId);
    } catch {
      /* best-effort */
    }
  }

  // --- coordination ---

  async withAccountLock<T>(uuid: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    const owner = `${this.ownerId}:${Math.random().toString(36).slice(2, 10)}`;
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    let acquired: { account: AccountFile | null; usage: UsageFile | null } | undefined;
    while (!acquired) {
      let res;
      try {
        res = await this.http.request("POST", `/v1/pool/locks/${uuid}`, {
          body: { owner, ttlMs: LOCK_TTL_MS },
          retry: RETRY_NONE,
        });
      } catch {
        return undefined; // unreachable server = skip this cycle, like a lost lock race
      }
      if (res.status === 200) {
        acquired = res.json as { account: AccountFile | null; usage: UsageFile | null };
        break;
      }
      if (res.status !== 423 || Date.now() + LOCK_RETRY_MS > deadline) {
        return undefined;
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
    // Install the ride-along docs so sync reads inside the callback are fresh.
    if (acquired.account) {
      this.accounts.set(uuid, acquired.account);
    } else {
      this.accounts.delete(uuid);
    }
    if (acquired.usage) {
      this.usage.set(uuid, acquired.usage);
    } else {
      this.usage.delete(uuid);
    }
    try {
      return await fn();
    } finally {
      try {
        await this.http.request("DELETE", `/v1/pool/locks/${uuid}?owner=${encodeURIComponent(owner)}`, {
          retry: RETRY_STANDARD,
        });
      } catch {
        /* the 30s TTL bounds a lost release to one skipped cycle */
      }
    }
  }

  watch(onChange: () => void): StoreWatcher[] {
    this.callbacks.add(onChange);
    return [{ close: () => this.callbacks.delete(onChange) }];
  }
}
