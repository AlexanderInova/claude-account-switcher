import hashlib
import os
import secrets as pysecrets

import pytest
from fastapi.testclient import TestClient

from claude_switcher_sync.app import create_app
from claude_switcher_sync.config import Settings


def make_client(tmp_path, **overrides) -> TestClient:
    kwargs = {
        "db_path": os.path.join(str(tmp_path), "test.db"),
        "rate_auth_per_min": 10_000,
        "rate_unauth_per_min": 10_000,
        **overrides,
    }
    return TestClient(create_app(Settings(**kwargs)))


class User:
    """A registered test user with derived-key headers, like the extension would send."""

    def __init__(self, client: TestClient, user_id: str, token: str | None = None):
        self.client = client
        self.user_id = user_id
        self.auth_key = pysecrets.token_bytes(32)
        self.salt_hex = pysecrets.token_hex(16)
        r = client.post(
            "/v1/users",
            json={
                "userId": user_id,
                "saltHex": self.salt_hex,
                "verifierSha256": hashlib.sha256(self.auth_key).hexdigest(),
                **({"registrationToken": token} if token else {}),
            },
        )
        assert r.status_code == 201, r.text
        self.headers = {
            "Authorization": "Bearer " + self.auth_key.hex(),
            "X-CAS-User": user_id,
        }

    def get(self, path, **kw):
        return self.client.get(path, headers=self.headers, **kw)

    def put(self, path, **kw):
        return self.client.put(path, headers=self.headers, **kw)

    def post(self, path, **kw):
        return self.client.post(path, headers=self.headers, **kw)

    def delete(self, path, **kw):
        return self.client.delete(path, headers=self.headers, **kw)


@pytest.fixture
def client(tmp_path) -> TestClient:
    return make_client(tmp_path)


@pytest.fixture
def user(client) -> User:
    return User(client, "alice@example.com")


def account_doc(uuid: str, label: str = "Test", creds=None) -> dict:
    return {
        "version": 1,
        "rev": 0,
        "updatedAt": 0,
        "account": {
            "uuid": uuid,
            "label": label,
            "order": 1,
            "addedAt": 1,
            "updatesEnabled": True,
        },
        "credentials": creds or [],
    }


def usage_doc(fetched_at: int, attempt: int, session: float = 10.0) -> dict:
    return {
        "rev": 0,
        "updatedAt": 0,
        "lastAttemptAt": attempt,
        "snapshot": {
            "fetchedAt": fetched_at,
            "windows": [],
            "sessionPercent": session,
            "weeklyPercent": None,
        },
    }
