// dshpkg — supervisor unit tests.
// Fully offline by construction:
//   - no real child processes: injected spawnImpl returns fake children;
//   - no real network: injected probeImpl returns canned booleans;
//   - no real clock: injected sleepImpl resolves immediately;
//   - no real profiles / state: DSH_HOME and DSH_PKG_HOME point at temp dirs.
// The supervisor is stopped in every loop test via process.emit("SIGINT"),
// which only fires the registered listener (safe on Windows, no real signal).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  supervise,
  parseLoaderErrors,
  readPatchTopLevel,
  writeManagedDisable,
  removeManagedBlock,
} from "../bin/supervisor.js";

// Exact verified message from the Phase 0 PoC (CONTRACTS.md).
const EXACT_CRASH_TEXT =
  "failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure";
// Outer wrapper adds one nesting level (cordis:include names the wrapper).
const NESTED_CRASH_TEXT = `failed to apply loader entry include (cordis:include): ${EXACT_CRASH_TEXT}`;

// --- helpers ---------------------------------------------------------------

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

/** Yield the event loop a few macrotask turns. */
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

/** Poll until a condition holds (real fs I/O makes fixed ticks racy). */
async function waitFor(check, timeoutMs = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not reached in time");
    }
    await tick(1);
  }
}

/** Temp profile home (~/.dsh stand-in) with a valid "web" profile. */
async function makeProfileHome(t) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-sup-home-"));
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
  return { home, profileDir };
}

/** Temp state root (DSH_PKG_HOME stand-in) with a snapshots/ dir. */
async function makeStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-sup-state-"));
  await mkdir(join(root, "snapshots"), { recursive: true });
  return root;
}

/** Point DSH_HOME / DSH_PKG_HOME at temp dirs for one test, then restore. */
function useTempEnv(t, { home, stateRoot }) {
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
}

// --- parseLoaderErrors -----------------------------------------------------

test("parseLoaderErrors: parses the exact verified message", () => {
  const matches = parseLoaderErrors(EXACT_CRASH_TEXT);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], {
    stage: "apply",
    entryId: "boot-crash-fixture",
    entryName: "dshpkg-fixture-boot-crash",
    detail: "boot-crash fixture: intentional boot failure",
  });
});

test("parseLoaderErrors: innermost match is last with nested wrappers", () => {
  const matches = parseLoaderErrors(NESTED_CRASH_TEXT);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].entryId, "include");
  assert.equal(matches[0].entryName, "cordis:include");
  const culprit = matches[matches.length - 1];
  assert.equal(culprit.entryId, "boot-crash-fixture");
  assert.equal(culprit.stage, "apply");
});

test("parseLoaderErrors: returns [] when no loader error present", () => {
  assert.deepEqual(parseLoaderErrors("some unrelated stderr noise\n"), []);
  assert.deepEqual(parseLoaderErrors(""), []);
});

test("parseLoaderErrors: supports all four stages", () => {
  const text = [
    "failed to import loader entry a (mod-a): boom a",
    "failed to dispose loader entry b (mod-b): boom b",
    "failed to rollback loader entry c (mod-c): boom c",
  ].join("\n");
  const stages = parseLoaderErrors(text).map((m) => m.stage);
  assert.deepEqual(stages, ["import", "dispose", "rollback"]);
});

// --- readPatchTopLevel -----------------------------------------------------

test("readPatchTopLevel: empty file and comment-only file are 'empty'", () => {
  assert.deepEqual(readPatchTopLevel(""), { ok: true, kind: "empty" });
  assert.deepEqual(readPatchTopLevel("# only a comment\n\n# another\n"), {
    ok: true,
    kind: "empty",
  });
});

test("readPatchTopLevel: top-level array is 'array'", () => {
  assert.deepEqual(readPatchTopLevel("- id: x\n  disabled: true\n"), {
    ok: true,
    kind: "array",
  });
  assert.deepEqual(readPatchTopLevel("# comment\n- id: x\n"), {
    ok: true,
    kind: "array",
  });
});

test("readPatchTopLevel: non-array top level is 'invalid'", () => {
  const result = readPatchTopLevel("insert:\n  - id: x\n");
  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
});

// --- writeManagedDisable / removeManagedBlock -------------------------------

test("writeManagedDisable: appends a managed block to an empty patch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  const result = await writeManagedDisable(dir, "crashy");
  assert.deepEqual(result, { written: true });
  const text = await readFile(join(dir, "cordis.patch.yml"), "utf8");
  assert.equal(
    text,
    "# dshpkg:managed:start\n- id: crashy\n  disabled: true\n# dshpkg:managed:end\n",
  );
});

test("writeManagedDisable: appends after an existing array without touching it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  const original = "# user comment\n- id: user-entry\n  disabled: false\n";
  await writeFile(join(dir, "cordis.patch.yml"), original, "utf8");
  const result = await writeManagedDisable(dir, "crashy");
  assert.deepEqual(result, { written: true });
  const text = await readFile(join(dir, "cordis.patch.yml"), "utf8");
  assert.ok(text.startsWith(original));
  assert.ok(
    text.endsWith(
      "# dshpkg:managed:start\n- id: crashy\n  disabled: true\n# dshpkg:managed:end\n",
    ),
  );
});

test("writeManagedDisable: same entry id is not written twice", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  await writeManagedDisable(dir, "crashy");
  const before = await readFile(join(dir, "cordis.patch.yml"), "utf8");
  const result = await writeManagedDisable(dir, "crashy");
  assert.deepEqual(result, { written: false });
  const after = await readFile(join(dir, "cordis.patch.yml"), "utf8");
  assert.equal(after, before);
  // a different id still gets its own block
  const other = await writeManagedDisable(dir, "other-crashy");
  assert.deepEqual(other, { written: true });
});

test("writeManagedDisable: refuses a non-array top level", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  await writeFile(join(dir, "cordis.patch.yml"), "insert:\n  - id: x\n", "utf8");
  await assert.rejects(
    () => writeManagedDisable(dir, "crashy"),
    /拒绝写入/,
  );
  // file untouched
  assert.equal(
    await readFile(join(dir, "cordis.patch.yml"), "utf8"),
    "insert:\n  - id: x\n",
  );
});

test("removeManagedBlock: removes only managed blocks, keeps user content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  const before =
    "# user comment\n" +
    "- id: user-entry\n  disabled: false\n" +
    "# dshpkg:managed:start\n- id: a\n  disabled: true\n# dshpkg:managed:end\n" +
    "- id: user2\n" +
    "# dshpkg:managed:start\n- id: b\n  disabled: true\n# dshpkg:managed:end\n";
  await writeFile(join(dir, "cordis.patch.yml"), before, "utf8");
  const removed = await removeManagedBlock(dir);
  assert.equal(removed, 2);
  assert.equal(
    await readFile(join(dir, "cordis.patch.yml"), "utf8"),
    "# user comment\n- id: user-entry\n  disabled: false\n- id: user2\n",
  );
});

test("removeManagedBlock: no-op when file missing or has no managed blocks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  assert.equal(await removeManagedBlock(dir), 0);
  const original = "- id: user-entry\n";
  await writeFile(join(dir, "cordis.patch.yml"), original, "utf8");
  assert.equal(await removeManagedBlock(dir), 0);
  assert.equal(await readFile(join(dir, "cordis.patch.yml"), "utf8"), original);
});

// --- supervise: healthy path ------------------------------------------------

test("supervise: healthy child emits healthy, then SIGINT stops it", async (t) => {
  const { home } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  const events = [];
  const children = [];
  const run = supervise({
    profile: "web",
    onEvent: (event) => events.push(event),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => true,
    sleepImpl: async () => {},
  });
  await waitFor(() => events.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await run;

  assert.equal(events.some((e) => e.type === "healthy"), true);
  assert.equal(events.some((e) => e.type === "boot-failed"), false);
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, true);
});

// --- supervise: triage hit -> managed disable -> restart -> healthy ---------

test("supervise: triage hit disables the culprit and restarts", async (t) => {
  const { home, profileDir } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  const events = [];
  const children = [];
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
    // First child crashes during the grace sleep with the nested loader
    // error on stderr; every later child stays alive.
    sleepImpl: async () => {
      const index = graceCalls;
      graceCalls += 1;
      const child = children[index];
      if (child && index === 0) {
        child.stderr.emit("data", NESTED_CRASH_TEXT);
        child.emit("exit", 1, null);
      }
    },
  });
  // Wait for the restart to settle (second spawn healthy), then stop.
  await waitFor(() => events.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await run;

  const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  assert.match(patch, /# dshpkg:managed:start/);
  assert.match(patch, /- id: boot-crash-fixture/);
  assert.match(patch, /disabled: true/);
  assert.match(patch, /# dshpkg:managed:end/);
  // original user content untouched
  assert.match(patch, /- id: original-entry/);

  const types = events.map((e) => e.type);
  assert.ok(types.includes("boot-failed"));
  assert.ok(types.includes("restarting"));
  assert.ok(types.includes("healthy"));
  assert.equal(types.includes("circuit-open"), false);

  const bootFailed = events.find((e) => e.type === "boot-failed");
  // innermost culprit wins over the cordis:include wrapper
  assert.equal(bootFailed.detail.entryId, "boot-crash-fixture");
  assert.equal(children.length, 2);
});

// --- supervise: three failures -> circuit open -> snapshot restore ----------

test("supervise: three consecutive failures restore the newest snapshot", async (t) => {
  const { home, profileDir } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  // Two snapshots; the newest one must win the restore.
  const snapOld = join(stateRoot, "snapshots", "2026-08-01T00-00-00.000Z");
  const snapNew = join(stateRoot, "snapshots", "2026-08-20T12-00-00.000Z");
  await mkdir(snapOld, { recursive: true });
  await mkdir(snapNew, { recursive: true });
  await writeFile(join(snapOld, "package.json"), JSON.stringify({ name: "old-snapshot" }), "utf8");
  await writeFile(join(snapOld, "cordis.patch.yml"), "- id: stale-entry\n", "utf8");
  await writeFile(join(snapOld, "pnpm-lock.yaml"), "lockfileVersion: 6\n", "utf8");
  await writeFile(join(snapNew, "package.json"), JSON.stringify({ name: "new-snapshot" }), "utf8");
  await writeFile(join(snapNew, "cordis.patch.yml"), "- id: good-entry\n  disabled: false\n", "utf8");
  await writeFile(join(snapNew, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");

  // Pre-seed a managed block + user content: the restore must end with
  // exactly the snapshot content (managed blocks removed).
  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    "- id: original-entry\n  disabled: false\n" +
      "# dshpkg:managed:start\n- id: old-crashy\n  disabled: true\n# dshpkg:managed:end\n",
    "utf8",
  );

  const events = [];
  const children = [];
  let graceCalls = 0;
  const run = supervise({
    profile: "web",
    onEvent: (event) => events.push(event),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => false,
    // Every child dies during its grace sleep with an unattributed error
    // (no loader match), so triage misses and the failure counter climbs.
    sleepImpl: async () => {
      const index = graceCalls;
      graceCalls += 1;
      const child = children[index];
      if (child) {
        child.stderr.emit("data", "unattributed failure text\n");
        child.emit("exit", 1, null);
      }
    },
  });
  // Stop right after the snapshot restore (the loop keeps restarting).
  await waitFor(() => events.some((e) => e.type === "snapshot-restored"));
  process.emit("SIGINT");
  await run;

  const types = events.map((e) => e.type);
  assert.ok(types.includes("circuit-open"));
  const restored = events.find((e) => e.type === "snapshot-restored");
  assert.ok(restored);
  assert.equal(restored.detail.ts, "2026-08-20T12-00-00.000Z");

  // profile files are back to the newest snapshot content
  assert.deepEqual(
    JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")),
    { name: "new-snapshot" },
  );
  assert.equal(
    await readFile(join(profileDir, "cordis.patch.yml"), "utf8"),
    "- id: good-entry\n  disabled: false\n",
  );
  assert.equal(
    await readFile(join(profileDir, "pnpm-lock.yaml"), "utf8"),
    "lockfileVersion: 9\n",
  );
});

// --- supervise: probe port resolution ---------------------------------------

test("supervise: probe port comes from --port arg, option, or 3080 default", async (t) => {
  const { home } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  const seen = [];
  const base = {
    profile: "web",
    spawnImpl: async () => fakeChild(),
    sleepImpl: async () => {},
    onEvent: () => {},
  };

  // case A: --port inside args
  const eventsA = [];
  const runA = supervise({
    ...base,
    args: ["--port", "3199"],
    onEvent: (event) => eventsA.push(event),
    probeImpl: async ({ port }) => {
      seen.push(["args", port]);
      return true;
    },
  });
  await waitFor(() => eventsA.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await runA;

  // case B: no port anywhere -> 3080
  const eventsB = [];
  const runB = supervise({
    ...base,
    onEvent: (event) => eventsB.push(event),
    probeImpl: async ({ port }) => {
      seen.push(["default", port]);
      return true;
    },
  });
  await waitFor(() => eventsB.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await runB;

  // case C: explicit port option wins over --port in args
  const eventsC = [];
  const runC = supervise({
    ...base,
    port: 4000,
    args: ["--port", "3199"],
    onEvent: (event) => eventsC.push(event),
    probeImpl: async ({ port }) => {
      seen.push(["option", port]);
      return true;
    },
  });
  await waitFor(() => eventsC.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await runC;

  assert.deepEqual(seen, [
    ["args", 3199],
    ["default", 3080],
    ["option", 4000],
  ]);
});

// --- supervise: hung child (probe failures) is killed and restarted ---------

test("supervise: probe failures kill a hung child and restart it", async (t) => {
  const { home } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  const events = [];
  const children = [];
  const run = supervise({
    profile: "web",
    onEvent: (event) => events.push(event),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => false, // always unhealthy, child never exits
    sleepImpl: async () => {},
  });
  // Wait until the first child was killed as hung and a restart happened.
  await waitFor(() => children[0]?.killed === true && children.length >= 2);
  process.emit("SIGINT");
  await run;

  // first child was killed as hung, and at least one restart happened
  assert.equal(children[0].killed, true);
  assert.ok(children.length >= 2);
  assert.ok(events.some((e) => e.type === "boot-failed"));
  assert.ok(events.some((e) => e.type === "restarting"));
});

// --- supervise: clean child exit stops the watchdog -------------------------

test("supervise: clean exit (code 0) stops the supervisor without triage", async (t) => {
  const { home } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  const events = [];
  const children = [];
  const run = supervise({
    profile: "web",
    onEvent: (event) => events.push(event),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    // First probe succeeds (healthy), then the child shuts down cleanly.
    // setImmediate puts the exit on the macrotask queue, i.e. strictly after
    // the probe resolution microtask, so the supervisor sees healthy first.
    probeImpl: async () => {
      const child = children[children.length - 1];
      setImmediate(() => child.emit("exit", 0, null));
      return true;
    },
    sleepImpl: async () => {},
  });
  await run; // resolves on its own: clean exit stops the watchdog

  const types = events.map((e) => e.type);
  assert.ok(types.includes("healthy"));
  assert.equal(types.includes("boot-failed"), false);
  assert.equal(types.includes("restarting"), false);
  assert.equal(children.length, 1);
});
