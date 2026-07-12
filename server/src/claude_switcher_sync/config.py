import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_path: str = "/data/switcher.db"
    host: str = "0.0.0.0"
    port: int = 8787
    # Empty string = open registration.
    registration_token: str = ""
    # Sliding-window request limits. Authed traffic is keyed per user and all of a
    # user's windows share the bucket (~16 req/min each: rev-poll + heartbeat +
    # occasional snapshot/locks), so the default leaves room for a few dozen windows.
    # Unauthenticated traffic (register / salt lookup) is keyed per IP and kept
    # tight since it is the online brute-force surface.
    rate_auth_per_min: int = 600
    rate_unauth_per_min: int = 10
    # Uvicorn access log (one line per request) — off by default; the rev-poll
    # makes it pure noise. CAS_ACCESS_LOG=1 turns it back on.
    access_log: bool = False
    # Application event log level. INFO = meaningful events (registrations, account
    # writes, presence changes, lock steals, auth failures); DEBUG adds usage writes
    # and normal lock cycles.
    log_level: str = "INFO"
    # Encrypted credential blobs are ~1KB; anything near the cap is abuse.
    max_secret_bytes: int = 16 * 1024


def from_env() -> Settings:
    return Settings(
        db_path=os.environ.get("CAS_DB_PATH", Settings.db_path),
        host=os.environ.get("CAS_HOST", Settings.host),
        port=int(os.environ.get("CAS_PORT", Settings.port)),
        registration_token=os.environ.get("CAS_REGISTRATION_TOKEN", ""),
        rate_auth_per_min=int(os.environ.get("CAS_RATE_AUTH_PER_MIN", Settings.rate_auth_per_min)),
        rate_unauth_per_min=int(
            os.environ.get("CAS_RATE_UNAUTH_PER_MIN", Settings.rate_unauth_per_min)
        ),
        access_log=os.environ.get("CAS_ACCESS_LOG", "0") in ("1", "true", "yes"),
        log_level=os.environ.get("CAS_LOG_LEVEL", Settings.log_level).upper(),
    )
