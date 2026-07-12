/**
 * Small fetch wrapper for the sync server: base URL + auth headers, per-request
 * timeout, and declarative retry policies. Retries cover network errors,
 * timeouts, and 5xx; 429 waits for Retry-After. A 401 is never retried — it
 * means the stored keys are wrong (or the user was deleted) and is surfaced
 * once via onAuthFailure so the extension can flip to the "locked" state.
 */

export interface RetryPolicy {
  /** Delays (ms) between attempts; attempts = delays.length + 1. */
  delays: number[];
}

export const RETRY_NONE: RetryPolicy = { delays: [] };
export const RETRY_STANDARD: RetryPolicy = { delays: [500, 2000] };
/** Only for secret pushes, where a lost write means a dead single-use refresh token. */
export const RETRY_AGGRESSIVE: RetryPolicy = { delays: [500, 1000, 2000, 5000, 10_000] };

export interface SyncResponse {
  status: number;
  json: unknown;
}

export class SyncHttpError extends Error {}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class SyncHttp {
  private readonly base: string;
  private authFailed = false;

  constructor(
    baseUrl: string,
    private readonly userId: string,
    private readonly authKeyHex: string,
    private readonly onAuthFailure: () => void = () => {}
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Resolves with {status, json} for any HTTP response (including 4xx/5xx after
   * retries are exhausted); throws SyncHttpError only when the network itself
   * failed on every attempt.
   */
  async request(
    method: string,
    path: string,
    opts: { body?: unknown; timeoutMs?: number; retry?: RetryPolicy } = {}
  ): Promise<SyncResponse> {
    const retry = opts.retry ?? RETRY_NONE;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(this.base + path, {
          method,
          signal: ctl.signal,
          headers: {
            Authorization: "Bearer " + this.authKeyHex,
            "X-CAS-User": this.userId,
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        if (res.status === 401 && !this.authFailed) {
          this.authFailed = true;
          try {
            this.onAuthFailure();
          } catch {
            /* ignore */
          }
        }
        if (RETRYABLE.has(res.status) && attempt < retry.delays.length) {
          const after = Number(res.headers.get("retry-after"));
          const wait = res.status === 429 && after > 0 ? after * 1000 : retry.delays[attempt];
          await res.body?.cancel().catch(() => {});
          await sleep(wait);
          continue;
        }
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          /* 204s and error pages have no JSON body */
        }
        return { status: res.status, json };
      } catch (e) {
        lastError = e;
        if (attempt < retry.delays.length) {
          await sleep(retry.delays[attempt]);
          continue;
        }
        throw new SyncHttpError(
          `Sync server unreachable (${method} ${path}): ${(e as Error).message}`
        );
      } finally {
        clearTimeout(timer);
      }
    }
    // Unreachable, but keeps TS honest about the loop.
    throw new SyncHttpError(String(lastError));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
