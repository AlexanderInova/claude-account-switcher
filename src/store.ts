import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomicWrite";
import { AccountFile, InstanceInfo, UsageFile } from "./types";
import { withLock } from "./lockFile";

/** Live instances whose heartbeat is older than this are considered dead. */
const INSTANCE_STALE_MS = 90_000;

/**
 * The shared, file-backed coordination store (one directory, typically shared
 * across containers via a mounted home or a symlink). It is the single authority
 * for account metadata, parked-credential references, usage snapshots, presence,
 * and cross-instance locking. Token material is NOT stored here (see SecretVault).
 *
 * All writes are atomic (tmp + rename). All reads tolerate parse errors and a
 * concurrent writer by returning null, so callers keep their last good state.
 */
export class SharedStore {
  constructor(private readonly dir: string) {}

  get root(): string {
    return this.dir;
  }

  private sub(name: string): string {
    return path.join(this.dir, name);
  }

  /** Creates the directory layout and a `.gitignore` (only if missing). */
  ensureLayout(): void {
    for (const s of ["accounts", "usage", "locks", "instances"]) {
      fs.mkdirSync(this.sub(s), { recursive: true, mode: 0o700 });
    }
    const gi = this.sub(".gitignore");
    if (!fs.existsSync(gi)) {
      try {
        fs.writeFileSync(gi, "# Managed by the Claude Account Switcher extension\n*\n", {
          mode: 0o600,
        });
      } catch {
        /* best-effort */
      }
    }
  }

  // --- atomic JSON IO ---

  private writeJson(p: string, obj: unknown): void {
    writeFileAtomic(p, JSON.stringify(obj, null, 2));
  }

  private readJson<T>(p: string): T | null {
    // Retry once: a read can rarely race an atomic replace on some container mounts.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8")) as T;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return null; // genuinely absent — no point retrying
        }
        if (attempt === 0) {
          continue;
        }
        return null;
      }
    }
    return null;
  }

  // --- account files ---

  private accountPath(uuid: string): string {
    return path.join(this.sub("accounts"), uuid + ".json");
  }

  lockPath(uuid: string): string {
    return path.join(this.sub("locks"), uuid + ".lock");
  }

  listAccountUuids(): string[] {
    try {
      return fs
        .readdirSync(this.sub("accounts"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  listAccounts(): AccountFile[] {
    const out: AccountFile[] = [];
    for (const uuid of this.listAccountUuids()) {
      const f = this.readAccount(uuid);
      if (f) {
        out.push(f);
      }
    }
    return out;
  }

  readAccount(uuid: string): AccountFile | null {
    return this.readJson<AccountFile>(this.accountPath(uuid));
  }

  /** Writes an account file, bumping rev + updatedAt. */
  writeAccount(file: AccountFile): void {
    file.rev = (file.rev ?? 0) + 1;
    file.updatedAt = Date.now();
    file.version = 1;
    this.writeJson(this.accountPath(file.account.uuid), file);
  }

  deleteAccount(uuid: string): void {
    try {
      fs.unlinkSync(this.accountPath(uuid));
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(this.usagePath(uuid));
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(this.lockPath(uuid));
    } catch {
      /* ignore */
    }
  }

  // --- usage files ---

  private usagePath(uuid: string): string {
    return path.join(this.sub("usage"), uuid + ".json");
  }

  readUsage(uuid: string): UsageFile | null {
    return this.readJson<UsageFile>(this.usagePath(uuid));
  }

  /**
   * Writes a usage file, but never regresses and never downgrades to older data.
   * All callers hold the per-account lock, so this read-modify-write is safe.
   *
   * - `rev` is always derived from what is on disk, so it can never run backwards.
   * - If the on-disk snapshot has a strictly newer `fetchedAt` than the incoming one,
   *   the on-disk snapshot is kept (a stale/empty snapshot can't clobber a fresh one);
   *   only `lastAttemptAt` advances. Equal `fetchedAt` (error/claim bookkeeping writes)
   *   still applies. Containers share one host clock, so `fetchedAt` is a safe key.
   */
  writeUsage(uuid: string, file: UsageFile): void {
    const current = this.readUsage(uuid);
    const keepCurrent =
      !!current && current.snapshot.fetchedAt > (file.snapshot?.fetchedAt ?? 0);
    const merged: UsageFile = {
      rev: (current?.rev ?? 0) + 1,
      updatedAt: Date.now(),
      lastAttemptAt: Math.max(current?.lastAttemptAt ?? 0, file.lastAttemptAt ?? 0),
      snapshot: keepCurrent ? current!.snapshot : file.snapshot,
    };
    this.writeJson(this.usagePath(uuid), merged);
  }

  // --- global 429 cooldown ---

  private cooldownPath(): string {
    return this.sub("cooldown.json");
  }

  cooldownUntil(): number {
    const c = this.readJson<{ cooldownUntil?: number }>(this.cooldownPath());
    return c?.cooldownUntil ?? 0;
  }

  setCooldownUntil(until: number): void {
    try {
      this.writeJson(this.cooldownPath(), { cooldownUntil: until });
    } catch {
      /* ignore */
    }
  }

  // --- presence / heartbeats ---

  private instancePath(instanceId: string): string {
    return path.join(this.sub("instances"), instanceId + ".json");
  }

  writeInstance(info: InstanceInfo): void {
    try {
      this.writeJson(this.instancePath(info.instanceId), info);
    } catch {
      /* ignore */
    }
  }

  removeInstance(instanceId: string): void {
    try {
      fs.unlinkSync(this.instancePath(instanceId));
    } catch {
      /* ignore */
    }
  }

  /** All non-stale instance records. Also opportunistically deletes stale ones. */
  listLiveInstances(now: number): InstanceInfo[] {
    const dir = this.sub("instances");
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const live: InstanceInfo[] = [];
    for (const f of files) {
      const info = this.readJson<InstanceInfo>(path.join(dir, f));
      if (!info) {
        continue;
      }
      if (now - info.heartbeatAt > INSTANCE_STALE_MS) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* raced with the owner recreating it — fine */
        }
        continue;
      }
      live.push(info);
    }
    return live;
  }

  // --- locking ---

  /** Runs `fn` while holding this account's lock. Returns undefined if not acquired. */
  withAccountLock<T>(uuid: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    return withLock(this.lockPath(uuid), fn);
  }

  // --- change detection ---

  /**
   * A cheap signature of the store's mutable state (account + usage file mtimes).
   * Callers compare it between ticks to decide whether to reload + refresh the UI.
   */
  revSignature(): string {
    const parts: string[] = [];
    for (const s of ["accounts", "usage"]) {
      const d = this.sub(s);
      let files: string[];
      try {
        files = fs.readdirSync(d).sort();
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(d, f));
          parts.push(`${s}/${f}:${st.mtimeMs}`);
        } catch {
          /* ignore */
        }
      }
    }
    return parts.join("|");
  }

  /** Watches the store dirs; `onChange` fires (debounced by the caller) on any change. */
  watch(onChange: () => void): fs.FSWatcher[] {
    const watchers: fs.FSWatcher[] = [];
    for (const s of ["accounts", "usage", "instances"]) {
      try {
        watchers.push(fs.watch(this.sub(s), { persistent: false }, () => onChange()));
      } catch {
        /* inotify may be unavailable on this mount — tick polling covers it */
      }
    }
    return watchers;
  }
}
