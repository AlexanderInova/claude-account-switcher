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

## 0.1.0

- Initial release.
- Save the currently logged-in Claude account as a profile (tokens stored in SecretStorage).
- Fast account switching (panel, status bar, QuickPick) by swapping `~/.claude/.credentials.json`,
  with a `.bak` backup and an undo command.
- Live usage limits (5-hour and weekly windows) from the `/api/oauth/usage` endpoint,
  with auto-refresh, backoff on 429, and manual refresh.
- Automatic refresh of expired tokens (refresh token flow).
