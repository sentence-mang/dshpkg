// dshpkg — core protection list tests (Spec section 9).
//
// Covers:
//   1. lib/protect.js: isProtected exact / prefix / negative cases;
//   2. lib/index.js: apply() with a fake ctx — setEntryDisabled refuses
//      protected entries with {ok:false, protected:true} and never touches
//      the loader; non-protected entries still work;
//   3. bin/supervisor.js: a boot failure attributed to a protected entry
//      emits protected-blocked, skips the managed disable block write, and
//      keeps restarting (injected spawnImpl/probeImpl — fully offline).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_PROTECT_LIST, isProtected } from "../lib/protect.js";
import { apply } from "../lib/index.js";
import { supervise } from "../bin/supervisor.js";

// --- lib/protect.js ---------------------------------------------------------

test("isProtected: every exact core entry is protected", () => {
  for (const id of CORE_PROTECT_LIST) {
    assert.equal(isProtected(id), true, `expected ${id} to be protected`);
  }
  assert.deepEqual(CORE_PROTECT_LIST, [
    "loader",
    "include",
    "cordis-host-runner",
    "web-startup",
    "web-runtime",
    "api-gateway",
    "webserver",
    "dshpkg",
  ]);
});

test("isProtected: prefix matches protect loader/cordis-host-runner variants", () => {
  assert.equal(isProtected("loader-extra"), true);
  assert.equal(isProtected("loader2"), true);
  assert.equal(isProtected("loaders"), true);
  assert.equal(isProtected("cordis-host-runner-beta"), true);
  assert.equal(isProtected("cordis-host-runner-old"), true);
});

test("isProtected: non-core ids and junk inputs are not protected", () => {
  assert.equal(isProtected("web-startup-extra"), false); // exact list only
  assert.equal(isProtected("my-plugin"), false);
  assert.equal(isProtected("boot-crash-fixture"), false);
  assert.equal(isProtected("xloader"), false); // prefix only, not substring
  assert.equal(isProtected(""), false);
  assert.equal(isProtected(null), false);
  assert.equal(isProtected(undefined), false);
  assert.equal(isProtected(42), false);
});

test("isProtected: trims surrounding whitespace", () => {
  assert.equal(isProtected("  loader  "), true);
  assert.equal(isProtected("\tinclude\n"), true);
});

// --- lib/index.js: setEntryDisabled protect gate ----------------------------

/** Fake loader exposing one controllable entry through entryById(). */
function fakeLoader(entryId, { disabled = false } = {}) {
  const updates = [];
  const entry = {
    id: entryId,
    disabled,
    update: async (patch) => {
      updates.push(patch);
      if (patch && typeof patch.disabled === "boolean") entry.disabled = patch.disabled;
    },
  };
  return {
    loader: { entryById: (id) => (id === entryId ? entry : null), entries: [] },
    entry,
    updates,
  };
}

/** apply() against a fake ctx (no webServer / tools / commands / prompts). */
function bootFakeHost(ctxExtra = {}) {
  const ctx = {
    get: () => null,
    plugin: async () => ({ dispose: async () => {} }),
    ...ctxExtra,
  };
  return apply(ctx);
}

/** Point DSH_PKG_HOME at a temp dir so apply()'s autoRestore never reads real state. */
async function useTempPkgHome(t) {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-protect-index-state-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });
  return root;
}

test("index: setEntryDisabled refuses protected ids and never calls update", async (t) => {
  await useTempPkgHome(t);
  const { loader, updates } = fakeLoader("loader");
  const api = bootFakeHost({ get: (key) => (key === "loader" ? loader : null) });

  const result = await api.setEntryDisabled("loader", true);
  assert.deepEqual(result, {
    ok: false,
    protected: true,
    reason: "核心条目受保护，禁止熔断",
  });
  assert.equal(updates.length, 0, "loader.update must never be called");
});

test("index: enableEntry/disableEntry/toggleEntry inherit the protect gate", async (t) => {
  await useTempPkgHome(t);
  const { loader, updates } = fakeLoader("include");
  const api = bootFakeHost({ get: (key) => (key === "loader" ? loader : null) });

  assert.equal((await api.enableEntry("include")).protected, true);
  assert.equal((await api.disableEntry("include")).protected, true);
  const toggled = await api.toggleEntry("include");
  assert.equal(toggled.ok, false);
  assert.equal(toggled.protected, true);
  assert.equal(updates.length, 0);
});

test("index: non-protected entries still enable/disable normally", async (t) => {
  await useTempPkgHome(t);
  const { loader, entry, updates } = fakeLoader("some-plugin");
  const api = bootFakeHost({ get: (key) => (key === "loader" ? loader : null) });

  const disabled = await api.setEntryDisabled("some-plugin", true);
  assert.deepEqual(disabled, { ok: true, name: "some-plugin", disabled: true });
  assert.deepEqual(updates[0], { disabled: true });
  assert.equal(entry.disabled, true);

  const enabled = await api.enableEntry("some-plugin");
  assert.equal(enabled.ok, true);
  assert.deepEqual(updates[1], { disabled: false });
});

test("index: toggleEntry flips the current disabled state", async (t) => {
  await useTempPkgHome(t);
  const { loader } = fakeLoader("flip-me", { disabled: true });
  const api = bootFakeHost({ get: (key) => (key === "loader" ? loader : null) });

  const result = await api.toggleEntry("flip-me");
  assert.deepEqual(result, { ok: true, name: "flip-me", disabled: false });
});

test("index: apply is defensive when every service is absent", async (t) => {
  await useTempPkgHome(t);
  // ctx.get returns null for everything; apply must not throw and must
  // still return a usable api surface.
  const api = bootFakeHost();
  assert.equal(typeof api.setEntryDisabled, "function");
  assert.equal(typeof api.toggleEntry, "function");
  assert.equal(typeof api.layer.list, "function");
});

// --- bin/supervisor.js: protected-blocked scenario --------------------------

/** ChildProcess-like fake: EventEmitter + piped stdout/stderr + kill(). */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function tick(turns = 5) {
  return new Promise((resolve) => {
    let left = turns;
    const step = () => {
      left -= 1;
      if (left <= 0) return resolve();
      setImmediate(step);
    };
    setImmediate(step);
  });
}

async function waitFor(check, timeoutMs = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not reached in time");
    }
    await tick(1);
  }
}

test("supervisor: protected culprit skips disable write and emits protected-blocked", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-protect-home-"));
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "web", dsh: { profile: true } }),
    "utf8",
  );
  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    "- id: original-entry\n  disabled: false\n",
    "utf8",
  );
  const stateRoot = await mkdtemp(join(tmpdir(), "dshpkg-protect-state-"));
  await mkdir(join(stateRoot, "snapshots"), { recursive: true });

  const prevHome = process.env.DSH_HOME;
  const prevPkgHome = process.env.DSH_PKG_HOME;
  process.env.DSH_HOME = home;
  process.env.DSH_PKG_HOME = stateRoot;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevPkgHome === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prevPkgHome;
  });

  // First child crashes with a loader error naming the CORE "loader" entry;
  // every later child stays healthy.
  const children = [];
  const events = [];
  let graceCalls = 0;
  const run = supervise({
    profile: "web",
    onEvent: (event) => events.push(event),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => true,
    portCheckImpl: async () => ({ free: true }),
    sleepImpl: async () => {
      graceCalls += 1;
      const child = children[children.length - 1];
      if (child && graceCalls === 1) {
        child.stderr.emit(
          "data",
          "failed to apply loader entry loader (cordis:loader): core entry intentionally broken\n",
        );
        child.emit("exit", 1, null);
      }
    },
  });

  await waitFor(() => events.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await run;

  // The protected-blocked event carries the culprit id.
  const blocked = events.find((e) => e.type === "protected-blocked");
  assert.ok(blocked, "expected a protected-blocked event");
  assert.deepEqual(blocked.detail, { entryId: "loader" });

  // The patch file must NOT contain a dshpkg managed disable block.
  const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  assert.equal(patch.includes("# dshpkg:managed:start"), false);
  assert.ok(patch.includes("original-entry"), "user content stays untouched");

  // Failure counting still happened: boot-failed was reported.
  assert.equal(events.some((e) => e.type === "boot-failed"), true);
});

test("supervisor: non-protected culprit still writes the managed block", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-protect-home-"));
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "web", dsh: { profile: true } }),
    "utf8",
  );
  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    "- id: original-entry\n  disabled: false\n",
    "utf8",
  );
  const stateRoot = await mkdtemp(join(tmpdir(), "dshpkg-protect-state-"));
  await mkdir(join(stateRoot, "snapshots"), { recursive: true });

  const prevHome = process.env.DSH_HOME;
  const prevPkgHome = process.env.DSH_PKG_HOME;
  process.env.DSH_HOME = home;
  process.env.DSH_PKG_HOME = stateRoot;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevPkgHome === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prevPkgHome;
  });

  const children = [];
  const events = [];
  let graceCalls = 0;
  const run = supervise({
    profile: "web",
    onEvent: (event) => events.push(event),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => true,
    portCheckImpl: async () => ({ free: true }),
    sleepImpl: async () => {
      graceCalls += 1;
      const child = children[children.length - 1];
      if (child && graceCalls === 1) {
        child.stderr.emit(
          "data",
          "failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure\n",
        );
        child.emit("exit", 1, null);
      }
    },
  });

  await waitFor(() => events.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await run;

  assert.equal(events.some((e) => e.type === "protected-blocked"), false);
  const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  assert.ok(patch.includes("# dshpkg:managed:start"));
  assert.ok(patch.includes("- id: boot-crash-fixture"));
});

test("supervisor: EADDRINUSE crash disables nothing and restarts (R18)", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-addrinuse-home-"));
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "web", dsh: { profile: true } }),
    "utf8",
  );
  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    "- id: original-entry\n  disabled: false\n",
    "utf8",
  );
  const stateRoot = await mkdtemp(join(tmpdir(), "dshpkg-addrinuse-state-"));
  await mkdir(join(stateRoot, "snapshots"), { recursive: true });

  const prevHome = process.env.DSH_HOME;
  const prevPkgHome = process.env.DSH_PKG_HOME;
  process.env.DSH_HOME = home;
  process.env.DSH_PKG_HOME = stateRoot;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevPkgHome === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prevPkgHome;
  });

  // First child dies with the real EADDRINUSE output shape (a webserver
  // listen failure); every later child stays healthy.
  const children = [];
  const events = [];
  let graceCalls = 0;
  const run = supervise({
    profile: "web",
    onEvent: (event) => events.push(event),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => true,
    portCheckImpl: async () => ({ free: true }),
    sleepImpl: async () => {
      graceCalls += 1;
      const child = children[children.length - 1];
      if (child && graceCalls === 1) {
        child.stderr.emit(
          "data",
          "failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): Error: listen EADDRINUSE: address already in use 127.0.0.1:3080\n",
        );
        child.emit("exit", 1, null);
      }
    },
  });

  await waitFor(() => events.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await run;

  // The crash is classified as port contention, not a plugin failure.
  const failed = events.find((e) => e.type === "boot-failed" && e.detail?.reason === "port-busy");
  assert.ok(failed, "expected a port-busy boot-failed event");
  assert.equal(events.some((e) => e.type === "protected-blocked"), false);
  assert.equal(events.some((e) => e.type === "snapshot-restored"), false);

  // Nothing was disabled: no managed block, user content untouched.
  const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  assert.equal(patch.includes("# dshpkg:managed:start"), false);
  assert.ok(patch.includes("original-entry"));
});

test("supervisor: busy port held by a stale dsh instance is evicted before spawn (R18)", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-evict-home-"));
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "web", dsh: { profile: true } }),
    "utf8",
  );
  await writeFile(join(profileDir, "cordis.patch.yml"), "", "utf8");
  const stateRoot = await mkdtemp(join(tmpdir(), "dshpkg-evict-state-"));
  await mkdir(join(stateRoot, "snapshots"), { recursive: true });

  const prevHome = process.env.DSH_HOME;
  const prevPkgHome = process.env.DSH_PKG_HOME;
  process.env.DSH_HOME = home;
  process.env.DSH_PKG_HOME = stateRoot;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevPkgHome === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prevPkgHome;
  });

  const events = [];
  let portChecks = 0;
  let evictions = 0;
  const run = supervise({
    profile: "web",
    onEvent: (event) => events.push(event),
    spawnImpl: async () => fakeChild(),
    probeImpl: async () => true,
    sleepImpl: async () => {},
    // First arbitration round sees a stale dsh instance on the port; the
    // eviction (injected) frees it.
    portCheckImpl: async () => {
      portChecks += 1;
      return portChecks === 1 ? { free: false, pid: 11100, holder: "node dsh/lib/bin.js web" } : { free: true };
    },
    evictImpl: async () => {
      evictions += 1;
      return { ok: true, evicted: 1 };
    },
  });

  await waitFor(() => events.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await run;

  assert.equal(evictions, 1, "the stale holder must be evicted exactly once");
  const evicted = events.find((e) => e.type === "port-evicted");
  assert.ok(evicted, "expected a port-evicted event");
});
