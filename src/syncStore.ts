import { AccountFile, InstanceInfo, UsageFile } from "./types";

/** Live instances whose heartbeat is older than this are considered dead. */
export const INSTANCE_STALE_MS = 90_000;

/** Anything watch() returns — an fs.FSWatcher satisfies this. */
export interface StoreWatcher {
  close(): void;
}

/**
 * The coordination-store seam. Two implementations:
 *  - `SharedStore` (store.ts): the original shared folder (fs-backed).
 *  - `ServerStore` (serverSync/serverStore.ts): a self-hosted sync server (HTTP-backed,
 *    reads served from a client-side cache kept fresh by a rev-poll).
 *
 * Reads are synchronous by contract; consumers call them freely from render paths.
 * Mutations are async. Inside `withAccountLock`, reads are guaranteed fresh: the
 * folder reads the fs directly, and the server impl installs the lock response's
 * account/usage docs into its cache before running the callback.
 */
export interface SyncStore {
  /** Display string for the UI footer (a path, or "server — user@url"). */
  readonly root: string;

  /** One-time setup (folder layout / initial snapshot). */
  init(): Promise<void>;

  // --- reads (synchronous; ServerStore serves deep clones from its cache) ---
  listAccountUuids(): string[];
  listAccounts(): AccountFile[];
  readAccount(uuid: string): AccountFile | null;
  readUsage(uuid: string): UsageFile | null;
  cooldownUntil(): number;
  listLiveInstances(now: number): InstanceInfo[];
  /** Cheap change signature; compared between ticks to decide whether to reload. */
  revSignature(): string;

  // --- mutations ---
  writeAccount(file: AccountFile): Promise<void>;
  deleteAccount(uuid: string): Promise<void>;
  writeUsage(uuid: string, file: UsageFile): Promise<void>;
  setCooldownUntil(until: number): Promise<void>;
  writeInstance(info: InstanceInfo): Promise<void>;
  removeInstance(instanceId: string): Promise<void>;

  // --- coordination ---
  /** Runs `fn` while holding this account's lock. Returns undefined if not acquired. */
  withAccountLock<T>(uuid: string, fn: () => T | Promise<T>): Promise<T | undefined>;
  /** Fires `onChange` (caller debounces) whenever shared state may have changed. */
  watch(onChange: () => void): StoreWatcher[];
}
