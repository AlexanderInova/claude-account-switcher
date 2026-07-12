# Claude Account Switcher — Sync Server

A small self-hosted server that lets the [Claude Multi-Account Switcher](../README.md)
VS Code extension share its account/credential pool across **multiple machines** (the
default shared-folder sync only reaches containers/windows on one host).

## Security model (what the server can and cannot see)

- **End-to-end encrypted secrets.** OAuth token blobs are encrypted client-side
  (AES-256-GCM) with a key derived from your passphrase (scrypt → HKDF). The server
  stores only ciphertext and can never decrypt it.
- **Derived login.** A sibling derivation of the same passphrase is the auth key
  (`Authorization: Bearer …`); the server stores only its sha256. Wrong passphrase =
  401 — that's the guard against accidentally writing into someone else's pool.
  The passphrase itself never leaves the extension.
- **Plaintext metadata.** Account labels/emails, usage percentages, credential
  references (ids + refresh-token hashes), and window presence are stored as plain
  JSON, namespaced per user. Nothing in them lets the server (or another user) use
  your accounts.
- **Multi-user.** Every user's pool is fully isolated. Set `CAS_REGISTRATION_TOKEN`
  to gate who can register.
- **TLS**: run behind a reverse proxy (Caddy, nginx) for HTTPS. Even over plain HTTP
  the token material stays encrypted; what TLS additionally protects is the bearer
  key (whose theft would allow metadata tampering, not token theft).

## Run with Docker

```bash
cd server
docker compose up -d          # data persists in the named volume `cas-data`
```

Or without compose (an anonymous volume still keeps the data):

```bash
docker build -t claude-switcher-sync .
docker run -d -p 8787:8787 -v cas-data:/data claude-switcher-sync
```

## Run bare

```bash
cd server
pip install .
CAS_DB_PATH=./dev.db claude-switcher-sync
# or: uvicorn --factory claude_switcher_sync.app:app_factory --port 8787
```

Interactive API docs at `http://localhost:8787/docs`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CAS_DB_PATH` | `/data/switcher.db` | SQLite file (backup = copy this one file) |
| `CAS_HOST` / `CAS_PORT` | `0.0.0.0` / `8787` | Bind address |
| `CAS_REGISTRATION_TOKEN` | *(empty = open)* | Require this token to register new users |
| `CAS_RATE_AUTH_PER_MIN` | `600` | Per-user request limit (~16 req/min per open window) |
| `CAS_RATE_UNAUTH_PER_MIN` | `10` | Per-IP limit for register/salt lookups |
| `CAS_ACCESS_LOG` | `0` | Set `1` to log every request (noisy: clients poll every 5s) |
| `CAS_LOG_LEVEL` | `INFO` | Event-log level (`DEBUG` adds usage writes + lock cycles) |

## Logging

By default the server logs **events, not requests**: startup config, registrations,
account writes that changed something (park/deploy/rename/delete — lease bookkeeping is
`DEBUG`), windows joining/leaving/switching accounts (keep-alive heartbeats are silent),
secret stores/deletes (ids and ciphertext size only — never content), stolen locks (a
window died mid-operation), Anthropic-429 cooldowns, and — at `WARNING` — auth failures
and rate-limit hits. `CAS_LOG_LEVEL=DEBUG` shows the full lock/usage churn;
`CAS_ACCESS_LOG=1` additionally re-enables uvicorn's raw request log.

## Publishing the image

```bash
cd server
docker build -t claude-switcher-sync:0.2.2 .          # keep the tag = pyproject version

# Docker Hub
docker tag claude-switcher-sync:0.2.2 YOURUSER/claude-switcher-sync:0.2.2
docker tag claude-switcher-sync:0.2.2 YOURUSER/claude-switcher-sync:latest
docker login
docker push YOURUSER/claude-switcher-sync:0.2.2
docker push YOURUSER/claude-switcher-sync:latest

# GitHub Container Registry (PAT needs the write:packages scope)
docker tag claude-switcher-sync:0.2.2 ghcr.io/YOURUSER/claude-switcher-sync:0.2.2
echo "$GITHUB_PAT" | docker login ghcr.io -u YOURUSER --password-stdin
docker push ghcr.io/YOURUSER/claude-switcher-sync:0.2.2

# Multi-arch (amd64 + arm64 — e.g. to run on a Pi/NAS), builds and pushes in one step:
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/YOURUSER/claude-switcher-sync:0.2.2 --push .
```

Machines that consume the published image use `image:` instead of `build:` in
`docker-compose.yml` (see the commented line there).

## Using it from VS Code

1. Set `claudeSwitcher.sync.mode` to `server`, `claudeSwitcher.sync.server.url` to the
   server address, and `claudeSwitcher.sync.server.user` to your user id (e.g. your
   email).
2. Run **Claude: Unlock sync server…** and enter your passphrase (first time: it
   offers to register the user).
3. If you were using folder sync before, the extension detects the existing folder and
   offers to upload it; afterwards the folder is stamped with a `.migrated` marker so
   it can't be used accidentally. **Claude: Migrate folder store to sync server…**
   does the same on demand.

## Development

```bash
cd server
uv venv && uv pip install -e ".[test]"
.venv/bin/python -m pytest tests
```
