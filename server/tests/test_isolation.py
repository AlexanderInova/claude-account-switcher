from conftest import User, account_doc, usage_doc


def test_cross_user_isolation(client):
    alice = User(client, "alice@example.com")
    bob = User(client, "bob@example.com")

    alice.put("/v1/pool/accounts/u1", json=account_doc("u1", label="Alice's"))
    alice.put("/v1/pool/usage/u1", json=usage_doc(100, 100))
    alice.put("/v1/pool/secrets/c1", json={"blob": "QUJD"})
    alice.post("/v1/pool/locks/u1", json={"owner": "alice-w1"})

    # Bob sees an empty pool and cannot reach Alice's records by id.
    snap = bob.get("/v1/pool/snapshot").json()
    assert snap["accounts"] == [] and snap["usage"] == {} and snap["rev"] == 0
    assert bob.get("/v1/pool/accounts/u1").status_code == 404
    assert bob.get("/v1/pool/secrets/c1").status_code == 404

    # Same uuid in Bob's namespace is an independent record and an independent lock.
    assert bob.post("/v1/pool/locks/u1", json={"owner": "bob-w1"}).status_code == 200
    bob.put("/v1/pool/accounts/u1", json=account_doc("u1", label="Bob's"))
    assert alice.get("/v1/pool/accounts/u1").json()["account"]["label"] == "Alice's"

    # Bob's deletes don't touch Alice.
    bob.delete("/v1/pool/accounts/u1")
    bob.delete("/v1/pool/secrets/c1")
    assert alice.get("/v1/pool/accounts/u1").status_code == 200
    assert alice.get("/v1/pool/secrets/c1").status_code == 200


def test_rate_limit_429(tmp_path):
    from conftest import make_client
    client = make_client(tmp_path, rate_unauth_per_min=3)
    for _ in range(3):
        assert client.get("/v1/users/nobody/salt").status_code == 404
    r = client.get("/v1/users/nobody/salt")
    assert r.status_code == 429 and r.headers.get("retry-after")


def test_rate_limit_authed_keyed_per_user(tmp_path):
    from conftest import make_client
    client = make_client(tmp_path, rate_auth_per_min=5)
    alice = User(client, "alice@example.com")
    bob = User(client, "bob@example.com")
    for _ in range(5):
        assert alice.get("/v1/pool/rev").status_code == 200
    assert alice.get("/v1/pool/rev").status_code == 429
    assert bob.get("/v1/pool/rev").status_code == 200  # separate bucket
