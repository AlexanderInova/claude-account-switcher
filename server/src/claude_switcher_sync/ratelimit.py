"""In-process sliding-window rate limiter.

Authenticated pool traffic is keyed by the claimed user id; everything else
(registration, salt lookup — the online brute-force surface) by client IP.
Good enough for a single-process self-hosted service; not shared across
workers (run with one worker, the default).
"""

import time
from collections import deque

from fastapi import Request
from fastapi.responses import JSONResponse

from .config import Settings


class SlidingWindow:
    def __init__(self, limit_per_min: int):
        self.limit = limit_per_min
        self.hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self.hits.setdefault(key, deque())
        while q and now - q[0] > 60.0:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        # Opportunistic cleanup so idle keys don't accumulate forever.
        if len(self.hits) > 10_000:
            for k in [k for k, v in self.hits.items() if not v]:
                del self.hits[k]
        return True


def make_middleware(settings: Settings):
    authed = SlidingWindow(settings.rate_auth_per_min)
    unauthed = SlidingWindow(settings.rate_unauth_per_min)

    async def limiter(request: Request, call_next):
        path = request.url.path
        if path == "/healthz":
            return await call_next(request)
        if path.startswith("/v1/pool"):
            key = request.headers.get("x-cas-user") or (
                request.client.host if request.client else "?"
            )
            ok = authed.allow("u:" + key)
        else:
            key = request.client.host if request.client else "?"
            ok = unauthed.allow("ip:" + key)
        if not ok:
            return JSONResponse(
                {"detail": "Rate limit exceeded"}, status_code=429, headers={"Retry-After": "30"}
            )
        return await call_next(request)

    return limiter
