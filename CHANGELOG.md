# Changelog

## 0.2.0

Reworked for running many windows/devcontainers at once.

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

## 0.1.0

- Initial release.
- Save the currently logged-in Claude account as a profile (tokens stored in SecretStorage).
- Fast account switching (panel, status bar, QuickPick) by swapping `~/.claude/.credentials.json`,
  with a `.bak` backup and an undo command.
- Live usage limits (5-hour and weekly windows) from the `/api/oauth/usage` endpoint,
  with auto-refresh, backoff on 429, and manual refresh.
- Automatic refresh of expired tokens (refresh token flow).
