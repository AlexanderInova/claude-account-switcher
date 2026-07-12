import logging

from conftest import User, account_doc

LOGGER = "claude_switcher_sync"


def test_registration_logs(client, caplog):
    with caplog.at_level(logging.INFO, logger=LOGGER):
        User(client, "alice@example.com")
    assert any("registered" in r.message and "alice@example.com" in r.message for r in caplog.records)


def test_keepalive_heartbeat_is_silent_at_info(user, caplog):
    info = {"instanceId": "i1", "hostname": "h", "pid": 1, "workspaceName": "w",
            "startedAt": 1, "heartbeatAt": 1}
    user.put("/v1/pool/instances/i1", json=info)  # join — logs
    with caplog.at_level(logging.INFO, logger=LOGGER):
        caplog.clear()
        user.put("/v1/pool/instances/i1", json=info)  # keep-alive — silent
    assert [r for r in caplog.records if r.name == LOGGER] == []


def test_instance_transitions_log(user, caplog):
    user.put("/v1/pool/accounts/u9", json=account_doc("u9", label="Work"))
    info = {"instanceId": "i1", "hostname": "box", "pid": 1, "workspaceName": "proj",
            "startedAt": 1, "heartbeatAt": 1}
    with caplog.at_level(logging.INFO, logger=LOGGER):
        user.put("/v1/pool/instances/i1", json=info)
        user.put("/v1/pool/instances/i1", json={**info, "activeAccountUuid": "u9"})
        user.put("/v1/pool/instances/i1", json=info)  # back to no account
    msgs = [r.message for r in caplog.records]
    assert any("came online" in m and "box" in m and "signed out" in m for m in msgs)
    assert any("signed in to 'Work'" in m for m in msgs)
    assert any("signed out of 'Work'" in m for m in msgs)


def test_account_write_meaningful_vs_bookkeeping(user, caplog):
    doc = account_doc("u1", label="Work", creds=[{"id": "c1", "addedAt": 1, "expiresAt": 2,
                                                  "refreshTokenHash": "ab" * 8}])
    with caplog.at_level(logging.INFO, logger=LOGGER):
        user.put("/v1/pool/accounts/u1", json=doc)  # create + park — INFO
        assert any("account 'Work' created" in r.message and "parked into 'Work'" in r.message
                   for r in caplog.records)
        caplog.clear()
        user.put("/v1/pool/accounts/u1", json=doc)  # same shape (lease bookkeeping) — DEBUG only
        assert [r for r in caplog.records if "Work" in r.message] == []
        user.put("/v1/pool/accounts/u1", json=account_doc("u1", label="Work", creds=[]))
    assert any("taken from 'Work'" in r.message and "now 0 parked" in r.message
               for r in caplog.records)


def test_auth_failure_logs_warning(user, caplog):
    bad = {"Authorization": "Bearer " + ("00" * 32), "X-CAS-User": user.user_id}
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        user.client.get("/v1/pool/rev", headers=bad)
    assert any("401" in r.message and user.user_id in r.message for r in caplog.records)


def test_lock_steal_logs(user, caplog, monkeypatch):
    user.post("/v1/pool/locks/u1", json={"owner": "w1", "ttlMs": 5_000})
    import claude_switcher_sync.db as dbmod
    real_now = dbmod.now_ms
    monkeypatch.setattr(dbmod, "now_ms", lambda: real_now() + 61_000)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        user.post("/v1/pool/locks/u1", json={"owner": "w2"})
    assert any("STOLEN from w1 by w2" in r.message for r in caplog.records)
