import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_path: str = "/data/switcher.db"
    host: str = "0.0.0.0"
    port: int = 8787
    # Empty string = open registration.
    registration_token: str = ""
    # Sliding-window request limits. Authed traffic is keyed per user
    # (rev-poll at ~12/min + heartbeats + writes fit comfortably in 240);
    # unauthenticated traffic (register / salt lookup) is keyed per IP and
    # kept tight since it is the online brute-force surface.
    rate_auth_per_min: int = 240
    rate_unauth_per_min: int = 10
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
    )
