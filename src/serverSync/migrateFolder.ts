import * as fs from "fs";
import * as path from "path";
import { CredentialRef } from "../types";
import { SharedStore } from "../store";
import { TokenVault } from "../secretVault";
import { SyncStore } from "../syncStore";

const MARKER = ".migrated";

export interface MigratedMarker {
  migratedAt: number;
  serverUrl: string;
  userId: string;
}

export interface MigrationSummary {
  accounts: number;
  credentials: number;
  skippedDuplicates: number;
  orphanedRefs: number;
}

/**
 * A `.migrated` marker retires a folder store: its contents now live on a sync
 * server, and using the folder again would fork the pool (and hand out parked
 * refresh tokens that a server-side rotation may since have killed). Folder mode
 * refuses a marked folder; server mode uses its absence to offer an upload.
 */
export function readMigratedMarker(dir: string): MigratedMarker | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")) as MigratedMarker;
  } catch {
    return null;
  }
}

export function writeMigratedMarker(dir: string, info: MigratedMarker): void {
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(info, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** True when the folder holds accounts worth offering to upload. */
export function folderHasAccounts(dir: string): boolean {
  try {
    return fs.readdirSync(path.join(dir, "accounts")).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

/**
 * Uploads a folder store into the server pool. Safe to re-run: credentials are
 * deduped by refresh-token hash against what the server already has, and usage
 * uploads ride the server's monotonic merge. Per credential the blob is pushed
 * BEFORE its ref becomes visible (the blob-first invariant), so a crash mid-way
 * never publishes a ref whose token is unreachable. Leases are stripped — they
 * are per-window checkouts that mean nothing on a new backend.
 *
 * Does NOT write the marker itself; the caller stamps the folder only after a
 * fully successful run.
 */
export async function migrateFolderToServer(
  folder: SharedStore,
  localVault: TokenVault,
  server: SyncStore,
  remoteVault: TokenVault
): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    accounts: 0,
    credentials: 0,
    skippedDuplicates: 0,
    orphanedRefs: 0,
  };
  for (const file of folder.listAccounts()) {
    const uuid = file.account.uuid;
    const applied = await server.withAccountLock(uuid, async () => {
      const existing = server.readAccount(uuid);
      const target = existing ?? {
        version: 1 as const,
        rev: 0,
        updatedAt: 0,
        account: { ...file.account, suspended: undefined },
        credentials: [] as CredentialRef[],
      };
      const knownHashes = new Set(target.credentials.map((c) => c.refreshTokenHash));
      let added = 0;
      for (const ref of file.credentials) {
        if (knownHashes.has(ref.refreshTokenHash)) {
          summary.skippedDuplicates++;
          continue;
        }
        const creds = await localVault.get(ref.id);
        if (!creds) {
          summary.orphanedRefs++;
          continue;
        }
        await remoteVault.put(ref.id, creds); // blob first — throws on failure
        target.credentials.push({ ...ref, lease: undefined });
        knownHashes.add(ref.refreshTokenHash);
        added++;
      }
      if (!existing && added === 0 && file.credentials.length > 0) {
        // Every credential was orphaned — don't publish an empty husk.
        return false;
      }
      await server.writeAccount(target);
      summary.credentials += added;
      return true;
    });
    if (applied === undefined) {
      throw new Error(`Could not lock account "${file.account.label}" on the server.`);
    }
    if (!applied) {
      continue;
    }
    summary.accounts++;
    const usage = folder.readUsage(uuid);
    if (usage) {
      await server.writeUsage(uuid, usage);
    }
  }
  return summary;
}
