// Tests for lib/index.js /dshpkg request authorization (Phase 0 security).
// No real request is made — authorizeRequest and the guard predicates are
// pure functions; the token store is isolated to a temp DSH_PKG_HOME so a
// real ~/.dsh/dshpkg api-token is never created or read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeRequest,
  isLoopback,
  hasLoopbackAddr,
  isSameOrigin,
  hasOriginHeader,
  verifyToken,
  hostInstall,
  bootReconcile,
  armBootGuard,
  resetBootGuardForTests,
  routeMetrics,
} from "../lib/index.js";
import { readApiToken, readState, readIncidents, writeState, statePath, appendIncident } from "../lib/state.js";

/** Point DSH_PKG_HOME at a fresh temp state root for one test; restore it. */
async function usePkgHome(t) {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-idx-state-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });
  return root;
}

function req({ method = "GET", origin, host, addr, token } = {}) {
  return {
    method,
    headers: {
      host,
      ...(origin !== undefined ? { origin } : {}),
      ...(token !== undefined ? { "x-dshpkg-token": token } : {}),
    },
    socket: addr !== undefined ? { remoteAddress: addr } : {},
  };
}

const HOST = "127.0.0.1:3080";

test("GET /status from a same-origin loopback browser is allowed (no token)", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "GET", host: HOST, origin: `http://${HOST}`, addr: "127.0.0.1" });
  assert.deepEqual(await authorizeRequest(r), { ok: true });
});

test("POST without a token is rejected with 401 even when same-origin/loopback", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "POST", host: HOST, origin: `http://${HOST}`, addr: "127.0.0.1" });
  assert.deepEqual(await authorizeRequest(r), {
    ok: false,
    code: 401,
    error: "缺少或错误的 x-dshpkg-token",
  });
});

test("POST with a valid token is allowed (loopback, no origin — CLI path)", async (t) => {
  await usePkgHome(t);
  const token = await readApiToken();
  const r = req({ method: "POST", host: HOST, addr: "127.0.0.1", token });
  assert.deepEqual(await authorizeRequest(r), { ok: true });
});

test("no-Origin request without a token is rejected (no default trust)", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "GET", host: HOST, addr: "127.0.0.1" }); // no origin, no token
  const auth = await authorizeRequest(r);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 403);
});

test("no socket addr without a token is rejected (no 'no addr => trust')", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "GET", host: HOST, origin: `http://${HOST}` }); // no addr, no token
  const auth = await authorizeRequest(r);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 403);
});

test("no socket addr WITH a valid token is allowed", async (t) => {
  await usePkgHome(t);
  const token = await readApiToken();
  const r = req({ method: "GET", host: HOST, origin: `http://${HOST}`, token });
  assert.deepEqual(await authorizeRequest(r), { ok: true });
});

test("cross-origin request is rejected even with a valid token", async (t) => {
  await usePkgHome(t);
  const token = await readApiToken();
  const r = req({ method: "POST", host: HOST, origin: "http://evil.example", addr: "127.0.0.1", token });
  const auth = await authorizeRequest(r);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 403);
});

test("a wrong token is rejected with 401 on a POST route", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "POST", host: HOST, origin: `http://${HOST}`, addr: "127.0.0.1", token: "wrong" });
  assert.deepEqual(await authorizeRequest(r), {
    ok: false,
    code: 401,
    error: "缺少或错误的 x-dshpkg-token",
  });
});

test("a same-length wrong token is rejected (timingSafeEqual byte path)", async (t) => {
  await usePkgHome(t);
  const token = await readApiToken(); // 64 hex chars
  // Flip one hex digit: same length, different bytes — the length shortcut
  // cannot decide this, so the timingSafeEqual branch must reject it.
  const wrong = (token[0] === "0" ? "1" : "0") + token.slice(1);
  assert.equal(wrong.length, token.length);
  const r = req({ method: "POST", host: HOST, origin: `http://${HOST}`, addr: "127.0.0.1", token: wrong });
  const auth = await authorizeRequest(r);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 401);
});

test("verifyToken returns false when no (or an empty) token header is sent", async (t) => {
  await usePkgHome(t);
  assert.equal(await verifyToken(req({ token: undefined })), false);
  assert.equal(await verifyToken(req({ token: "" })), false);
});

test("isLoopback no longer trusts a missing address", () => {
  assert.equal(hasLoopbackAddr({ socket: {} }), false);
  assert.equal(isLoopback({ socket: {} }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "10.0.0.1" } }), false);
});

test("hasOriginHeader / isSameOrigin behave per the tightened contract", () => {
  assert.equal(hasOriginHeader({ headers: {} }), false);
  assert.equal(hasOriginHeader({ headers: { origin: "" } }), false);
  assert.equal(hasOriginHeader({ headers: { origin: "http://x" } }), true);
  assert.equal(
    isSameOrigin({ headers: { origin: `http://${HOST}`, host: HOST } }),
    true,
  );
  assert.equal(
    isSameOrigin({ headers: { origin: "http://evil.example", host: HOST } }),
    false,
  );
  // no origin: isSameOrigin is false (authorizeRequest decides the no-origin case)
  assert.equal(isSameOrigin({ headers: { host: HOST } }), false);
});

// --- hostInstall (AI install channel bookkeeping) ----------------------------

/** Temp DSH_HOME with a valid web profile for one test; restore the env. */
async function useDshHome(t) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-idx-home-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  });
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "web", dsh: { profile: true }, dependencies: {} }),
  );
  return { home, profileDir };
}

test("hostInstall records bookkeeping and snapshots after a successful install", async (t) => {
  const root = await usePkgHome(t);
  await useDshHome(t);
  const result = await hostInstall("dsh-plugin-x", {
    installImpl: async () => ({ ok: true, installed: ["dsh-plugin-x"] }),
  });
  assert.equal(result.ok, true);
  // state.packages + managed ledger recorded (status/list/upgrade see it)
  const state = await readState();
  assert.ok(state.packages["dsh-plugin-x"]);
  assert.equal(state.packages["dsh-plugin-x"].source, "dsh-plugin-x");
  assert.equal(state.managed["dsh-plugin-x"].via, "dshpkg");
  // known-good snapshot taken (best-effort path actually ran)
  const snaps = await readdir(join(root, "snapshots"));
  assert.ok(snaps.length >= 1);
});

test("hostInstall passes a failure through and records nothing", async (t) => {
  await usePkgHome(t);
  await useDshHome(t);
  const result = await hostInstall("dsh-plugin-x", {
    installImpl: async () => ({ ok: false, error: "安装失败", rolledBack: true }),
  });
  assert.equal(result.ok, false);
  const state = await readState();
  assert.equal(state.packages["dsh-plugin-x"], undefined);
});

test("hostInstall never lets a dangerous name reach the state keys", async (t) => {
  await usePkgHome(t);
  await useDshHome(t);
  const result = await hostInstall("evil", {
    installImpl: async () => ({ ok: true, installed: ["__proto__", "dsh-ok"] }),
  });
  assert.equal(result.ok, true);
  const state = await readState();
  assert.ok(state.packages["dsh-ok"]); // the safe name is still recorded
  assert.equal(
    Object.prototype.hasOwnProperty.call(state.packages, "__proto__"),
    false,
  );
});

// --- bootReconcile (boot-time self-healing) ---------------------------------

test("bootReconcile registers an installed-but-unregistered bundle and logs it", async (t) => {
  await usePkgHome(t);
  const { profileDir } = await useDshHome(t);
  // installed face: dsh-a declares dsh.bundle but the bundles list lacks it
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({
      name: "web",
      dependencies: { "dsh-a": "^1" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    }),
  );
  const pkgDir = join(profileDir, "node_modules", "dsh-a");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "dsh-a", dsh: { bundle: { patch: "./p.yml" } } }),
  );

  await bootReconcile();

  const manifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  assert.ok(manifest.dsh.profile.bundles.includes("dsh-a"));
  const incidents = await readIncidents(10);
  assert.ok(incidents.some((inc) => inc.type === "reconcile"));
});

test("bootReconcile is a silent no-op when the profile is missing", async (t) => {
  await usePkgHome(t);
  // DSH_HOME points at an empty temp dir: no profiles/web there
  const home = await mkdtemp(join(tmpdir(), "dshpkg-idx-noprofile-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  });
  await bootReconcile(); // must not throw
  const incidents = await readIncidents(10);
  assert.equal(incidents.some((inc) => inc.type === "reconcile"), false);
});

// --- armBootGuard (R16 in-process boot guardian) ------------------------------

/** Fake loader (array shape) with one updatable entry. */
function fakeLoaderWith(entryId) {
  const updates = [];
  const loader = {
    entries: [
      {
        id: entryId,
        options: { name: entryId },
        update: async (patch) => {
          updates.push(patch);
        },
      },
    ],
  };
  return { loader, updates };
}

test("armBootGuard: stale marker escalates and disables the attributed culprit", async (t) => {
  const root = await usePkgHome(t);
  const { profileDir } = await useDshHome(t);
  resetBootGuardForTests();
  // previous boot crashed: stale marker + stored attribution
  await writeState({
    ...(await readState()),
    bootFailures: 0,
    boot: { startedAt: "2026-08-31T00:00:00.000Z", lastCulprit: "dsh-a" },
  });
  const { loader, updates } = fakeLoaderWith("dsh-a");
  // immediate confirmation timer so the whole cycle runs inside the test
  armBootGuard(loader, {
    setTimeoutImpl: (fn) => {
      fn();
      return { unref() {} };
    },
    // R20: this scenario asserts the service became ready.
    isReadyImpl: () => true,
  });

  // escalation happened before the confirmation cleared the counter…
  // (the boot-crash-detected incident is appended fire-and-forget)
  await new Promise((r) => setTimeout(r, 50));
  const incidents = await readIncidents(20);
  assert.ok(incidents.some((inc) => inc.type === "boot-crash-detected"));
  // …the culprit got a persistent disable block AND a live update
  const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  assert.match(patch, /- id: dsh-a/);
  assert.match(patch, /disabled: true/);
  assert.deepEqual(updates, [{ disabled: true }]);
  // confirmation ran: marker cleared, failures reset, snapshot taken
  const state = await readState();
  assert.equal(state.boot, undefined);
  assert.equal(state.bootFailures, 0);
  assert.ok(state.lastBootOkAt);
  // the known-good snapshot is saved asynchronously after confirmation
  await new Promise((r) => setTimeout(r, 200));
  const snaps = await readdir(join(root, "snapshots")).catch(() => []);
  assert.ok(snaps.length >= 1, "known-good snapshot saved after confirmation");
});

test("armBootGuard: clean boot writes the marker and disables nothing", async (t) => {
  const root = await usePkgHome(t);
  await useDshHome(t);
  resetBootGuardForTests();
  const { loader, updates } = fakeLoaderWith("dsh-a");
  // no confirmation yet: hold the timer so the marker stays visible
  let confirmFn = null;
  armBootGuard(loader, {
    setTimeoutImpl: (fn) => {
      confirmFn = fn;
      return { unref() {} };
    },
    // R20: this scenario asserts the service became ready.
    isReadyImpl: () => true,
  });

  const midState = await readState();
  assert.ok(midState.boot?.startedAt); // marker set
  assert.equal(midState.bootFailures, 0); // no stale marker -> no escalation
  assert.equal(updates.length, 0); // nothing disabled
  // confirm now: marker cleared + known-good snapshot
  confirmFn();
  const state = await readState();
  assert.equal(state.boot, undefined);
  assert.ok(state.lastBootOkAt);
  await new Promise((r) => setTimeout(r, 200));
  const snaps = await readdir(join(root, "snapshots")).catch(() => []);
  assert.ok(snaps.length >= 1);
});

test("armBootGuard: a zombie boot degrades instead of confirming (R20)", async (t) => {
  await usePkgHome(t);
  await useDshHome(t);
  resetBootGuardForTests();
  const { loader } = fakeLoaderWith("dsh-a");
  let confirmFn = null;
  armBootGuard(loader, {
    setTimeoutImpl: (fn) => {
      confirmFn = fn;
      return { unref() {} };
    },
    // the /dshpkg routes never registered (dead plugin tree)
    isReadyImpl: () => false,
  });
  confirmFn();
  // NOT certified: the marker stays (next boot escalates with the stored
  // culprit), the failure counter climbs, boot-degraded is recorded.
  const state = await readState();
  assert.ok(state.boot?.startedAt, "marker must survive a degraded boot");
  assert.equal(state.bootFailures, 1);
  assert.equal(state.lastBootOkAt, null);
  const incidents = await readIncidents(10);
  assert.ok(incidents.some((e) => e.type === "boot-degraded"));
  assert.equal(incidents.some((e) => e.type === "boot-confirmed"), false);
});

test("armBootGuard: uncaught loader crash disables the culprit immediately (R20)", async (t) => {
  await usePkgHome(t);
  const { home } = await useDshHome(t);
  resetBootGuardForTests();
  const { loader } = fakeLoaderWith("dsh-a");
  // capture the registered uncaughtException handler instead of emitting
  // through process.emit (the test runner owns that channel)
  const realOnce = process.once.bind(process);
  let uncaughtHandler = null;
  process.once = (event, fn) => {
    if (event === "uncaughtException") {
      uncaughtHandler = fn;
      return process;
    }
    return realOnce(event, fn);
  };
  try {
    armBootGuard(loader, { setTimeoutImpl: () => ({ unref() {} }) });
  } finally {
    process.once = realOnce;
  }
  assert.ok(uncaughtHandler, "the guardian registers an uncaughtException handler");
  // the wrapped plugin-tree crash reaches the handler while the boot window
  // is still pending (marker set)
  uncaughtHandler(
    new Error(
      "dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): Cannot find package 'x'",
    ),
  );
  const state = await readState();
  assert.equal(state.boot.lastCulprit, "boot-crash-fixture");
  const patch = await readFile(join(home, "profiles", "web", "cordis.patch.yml"), "utf8").catch(() => "");
  assert.match(patch, /- id: boot-crash-fixture/);
  assert.match(patch, /disabled: true/);
  const incidents = await readIncidents(10);
  assert.ok(incidents.some((e) => e.type === "boot-tree-crash"));
});

// --- /dshpkg/metrics (R19 zero-dependency observability) --------------------

/** Minimal res capturing writeHead/end output. */
function captureRes() {
  const out = { code: null, body: null };
  return {
    out,
    res: {
      writeHead: (code) => {
        out.code = code;
      },
      end: (text) => {
        out.body = text;
      },
    },
  };
}

test("routeMetrics aggregates state + incidents into counters (R19)", async (t) => {
  await usePkgHome(t);
  const state = await readState();
  state.bootFailures = 2;
  state.lastBootOkAt = "2026-09-01T00:00:00.000Z";
  state.packages = { "dsh-broken": { circuitOpenAt: "t" } };
  await writeState(state);
  await appendIncident({ type: "boot-confirmed" });
  await appendIncident({ type: "port-evicted" });
  await appendIncident({ type: "port-busy" });
  await appendIncident({ type: "boot-crash", entryId: "x" });

  const { out, res } = captureRes();
  await routeMetrics(res);
  assert.equal(out.code, 200);
  const payload = JSON.parse(out.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.metrics.bootFailures, 2);
  assert.equal(payload.metrics.lastBootOkAt, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(payload.metrics.circuitOpen, ["dsh-broken"]);
  assert.equal(payload.metrics.counts.bootConfirmed, 1);
  assert.equal(payload.metrics.counts.portEvicted, 1);
  assert.equal(payload.metrics.counts.portBusy, 1);
  assert.equal(payload.metrics.counts.bootCrash, 1);
  assert.ok(payload.metrics.lastEvents.bootCrash);
});

test("routeMetrics reports a clean ledger without incidents", async (t) => {
  await usePkgHome(t);
  const { out, res } = captureRes();
  await routeMetrics(res);
  assert.equal(out.code, 200);
  const payload = JSON.parse(out.body);
  assert.equal(payload.metrics.bootFailures, 0);
  assert.deepEqual(payload.metrics.circuitOpen, []);
  assert.equal(payload.metrics.counts.bootCrash, 0);
});
