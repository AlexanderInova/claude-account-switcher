"""Bearer auth.

The client derives authKey (32 bytes) from the passphrase via scrypt+HKDF and
sends it hex-encoded as `Authorization: Bearer <hex>` plus `X-CAS-User`. We
store only sha256(authKeyBytes) — so a stolen DB still costs a scrypt run per
passphrase guess, and the server can never decrypt anyone's secrets (the
encryption key is a sibling derivation that never leaves the client).
"""

import hashlib
import hmac
import logging

from fastapi import HTTPException, Request

from .db import Database

log = logging.getLogger("claude_switcher_sync")


def verifier_from_bearer(bearer_hex: str) -> str:
    key = bytes.fromhex(bearer_hex)
    return hashlib.sha256(key).hexdigest()


def make_auth(db: Database):
    def current_user(request: Request) -> str:
        auth = request.headers.get("authorization", "")
        user_id = request.headers.get("x-cas-user", "")
        if not auth.lower().startswith("bearer ") or not user_id:
            raise HTTPException(status_code=401, detail="Missing credentials")
        bearer = auth[7:].strip()
        try:
            verifier = verifier_from_bearer(bearer)
        except ValueError:
            raise HTTPException(status_code=401, detail="Malformed token")
        user = db.get_user(user_id)
        # Constant-time compare; unknown user compares against itself so timing
        # doesn't reveal which of user/passphrase was wrong.
        expected = user["verifier_sha256"] if user else verifier + "x"
        if not hmac.compare_digest(verifier, expected):
            ip = request.client.host if request.client else "?"
            log.warning("401 for user '%s' from %s (wrong passphrase or unknown user)", user_id, ip)
            raise HTTPException(status_code=401, detail="Invalid credentials")
        return user_id

    return current_user
