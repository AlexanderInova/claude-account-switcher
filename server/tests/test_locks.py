from conftest import account_doc, usage_doc


def test_acquire_free_returns_docs(user):
    user.put("/v1/pool/accounts/u1", json=account_doc("u1"))
    user.put("/v1/pool/usage/u1", json=usage_doc(100, 100))
    r = user.post("/v1/pool/locks/u1", json={"owner": "w1", "ttlMs": 30_000})
    assert r.status_code == 200
    body = r.json()
    assert body["expiresAt"] > 0
    assert body["account"]["account"]["uuid"] == "u1"
    assert body["usage"]["snapshot"]["fetchedAt"] == 100


def test_acquire_missing_account_returns_nulls(user):
    r = user.post("/v1/pool/locks/ghost", json={"owner": "w1"})
    assert r.status_code == 200
    assert r.json()["account"] is None and r.json()["usage"] is None


def test_held_lock_423(user):
    user.post("/v1/pool/locks/u1", json={"owner": "w1"})
    r = user.post("/v1/pool/locks/u1", json={"owner": "w2"})
    assert r.status_code == 423
    assert r.json()["expiresAt"] > 0


def test_same_owner_renews(user):
    e1 = user.post("/v1/pool/locks/u1", json={"owner": "w1", "ttlMs": 10_000}).json()["expiresAt"]
    e2 = user.post("/v1/pool/locks/u1", json={"owner": "w1", "ttlMs": 30_000}).json()["expiresAt"]
    assert e2 > e1


def test_expired_lock_stolen(user, monkeypatch):
    user.post("/v1/pool/locks/u1", json={"owner": "w1", "ttlMs": 5_000})
    import claude_switcher_sync.db as dbmod
    real_now = dbmod.now_ms
    monkeypatch.setattr(dbmod, "now_ms", lambda: real_now() + 61_000)
    assert user.post("/v1/pool/locks/u1", json={"owner": "w2"}).status_code == 200


def test_release_owner_checked(user):
    user.post("/v1/pool/locks/u1", json={"owner": "w1"})
    assert user.delete("/v1/pool/locks/u1", params={"owner": "w2"}).status_code == 204
    # w2's release was a no-op; the lock is still held by w1.
    assert user.post("/v1/pool/locks/u1", json={"owner": "w3"}).status_code == 423
    assert user.delete("/v1/pool/locks/u1", params={"owner": "w1"}).status_code == 204
    assert user.post("/v1/pool/locks/u1", json={"owner": "w3"}).status_code == 200


def test_ttl_clamped_to_60s(user):
    r = user.post("/v1/pool/locks/u1", json={"owner": "w1", "ttlMs": 600_000})
    snap_now = user.get("/v1/pool/snapshot").json()["now"]
    assert r.json()["expiresAt"] - snap_now <= 61_000
