import { OAuthCreds } from "../types";
import { SecretStorageLike, TokenVault } from "../secretVault";

const SECRET_PREFIX = "claudeSwitcher.pendingRotation.";
const INDEX_KEY = "claudeSwitcher.pendingRotations";

/** Minimal shape of vscode.Memento (testable without vscode). */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/**
 * Write-ahead journal for rotated refresh tokens (server mode only).
 *
 * Refresh tokens are single-use: the moment TokenRefresher.refresh() succeeds,
 * the old token is dead and the new one exists only in process memory. In folder
 * mode the following vault.put is machine-local and near-certain; in server mode
 * it's an HTTP write that can fail. So rotation sites journal the fresh creds
 * into machine-local SecretStorage FIRST (cannot meaningfully fail), then push;
 * a crash or outage between the two is healed by retryPending() — called on
 * activation and on every poller tick while entries exist. Pushes are idempotent,
 * so double-delivery is harmless.
 *
 * The journal is deliberately per-machine: only the machine that performed the
 * rotation holds the new token.
 */
export class RotationRecovery {
  constructor(
    private readonly secrets: SecretStorageLike | null,
    private readonly state: MementoLike | null
  ) {}

  /** Inert instance for folder mode. */
  static noop(): RotationRecovery {
    return new RotationRecovery(null, null);
  }

  pendingIds(): string[] {
    return this.state?.get<string[]>(INDEX_KEY, []) ?? [];
  }

  async journal(credId: string, creds: OAuthCreds): Promise<void> {
    if (!this.secrets || !this.state) {
      return;
    }
    await this.secrets.store(SECRET_PREFIX + credId, JSON.stringify(creds));
    const ids = this.pendingIds();
    if (!ids.includes(credId)) {
      await this.state.update(INDEX_KEY, [...ids, credId]);
    }
  }

  async clear(credId: string): Promise<void> {
    if (!this.secrets || !this.state) {
      return;
    }
    await this.state.update(
      INDEX_KEY,
      this.pendingIds().filter((id) => id !== credId)
    );
    try {
      await this.secrets.delete(SECRET_PREFIX + credId);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Re-pushes journaled rotations. Failures are swallowed — the next tick
   * retries. Returns how many entries were successfully flushed.
   */
  async retryPending(vault: TokenVault): Promise<number> {
    let flushed = 0;
    for (const credId of this.pendingIds()) {
      const raw = this.secrets ? await this.secrets.get(SECRET_PREFIX + credId) : undefined;
      if (!raw) {
        await this.clear(credId); // index entry without a secret — nothing to push
        continue;
      }
      try {
        await vault.put(credId, JSON.parse(raw) as OAuthCreds);
        await this.clear(credId);
        flushed++;
      } catch {
        /* server still unreachable — keep the journal entry */
      }
    }
    return flushed;
  }
}
