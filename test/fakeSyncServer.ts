import * as crypto from "crypto";
import { AccountFile, InstanceInfo, UsageFile } from "../src/types";

/**
 * In-memory sync server mirroring server/src/claude_switcher_sync semantics,
 * installed as globalThis.fetch for the TS smoke tests. Also supports fault
 * injection (fail the next N pool requests) to exercise retry policies.
 */

interface UserRecord {
  saltHex: string;
  verifierSha256: string;
}

interface Pool {
  rev: number;
  accounts: Map<string, AccountFile>;
  usage: Map<string, UsageFile>;
  instances: Map<string, InstanceInfo>;
  cooldownUntil: number;
  locks: Map<string, { owner: string; expiresAt: number }>;
  secrets: Map<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class FakeSyncServer {
  users = new Map<string, UserRecord>();
  pools = new Map<string, Pool>();
  registrationToken = "";
  /** Pending injected failures for /v1/pool requests: [status or "network", count]. */
  private failQueue: Array<number | "network"> = [];
  requestLog: string[] = [];
  private realFetch: typeof fetch | undefined;

  failNext(n: number, status: number | "network" = 500): void {
    for (let i = 0; i < n; i++) {
      this.failQueue.push(status);
    }
  }

  private pool(userId: string): Pool {
    let p = this.pools.get(userId);
    if (!p) {
      p = {
        rev: 0,
        accounts: new Map(),
        usage: new Map(),
        instances: new Map(),
        cooldownUntil: 0,
        locks: new Map(),
        secrets: new Map(),
      };
      this.pools.set(userId, p);
    }
    return p;
  }

  install(): void {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.handle(input, init)) as typeof fetch;
  }

  uninstall(): void {
    if (this.realFetch) {
      globalThis.fetch = this.realFetch;
    }
  }

  private auth(headers: Headers): string | null {
    const bearer = (headers.get("authorization") ?? "").replace(/^bearer /i, "").trim();
    const userId = headers.get("x-cas-user") ?? "";
    const user = this.users.get(userId);
    if (!bearer || !user) {
      return null;
    }
    let verifier: string;
    try {
      verifier = crypto.createHash("sha256").update(Buffer.from(bearer, "hex")).digest("hex");
    } catch {
      return null;
    }
    return verifier === user.verifierSha256 ? userId : null;
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const p = url.pathname;
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.requestLog.push(`${method} ${p}`);

    if (p.startsWith("/v1/pool") && this.failQueue.length > 0) {
      const fail = this.failQueue.shift()!;
      if (fail === "network") {
        throw new TypeError("fetch failed (injected)");
      }
      return json(fail, { detail: "injected failure" });
    }

    if (p === "/healthz") {
      return json(200, { ok: true });
    }
    if (p === "/v1/users" && method === "POST") {
      if (this.registrationToken && body.registrationToken !== this.registrationToken) {
        return json(403, { detail: "Registration token required" });
      }
      const userId = String(body.userId ?? "");
      if (!/^[A-Za-z0-9._@-]{3,64}$/.test(userId)) {
        return json(422, { detail: "Invalid user id" });
      }
      if (this.users.has(userId)) {
        return json(409, { detail: "User already exists" });
      }
      this.users.set(userId, {
        saltHex: String(body.saltHex),
        verifierSha256: String(body.verifierSha256),
      });
      return json(201, { ok: true });
    }
    const saltMatch = p.match(/^\/v1\/users\/([^/]+)\/salt$/);
    if (saltMatch && method === "GET") {
      const user = this.users.get(decodeURIComponent(saltMatch[1]));
      return user ? json(200, { saltHex: user.saltHex }) : json(404, { detail: "Unknown user" });
    }

    if (!p.startsWith("/v1/pool")) {
      return json(404, { detail: "Not found" });
    }
    const userId = this.auth(headers);
    if (!userId) {
      return json(401, { detail: "Invalid credentials" });
    }
    const pool = this.pool(userId);
    const now = Date.now();

    if (p === "/v1/pool/rev") {
      return json(200, { rev: pool.rev });
    }
    if (p === "/v1/pool/snapshot") {
      for (const [id, i] of pool.instances) {
        if (now - i.heartbeatAt > 90_000) {
          pool.instances.delete(id);
        }
      }
      for (const [id, l] of pool.locks) {
        if (l.expiresAt < now) {
          pool.locks.delete(id);
        }
      }
      return json(200, {
        rev: pool.rev,
        now,
        accounts: [...pool.accounts.values()],
        usage: Object.fromEntries(pool.usage),
        instances: [...pool.instances.values()],
        cooldownUntil: pool.cooldownUntil,
      });
    }

    let m = p.match(/^\/v1\/pool\/accounts\/([^/]+)$/);
    if (m) {
      const uuid = decodeURIComponent(m[1]);
      if (method === "GET") {
        const doc = pool.accounts.get(uuid);
        return doc ? json(200, doc) : json(404, { detail: "No such account" });
      }
      if (method === "PUT") {
        const incoming = body as unknown as AccountFile;
        if (incoming.account?.uuid !== uuid) {
          return json(422, { detail: "account.uuid must match the path" });
        }
        const rev = (pool.accounts.get(uuid)?.rev ?? 0) + 1;
        const doc: AccountFile = { ...incoming, rev, updatedAt: now, version: 1 };
        pool.accounts.set(uuid, doc);
        pool.rev++;
        return json(200, { poolRev: pool.rev, doc });
      }
      if (method === "DELETE") {
        pool.accounts.delete(uuid);
        pool.usage.delete(uuid);
        pool.locks.delete(uuid);
        pool.rev++;
        return json(200, { poolRev: pool.rev });
      }
    }

    m = p.match(/^\/v1\/pool\/usage\/([^/]+)$/);
    if (m && method === "PUT") {
      const uuid = decodeURIComponent(m[1]);
      const incoming = body as unknown as UsageFile;
      const current = pool.usage.get(uuid);
      const keepCurrent =
        !!current && current.snapshot.fetchedAt > (incoming.snapshot?.fetchedAt ?? 0);
      const doc: UsageFile = {
        rev: (current?.rev ?? 0) + 1,
        updatedAt: now,
        lastAttemptAt: Math.max(current?.lastAttemptAt ?? 0, incoming.lastAttemptAt ?? 0),
        snapshot: keepCurrent ? current.snapshot : incoming.snapshot,
      };
      pool.usage.set(uuid, doc);
      pool.rev++;
      return json(200, { poolRev: pool.rev, doc });
    }

    m = p.match(/^\/v1\/pool\/instances\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === "PUT") {
        // Mirrors the real server: a pure keep-alive (content unchanged apart from
        // heartbeatAt) refreshes the timestamp without bumping the pool revision.
        const strip = (d: InstanceInfo): Partial<InstanceInfo> => ({ ...d, heartbeatAt: 0 });
        const old = pool.instances.get(id);
        const incoming = body as unknown as InstanceInfo;
        const changed = !old || JSON.stringify(strip(old)) !== JSON.stringify(strip(incoming));
        pool.instances.set(id, { ...incoming, heartbeatAt: now });
        if (changed) {
          pool.rev++;
        }
        return json(200, { poolRev: pool.rev });
      }
      if (method === "DELETE") {
        pool.instances.delete(id);
        pool.rev++;
        return new Response(null, { status: 204 });
      }
    }

    if (p === "/v1/pool/cooldown" && method === "PUT") {
      pool.cooldownUntil = Number(body.cooldownUntil ?? 0);
      pool.rev++;
      return json(200, { poolRev: pool.rev });
    }

    m = p.match(/^\/v1\/pool\/locks\/([^/]+)$/);
    if (m) {
      const uuid = decodeURIComponent(m[1]);
      if (method === "POST") {
        const owner = String(body.owner);
        const ttl = Math.max(1, Math.min(Number(body.ttlMs ?? 30_000), 60_000));
        const held = pool.locks.get(uuid);
        if (held && held.expiresAt >= now && held.owner !== owner) {
          return json(423, { expiresAt: held.expiresAt });
        }
        const expiresAt = now + ttl;
        pool.locks.set(uuid, { owner, expiresAt });
        return json(200, {
          expiresAt,
          account: pool.accounts.get(uuid) ?? null,
          usage: pool.usage.get(uuid) ?? null,
        });
      }
      if (method === "DELETE") {
        const owner = url.searchParams.get("owner");
        const held = pool.locks.get(uuid);
        if (held && held.owner === owner) {
          pool.locks.delete(uuid);
        }
        return new Response(null, { status: 204 });
      }
    }

    m = p.match(/^\/v1\/pool\/secrets\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === "GET") {
        const blob = pool.secrets.get(id);
        return blob !== undefined ? json(200, { blob }) : json(404, { detail: "No such secret" });
      }
      if (method === "PUT") {
        const blob = String(body.blob ?? "");
        if (blob.length > 16 * 1024) {
          return json(413, { detail: "Blob too large" });
        }
        pool.secrets.set(id, blob);
        return json(200, { ok: true });
      }
      if (method === "DELETE") {
        pool.secrets.delete(id);
        return new Response(null, { status: 204 });
      }
    }

    return json(404, { detail: "Not found" });
  }
}
