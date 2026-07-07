import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";

/**
 * Cross-process advisory lock built on atomic O_EXCL file creation.
 *
 * A lock is a small file created with the `wx` flag (fails if it exists). The
 * holder writes `{owner, at}` inside. Staleness is judged by the file's **mtime**
 * (kernel clock — immune to wall-clock skew between containers), never by pid,
 * which is meaningless across containers. Locks are held only for the duration of
 * a fast read-modify-write, never across network calls.
 */

const STALE_MS = 10_000;
const RETRY_MS = 50;
const MAX_WAIT_MS = 2_000;

export interface LockHandle {
  path: string;
  owner: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newOwner(): string {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Tries to acquire the lock, retrying for up to ~2s and stealing locks whose
 * file mtime is older than STALE_MS. Returns null if it could not be acquired.
 */
export async function acquireLock(lockPath: string): Promise<LockHandle | null> {
  const owner = newOwner();
  const deadline = Date.now() + MAX_WAIT_MS;

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ owner, at: Date.now() }));
      fs.closeSync(fd);
      return { path: lockPath, owner };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        // Lock directory missing or unwritable — treat as "cannot lock".
        return null;
      }
      // The lock exists. Steal it if it is stale.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          // Rare steal race: two stealers may both unlink then one wins the wx
          // create; the loser loops. Worst case is a duplicate poll, never data loss.
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* someone else got it first */
          }
          continue;
        }
      } catch {
        // Lock vanished between open and stat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        return null;
      }
      await sleep(RETRY_MS);
    }
  }
}

/** Releases a lock, but only if we still own it (never delete a stolen lock). */
export function releaseLock(handle: LockHandle): void {
  try {
    const raw = fs.readFileSync(handle.path, "utf8");
    const data = JSON.parse(raw) as { owner?: string };
    if (data.owner !== handle.owner) {
      return;
    }
  } catch {
    /* unreadable/gone — fall through and best-effort remove */
  }
  try {
    fs.unlinkSync(handle.path);
  } catch {
    /* ignore */
  }
}

/**
 * Runs `fn` while holding `lockPath`. Returns `fn`'s result, or `undefined` if the
 * lock could not be acquired (caller should skip this cycle).
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>
): Promise<T | undefined> {
  const handle = await acquireLock(lockPath);
  if (!handle) {
    return undefined;
  }
  try {
    return await fn();
  } finally {
    releaseLock(handle);
  }
}

export const LOCK_CONSTANTS = { STALE_MS, RETRY_MS, MAX_WAIT_MS };
