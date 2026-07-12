"""SQLite persistence.

One short-lived connection per operation (embedded DB, low QPS) with WAL and a
busy timeout, so concurrent uvicorn workers/threads serialize cleanly. Every
mutation of accounts/usage/instances/cooldown bumps the owning user's pool
revision inside the same transaction — the clients' cheap change-detection
signal. Secrets deliberately do NOT bump it (secret changes never trigger a UI
refresh, mirroring the folder backend where the vault lives outside the
watched folder).

All timestamps are epoch milliseconds from the server clock.
"""

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Iterator, Optional

INSTANCE_STALE_MS = 90_000
LOCK_MAX_TTL_MS = 60_000
LOCK_DEFAULT_TTL_MS = 30_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    salt_hex TEXT NOT NULL,
    verifier_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_rev (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    rev INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS accounts (
    user_id TEXT NOT NULL,
    uuid TEXT NOT NULL,
    doc TEXT NOT NULL,
    rev INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, uuid)
);
CREATE TABLE IF NOT EXISTS usage (
    user_id TEXT NOT NULL,
    uuid TEXT NOT NULL,
    doc TEXT NOT NULL,
    rev INTEGER NOT NULL,
    snapshot_fetched_at INTEGER NOT NULL,
    last_attempt_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, uuid)
);
CREATE TABLE IF NOT EXISTS instances (
    user_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    doc TEXT NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, instance_id)
);
CREATE TABLE IF NOT EXISTS cooldown (
    user_id TEXT PRIMARY KEY,
    until_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
    user_id TEXT NOT NULL,
    uuid TEXT NOT NULL,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, uuid)
);
CREATE TABLE IF NOT EXISTS secrets (
    user_id TEXT NOT NULL,
    cred_id TEXT NOT NULL,
    blob TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, cred_id)
);
"""


def now_ms() -> int:
    return int(time.time() * 1000)


class Database:
    def __init__(self, path: str):
        self.path = path
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        with self._tx() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            with conn:  # one transaction per operation
                yield conn
        finally:
            conn.close()

    # --- users ---

    def create_user(self, user_id: str, salt_hex: str, verifier_sha256: str) -> bool:
        """Returns False if the user already exists."""
        with self._tx() as c:
            try:
                c.execute(
                    "INSERT INTO users(id, salt_hex, verifier_sha256, created_at) VALUES(?,?,?,?)",
                    (user_id, salt_hex, verifier_sha256, now_ms()),
                )
                c.execute("INSERT INTO pool_rev(user_id, rev) VALUES(?, 0)", (user_id,))
            except sqlite3.IntegrityError:
                return False
        return True

    def get_user(self, user_id: str) -> Optional[dict]:
        with self._tx() as c:
            row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None

    # --- pool revision ---

    @staticmethod
    def _bump_rev(c: sqlite3.Connection, user_id: str) -> int:
        c.execute("UPDATE pool_rev SET rev = rev + 1 WHERE user_id = ?", (user_id,))
        row = c.execute("SELECT rev FROM pool_rev WHERE user_id = ?", (user_id,)).fetchone()
        return int(row["rev"]) if row else 0

    def pool_rev(self, user_id: str) -> int:
        with self._tx() as c:
            row = c.execute("SELECT rev FROM pool_rev WHERE user_id = ?", (user_id,)).fetchone()
        return int(row["rev"]) if row else 0

    # --- accounts ---

    def put_account(
        self, user_id: str, uuid: str, doc: dict
    ) -> tuple[int, dict, Optional[dict]]:
        """Stores the doc; the server owns `rev`/`updatedAt`/`version`.

        Also returns the previous doc (None on create) so the route can tell a
        meaningful change (park/deploy/rename) from lease bookkeeping when logging.
        """
        with self._tx() as c:
            row = c.execute(
                "SELECT rev, doc FROM accounts WHERE user_id = ? AND uuid = ?", (user_id, uuid)
            ).fetchone()
            prev = json.loads(row["doc"]) if row else None
            rev = (int(row["rev"]) if row else 0) + 1
            doc = {**doc, "rev": rev, "updatedAt": now_ms(), "version": 1}
            c.execute(
                "INSERT INTO accounts(user_id, uuid, doc, rev, updated_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(user_id, uuid) DO UPDATE SET doc=excluded.doc, rev=excluded.rev, "
                "updated_at=excluded.updated_at",
                (user_id, uuid, json.dumps(doc), rev, doc["updatedAt"]),
            )
            pool = self._bump_rev(c, user_id)
        return pool, doc, prev

    def get_account(self, user_id: str, uuid: str) -> Optional[dict]:
        with self._tx() as c:
            row = c.execute(
                "SELECT doc FROM accounts WHERE user_id = ? AND uuid = ?", (user_id, uuid)
            ).fetchone()
        return json.loads(row["doc"]) if row else None

    def delete_account(self, user_id: str, uuid: str) -> int:
        """Deletes the account plus its usage row and lock (mirrors folder deleteAccount)."""
        with self._tx() as c:
            c.execute("DELETE FROM accounts WHERE user_id = ? AND uuid = ?", (user_id, uuid))
            c.execute("DELETE FROM usage WHERE user_id = ? AND uuid = ?", (user_id, uuid))
            c.execute("DELETE FROM locks WHERE user_id = ? AND uuid = ?", (user_id, uuid))
            pool = self._bump_rev(c, user_id)
        return pool

    # --- usage (monotonic merge, verbatim SharedStore.writeUsage rules) ---

    def put_usage(
        self, user_id: str, uuid: str, doc: dict
    ) -> tuple[int, dict, Optional[dict]]:
        """Returns (pool_rev, merged_doc, prev_snapshot) — prev lets the route tell a
        real usage update / new error apart from claim bookkeeping when logging."""
        incoming_snapshot = doc.get("snapshot") or {}
        incoming_fetched = int(incoming_snapshot.get("fetchedAt") or 0)
        incoming_attempt = int(doc.get("lastAttemptAt") or 0)
        with self._tx() as c:
            row = c.execute(
                "SELECT doc, rev, snapshot_fetched_at, last_attempt_at FROM usage "
                "WHERE user_id = ? AND uuid = ?",
                (user_id, uuid),
            ).fetchone()
            rev = (int(row["rev"]) if row else 0) + 1
            prev_snapshot = json.loads(row["doc"])["snapshot"] if row else None
            # A strictly newer stored snapshot is kept (a stale/empty snapshot can't
            # clobber a fresh one); equal fetchedAt (error/claim bookkeeping) still applies.
            keep_current = row is not None and int(row["snapshot_fetched_at"]) > incoming_fetched
            snapshot = prev_snapshot if keep_current else incoming_snapshot
            fetched = int(row["snapshot_fetched_at"]) if keep_current else incoming_fetched
            attempt = max(int(row["last_attempt_at"]) if row else 0, incoming_attempt)
            merged = {
                "rev": rev,
                "updatedAt": now_ms(),
                "lastAttemptAt": attempt,
                "snapshot": snapshot,
            }
            c.execute(
                "INSERT INTO usage(user_id, uuid, doc, rev, snapshot_fetched_at, last_attempt_at, "
                "updated_at) VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(user_id, uuid) DO UPDATE SET doc=excluded.doc, rev=excluded.rev, "
                "snapshot_fetched_at=excluded.snapshot_fetched_at, "
                "last_attempt_at=excluded.last_attempt_at, updated_at=excluded.updated_at",
                (user_id, uuid, json.dumps(merged), rev, fetched, attempt, merged["updatedAt"]),
            )
            pool = self._bump_rev(c, user_id)
        return pool, merged, prev_snapshot

    def get_usage(self, user_id: str, uuid: str) -> Optional[dict]:
        with self._tx() as c:
            row = c.execute(
                "SELECT doc FROM usage WHERE user_id = ? AND uuid = ?", (user_id, uuid)
            ).fetchone()
        return json.loads(row["doc"]) if row else None

    # --- instances (presence) ---

    def put_instance(
        self, user_id: str, instance_id: str, doc: dict
    ) -> tuple[int, str, Optional[dict]]:
        """Heartbeat is stamped with the server clock so presence is skew-immune.

        The pool revision is bumped only when the instance's *content* changed
        (new window, different active account, …). A pure keep-alive updates the
        timestamp without a bump — otherwise every window's 20s heartbeat would
        make every other window pull a full snapshot on its next rev-poll.
        Clients compensate for the missing bumps with a periodic full sync.

        Returns (pool_rev, kind, prev_doc) with kind ∈ "created" | "updated" |
        "keepalive" — prev_doc lets the route describe the transition (signed in /
        out / switched) when logging.
        """
        beat = now_ms()
        new_content = {k: v for k, v in doc.items() if k != "heartbeatAt"}
        doc = {**doc, "heartbeatAt": beat}
        with self._tx() as c:
            row = c.execute(
                "SELECT doc FROM instances WHERE user_id = ? AND instance_id = ?",
                (user_id, instance_id),
            ).fetchone()
            prev_doc = json.loads(row["doc"]) if row else None
            old_content = (
                {k: v for k, v in prev_doc.items() if k != "heartbeatAt"} if prev_doc else None
            )
            c.execute(
                "INSERT INTO instances(user_id, instance_id, doc, heartbeat_at) VALUES(?,?,?,?) "
                "ON CONFLICT(user_id, instance_id) DO UPDATE SET doc=excluded.doc, "
                "heartbeat_at=excluded.heartbeat_at",
                (user_id, instance_id, json.dumps(doc), beat),
            )
            if old_content == new_content:
                pool_row = c.execute(
                    "SELECT rev FROM pool_rev WHERE user_id = ?", (user_id,)
                ).fetchone()
                return (int(pool_row["rev"]) if pool_row else 0, "keepalive", prev_doc)
            pool = self._bump_rev(c, user_id)
        return (pool, "created" if row is None else "updated", prev_doc)

    def delete_instance(self, user_id: str, instance_id: str) -> int:
        with self._tx() as c:
            c.execute(
                "DELETE FROM instances WHERE user_id = ? AND instance_id = ?",
                (user_id, instance_id),
            )
            pool = self._bump_rev(c, user_id)
        return pool

    # --- cooldown ---

    def set_cooldown(self, user_id: str, until_ms: int) -> int:
        with self._tx() as c:
            c.execute(
                "INSERT INTO cooldown(user_id, until_ms) VALUES(?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET until_ms=excluded.until_ms",
                (user_id, until_ms),
            )
            pool = self._bump_rev(c, user_id)
        return pool

    # --- locks (TTL, server clock only) ---

    def acquire_lock(
        self, user_id: str, uuid: str, owner: str, ttl_ms: int
    ) -> tuple[bool, int, Optional[str]]:
        """Atomic acquire / expired-steal / same-owner renew.

        Returns (acquired, expiresAt, stolen_from) — stolen_from is the previous
        owner when an expired lock was taken over (worth logging: it means a
        window died or stalled mid-operation).
        """
        ttl_ms = max(1, min(ttl_ms or LOCK_DEFAULT_TTL_MS, LOCK_MAX_TTL_MS))
        now = now_ms()
        expires = now + ttl_ms
        with self._tx() as c:
            prev = c.execute(
                "SELECT owner, expires_at FROM locks WHERE user_id = ? AND uuid = ?",
                (user_id, uuid),
            ).fetchone()
            c.execute(
                "INSERT INTO locks(user_id, uuid, owner, expires_at) VALUES(?,?,?,?) "
                "ON CONFLICT(user_id, uuid) DO UPDATE SET owner=excluded.owner, "
                "expires_at=excluded.expires_at "
                "WHERE locks.expires_at < ? OR locks.owner = excluded.owner",
                (user_id, uuid, owner, expires, now),
            )
            row = c.execute(
                "SELECT owner, expires_at FROM locks WHERE user_id = ? AND uuid = ?",
                (user_id, uuid),
            ).fetchone()
        acquired = row["owner"] == owner
        stolen_from = (
            prev["owner"]
            if acquired and prev is not None and prev["owner"] != owner and int(prev["expires_at"]) < now
            else None
        )
        return acquired, int(row["expires_at"]), stolen_from

    def release_lock(self, user_id: str, uuid: str, owner: str) -> None:
        """Only the owner's lock is released (a stolen lock is left alone)."""
        with self._tx() as c:
            c.execute(
                "DELETE FROM locks WHERE user_id = ? AND uuid = ? AND owner = ?",
                (user_id, uuid, owner),
            )

    # --- secrets (opaque encrypted blobs; never bump pool rev) ---

    def put_secret(self, user_id: str, cred_id: str, blob: str) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO secrets(user_id, cred_id, blob, updated_at) VALUES(?,?,?,?) "
                "ON CONFLICT(user_id, cred_id) DO UPDATE SET blob=excluded.blob, "
                "updated_at=excluded.updated_at",
                (user_id, cred_id, blob, now_ms()),
            )

    def get_secret(self, user_id: str, cred_id: str) -> Optional[str]:
        with self._tx() as c:
            row = c.execute(
                "SELECT blob FROM secrets WHERE user_id = ? AND cred_id = ?", (user_id, cred_id)
            ).fetchone()
        return row["blob"] if row else None

    def delete_secret(self, user_id: str, cred_id: str) -> None:
        with self._tx() as c:
            c.execute(
                "DELETE FROM secrets WHERE user_id = ? AND cred_id = ?", (user_id, cred_id)
            )

    # --- snapshot ---

    def snapshot(self, user_id: str) -> dict[str, Any]:
        """Everything a client cache needs, with stale presence/locks pruned first."""
        now = now_ms()
        with self._tx() as c:
            c.execute(
                "DELETE FROM instances WHERE user_id = ? AND heartbeat_at < ?",
                (user_id, now - INSTANCE_STALE_MS),
            )
            c.execute(
                "DELETE FROM locks WHERE user_id = ? AND expires_at < ?", (user_id, now)
            )
            rev_row = c.execute(
                "SELECT rev FROM pool_rev WHERE user_id = ?", (user_id,)
            ).fetchone()
            accounts = [
                json.loads(r["doc"])
                for r in c.execute(
                    "SELECT doc FROM accounts WHERE user_id = ? ORDER BY uuid", (user_id,)
                )
            ]
            usage = {
                r["uuid"]: json.loads(r["doc"])
                for r in c.execute(
                    "SELECT uuid, doc FROM usage WHERE user_id = ?", (user_id,)
                )
            }
            instances = [
                json.loads(r["doc"])
                for r in c.execute(
                    "SELECT doc FROM instances WHERE user_id = ?", (user_id,)
                )
            ]
            cd = c.execute(
                "SELECT until_ms FROM cooldown WHERE user_id = ?", (user_id,)
            ).fetchone()
        return {
            "rev": int(rev_row["rev"]) if rev_row else 0,
            "now": now,
            "accounts": accounts,
            "usage": usage,
            "instances": instances,
            "cooldownUntil": int(cd["until_ms"]) if cd else 0,
        }
