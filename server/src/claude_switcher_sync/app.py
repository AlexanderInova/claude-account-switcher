"""HTTP surface. Thin routes over db.py — a Flask/Django port would only rewrite this file."""

import hmac
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


def create_app(settings: Settings) -> FastAPI:
    db = Database(settings.db_path)
    app = FastAPI(title="claude-switcher-sync", version=__version__, docs_url="/docs")
    app.middleware("http")(make_middleware(settings))
    user_dep = Depends(make_auth(db))

    # --- unauthenticated ---

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    @app.post("/v1/users", status_code=201)
    def register(body: RegisterBody) -> dict:
        if settings.registration_token and not hmac.compare_digest(
            body.registrationToken or "", settings.registration_token
        ):
            raise HTTPException(status_code=403, detail="Registration token required")
        if not USER_ID_RE.match(body.userId):
            raise HTTPException(status_code=422, detail="Invalid user id")
        if not SALT_RE.match(body.saltHex) or not SHA256_RE.match(body.verifierSha256):
            raise HTTPException(status_code=422, detail="Invalid salt or verifier")
        if not db.create_user(body.userId, body.saltHex, body.verifierSha256):
            raise HTTPException(status_code=409, detail="User already exists")
        return {"ok": True}

    @app.get("/v1/users/{user_id}/salt")
    def salt(user_id: str) -> dict:
        user = db.get_user(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="Unknown user")
        return {"saltHex": user["salt_hex"]}

    # --- pool (authenticated; namespace = the authed user) ---

    @app.get("/v1/pool/rev")
    def rev(user: str = user_dep) -> dict:
        return {"rev": db.pool_rev(user)}

    @app.get("/v1/pool/snapshot")
    def snapshot(user: str = user_dep) -> dict:
        return db.snapshot(user)

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
        pool, stored = db.put_account(user, uuid, doc)
        return {"poolRev": pool, "doc": stored}

    @app.delete("/v1/pool/accounts/{uuid}")
    def delete_account(uuid: str, user: str = user_dep) -> dict:
        return {"poolRev": db.delete_account(user, uuid)}

    @app.put("/v1/pool/usage/{uuid}")
    def put_usage(uuid: str, doc: dict = Body(...), user: str = user_dep) -> dict:
        pool, stored = db.put_usage(user, uuid, doc)
        return {"poolRev": pool, "doc": stored}

    @app.put("/v1/pool/instances/{instance_id}")
    def put_instance(instance_id: str, doc: dict = Body(...), user: str = user_dep) -> dict:
        return {"poolRev": db.put_instance(user, instance_id, doc)}

    @app.delete("/v1/pool/instances/{instance_id}", status_code=204)
    def delete_instance(instance_id: str, user: str = user_dep) -> Response:
        db.delete_instance(user, instance_id)
        return Response(status_code=204)

    @app.put("/v1/pool/cooldown")
    def put_cooldown(body: CooldownBody, user: str = user_dep) -> dict:
        return {"poolRev": db.set_cooldown(user, body.cooldownUntil)}

    @app.post("/v1/pool/locks/{uuid}")
    def acquire_lock(uuid: str, body: LockBody, user: str = user_dep) -> Any:
        acquired, expires = db.acquire_lock(user, uuid, body.owner, body.ttlMs)
        if not acquired:
            return JSONResponse({"expiresAt": expires}, status_code=423)
        # Fresh copies ride along so the client can serve guaranteed-fresh reads
        # inside its lock scope without an extra round trip.
        return {
            "expiresAt": expires,
            "account": db.get_account(user, uuid),
            "usage": db.get_usage(user, uuid),
        }

    @app.delete("/v1/pool/locks/{uuid}", status_code=204)
    def release_lock(uuid: str, owner: str = Query(...), user: str = user_dep) -> Response:
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
        return {"ok": True}

    @app.delete("/v1/pool/secrets/{cred_id}", status_code=204)
    def delete_secret(cred_id: str, user: str = user_dep) -> Response:
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
