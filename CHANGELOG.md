# Changelog

## 0.2.2

- **Sync server (multi-machine).** New opt-in `claudeSwitcher.sync.mode: "server"` coordinates
  through a small self-hosted service (see `server/` — FastAPI + SQLite, runs bare or via
  `docker compose up`, data in one volume-backed file) so **multiple machines** share one
  account pool. Multi-user: every user id is an isolated pool.
  - **End-to-end encrypted**: parked tokens are AES-256-GCM-encrypted on your machine with a
    key derived from your passphrase (scrypt → HKDF); the server only ever stores ciphertext.
    A sibling derivation is the login — a wrong passphrase is a plain 401, so nobody can
    accidentally read or write someone else's pool.
  - **Unlock once per machine**: `Claude: Unlock sync server…` (registers on first use; only
    derived keys are stored, never the passphrase). `Claude: Lock sync server` forgets them.
    The panel shows a clickable "🔒 server sync locked" hint until then.
  - **Graceful unavailability**: if the server is unreachable the panel shows
    "⚠ sync server unreachable — retrying…" with the age of the shown data, windows keep the
    last known state, polling skips cycles instead of erroring, and the connection recovers
    automatically (checked every ~5s). Rotated refresh tokens are journaled locally before
    any upload, so even a crash or outage mid-rotation can't lose a single-use token.
  - **Folder import**: in server mode the extension detects an existing shared folder with
    parked accounts and offers to upload it (`Claude: Migrate folder store to sync server…`
    does it on demand; re-running is safe). A successful upload stamps the folder with a
    `.migrated` marker; folder mode refuses a marked folder so the pool can't fork.
  - **Lean traffic**: each window costs ~16 requests/min (a 5s single-integer change poll,
    a 20s presence heartbeat, and locks only when an account is actually due) — dueness is
    pre-checked against the local cache before any lock, and pure keep-alive heartbeats
    don't invalidate other windows' caches. Instead of a raw access log (off by default,
    `CAS_ACCESS_LOG=1` re-enables it) the server logs **events**: registrations, account
    changes, windows joining/leaving/switching, secret writes (ids only), stolen locks,
    cooldowns, and auth/rate-limit failures (`CAS_LOG_LEVEL` to tune).

## 0.2.0

Reworked for running many windows/devcontainers at once.

- **Manual refresh now works for idle accounts.** Auto-polling never rotates an idle parked
  token (each refresh spends a single-use refresh token), so once such a token expired, even ⟳
  silently did nothing and the card froze. A manual ⟳ now mints a fresh token for an expired
  parked credential and fetches live usage (a dead grant is dropped, like "Test parked
  credentials" would). Cards that can't auto-update — idle everywhere with every parked token
  expired — show a **"stale"** badge explaining that ⟳ will update them.
- **Cards are ordered by usability.** This window's account first, then accounts in use in
  other windows (free before limit-reached), then available accounts (session limit not
  reached before reached, each sorted by soonest weekly reset), and finally manually paused,
  suspended, and credential-less accounts — collapsed into a "Paused & unavailable" section
  at the bottom (starts collapsed; the toggle is remembered).
- **Switch and Delete always confirm.** The credential picker now appears even when an
  account has a single parked credential, so a stray click on Switch (or Delete) can't
  change accounts or remove a credential without an explicit confirmation.

- **Choose which credential on Switch and Delete.** When an account has several parked
  credentials, switching now shows a picker listing each one with when it was parked, when it
  was last used to fetch usage, its expiry, and whether its token is actually reachable in the
  shared secret store (an instant local check — ⚠ flags an orphaned reference). Deleting shows
  a multi-select list so you can remove just some credentials (or all) instead of the whole
  pool. Accounts with a single credential switch/delete with no extra prompt, as before.

- **Fixed "Switch" silently doing nothing.** When `~/.claude/.credentials.json` (or `~/.claude.json`)
  is a bind-mounted single file, the atomic `rename`-based write can't replace the mount point and
  threw — aborting the switch with no feedback. Writes now fall back to an in-place write when a
  rename isn't possible, and the Switch command surfaces any error instead of failing silently.
- **Fixed "Stored credential is unavailable" on Switch.** A parked credential's shared ref-hash could
  drift from its stored token; the deploy required them to match and refused. Deploy now trusts the
  stored token (which is always written before the ref-hash, so it's authoritative). If the token is
  genuinely missing, the orphaned entry is removed with a clear "re-park it" message instead of a dead
  button. "Test parked credentials" now also detects and drops **orphaned** entries (missing token),
  reported separately from invalid ones. Idle parked spares are no longer refreshed/rotated just to
  poll usage (that churn was the source of the drift). Added a "Debug — Inspect parked credentials"
  action that shows, per credential, whether its token is present and its hash matches.

- **Credential pool model.** Accounts and credentials are now separate: an account can hold several
  credentials, which are either *live* in one window or *parked* (idle) in a shared pool — never
  both. "Save current account" became **Park current credential** (moves the live credential into
  the pool and signs the window out); switching parks the current credential and deploys the target.
  This makes cross-window token collisions impossible by construction.
- **Shared coordination folder.** Account metadata, usage snapshots, per-account locks, and instance
  presence live in a shared folder (`claudeSwitcher.sync.folder`, else a workspace
  `.claude-account-switcher`, else `~/.claude/account-switcher/`). Token material stays in encrypted
  SecretStorage, addressed by random ids that only exist in the folder — so secret sharing follows
  folder sharing. A `.gitignore` is created automatically.
- **Coordinated polling.** Windows take turns polling each account under a per-account lock, so N
  windows no longer multiply the request rate. `pollIntervalSeconds` is now a group-wide freshness
  target.
- **Correct active indicator.** Each window derives its active account locally (from
  `~/.claude.json` + the credentials file); no window can mislabel another. Cards show parked-credential
  counts and which windows an account is in use in.
- **Errors never hide usage.** A 429 or fetch error keeps the last known numbers and reports how old
  they are, instead of blanking the card.
- **Pause & auto-suspend.** Pause updates per account; optionally auto-suspend after a 429 or an
  invalid/expired refresh token (`claudeSwitcher.autoSuspend`, on by default), with a Retry button.
- **Never refreshes Claude's live token.** The active window's token is only read for usage; the
  extension refreshes only credentials it exclusively owns.
- **Removed** the `.bak` undo mechanism (undo is now "switch back") and the old per-profile
  globalState storage (migrated automatically on first launch).
- **Usage for the account currently in use.** The account logged in to a window is auto-registered
  (metadata only; its live credential is not parked) so its usage is polled and it appears as a card
  in every window. If its identity can't be determined, a display-only "unsaved" card still shows
  its usage, with a **Park to save** action.
- **Smarter delete.** Deleting the active account now asks whether to remove the credential live in
  this window (signs out here) or the parked ones (only asked when parked credentials exist), each
  behind a confirmation. Deleting the local credential no longer silently reappears on the next poll.
- **UI polish.** The active account is always listed first, and usage bars use a neutral track so the
  green/amber/red fill stays legible in both light and dark themes. Relative times (resets, last
  update) now have tooltips showing the absolute local time.
- **Pause polling at 100%.** When an account's 5h session or 7d weekly window hits 100%, automatic
  refreshing stops until that window resets (there is nothing new to learn until then), saving API
  calls. The footer shows "⏸ paused until reset"; a manual ⟳ still refreshes.
- **Test parked credentials.** A new command (and 🧪 toolbar button) "Test parked credentials (drop
  invalid)" probes every parked credential and permanently removes the ones that are definitively
  invalid (401/403 on use, or `invalid_grant` on refresh). Transient failures (429/network/5xx) are
  never dropped; it stops early on a rate limit and never touches the credential in use in this window.
- **Status bar shows the weekly limit too.** The active account now displays both the 5h session and
  the weekly usage (e.g. `2% | 44%`), and the status bar turns amber when *either* crosses the warning
  threshold — so an account that's free on 5h but exhausted weekly no longer looks available.
- **Fixed stale usage flicker.** Concurrent windows could momentarily overwrite an account's usage
  with an older or empty snapshot (the file's revision could even run backwards), so wrong/earlier
  values appeared until the next refresh. Usage writes are now monotonic — an older or empty snapshot
  never replaces a fresher one and the revision never regresses. Foregrounding a window now also
  reconciles immediately instead of showing a stale cached view, and migration never overwrites
  newer shared usage.

## 0.1.0

- Initial release.
- Save the currently logged-in Claude account as a profile (tokens stored in SecretStorage).
- Fast account switching (panel, status bar, QuickPick) by swapping `~/.claude/.credentials.json`,
  with a `.bak` backup and an undo command.
- Live usage limits (5-hour and weekly windows) from the `/api/oauth/usage` endpoint,
  with auto-refresh, backoff on 429, and manual refresh.
- Automatic refresh of expired tokens (refresh token flow).
