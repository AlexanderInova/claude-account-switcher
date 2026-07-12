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
