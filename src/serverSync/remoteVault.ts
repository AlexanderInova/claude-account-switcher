import { OAuthCreds } from "../types";
import { TokenVault, getVerifiedFrom } from "../secretVault";
import { decryptBlob, encryptBlob } from "./crypto";
import { RETRY_AGGRESSIVE, RETRY_STANDARD, SyncHttp } from "./http";

/**
 * TokenVault backed by the sync server. Blobs are AES-256-GCM-encrypted with the
 * unlocked encKey before they leave this machine; the server only ever sees
 * ciphertext. Semantics mirror SecretVault: get() returns null for a missing OR
 * undecryptable blob (both behave like today's "orphaned ref"), remove() is
 * best-effort, and put() throws if the write could not be confirmed — callers
 * treat a rotated token as lost-unless-persisted, so silence would be a lie.
 */
export class RemoteVault implements TokenVault {
  constructor(
    private readonly http: SyncHttp,
    private readonly encKeyHex: string
  ) {}

  async put(id: string, creds: OAuthCreds): Promise<void> {
    const blob = encryptBlob(this.encKeyHex, JSON.stringify(creds));
    const res = await this.http.request("PUT", `/v1/pool/secrets/${id}`, {
      body: { blob },
      retry: RETRY_AGGRESSIVE,
    });
    if (res.status !== 200) {
      throw new Error(`Secret write failed (HTTP ${res.status})`);
    }
  }

  async get(id: string): Promise<OAuthCreds | null> {
    let res;
    try {
      res = await this.http.request("GET", `/v1/pool/secrets/${id}`, { retry: RETRY_STANDARD });
    } catch {
      return null; // unreachable server reads like a missing secret; callers keep last state
    }
    if (res.status !== 200) {
      return null;
    }
    const blob = (res.json as { blob?: string } | null)?.blob;
    const plain = blob ? decryptBlob(this.encKeyHex, blob) : null;
    if (!plain) {
      return null;
    }
    try {
      return JSON.parse(plain) as OAuthCreds;
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.http.request("DELETE", `/v1/pool/secrets/${id}`, { retry: RETRY_STANDARD });
    } catch {
      /* best-effort, like SecretVault.remove */
    }
  }

  getVerified(id: string, expectedHash: string): Promise<OAuthCreds | null> {
    return getVerifiedFrom(this, id, expectedHash);
  }
}
