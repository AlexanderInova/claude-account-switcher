/**
 * Smoke tests for the sync-server client layer (crypto, http retries,
 * RemoteVault, ServerStore, RotationRecovery, folder migration).
 *
 * Runs against the in-memory FakeSyncServer by default; set SERVER_URL to run
 * the same suite against a real server (contract test) — fault-injection and
 * fake-introspection checks are skipped there.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decryptBlob, deriveKeys, encryptBlob, newSaltHex, verifierFromAuthKey } from "../src/serverSync/crypto";
import { RETRY_AGGRESSIVE, SyncHttp } from "../src/serverSync/http";
import { RemoteVault } from "../src/serverSync/remoteVault";
import { ServerStore } from "../src/serverSync/serverStore";
import { MementoLike, RotationRecovery } from "../src/serverSync/rotationRecovery";
import { unlock } from "../src/serverSync/session";
import { folderHasAccounts, migrateFolderToServer, readMigratedMarker, writeMigratedMarker } from "../src/serverSync/migrateFolder";
import { SecretStorageLike, SecretVault, refreshTokenHash } from "../src/secretVault";
import { SharedStore } from "../src/store";
import { AccountFile, OAuthCreds, UsageFile } from "../src/types";
import { FakeSyncServer } from "./fakeSyncServer";

const REAL = !!process.env.SERVER_URL;
const BASE = process.env.SERVER_URL ?? "http://fake.test";
// Unique per run so re-running against a persistent real server starts clean.
const RUN = Math.random().toString(36).slice(2, 8);
const USER = `smoke-${RUN}@example.com`;

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? "  PASS" : "  FAIL") + " - " + name);
  if (!cond) failures++;
}

function creds(tag: string, expiresAt = Date.now() + 3_600_000): OAuthCreds {
  return {
    accessToken: `acc-${tag}`,
    refreshToken: `ref-${tag}`,
    expiresAt,
    scopes: ["user:inference"],
  };
}

function accountFile(uuid: string, label: string): AccountFile {
  return {
    version: 1,
    rev: 0,
    updatedAt: 0,
    account: { uuid, label, order: 1, addedAt: 1, updatesEnabled: true },
    credentials: [],
  };
}

function usageFile(fetchedAt: number, session: number): UsageFile {
  return {
    rev: 0,
    updatedAt: 0,
    lastAttemptAt: fetchedAt,
    snapshot: { fetchedAt, windows: [], sessionPercent: session, weeklyPercent: null },
  };
}

class MemorySecrets implements SecretStorageLike {
  map = new Map<string, string>();
  async get(k: string): Promise<string | undefined> {
    return this.map.get(k);
  }
  async store(k: string, v: string): Promise<void> {
    this.map.set(k, v);
  }
  async delete(k: string): Promise<void> {
    this.map.delete(k);
  }
}

class MemoryMemento implements MementoLike {
  map = new Map<string, unknown>();
  get<T>(k: string, def: T): T {
    return (this.map.has(k) ? this.map.get(k) : def) as T;
  }
  async update(k: string, v: unknown): Promise<void> {
    this.map.set(k, v);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const fake = new FakeSyncServer();
  if (!REAL) {
    fake.install();
  }

  // --- crypto ---
  console.log("crypto:");
  const salt = newSaltHex();
  const k1 = await deriveKeys("correct horse", salt);
  const k1b = await deriveKeys("correct horse", salt);
  const k2 = await deriveKeys("wrong horse", salt);
  check("derivation is deterministic", k1.encKeyHex === k1b.encKeyHex && k1.authKeyHex === k1b.authKeyHex);
  check("different passphrase, different keys", k1.encKeyHex !== k2.encKeyHex);
  check("enc and auth keys differ", k1.encKeyHex !== k1.authKeyHex);
  const blob = encryptBlob(k1.encKeyHex, '{"hello":"world"}');
  check("round-trip decrypt", decryptBlob(k1.encKeyHex, blob) === '{"hello":"world"}');
  check("wrong key decrypts to null", decryptBlob(k2.encKeyHex, blob) === null);
  const tampered = Buffer.from(blob, "base64");
  tampered[14] ^= 0xff;
  check("tampered blob decrypts to null", decryptBlob(k1.encKeyHex, tampered.toString("base64")) === null);
  check("nonces are random (same input, new ciphertext)", encryptBlob(k1.encKeyHex, "x") !== encryptBlob(k1.encKeyHex, "x"));
  check("verifier is 64 hex chars", /^[0-9a-f]{64}$/.test(verifierFromAuthKey(k1.authKeyHex)));

  // --- unlock / registration ---
  console.log("unlock:");
  const noReg = await unlock(BASE, USER, "pass-1");
  check("unknown user reports needsRegistration", !noReg.ok && noReg.needsRegistration === true);
  const reg = await unlock(BASE, USER, "pass-1", { register: true });
  check("registration unlocks", reg.ok && reg.registered);
  const again = await unlock(BASE, USER, "pass-1");
  check("re-unlock with same passphrase", again.ok && !(again as { registered?: boolean }).registered);
  const wrong = await unlock(BASE, USER, "pass-2");
  check("wrong passphrase rejected (takeover guard)", !wrong.ok && /passphrase/i.test(!wrong.ok ? wrong.error : ""));
  if (!reg.ok || !again.ok) {
    throw new Error("cannot continue without a session");
  }
  const session = again.session;
  check("re-derived keys match registration", session.encKeyHex === reg.session.encKeyHex);

  const http = new SyncHttp(BASE, USER, session.authKeyHex);
  const vault = new RemoteVault(http, session.encKeyHex);

  // --- RemoteVault ---
  console.log("remoteVault:");
  const c1 = creds("one");
  await vault.put("cred-1", c1);
  const got = await vault.get("cred-1");
  check("put/get round-trip", got?.accessToken === "acc-one" && got?.refreshToken === "ref-one");
  check("missing secret is null", (await vault.get("cred-missing")) === null);
  check("getVerified matches hash", (await vault.getVerified("cred-1", refreshTokenHash(c1)))?.accessToken === "acc-one");
  const wrongVault = new RemoteVault(new SyncHttp(BASE, USER, session.authKeyHex), k2.encKeyHex);
  check("foreign key reads as orphaned (null)", (await wrongVault.get("cred-1")) === null);
  if (!REAL) {
    const stored = fake.pools.get(USER)!.secrets.get("cred-1")!;
    check("server never sees plaintext", !stored.includes("acc-one") && !Buffer.from(stored, "base64").toString("latin1").includes("ref-one"));
    fake.failNext(2, 500);
    await vault.put("cred-1", c1);
    check("aggressive retry survives two 500s", (await vault.get("cred-1"))?.accessToken === "acc-one");
    fake.failNext(1, "network");
    await vault.put("cred-1", c1);
    check("aggressive retry survives a network error", (await vault.get("cred-1"))?.accessToken === "acc-one");
  }
  await vault.remove("cred-1");
  check("remove deletes", (await vault.get("cred-1")) === null);

  // --- ServerStore ---
  console.log("serverStore:");
  const store = new ServerStore(http, "win-1", "server-test", 150);
  await store.init();
  check("starts reachable with empty pool", store.status().reachable && store.listAccounts().length === 0);

  await store.writeAccount(accountFile("u1", "Alpha"));
  const readBack = store.readAccount("u1");
  check("write-through cache read", readBack?.account.label === "Alpha" && readBack.rev === 1);
  const sigAfterWrite = store.revSignature();
  readBack!.account.label = "MUTATED";
  check("reads are clones (cache uncorrupted)", store.readAccount("u1")!.account.label === "Alpha");

  // A second client (another window) writes; our rev-poll must pick it up and fire watch.
  const http2 = new SyncHttp(BASE, USER, session.authKeyHex);
  const store2 = new ServerStore(http2, "win-2", "server-test-2", 150);
  await store2.init();
  let watchFired = 0;
  const watchers = store.watch(() => watchFired++);
  await store2.writeAccount(accountFile("u2", "Beta"));
  await sleep(500);
  check("rev-poll sees another window's write", store.readAccount("u2")?.account.label === "Beta");
  check("watch fired on external change", watchFired > 0);
  check("revSignature advanced", store.revSignature() !== sigAfterWrite);

  // Gap detection: two external writes between polls must not be half-applied.
  await store2.writeAccount(accountFile("u3", "Gamma"));
  await store2.writeUsage("u3", usageFile(1_000, 10));
  await store.writeAccount(accountFile("u4", "Delta")); // our own write, poolRev gap > 1
  await sleep(500);
  check("gap after own write triggers snapshot (sees u3 + usage)", store.readAccount("u3") !== null && store.readUsage("u3") !== null);

  // Monotonic usage via the server merge.
  await store.writeUsage("u1", usageFile(2_000, 50));
  await store.writeUsage("u1", usageFile(1_500, 5));
  check("stale usage write keeps fresher snapshot", store.readUsage("u1")!.snapshot.sessionPercent === 50);

  // Lock freshness: store2 changes u1 behind store's back; the lock response must deliver it.
  await store2.withAccountLock("u1", async () => {
    const f = store2.readAccount("u1")!;
    f.account.label = "Alpha-renamed";
    await store2.writeAccount(f);
  });
  const seenInLock = await store.withAccountLock("u1", () => store.readAccount("u1")!.account.label);
  check("lock installs fresh docs before callback", seenInLock === "Alpha-renamed");

  // Contention: while store2 holds the lock, store must give up with undefined.
  const blocked = await store2.withAccountLock("u1", async () => {
    return await store.withAccountLock("u1", () => "should-not-run");
  });
  check("held lock yields undefined for others", blocked === undefined);

  // Release on throw + TTL steal.
  await store.withAccountLock("u1", () => {
    throw new Error("boom");
  }).catch(() => {});
  check("lock released after callback throw", (await store2.withAccountLock("u1", () => "ok")) === "ok");
  const rawLock = await http.request("POST", "/v1/pool/locks/u1", { body: { owner: "zombie", ttlMs: 300 } });
  check("raw short-ttl lock acquired", rawLock.status === 200);
  await sleep(450);
  check("expired lock is stolen", (await store.withAccountLock("u1", () => "stolen")) === "stolen");

  // Presence + cooldown + delete.
  await store.writeInstance({ instanceId: "i-1", hostname: "h", pid: 1, workspaceName: "w", startedAt: 1, heartbeatAt: 1 });
  await sleep(400);
  check("instance visible to the other window", store2.listLiveInstances(Date.now()).some((i) => i.instanceId === "i-1"));
  await store.setCooldownUntil(4_242);
  check("cooldown write-through", store.cooldownUntil() === 4_242);
  await store.deleteAccount("u4");
  check("delete removes from cache", store.readAccount("u4") === null);
  await sleep(400);
  check("delete propagates to the other window", store2.readAccount("u4") === null);

  // --- RotationRecovery ---
  console.log("rotationRecovery:");
  const secrets = new MemorySecrets();
  const memento = new MemoryMemento();
  const rec = new RotationRecovery(secrets, memento);
  const rotated = creds("rotated");
  await rec.journal("cred-rot", rotated);
  check("journal indexed", rec.pendingIds().includes("cred-rot"));
  // Simulated crash: a NEW instance over the same storage must find and push it.
  const rec2 = new RotationRecovery(secrets, memento);
  // A push that can't land (401 — not retryable) must keep the journal entry.
  const badVault = new RemoteVault(new SyncHttp(BASE, USER, "00".repeat(32)), session.encKeyHex);
  check("push failure keeps journal", (await rec2.retryPending(badVault)) === 0 && rec2.pendingIds().length === 1);
  const flushed = await rec2.retryPending(vault);
  check("retryPending pushes after recovery", flushed === 1 && rec2.pendingIds().length === 0);
  check("rotated token reachable on server", (await vault.get("cred-rot"))?.refreshToken === "ref-rotated");
  check("noop instance is inert", RotationRecovery.noop().pendingIds().length === 0);

  // --- folder migration ---
  console.log("migrateFolder:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-migrate-"));
  const folder = new SharedStore(dir);
  await folder.init();
  const localSecrets = new MemorySecrets();
  const localVault = new SecretVault(localSecrets);
  const mCreds = creds("migrate-a");
  const dupCreds = creds("migrate-dup");
  await localVault.put("ref-a", mCreds);
  await localVault.put("ref-dup", dupCreds);
  const mig = accountFile("acc-m", "Migrated");
  mig.credentials = [
    { id: "ref-a", addedAt: 1, expiresAt: mCreds.expiresAt, refreshTokenHash: refreshTokenHash(mCreds), lease: { instanceId: "old", at: 1 } },
    { id: "ref-dup", addedAt: 2, expiresAt: dupCreds.expiresAt, refreshTokenHash: refreshTokenHash(dupCreds) },
    { id: "ref-orphan", addedAt: 3, expiresAt: 99, refreshTokenHash: "deadbeefdeadbeef" },
  ];
  await folder.writeAccount(mig);
  await folder.writeUsage("acc-m", usageFile(3_000, 33));
  // Pre-seed the duplicate on the server under a different ref id.
  await vault.put("server-dup", dupCreds);
  const preexisting = accountFile("acc-m", "Already there");
  preexisting.credentials = [
    { id: "server-dup", addedAt: 5, expiresAt: dupCreds.expiresAt, refreshTokenHash: refreshTokenHash(dupCreds) },
  ];
  await store.writeAccount(preexisting);

  const summary = await migrateFolderToServer(folder, localVault, store, vault);
  check("summary counts", summary.accounts === 1 && summary.credentials === 1 && summary.skippedDuplicates === 1 && summary.orphanedRefs === 1);
  const migrated = store.readAccount("acc-m")!;
  check("existing server meta kept", migrated.account.label === "Already there");
  check("lease stripped + creds merged", migrated.credentials.length === 2 && migrated.credentials.every((c) => !c.lease));
  check("migrated blob reachable", (await vault.getVerified("ref-a", refreshTokenHash(mCreds)))?.accessToken === "acc-migrate-a");
  check("usage migrated", store.readUsage("acc-m")?.snapshot.sessionPercent === 33);
  check("re-run is a no-op", (await migrateFolderToServer(folder, localVault, store, vault)).credentials === 0);
  check("folderHasAccounts true before marker", folderHasAccounts(dir));
  writeMigratedMarker(dir, { migratedAt: 42, serverUrl: BASE, userId: USER });
  const marker = readMigratedMarker(dir);
  check("marker round-trip", marker?.migratedAt === 42 && marker.serverUrl === BASE);
  fs.rmSync(dir, { recursive: true, force: true });

  // --- auth failure surfacing ---
  if (!REAL) {
    console.log("auth:");
    let authFailures = 0;
    const badHttp = new SyncHttp(BASE, USER, "00".repeat(32), () => authFailures++);
    const res = await badHttp.request("GET", "/v1/pool/rev");
    await badHttp.request("GET", "/v1/pool/rev");
    check("401 surfaced once via onAuthFailure", res.status === 401 && authFailures === 1);
  }

  watchers.forEach((w) => w.close());
  store.dispose();
  store2.dispose();
  if (!REAL) {
    fake.uninstall();
  }

  console.log(failures === 0 ? "\nSERVER-SMOKE PASS" : `\n${failures} SERVER-SMOKE FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
