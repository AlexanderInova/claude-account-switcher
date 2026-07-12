from conftest import usage_doc


def put(user, doc):
    r = user.put("/v1/pool/usage/u1", json=doc)
    assert r.status_code == 200
    return r.json()["doc"]


def test_fresh_beats_stale(user):
    put(user, usage_doc(fetched_at=200, attempt=200, session=50.0))
    merged = put(user, usage_doc(fetched_at=100, attempt=300, session=1.0))
    # The stale snapshot is discarded; only lastAttemptAt advances.
    assert merged["snapshot"]["fetchedAt"] == 200
    assert merged["snapshot"]["sessionPercent"] == 50.0
    assert merged["lastAttemptAt"] == 300


def test_equal_fetched_at_still_applies(user):
    put(user, usage_doc(fetched_at=200, attempt=200, session=50.0))
    merged = put(user, usage_doc(fetched_at=200, attempt=250, session=75.0))
    assert merged["snapshot"]["sessionPercent"] == 75.0


def test_rev_never_regresses(user):
    d1 = put(user, usage_doc(100, 100))
    stale = usage_doc(50, 50)
    stale["rev"] = 0
    d2 = put(user, stale)
    assert d2["rev"] == d1["rev"] + 1


def test_last_attempt_only_advances(user):
    put(user, usage_doc(fetched_at=100, attempt=500))
    merged = put(user, usage_doc(fetched_at=600, attempt=300))
    assert merged["lastAttemptAt"] == 500
    assert merged["snapshot"]["fetchedAt"] == 600  # newer snapshot still applies
