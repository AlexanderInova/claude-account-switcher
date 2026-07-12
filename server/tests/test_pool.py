from conftest import account_doc, usage_doc


def test_account_roundtrip_and_server_owned_rev(user):
    r = user.put("/v1/pool/accounts/u1", json=account_doc("u1"))
    assert r.status_code == 200
    body = r.json()
    assert body["poolRev"] == 1
    assert body["doc"]["rev"] == 1 and body["doc"]["updatedAt"] > 0

    # Client-supplied rev is ignored; the server increments its own.
    doc = account_doc("u1")
    doc["rev"] = 999
    body2 = user.put("/v1/pool/accounts/u1", json=doc).json()
    assert body2["doc"]["rev"] == 2 and body2["poolRev"] == 2

    got = user.get("/v1/pool/accounts/u1")
    assert got.status_code == 200 and got.json()["rev"] == 2


def test_account_uuid_mismatch_422(user):
    assert user.put("/v1/pool/accounts/u1", json=account_doc("other")).status_code == 422


def test_delete_account_cascades(user):
    user.put("/v1/pool/accounts/u1", json=account_doc("u1"))
    user.put("/v1/pool/usage/u1", json=usage_doc(100, 100))
    user.post("/v1/pool/locks/u1", json={"owner": "w1"})
    r = user.delete("/v1/pool/accounts/u1")
    assert r.status_code == 200
    assert user.get("/v1/pool/accounts/u1").status_code == 404
    snap = user.get("/v1/pool/snapshot").json()
    assert snap["accounts"] == [] and snap["usage"] == {}
    # The lock went with it: a different owner can acquire immediately.
    assert user.post("/v1/pool/locks/u1", json={"owner": "w2"}).status_code == 200


def test_snapshot_shape_and_rev(user):
    user.put("/v1/pool/accounts/u1", json=account_doc("u1"))
    user.put("/v1/pool/usage/u1", json=usage_doc(100, 100))
    user.put("/v1/pool/instances/i1", json={"instanceId": "i1", "hostname": "h", "pid": 1,
                                            "workspaceName": "w", "startedAt": 1, "heartbeatAt": 1})
    user.put("/v1/pool/cooldown", json={"cooldownUntil": 12345})
    snap = user.get("/v1/pool/snapshot").json()
    assert snap["rev"] == 4 and snap["now"] > 0
    assert [a["account"]["uuid"] for a in snap["accounts"]] == ["u1"]
    assert "u1" in snap["usage"]
    assert [i["instanceId"] for i in snap["instances"]] == ["i1"]
    assert snap["cooldownUntil"] == 12345
    assert user.get("/v1/pool/rev").json() == {"rev": 4}


def test_instance_heartbeat_server_stamped_and_pruned(user, monkeypatch):
    user.put("/v1/pool/instances/i1", json={"instanceId": "i1", "hostname": "h", "pid": 1,
                                            "workspaceName": "w", "startedAt": 1,
                                            "heartbeatAt": 1})
    snap = user.get("/v1/pool/snapshot").json()
    beat = snap["instances"][0]["heartbeatAt"]
    assert abs(beat - snap["now"]) < 5_000  # server clock, not the client's "1"

    # Age the heartbeat past staleness and confirm the snapshot prunes it.
    import claude_switcher_sync.db as dbmod
    real_now = dbmod.now_ms
    monkeypatch.setattr(dbmod, "now_ms", lambda: real_now() + 120_000)
    snap2 = user.get("/v1/pool/snapshot").json()
    assert snap2["instances"] == []


def test_instance_delete_204(user):
    user.put("/v1/pool/instances/i1", json={"instanceId": "i1", "hostname": "h", "pid": 1,
                                            "workspaceName": "w", "startedAt": 1,
                                            "heartbeatAt": 1})
    assert user.delete("/v1/pool/instances/i1").status_code == 204
    assert user.get("/v1/pool/snapshot").json()["instances"] == []


def test_secrets_crud_and_isolation_from_pool_rev(user):
    rev0 = user.get("/v1/pool/rev").json()["rev"]
    assert user.put("/v1/pool/secrets/c1", json={"blob": "QUJD"}).status_code == 200
    assert user.get("/v1/pool/secrets/c1").json() == {"blob": "QUJD"}
    assert user.get("/v1/pool/rev").json()["rev"] == rev0  # secrets never bump poolRev
    assert user.delete("/v1/pool/secrets/c1").status_code == 204
    assert user.get("/v1/pool/secrets/c1").status_code == 404


def test_secret_size_cap_and_format(user):
    assert user.put("/v1/pool/secrets/c1", json={"blob": "A" * 20_000}).status_code == 413
    assert user.put("/v1/pool/secrets/c1", json={"blob": "not base64!!"}).status_code == 422
