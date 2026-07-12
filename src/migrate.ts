import * as crypto from "crypto";
import * as vscode from "vscode";
import { CredentialsManager } from "./credentials";
import { IdentityManager } from "./identity";
import { SecretVault, refreshTokenHash } from "./secretVault";
import { SyncStore } from "./syncStore";
import { AccountFile, OAuthAccountInfo, OAuthCreds, UsageSnapshot } from "./types";

const OLD_PROFILES_KEY = "claudeSwitcher.profiles";
const OLD_ACTIVE_KEY = "claudeSwitcher.activeId";
const OLD_SECRET_PREFIX = "claudeSwitcher.account.";
const MIGRATED_KEY = "claudeSwitcher.migratedV2";

interface OldProfile {
  id: string;
  label: string;
  subscriptionType?: string;
  addedAt: number;
  order: number;
  lastUsage?: UsageSnapshot;
}

function accountFile(
  uuid: string,
  label: string,
  ident: OAuthAccountInfo | undefined,
  subscriptionType: string | undefined,
  order: number,
  provisional: boolean
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
      subscriptionType,
      updatesEnabled: true,
      provisional: provisional || undefined,
    },
    credentials: [],
  };
}

/**
 * One-time migration from the 0.1.x storage model (per-profile globalState +
 * per-id SecretStorage) to the shared credential pool. Convergent under concurrent
 * instances: credentials are deduped by refresh-token hash under per-account locks.
 *
 * The locally-live account is recorded with its real identity (from ~/.claude.json)
 * but its credential is NOT parked (it stays live). Other profiles become
 * provisional accounts whose identity is confirmed lazily on first successful poll.
 */
export async function migrateIfNeeded(
  context: vscode.ExtensionContext,
  store: SyncStore,
  vault: SecretVault,
  credentials: CredentialsManager,
  identity: IdentityManager
): Promise<void> {
  if (context.globalState.get<boolean>(MIGRATED_KEY)) {
    return;
  }
  const profiles = context.globalState.get<OldProfile[]>(OLD_PROFILES_KEY, []);
  if (!profiles || profiles.length === 0) {
    await context.globalState.update(MIGRATED_KEY, true);
    return;
  }

  const localCreds = credentials.readCurrent();
  const localIdent = identity.readLocalIdentity() ?? undefined;
  let order = store.listAccounts().length;

  for (const p of profiles) {
    let creds: OAuthCreds | null = null;
    try {
      const raw = await context.secrets.get(OLD_SECRET_PREFIX + p.id);
      if (raw) {
        creds = JSON.parse(raw) as OAuthCreds;
      }
    } catch {
      creds = null;
    }
    if (!creds) {
      continue;
    }
    const hash = refreshTokenHash(creds);
    const isLocalLive =
      !!localCreds &&
      (localCreds.accessToken === creds.accessToken ||
        localCreds.refreshToken === creds.refreshToken);

    if (isLocalLive) {
      const uuid = localIdent?.accountUuid ?? p.id;
      await store.withAccountLock(uuid, async () => {
        const file =
          store.readAccount(uuid) ??
          accountFile(uuid, p.label, localIdent, creds!.subscriptionType, order++, false);
        if (localIdent?.emailAddress) {
          file.account.email = localIdent.emailAddress;
        }
        if (creds!.subscriptionType) {
          file.account.subscriptionType = creds!.subscriptionType;
        }
        await store.writeAccount(file);
        // Seed usage only if the shared store has none yet — never clobber fresher data.
        if (p.lastUsage && !store.readUsage(uuid)) {
          await store.writeUsage(uuid, {
            rev: 0,
            updatedAt: 0,
            lastAttemptAt: 0,
            snapshot: p.lastUsage,
          });
        }
      });
      // Its live credential stays in .credentials.json — do not park it.
    } else {
      const uuid = p.id;
      const dup = store
        .listAccounts()
        .some((f) => f.credentials.some((c) => c.refreshTokenHash === hash));
      if (dup) {
        // Already imported by another instance's migration.
        try {
          await context.secrets.delete(OLD_SECRET_PREFIX + p.id);
        } catch {
          /* ignore */
        }
        continue;
      }
      const credId = crypto.randomUUID();
      await vault.put(credId, creds);
      await store.withAccountLock(uuid, async () => {
        const file =
          store.readAccount(uuid) ??
          accountFile(uuid, p.label, undefined, creds!.subscriptionType, order++, true);
        if (!file.credentials.some((c) => c.refreshTokenHash === hash)) {
          file.credentials.push({
            id: credId,
            addedAt: Date.now(),
            expiresAt: creds!.expiresAt,
            refreshTokenHash: hash,
            unverified: true,
          });
        }
        await store.writeAccount(file);
        if (p.lastUsage && !store.readUsage(uuid)) {
          await store.writeUsage(uuid, {
            rev: 0,
            updatedAt: 0,
            lastAttemptAt: 0,
            snapshot: p.lastUsage,
          });
        }
      });
    }

    try {
      await context.secrets.delete(OLD_SECRET_PREFIX + p.id);
    } catch {
      /* ignore */
    }
  }

  await context.globalState.update(OLD_PROFILES_KEY, undefined);
  await context.globalState.update(OLD_ACTIVE_KEY, undefined);
  await context.globalState.update(MIGRATED_KEY, true);
}
