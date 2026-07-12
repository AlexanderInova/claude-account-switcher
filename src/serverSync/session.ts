import { SecretStorageLike } from "../secretVault";
import { DerivedKeys, deriveKeys, newSaltHex, verifierFromAuthKey } from "./crypto";

const SESSION_KEY = "claudeSwitcher.server.session";

/**
 * The unlocked sync-server session, persisted in machine-local SecretStorage so
 * each machine unlocks once. Holds only DERIVED keys — never the passphrase.
 */
export interface ServerSession extends DerivedKeys {
  url: string;
  userId: string;
}

export async function loadSession(secrets: SecretStorageLike): Promise<ServerSession | null> {
  const raw = await secrets.get(SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    const s = JSON.parse(raw) as ServerSession;
    return s.url && s.userId && s.encKeyHex && s.authKeyHex ? s : null;
  } catch {
    return null;
  }
}

export async function saveSession(secrets: SecretStorageLike, s: ServerSession): Promise<void> {
  await secrets.store(SESSION_KEY, JSON.stringify(s));
}

export async function clearSession(secrets: SecretStorageLike): Promise<void> {
  try {
    await secrets.delete(SESSION_KEY);
  } catch {
    /* best-effort */
  }
}

export type UnlockResult =
  | { ok: true; session: ServerSession; registered: boolean }
  | { ok: false; error: string; needsRegistration?: boolean; needsToken?: boolean };

/**
 * Pure (UI-free) unlock: fetch the user's salt, derive keys, verify them with an
 * authenticated probe. `register` controls the 404 path: when true, a new user is
 * created with a fresh random salt (optionally gated by a registration token).
 * The extension command wraps this with input boxes.
 */
export async function unlock(
  url: string,
  userId: string,
  passphrase: string,
  opts: { register?: boolean; registrationToken?: string } = {}
): Promise<UnlockResult> {
  const base = url.replace(/\/+$/, "");
  let saltHex: string;
  let registered = false;
  try {
    const saltRes = await fetch(`${base}/v1/users/${encodeURIComponent(userId)}/salt`);
    if (saltRes.status === 404) {
      if (!opts.register) {
        return { ok: false, error: "Unknown user on this server.", needsRegistration: true };
      }
      saltHex = newSaltHex();
      const keys = await deriveKeys(passphrase, saltHex);
      const reg = await fetch(`${base}/v1/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          saltHex,
          verifierSha256: verifierFromAuthKey(keys.authKeyHex),
          ...(opts.registrationToken ? { registrationToken: opts.registrationToken } : {}),
        }),
      });
      if (reg.status === 403) {
        return { ok: false, error: "This server requires a registration token.", needsToken: true };
      }
      if (reg.status === 409) {
        // Someone registered this id concurrently — fall through to a normal unlock.
        return unlock(url, userId, passphrase);
      }
      if (reg.status !== 201) {
        return { ok: false, error: `Registration failed (HTTP ${reg.status}).` };
      }
      registered = true;
      return { ok: true, session: { url: base, userId, ...keys }, registered };
    }
    if (!saltRes.ok) {
      return { ok: false, error: `Salt lookup failed (HTTP ${saltRes.status}).` };
    }
    saltHex = ((await saltRes.json()) as { saltHex: string }).saltHex;
  } catch (e) {
    return { ok: false, error: `Server unreachable: ${(e as Error).message}` };
  }

  const keys = await deriveKeys(passphrase, saltHex);
  // Authenticated probe — a wrong passphrase is a 401 here, which is exactly the
  // accidental-takeover guard: you cannot see or touch a pool you can't unlock.
  try {
    const probe = await fetch(`${base}/v1/pool/rev`, {
      headers: { Authorization: "Bearer " + keys.authKeyHex, "X-CAS-User": userId },
    });
    if (probe.status === 401) {
      return { ok: false, error: "Wrong passphrase for this user." };
    }
    if (!probe.ok) {
      return { ok: false, error: `Server error (HTTP ${probe.status}).` };
    }
  } catch (e) {
    return { ok: false, error: `Server unreachable: ${(e as Error).message}` };
  }
  return { ok: true, session: { url: base, userId, ...keys }, registered };
}
