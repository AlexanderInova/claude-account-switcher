import hashlib
import secrets as pysecrets

from conftest import User, make_client


def test_register_login_roundtrip(client):
    u = User(client, "alice@example.com")
    r = u.get("/v1/pool/rev")
    assert r.status_code == 200 and r.json() == {"rev": 0}


def test_register_duplicate_409(client):
    User(client, "alice@example.com")
    r = client.post(
        "/v1/users",
        json={
            "userId": "alice@example.com",
            "saltHex": pysecrets.token_hex(16),
            "verifierSha256": hashlib.sha256(b"x" * 32).hexdigest(),
        },
    )
    assert r.status_code == 409


def test_register_invalid_user_id_422(client):
    for bad in ["ab", "a" * 65, "has space", "sneaky/../path"]:
        r = client.post(
            "/v1/users",
            json={
                "userId": bad,
                "saltHex": pysecrets.token_hex(16),
                "verifierSha256": hashlib.sha256(b"x" * 32).hexdigest(),
            },
        )
        assert r.status_code == 422, bad


def test_registration_token_enforced(tmp_path):
    client = make_client(tmp_path, registration_token="letmein")
    r = client.post(
        "/v1/users",
        json={
            "userId": "alice@example.com",
            "saltHex": pysecrets.token_hex(16),
            "verifierSha256": hashlib.sha256(b"x" * 32).hexdigest(),
        },
    )
    assert r.status_code == 403
    User(client, "alice@example.com", token="letmein")  # asserts 201 internally


def test_salt_is_public_and_404s(client):
    u = User(client, "alice@example.com")
    r = client.get(f"/v1/users/{u.user_id}/salt")
    assert r.status_code == 200 and r.json() == {"saltHex": u.salt_hex}
    assert client.get("/v1/users/nobody@example.com/salt").status_code == 404


def test_wrong_key_401(client):
    u = User(client, "alice@example.com")
    bad = {"Authorization": "Bearer " + ("00" * 32), "X-CAS-User": u.user_id}
    assert client.get("/v1/pool/rev", headers=bad).status_code == 401


def test_unknown_user_401(client):
    bad = {"Authorization": "Bearer " + ("00" * 32), "X-CAS-User": "ghost@example.com"}
    assert client.get("/v1/pool/rev", headers=bad).status_code == 401


def test_missing_headers_401(client):
    assert client.get("/v1/pool/rev").status_code == 401
    assert client.get("/v1/pool/rev", headers={"Authorization": "Bearer zz"}).status_code == 401


def test_healthz_open(client):
    assert client.get("/healthz").json() == {"ok": True}
