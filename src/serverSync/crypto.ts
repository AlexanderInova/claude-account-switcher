import * as crypto from "crypto";

/**
 * Key derivation + blob encryption for the sync server. Pure node:crypto, no
 * native deps. The scheme:
 *
 *   masterKey = scrypt(passphrase, salt, 32)      salt: random, stored server-side
 *   encKey    = HKDF(masterKey, "cas-enc")        never leaves this machine
 *   authKey   = HKDF(masterKey, "cas-auth")       sent as Bearer; server stores sha256
 *
 * Only OAuth token blobs are encrypted (AES-256-GCM); the GCM tag doubles as an
 * integrity check, so a tampered or foreign-key blob decrypts to null, which the
 * callers already treat like an orphaned credential.
 */

const SCRYPT_N = 1 << 15;
const SCRYPT_OPTS: crypto.ScryptOptions = {
  N: SCRYPT_N,
  r: 8,
  p: 1,
  maxmem: 128 * SCRYPT_N * 8 * 2, // scrypt needs 128*N*r; default maxmem is exactly that
};

export interface DerivedKeys {
  /** AES-256-GCM key for secret blobs (hex). Never sent anywhere. */
  encKeyHex: string;
  /** Login credential (hex). The server stores only its sha256. */
  authKeyHex: string;
}

export function newSaltHex(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function deriveKeys(passphrase: string, saltHex: string): Promise<DerivedKeys> {
  const salt = Buffer.from(saltHex, "hex");
  const master = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, SCRYPT_OPTS, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
  const hkdf = (info: string): string =>
    Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), info, 32)).toString("hex");
  return { encKeyHex: hkdf("cas-enc"), authKeyHex: hkdf("cas-auth") };
}

/** What the server stores instead of the auth key: sha256 of its raw bytes, hex. */
export function verifierFromAuthKey(authKeyHex: string): string {
  return crypto.createHash("sha256").update(Buffer.from(authKeyHex, "hex")).digest("hex");
}

/** base64(nonce | ciphertext | tag) */
export function encryptBlob(encKeyHex: string, plaintext: string): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(encKeyHex, "hex"), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

/** null on any failure — wrong key, tampered blob, malformed input. */
export function decryptBlob(encKeyHex: string, blobB64: string): string | null {
  try {
    const raw = Buffer.from(blobB64, "base64");
    if (raw.length < 12 + 16) {
      return null;
    }
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(encKeyHex, "hex"), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
