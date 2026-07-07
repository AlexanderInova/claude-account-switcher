import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CredentialsManager } from "../src/credentials";
import { acquireLock, releaseLock, withLock } from "../src/lockFile";
import { refreshTokenHash, SecretVault, SecretStorageLike } from "../src/secretVault";
import { SharedStore } from "../src/store";
import { AccountFile, OAuthCreds, UsageSnapshot } from "../src/types";
import { errorSnapshot, isDue, parseUsage, pickFreeCredential } from "../src/usage";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? "  PASS" : "  FAIL") + " - " + name);
  if (!cond) failures++;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const creds = (over: Partial<OAuthCreds> = {}): OAuthCreds => ({
  accessToken: "AAA",
  refreshToken: "ra",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["x"],
  ...over,
});

/** In-memory SecretStorage for the vault. */
function memSecrets(): SecretStorageLike {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k)),
    store: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
  };
}

async function main(): Promise<void> {
  console.log("parseUsage + labels:");
  const real = {
    limits: [
      { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: null },
      { kind: "weekly_all", group: "weekly", percent: 8, severity: "normal", resets_at: null },
    ],
  };
  const snap = parseUsage(real as never);
  check("2 windows from limits[]", snap.windows.length === 2);
  check("sessionPercent = 12", snap.sessionPercent === 12);
  check("weeklyPercent = 8", snap.weeklyPercent === 8);
  check("session label", snap.windows[0].label === "Session (5h)");
  check("weekly_all renamed to Weekly (7d)", snap.windows[1].label === "Weekly (7d)");

  const bare = parseUsage({ limits: [{ group: "weekly", percent: 3 }] } as never);
  check("bare weekly renamed to Weekly Fable", bare.windows[0].label === "Weekly Fable");

  const fb = parseUsage({ seven_day: { utilization: 90, resets_at: null } } as never);
  check("seven_day fallback label = Weekly (7d)", fb.windows[0].label === "Weekly (7d)");

  console.log("isDue:");
  const now = Date.now();
  const interval = 180_000;
  check("due when never fetched", isDue(now, interval, null) === true);
  check(
    "not due right after attempt",
    isDue(now, interval, {
      rev: 1,
      updatedAt: now,
      lastAttemptAt: now,
      snapshot: { fetchedAt: 0, windows: [], sessionPercent: null, weeklyPercent: null },
    }) === false
  );
  check(
    "not due while in retryAfter backoff",
    isDue(now, interval, {
      rev: 1,
      updatedAt: now,
      lastAttemptAt: 0,
      snapshot: {
        fetchedAt: 0,
        windows: [],
        sessionPercent: null,
        weeklyPercent: null,
        retryAfter: now + 60_000,
      },
    }) === false
  );
  check(
    "not due while capped at 100% until reset",
    isDue(now, interval, {
      rev: 1,
      updatedAt: now,
      lastAttemptAt: 0,
      snapshot: { fetchedAt: 0, windows: [], sessionPercent: 100, weeklyPercent: null, cappedUntil: now + 3_600_000 },
    }) === false
  );
  check(
    "due again once the cap has passed",
    isDue(now, interval, {
      rev: 1,
      updatedAt: now,
      lastAttemptAt: 0,
      snapshot: { fetchedAt: 0, windows: [], sessionPercent: 100, weeklyPercent: null, cappedUntil: now - 1000 },
    }) === true
  );

  console.log("cappedUntil from a maxed window:");
  const capReset = "2999-01-01T00:00:00.000Z";
  const capped = parseUsage({
    limits: [{ kind: "session", group: "session", percent: 100, resets_at: capReset }],
  } as never);
  check("session at 100% sets cappedUntil to its reset", capped.cappedUntil === Date.parse(capReset));
  const notCapped = parseUsage({
    limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }],
  } as never);
  check("no cap when reset time unknown", notCapped.cappedUntil === undefined);
  const opusMaxed = parseUsage({
    limits: [{ kind: "weekly_opus", group: "weekly", percent: 100, resets_at: capReset }],
  } as never);
  check("model-specific weekly (Opus) at 100% does not cap", opusMaxed.cappedUntil === undefined);

  console.log("errorSnapshot preserves prior data:");
  const prev: UsageSnapshot = {
    fetchedAt: 1000,
    windows: [{ kind: "session", label: "Session (5h)", percent: 42, severity: "normal", resetsAt: null }],
    sessionPercent: 42,
    weeklyPercent: 7,
  };
  const errSnap = errorSnapshot(prev, { error: "boom", status: 500 }, now);
  check("keeps windows", errSnap.windows.length === 1 && errSnap.sessionPercent === 42);
  check("keeps original fetchedAt (honest 'X ago')", errSnap.fetchedAt === 1000);
  check("sets error + errorAt", errSnap.error === "boom" && errSnap.errorAt === now);
  const rl = errorSnapshot(prev, { error: "rl", status: 429, retryAfter: now + 5000 }, now);
  check("429 sets retryAfter", rl.retryAfter === now + 5000);

  console.log("pickFreeCredential:");
  const acctFile: AccountFile = {
    version: 1,
    rev: 1,
    updatedAt: now,
    account: { uuid: "u1", label: "A", order: 0, addedAt: now, updatesEnabled: true },
    credentials: [
      { id: "c1", addedAt: now, expiresAt: now, refreshTokenHash: "h1", invalid: { at: now, detail: "x" } },
      { id: "c2", addedAt: now, expiresAt: now, refreshTokenHash: "h2", lease: { instanceId: "i", at: now } },
      { id: "c3", addedAt: now, expiresAt: now, refreshTokenHash: "h3" },
    ],
  };
  check("skips invalid + freshly-leased, picks c3", pickFreeCredential(acctFile, now)?.id === "c3");
  check(
    "reclaims a stale lease",
    pickFreeCredential(
      { ...acctFile, credentials: [acctFile.credentials[1]] },
      now + 130_000
    )?.id === "c2"
  );

  console.log("SecretVault + hash:");
  const vault = new SecretVault(memSecrets());
  const c = creds();
  await vault.put("id1", c);
  check("get round-trips", (await vault.get("id1"))?.accessToken === "AAA");
  check("getVerified matches hash", (await vault.getVerified("id1", refreshTokenHash(c)))?.refreshToken === "ra");
  check("getVerified rejects wrong hash", (await vault.getVerified("id1", "deadbeef")) === null);
  await vault.remove("id1");
  check("remove clears", (await vault.get("id1")) === null);

  console.log("lockFile:");
  const lockDir = tmpDir("cas-lock-");
  const lp = path.join(lockDir, "a.lock");
  const h = await acquireLock(lp);
  check("acquire succeeds", h !== null);
  // stale steal
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lp, past, past);
  const h2 = await acquireLock(lp);
  check("steals a stale lock", h2 !== null);
  if (h2) releaseLock(h2);
  check("release removes the file", !fs.existsSync(lp));
  // mutual exclusion under withLock
  let counter = 0;
  const inc = () =>
    withLock(lp, async () => {
      const v = counter;
      await new Promise((r) => setTimeout(r, 20));
      counter = v + 1;
    });
  await Promise.all([inc(), inc()]);
  check("withLock serializes (no lost update)", counter === 2);
  fs.rmSync(lockDir, { recursive: true, force: true });

  console.log("SharedStore:");
  const storeDir = tmpDir("cas-store-");
  const store = new SharedStore(storeDir);
  store.ensureLayout();
  check("gitignore created with *", fs.readFileSync(path.join(storeDir, ".gitignore"), "utf8").includes("*"));
  check("layout dirs exist", fs.existsSync(path.join(storeDir, "accounts")) && fs.existsSync(path.join(storeDir, "locks")));

  const af: AccountFile = {
    version: 1,
    rev: 0,
    updatedAt: 0,
    account: { uuid: "acc-1", label: "Work", order: 0, addedAt: now, updatesEnabled: true },
    credentials: [],
  };
  store.writeAccount(af);
  check("account round-trips", store.readAccount("acc-1")?.account.label === "Work");
  check("writeAccount bumps rev", (store.readAccount("acc-1")?.rev ?? 0) >= 1);
  check("listAccountUuids finds it", store.listAccountUuids().includes("acc-1"));

  const sig1 = store.revSignature();
  store.writeUsage("acc-1", {
    rev: 0,
    updatedAt: 0,
    lastAttemptAt: now,
    snapshot: { fetchedAt: now, windows: [], sessionPercent: 5, weeklyPercent: 1 },
  });
  check("revSignature changes after a write", store.revSignature() !== sig1);

  // withAccountLock RMW is serialized
  const bump = () =>
    store.withAccountLock("acc-1", async () => {
      const f = store.readAccount("acc-1")!;
      const o = f.account.order;
      await new Promise((r) => setTimeout(r, 15));
      f.account.order = o + 1;
      store.writeAccount(f);
    });
  await Promise.all([bump(), bump(), bump()]);
  check("locked RMW has no lost updates", store.readAccount("acc-1")?.account.order === 3);

  // instances cleanup
  store.writeInstance({
    instanceId: "live",
    hostname: "h",
    pid: 1,
    workspaceName: "w",
    startedAt: now,
    heartbeatAt: now,
  });
  store.writeInstance({
    instanceId: "dead",
    hostname: "h",
    pid: 2,
    workspaceName: "w2",
    startedAt: now - 200_000,
    heartbeatAt: now - 200_000,
  });
  const live = store.listLiveInstances(now);
  check("stale instance filtered + cleaned", live.length === 1 && live[0].instanceId === "live");

  store.deleteAccount("acc-1");
  check("deleteAccount removes files", store.readAccount("acc-1") === null && store.readUsage("acc-1") === null);
  fs.rmSync(storeDir, { recursive: true, force: true });

  console.log("deploy crash-safety (store + vault mechanics):");
  const d2 = tmpDir("cas-deploy-");
  const st = new SharedStore(d2);
  st.ensureLayout();
  const v2 = new SecretVault(memSecrets());
  const dc = creds({ refreshToken: "rr" });
  const credId = "cred-x";
  await v2.put(credId, dc);
  st.writeAccount({
    version: 1,
    rev: 0,
    updatedAt: 0,
    account: { uuid: "acc-2", label: "B", order: 0, addedAt: now, updatesEnabled: true },
    credentials: [{ id: credId, addedAt: now, expiresAt: dc.expiresAt, refreshTokenHash: refreshTokenHash(dc) }],
  });
  // deploy step: remove reference first
  await st.withAccountLock("acc-2", () => {
    const f = st.readAccount("acc-2")!;
    f.credentials = f.credentials.filter((x) => x.id !== credId);
    st.writeAccount(f);
  });
  check("reference removed before local write", st.readAccount("acc-2")!.credentials.length === 0);
  check("secret blob still present for recovery", (await v2.get(credId)) !== null);
  // recovery (write did NOT land): reinsert
  const rec = await v2.get(credId);
  await st.withAccountLock("acc-2", () => {
    const f = st.readAccount("acc-2")!;
    f.credentials.push({ id: credId, addedAt: now, expiresAt: rec!.expiresAt, refreshTokenHash: refreshTokenHash(rec!) });
    st.writeAccount(f);
  });
  check("recovery returns the credential to the pool (nothing lost)", st.readAccount("acc-2")!.credentials.length === 1);
  fs.rmSync(d2, { recursive: true, force: true });

  console.log("CredentialsManager (temp file):");
  const credDirRoot = tmpDir("cas-cred-");
  const credPath = path.join(credDirRoot, ".credentials.json");
  process.env.TEST_CRED_PATH = credPath;
  const mgr = new CredentialsManager();
  check("path resolves to override", mgr.getCredentialsPath() === credPath);
  mgr.writeCreds(creds({ accessToken: "AAA" }));
  check("write + read", mgr.readCurrent()?.accessToken === "AAA");
  fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: creds({ accessToken: "BBB" }), otherField: 123 }));
  mgr.writeCreds(creds({ accessToken: "CCC" }));
  const rawAfter = JSON.parse(fs.readFileSync(credPath, "utf8"));
  check("preserves extra fields on write", rawAfter.otherField === 123 && rawAfter.claudeAiOauth.accessToken === "CCC");
  mgr.clearLocal();
  const rawCleared = JSON.parse(fs.readFileSync(credPath, "utf8"));
  check("clearLocal removes claudeAiOauth but keeps extras", rawCleared.claudeAiOauth === undefined && rawCleared.otherField === 123);
  check("readCurrent null after clear", mgr.readCurrent() === null);
  fs.rmSync(credDirRoot, { recursive: true, force: true });

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
