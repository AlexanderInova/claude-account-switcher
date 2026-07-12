import * as crypto from "crypto";
import { OAuthCreds } from "./types";

/**
 * Passive, encrypted token store addressed by opaque random ids.
 *
 * Token material lives here (VS Code SecretStorage), never in the shared folder.
 * The shared folder holds only the ids and a hash of each refresh token, so a
 * credential is only reachable by someone who can read the folder — secret
 * sharing therefore follows folder sharing, even though SecretStorage is
 * machine-wide. We never enumerate secrets; ownership is decided by the folder.
 */

const PREFIX = "claudeSwitcher.cred.";

/** Non-secret fingerprint of a refresh token — used for dedupe + staleness checks. */
export function refreshTokenHash(creds: OAuthCreds): string {
  return crypto.createHash("sha256").update(creds.refreshToken).digest("hex").slice(0, 16);
}

/** Minimal shape of vscode.SecretStorage (so this module is testable without vscode). */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

/**
 * The token-store seam. `SecretVault` keeps blobs in machine-local SecretStorage
 * (folder sync); `RemoteVault` (serverSync/remoteVault.ts) keeps them E2E-encrypted
 * on the sync server so every machine can reach them.
 */
export interface TokenVault {
  put(id: string, creds: OAuthCreds): Promise<void>;
  get(id: string): Promise<OAuthCreds | null>;
  remove(id: string): Promise<void>;
  getVerified(id: string, expectedHash: string): Promise<OAuthCreds | null>;
}

/**
 * Reads a credential and checks it still matches the reference's hash.
 * Secret propagation is eventually consistent (cross-window SecretStorage, or a
 * just-pushed server blob), so on mismatch we retry once before giving up.
 */
export async function getVerifiedFrom(
  vault: Pick<TokenVault, "get">,
  id: string,
  expectedHash: string
): Promise<OAuthCreds | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const creds = await vault.get(id);
    if (creds && refreshTokenHash(creds) === expectedHash) {
      return creds;
    }
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return null;
}

export class SecretVault implements TokenVault {
  constructor(private readonly secrets: SecretStorageLike) {}

  async put(id: string, creds: OAuthCreds): Promise<void> {
    await this.secrets.store(PREFIX + id, JSON.stringify(creds));
  }

  async get(id: string): Promise<OAuthCreds | null> {
    const raw = await this.secrets.get(PREFIX + id);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as OAuthCreds;
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.secrets.delete(PREFIX + id);
    } catch {
      /* ignore */
    }
  }

  getVerified(id: string, expectedHash: string): Promise<OAuthCreds | null> {
    return getVerifiedFrom(this, id, expectedHash);
  }
}
