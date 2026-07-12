# Claude Multi-Account Switcher

Quickly switch between Claude accounts (subscriptions) in **Claude Code** inside VS Code,
with live usage limits — built to stay correct across **many windows and devcontainers running
at once**.

## Why

You have several Claude subscriptions and often many VS Code windows open (frequently in
devcontainers). When one account runs low on usage (5-hour or weekly window), switch Claude Code
to another with a single click — and let all your windows share one consistent, rate-limit-friendly
view of accounts and usage.

## Concepts

- **Account** — a Claude subscription identity (keyed by its account UUID). One account can hold
  several **credentials** (each `/login` creates an independent OAuth grant).
- **Pool** — the set of *idle* credentials that are not currently in use by any window.
- **Park** — move the credential currently live in this window into the pool and sign this window
  out. This frees the grant for other windows and lets you log in to a different account here.
- **Deploy / Switch** — take a parked credential out of the pool and make it live in this window.
  Switching = park the current one, then deploy the target.

The key safety rule: **a credential is live in exactly one window, or idle in the pool — never
both.** This makes the token collisions that used to cause wrong "active" indicators, failed saves,
and `invalid_grant` errors impossible by construction.

## Features

- **Park / switch** accounts from the panel, the status bar, or the command palette.
- **Multi-window coordination** — all windows sharing a store show the same accounts and the same
  usage, and they **take turns** polling so N windows don't multiply your request rate.
- **Correct "active" indicator** — each window derives its own active account locally; no window can
  mislabel another. Cards show how many credentials are **parked** and which windows an account is
  **in use** in.
- **Live usage limits** — 5-hour and weekly windows per account, with time-to-reset. A rate limit or
  error **never hides the last known numbers**; the footer honestly says how old they are.
- **Pause & auto-suspend** — pause updates for any account (`⏸`), and (optionally) auto-suspend an
  account after a 429 or a dead refresh token, with a **Retry** button. Suspended accounts keep
  showing their last usage.
- **Never touches Claude's live token** — the extension only *reads* the active window's access
  token for usage; it refreshes only credentials it exclusively owns in the pool.

## How it works

- Claude Code credentials live in `~/.claude/.credentials.json`. Deploying writes an account's
  tokens there; parking removes them. The extension also keeps `oauthAccount` in `~/.claude.json`
  consistent so the active account is identified correctly.
- **After switching, reload the VS Code window** so Claude Code picks up the new account — the
  extension offers to, or can auto-reload (setting).
- **Storage split:** token material stays in VS Code's encrypted **SecretStorage**, addressed by
  random ids. Everything else — account metadata, those ids, usage snapshots, locks, and presence —
  lives in a **shared folder** so windows can coordinate. Because a credential is only reachable via
  an id that exists in the folder, *secret sharing follows folder sharing*.
- Usage is read from the unofficial `api.anthropic.com/api/oauth/usage` endpoint (the same source as
  `/usage`). It is heavily rate-limited, so `pollIntervalSeconds` is a **group-wide** freshness
  target (240s default, min 180s) that all windows share, plus a manual ⟳.

### The shared folder

Resolved in this order:

1. `claudeSwitcher.sync.folder` (an absolute path), if set;
2. a `.claude-account-switcher` directory in your workspace, if it exists;
3. otherwise `account-switcher/` next to your credentials file (e.g. `~/.claude/account-switcher/`).

For the common devcontainer setup where `~/.claude` is already mounted into every container, option
3 means **it just works** — all your containers coordinate out of the box.

To share one store across workspaces that *don't* share a home, create one directory and
**symlink** `.claude-account-switcher` to it from each workspace. The symlink target must resolve to
the same real path inside each container (a shared mount). A `.gitignore` (`*`) is created
automatically so the folder is never committed.

Notes and limits:

- A store folder coordinates windows of **one machine** (the ids resolve against that machine's
  secret store). To coordinate **across machines**, use the sync server below.
- If no store is available (sync disabled, or the folder isn't writable), switching is disabled and
  the panel shows only the account currently logged in to this window, with its usage.

### The sync server (multi-machine)

Set `claudeSwitcher.sync.mode` to `server` to coordinate through a small self-hosted service
instead of a folder — this lets **multiple machines** share one account pool. See
[server/README.md](server/README.md) for running it (bare Python or `docker compose up`; data
persists in a volume; one SQLite file to back up).

- **End-to-end encrypted.** Token blobs are encrypted on your machine (AES-256-GCM) with a key
  derived from your passphrase (scrypt → HKDF); the server only ever stores ciphertext. A sibling
  derivation of the same passphrase is the login credential, so a wrong passphrase is a plain 401 —
  you cannot accidentally read or write someone else's pool.
- **Multi-user.** Each user id (e.g. your email) is an isolated pool. A team can share one pool by
  sharing the user id + passphrase.
- **Unlock once per machine.** `Claude: Unlock sync server…` asks for the passphrase (first time:
  offers to register), derives the keys, and stores only the derived keys in SecretStorage — the
  passphrase itself is never persisted. `Claude: Lock sync server` forgets them.
- **Folder import.** If a folder store with parked accounts is found while server mode is active,
  the extension offers to upload it (also available as `Claude: Migrate folder store to sync
  server…`). A successful upload stamps the folder with a `.migrated` marker so it can't be used
  accidentally afterwards; delete the marker to reactivate the folder.
- **Offline behavior.** If the server is unreachable, windows keep showing the last known state
  (marked as stale) and recover automatically; nothing is lost.

## Usage

1. Log in to Claude Code with account #1.
2. Open the **Claude Accounts** panel → **"⛁ Park current credential"**. Name the profile. This
   signs the window out so you can log in to another account.
3. Log in to account #2 (`/login`) and park it too.
4. Now **Switch** between them from any window. After confirmation the window reloads onto the
   selected account. Windows that share the store all see the same accounts and usage.

## Commands

| Command | Description |
| --- | --- |
| `Claude: Park current credential (sign out here)` | move the live credential into the pool + sign out |
| `Claude: Switch account` | park current, deploy the chosen account (QuickPick) |
| `Claude: Refresh usage limits` | force a refresh (clears an account's suspension) |
| `Claude: Pause/resume usage updates for account` | stop/resume automatic polling for one account |
| `Claude: Undo last switch` | switch back to the previously active account |
| `Claude: Remove / Rename account profile` | manage profiles |
| `Claude: Unlock sync server…` | enter the passphrase for server sync (registers on first use) |
| `Claude: Lock sync server (forget keys)` | drop the derived keys from this machine |
| `Claude: Migrate folder store to sync server…` | upload a folder store, then retire it (`.migrated`) |

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `claudeSwitcher.pollIntervalSeconds` | `240` | group-wide per-account freshness target (min 180) |
| `claudeSwitcher.autoSuspend` | `true` | auto-suspend an account after a 429 or dead token (until Retry) |
| `claudeSwitcher.sync.enabled` | `true` | coordinate via a shared store (off = local-only) |
| `claudeSwitcher.sync.mode` | `"folder"` | `folder` (one machine) or `server` (multi-machine) |
| `claudeSwitcher.sync.folder` | `""` | explicit shared-folder path (empty = auto-detect) |
| `claudeSwitcher.sync.server.url` | `""` | sync-server base URL (server mode) |
| `claudeSwitcher.sync.server.user` | `""` | your user id on the sync server (server mode) |
| `claudeSwitcher.autoReloadAfterSwitch` | `false` | auto-reload the window after switching |
| `claudeSwitcher.credentialsPath` | `""` | override the path to `.credentials.json` |
| `claudeSwitcher.warnThresholdPercent` | `80` | warning threshold (% → red bar) |

## Security and disclaimers

- OAuth tokens are stored only in VS Code's **encrypted `SecretStorage`** (folder mode) or
  **end-to-end encrypted on your own sync server** (server mode — the server never sees a key or a
  plaintext token). The shared folder holds only metadata, random ids, and usage — **no token
  material** — and is created with restrictive permissions (`0600`/`0700`).
- The extension never sends tokens anywhere except the official Anthropic endpoints, and never
  refreshes the token Claude Code is actively using in a window.
- This tool is for managing **your own** accounts.
- The usage endpoint and token-refresh flow are **unofficial** and may change.
- The file-based `.credentials.json` model is supported (Windows/Linux). The macOS Keychain is not
  supported yet.

## Upgrading from 0.1.x

On first launch, 0.1.x profiles are migrated automatically into the shared pool. The account you are
currently logged in to is recorded with its real identity (its live credential is left in place, not
parked); other saved profiles become entries whose identity is confirmed the first time they are
polled. The old per-profile storage is then cleared.

## Development

```bash
npm install
npm run watch       # build in watch mode
# press F5 in VS Code -> Extension Development Host
npm run typecheck          # type-check
npm run test:smoke         # pure-logic tests (locks, store, usage, credentials)
npm run test:server-smoke  # sync-server client layer against an in-memory fake server
npm run build:vsix         # build the .vsix package

# contract test: the same suite against the real Python server
(cd server && uv venv && uv pip install -e ".[test]" && .venv/bin/python -m pytest tests)
(cd server && CAS_DB_PATH=/tmp/cas.db CAS_PORT=18787 CAS_RATE_AUTH_PER_MIN=100000 \
  .venv/bin/python -m uvicorn --factory claude_switcher_sync.app:app_factory --port 18787 &) \
  && SERVER_URL=http://127.0.0.1:18787 npm run test:server-smoke
```

## License

MIT
