"""HTTP surface. Thin routes over db.py — a Flask/Django port would only rewrite this file."""

import hmac
import logging
import re
from typing import Any, Optional

from fastapi import Body, Depends, FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import __version__
from .auth import make_auth
from .config import Settings, from_env
from .db import Database
from .ratelimit import make_middleware

USER_ID_RE = re.compile(r"^[A-Za-z0-9._@-]{3,64}$")
SALT_RE = re.compile(r"^[0-9a-f]{16,128}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
BLOB_RE = re.compile(r"^[A-Za-z0-9+/=]+$")


class RegisterBody(BaseModel):
    userId: str
    saltHex: str
    verifierSha256: str
    registrationToken: Optional[str] = None


class LockBody(BaseModel):
    owner: str = Field(min_length=1, max_length=200)
    ttlMs: int = 30_000


class SecretBody(BaseModel):
    blob: str


class CooldownBody(BaseModel):
    cooldownUntil: int


log = logging.getLogger("claude_switcher_sync")


def _setup_logging(settings: Settings) -> None:
    root = logging.getLogger("claude_switcher_sync")
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        root.addHandler(handler)
    root.setLevel(getattr(logging, settings.log_level, logging.INFO))


def create_app(settings: Settings) -> FastAPI:
    _setup_logging(settings)
    db = Database(settings.db_path)
    app = FastAPI(title="claude-switcher-sync", version=__version__, docs_url="/docs")
    app.middleware("http")(make_middleware(settings))
    user_dep = Depends(make_auth(db))

    log.info(
        "claude-switcher-sync %s — db=%s, registration=%s, rate=%d/min per user (%d/min unauth per IP), access_log=%s",
        __version__,
        settings.db_path,
        "token-gated" if settings.registration_token else "open",
        settings.rate_auth_per_min,
        settings.rate_unauth_per_min,
        "on" if settings.access_log else "off",
    )

    # --- unauthenticated ---

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    @app.post("/v1/users", status_code=201)
    def register(body: RegisterBody) -> dict:
        if settings.registration_token and not hmac.compare_digest(
            body.registrationToken or "", settings.registration_token
        ):
            log.warning("registration rejected for '%s' (bad/missing token)", body.userId)
            raise HTTPException(status_code=403, detail="Registration token required")
        if not USER_ID_RE.match(body.userId):
            log.warning("registration rejected (invalid user id)")
            raise HTTPException(status_code=422, detail="Invalid user id")
        if not SALT_RE.match(body.saltHex) or not SHA256_RE.match(body.verifierSha256):
            raise HTTPException(status_code=422, detail="Invalid salt or verifier")
        if not db.create_user(body.userId, body.saltHex, body.verifierSha256):
            log.warning("registration rejected for '%s' (already exists)", body.userId)
            raise HTTPException(status_code=409, detail="User already exists")
        log.info("user '%s' registered", body.userId)
        return {"ok": True}

    @app.get("/v1/users/{user_id}/salt")
    def salt(user_id: str) -> dict:
        user = db.get_user(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="Unknown user")
        return {"saltHex": user["salt_hex"]}

    # --- pool (authenticated; namespace = the authed user) ---

    def account_label(user: str, uuid: Optional[str]) -> str:
        """Human-readable account name for log lines ('Work' beats a bare uuid)."""
        if not uuid:
            return "none"
        doc = db.get_account(user, uuid)
        label = (doc or {}).get("account", {}).get("label")
        return f"'{label}'" if label else uuid[:8]

    @app.get("/v1/pool/rev")
    def rev(user: str = user_dep) -> dict:
        return {"rev": db.pool_rev(user)}

    @app.get("/v1/pool/snapshot")
    def snapshot(user: str = user_dep) -> dict:
        snap = db.snapshot(user)
        log.debug("full state retrieved by %s (rev %d)", user, snap["rev"])
        return snap

    @app.get("/v1/pool/accounts/{uuid}")
    def get_account(uuid: str, user: str = user_dep) -> dict:
        doc = db.get_account(user, uuid)
        if doc is None:
            raise HTTPException(status_code=404, detail="No such account")
        return doc

    @app.put("/v1/pool/accounts/{uuid}")
    def put_account(uuid: str, doc: dict = Body(...), user: str = user_dep) -> dict:
        if not isinstance(doc.get("account"), dict) or doc["account"].get("uuid") != uuid:
            raise HTTPException(status_code=422, detail="account.uuid must match the path")
        pool, stored, prev = db.put_account(user, uuid, doc)
        label = stored.get("account", {}).get("label", "?")
        # Narrate what actually happened (created / parked / consumed / renamed);
        # lease & suspension bookkeeping during polls stays at DEBUG.
        new_ids = {c.get("id") for c in stored.get("credentials", [])}
        old_ids = {c.get("id") for c in (prev or {}).get("credentials", [])}
        added, removed = len(new_ids - old_ids), len(old_ids - new_ids)
        old_label = (prev or {}).get("account", {}).get("label")
        events: list[str] = []
        if prev is None:
            events.append(f"account '{label}' created")
        elif old_label != label:
            events.append(f"account '{old_label}' renamed to '{label}'")
        if added:
            events.append(f"{added} credential{'s' if added > 1 else ''} parked into '{label}'")
        if removed:
            events.append(
                f"{removed} credential{'s' if removed > 1 else ''} taken from '{label}' (deployed or deleted)"
            )
        if events:
            log.info("%s — now %d parked (by %s)", ", ".join(events), len(new_ids), user)
        else:
            log.debug("account '%s' bookkeeping write (rev %d) by %s", label, stored["rev"], user)
        return {"poolRev": pool, "doc": stored}

    @app.delete("/v1/pool/accounts/{uuid}")
    def delete_account(uuid: str, user: str = user_dep) -> dict:
        log.info("account %s removed by %s", account_label(user, uuid), user)
        return {"poolRev": db.delete_account(user, uuid)}

    @app.put("/v1/pool/usage/{uuid}")
    def put_usage(uuid: str, doc: dict = Body(...), user: str = user_dep) -> dict:
        pool, stored, prev = db.put_usage(user, uuid, doc)
        snap = stored.get("snapshot", {})
        fetched_advanced = (snap.get("fetchedAt") or 0) > ((prev or {}).get("fetchedAt") or 0)
        new_error = snap.get("error") and (snap.get("errorAt") or 0) > ((prev or {}).get("errorAt") or 0)
        if fetched_advanced:
            pct = lambda v: "?" if v is None else v  # noqa: E731 — key exists but may be null
            log.info(
                "usage updated for %s: session %s%%, weekly %s%%",
                account_label(user, uuid),
                pct(snap.get("sessionPercent")),
                pct(snap.get("weeklyPercent")),
            )
        elif new_error:
            log.info("usage fetch failed for %s: %s", account_label(user, uuid), snap.get("error"))
        else:
            log.debug("usage bookkeeping for %s (rev %d)", uuid[:8], stored["rev"])
        return {"poolRev": pool, "doc": stored}

    @app.put("/v1/pool/instances/{instance_id}")
    def put_instance(instance_id: str, doc: dict = Body(...), user: str = user_dep) -> dict:
        pool, kind, prev = db.put_instance(user, instance_id, doc)
        win = f"window {instance_id[:8]} ('{doc.get('workspaceName', '?')}')"
        if kind == "created":
            using = doc.get("activeAccountUuid")
            log.info(
                "%s came online on %s for %s%s",
                win,
                doc.get("hostname", "?"),
                user,
                f", using {account_label(user, using)}" if using else ", signed out",
            )
        elif kind == "updated":
            old_acc = (prev or {}).get("activeAccountUuid")
            new_acc = doc.get("activeAccountUuid")
            if old_acc == new_acc:
                log.info("%s updated its details", win)
            elif old_acc and new_acc:
                log.info("%s switched from %s to %s", win, account_label(user, old_acc), account_label(user, new_acc))
            elif new_acc:
                log.info("%s signed in to %s", win, account_label(user, new_acc))
            else:
                log.info("%s signed out of %s", win, account_label(user, old_acc))
        else:
            log.debug("heartbeat from %s", win)
        return {"poolRev": pool}

    @app.delete("/v1/pool/instances/{instance_id}", status_code=204)
    def delete_instance(instance_id: str, user: str = user_dep) -> Response:
        log.info("window %s closed (%s)", instance_id[:8], user)
        db.delete_instance(user, instance_id)
        return Response(status_code=204)

    @app.put("/v1/pool/cooldown")
    def put_cooldown(body: CooldownBody, user: str = user_dep) -> dict:
        log.info("global cooldown set until %d for %s (a 429 from Anthropic)", body.cooldownUntil, user)
        return {"poolRev": db.set_cooldown(user, body.cooldownUntil)}

    @app.post("/v1/pool/locks/{uuid}")
    def acquire_lock(uuid: str, body: LockBody, user: str = user_dep) -> Any:
        acquired, expires, stolen_from = db.acquire_lock(user, uuid, body.owner, body.ttlMs)
        if not acquired:
            log.debug("lock %s busy (wanted by %s)", uuid, body.owner)
            return JSONResponse({"expiresAt": expires}, status_code=423)
        if stolen_from:
            # An expired lock changed hands — the previous holder died or stalled.
            log.info("lock %s STOLEN from %s by %s", uuid, stolen_from, body.owner)
        else:
            log.debug("lock %s acquired by %s", uuid, body.owner)
        # Fresh copies ride along so the client can serve guaranteed-fresh reads
        # inside its lock scope without an extra round trip.
        return {
            "expiresAt": expires,
            "account": db.get_account(user, uuid),
            "usage": db.get_usage(user, uuid),
        }

    @app.delete("/v1/pool/locks/{uuid}", status_code=204)
    def release_lock(uuid: str, owner: str = Query(...), user: str = user_dep) -> Response:
        log.debug("lock %s released by %s", uuid, owner)
        db.release_lock(user, uuid, owner)
        return Response(status_code=204)

    @app.get("/v1/pool/secrets/{cred_id}")
    def get_secret(cred_id: str, user: str = user_dep) -> dict:
        blob = db.get_secret(user, cred_id)
        if blob is None:
            raise HTTPException(status_code=404, detail="No such secret")
        return {"blob": blob}

    @app.put("/v1/pool/secrets/{cred_id}")
    def put_secret(cred_id: str, body: SecretBody, user: str = user_dep) -> dict:
        if len(body.blob) > settings.max_secret_bytes:
            raise HTTPException(status_code=413, detail="Blob too large")
        if not BLOB_RE.match(body.blob):
            raise HTTPException(status_code=422, detail="Blob must be base64")
        db.put_secret(user, cred_id, body.blob)
        log.info(
            "encrypted token stored for credential %s by %s (%d bytes ciphertext)",
            cred_id[:8],
            user,
            len(body.blob),
        )
        return {"ok": True}

    @app.delete("/v1/pool/secrets/{cred_id}", status_code=204)
    def delete_secret(cred_id: str, user: str = user_dep) -> Response:
        log.info("encrypted token deleted for credential %s by %s", cred_id[:8], user)
        db.delete_secret(user, cred_id)
        return Response(status_code=204)

    return app


def main() -> None:
    import uvicorn

    settings = from_env()
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        access_log=settings.access_log,
    )


def app_factory() -> FastAPI:
    """For bare runs: `uvicorn --factory claude_switcher_sync.app:app_factory`."""
    return create_app(from_env())
