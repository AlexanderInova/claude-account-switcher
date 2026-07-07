/**
 * Raw structure stored in ~/.claude/.credentials.json
 * { "claudeAiOauth": { ... } }
 */
export interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the accessToken expires */
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface CredentialsFile {
  claudeAiOauth: OAuthCreds;
  [key: string]: unknown;
}

/** The `oauthAccount` object inside ~/.claude.json — identifies the logged-in account. */
export interface OAuthAccountInfo {
  accountUuid: string;
  emailAddress?: string;
  organizationUuid?: string;
  organizationName?: string;
}

/** A single usage window (5h / weekly / opus, etc.) normalized for the UI. */
export interface UsageWindow {
  kind: string;
  label: string;
  /** 0-100 */
  percent: number;
  severity: string;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  /** time of the last *successful* fetch — preserved across errors so "updated X ago" stays honest */
  fetchedAt: number;
  windows: UsageWindow[];
  /** convenience shortcuts for the UI */
  sessionPercent: number | null;
  weeklyPercent: number | null;
  /** set when the last attempt failed (previous data is kept) */
  error?: string;
  /** when the last error happened (epoch ms) */
  errorAt?: number;
  /** earliest time a retry is allowed (epoch ms) — backoff on 429 */
  retryAfter?: number;
  /**
   * When a tracked window (5h session or 7d weekly) is at 100%, the earliest reset
   * time (epoch ms) among those maxed windows. Automatic polling pauses until then —
   * there is nothing new to learn until the limit resets. Manual refresh still works.
   */
  cappedUntil?: number;
}

/** Why an account's automatic updates are currently suspended. */
export interface Suspension {
  at: number;
  reason: "rate-limit" | "invalid-grant";
  detail?: string;
}

/** A temporary exclusive checkout of a parked credential for polling. */
export interface Lease {
  instanceId: string;
  at: number;
}

/**
 * A parked-credential *reference*. The token material itself lives in the secret
 * vault under `claudeSwitcher.cred.<id>`; this record (in the shared folder) carries
 * only non-secret bookkeeping and acts as the ownership/coordination record.
 */
export interface CredentialRef {
  /** random uuid; also the secret-vault key suffix */
  id: string;
  addedAt: number;
  lastUsedAt?: number;
  /** access-token expiry (non-secret) so the poller can decide without reading the secret */
  expiresAt: number;
  /** sha256 prefix of the refresh token — dedupe + staleness check against the vault */
  refreshTokenHash: string;
  /** migrated from the old storage model, identity/liveness not yet proven */
  unverified?: boolean;
  /** the grant is dead (refresh returned invalid_grant); kept visible until removed */
  invalid?: { at: number; detail: string };
  /** exclusive checkout for polling (stale leases are reclaimable) */
  lease?: Lease;
}

/** Account metadata (no secrets). Persisted to accounts/<uuid>.json. */
export interface AccountMeta {
  /** accountUuid from oauthAccount (or a provisional id until identity is learned) */
  uuid: string;
  email?: string;
  label: string;
  order: number;
  addedAt: number;
  subscriptionType?: string;
  /** issue 4 — automatic usage updates for this account (travels with the account) */
  updatesEnabled: boolean;
  /** issues 5 & 7 — automatic updates suspended after a 429 or a dead refresh token */
  suspended?: Suspension;
  /** true while this uuid is provisional (identity not yet resolved) */
  provisional?: boolean;
}

/** One account file in the shared store: metadata + its parked credential references. */
export interface AccountFile {
  version: 1;
  rev: number;
  updatedAt: number;
  account: AccountMeta;
  credentials: CredentialRef[];
}

/** One usage file in the shared store. */
export interface UsageFile {
  rev: number;
  updatedAt: number;
  snapshot: UsageSnapshot;
  lastAttemptAt: number;
}

/** Presence/heartbeat record written by each running extension instance. */
export interface InstanceInfo {
  instanceId: string;
  hostname: string;
  pid: number;
  workspaceName: string;
  /** the account this instance currently has deployed locally (if known) */
  activeAccountUuid?: string;
  startedAt: number;
  heartbeatAt: number;
}

/** Assembled, render-ready view of an account (built by AccountStore). */
export interface AccountView {
  uuid: string;
  email?: string;
  label: string;
  order: number;
  subscriptionType?: string;
  updatesEnabled: boolean;
  suspended?: Suspension;
  /** usable parked credentials (present, not invalid) */
  parkedCount: number;
  /** parked credentials whose grant is dead */
  invalidCount: number;
  lastUsage?: UsageSnapshot;
  /** active in *this* instance */
  isActive: boolean;
  /** workspace names of other live instances where this account is deployed */
  inUseByOthers: string[];
  /**
   * A display-only card for a local login not backed by a stored account (identity
   * unknown, or no shared store). Usage shows, but switch/rename/remove/pause don't.
   */
  ephemeral?: boolean;
}
