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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  supervise,
  parseCliArgs,
  parseLoaderErrors,
  parseUncaughtModule,
  resolveEntryByPackage,
  listInstalledBundles,
  attributeFromStack,
  readPatchTopLevel,
  writeManagedDisable,
  removeManagedBlock,
  eventToIncident,
  persistCrash,
  persistCircuitOpen,
  selectSnapshotToRestore,
  resetToFactoryBaseline,
  lockfileHashOf,
} from "../bin/supervisor.js";
import { readState, writeState } from "../lib/state.js";

// Exact verified message from the Phase 0 PoC (CONTRACTS.md).
const EXACT_CRASH_TEXT =
  "failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure";
// Outer wrapper adds one nesting level (cordis:include names the wrapper).
const NESTED_CRASH_TEXT = `failed to apply loader entry include (cordis:include): ${EXACT_CRASH_TEXT}`;
// Real E2E stderr of the sync-crash fixture: a plain uncaughtException stack
// (no "failed to apply loader entry" message) — only the node_modules path
// segment reveals the culprit package.
const SYNC_CRASH_STACK = [
  "Error: sync-crash fixture: intentional uncaughtException",
  "    at Timeout._onTimeout (file:///C:/Users/Sente/.dsh/profiles/dshpkg-poc/node_modules/dshpkg-fixture-sync-crash/index.js:7:11)",
].join("\n");

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

// --- parseUncaughtModule ---------------------------------------------------

test("parseUncaughtModule: extracts the package from the real sync-crash stack", () => {
  assert.deepEqual(parseUncaughtModule(SYNC_CRASH_STACK), [
    "dshpkg-fixture-sync-crash",
  ]);
});

test("parseUncaughtModule: scoped packages and backslash separators", () => {
  const text = [
    "Error: boom",
    "    at fn (file:///x/node_modules/@deepseek-ai/dsh-base/lib/bin.js:1:1)",
    "    at fn2 (C:\\Users\\Sente\\.dsh\\profiles\\web\\node_modules\\dshpkg-fixture-sync-crash\\index.js:7:11)",
  ].join("\n");
  assert.deepEqual(parseUncaughtModule(text), [
    "@deepseek-ai/dsh-base",
    "dshpkg-fixture-sync-crash",
  ]);
});

test("parseUncaughtModule: dedupes and ranks by occurrence frequency", () => {
  const text = [
    "Error: boom",
    "    at a (/x/node_modules/pkg-a/index.js:1:1)",
    "    at b (/x/node_modules/pkg-b/index.js:2:2)",
    "    at c (/x/node_modules/pkg-a/helper.js:3:3)",
  ].join("\n");
  assert.deepEqual(parseUncaughtModule(text), ["pkg-a", "pkg-b"]);
});

test("parseUncaughtModule: skips pnpm virtual-store (.pnpm) segments", () => {
  const text = [
    "Error: boom",
    "    at fn (/x/node_modules/.pnpm/pkg-a@1.0.0/node_modules/pkg-a/index.js:1:1)",
  ].join("\n");
  assert.deepEqual(parseUncaughtModule(text), ["pkg-a"]);
});

test("parseUncaughtModule: no stack frames falls back to []", () => {
  assert.deepEqual(parseUncaughtModule(""), []);
  assert.deepEqual(parseUncaughtModule(null), []);
  assert.deepEqual(parseUncaughtModule("plain text without at-frames\n"), []);
  assert.deepEqual(
    parseUncaughtModule("Error: boom\n    at Timeout._onTimeout (node:internal/timers:501:7)\n"),
    [],
  );
});

// --- resolveEntryByPackage --------------------------------------------------

test("resolveEntryByPackage: reads the package's own cordis.patch.yml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-resolve-"));
  await mkdir(join(dir, "node_modules", "dshpkg-fixture-sync-crash"), {
    recursive: true,
  });
  await writeFile(
    join(dir, "node_modules", "dshpkg-fixture-sync-crash", "cordis.patch.yml"),
    "- insert:\n    - id: sync-crash-fixture\n      name: dshpkg-fixture-sync-crash\n",
    "utf8",
  );
  assert.equal(
    await resolveEntryByPackage(dir, "dshpkg-fixture-sync-crash"),
    "sync-crash-fixture",
  );
});

test("resolveEntryByPackage: falls back to dsh.profile.bundles (link: fixture path)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-resolve-"));
  const fixtureDir = join(dir, "linked-fixture");
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(
    join(fixtureDir, "cordis.patch.yml"),
    "- insert:\n    - id: linked-fixture-entry\n      name: linked-fixture\n",
    "utf8",
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fake-profile",
      dsh: { profile: { bundles: [`file:${fixtureDir}`] } },
    }),
    "utf8",
  );
  // no node_modules/<pkg>/ file: only the bundle path can resolve it
  assert.equal(
    await resolveEntryByPackage(dir, "linked-fixture"),
    "linked-fixture-entry",
  );
});

test("resolveEntryByPackage: returns null when nothing resolves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-resolve-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "fake-profile", dsh: { profile: { bundles: [] } } }),
    "utf8",
  );
  assert.equal(await resolveEntryByPackage(dir, "no-such-package"), null);
});

// --- listInstalledBundles / attributeFromStack ------------------------------

// The real E2E stderr of a link:-installed sync-crash fixture: the pnpm
// junction makes Node report the TRUE source path — no node_modules segment,
// no package name — so only real-path matching can attribute it.
const LINK_CRASH_STACK = [
  "Error: sync-crash fixture: intentional uncaughtException",
  "    at Timeout._onTimeout (file:///C:/Users/Sente/.dsh/dshpkg/dsh-pkg/fixtures/sync-crash/index.js:8:11)",
].join("\n");

/** cordis.patch.yml text of the real sync-crash fixture. */
const SYNC_CRASH_PATCH =
  "- insert:\n    - id: sync-crash-fixture\n      name: dshpkg-fixture-sync-crash\n";

test("listInstalledBundles: node_modules form resolves real path, entry id and name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-installed-"));
  const pkgDir = join(dir, "node_modules", "pkg-plain");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "cordis.patch.yml"),
    "- insert:\n    - id: plain-entry\n      name: pkg-plain\n",
    "utf8",
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fake-profile",
      dependencies: { "pkg-plain": "^1.0.0" },
      dsh: { profile: { bundles: ["pkg-plain"] } },
    }),
    "utf8",
  );
  const installed = await listInstalledBundles(dir);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].pkgName, "pkg-plain");
  assert.deepEqual(installed[0].realPaths, [await realpath(pkgDir)]);
  assert.deepEqual(installed[0].entryIds, ["plain-entry"]);
  assert.deepEqual(installed[0].moduleNames, ["pkg-plain"]);
});

test("listInstalledBundles: bundles-only names and version suffixes merge into one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-installed-"));
  const pkgDir = join(dir, "node_modules", "bundle-only");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "cordis.patch.yml"),
    "- insert:\n    - id: bundle-entry\n      name: bundle-only\n",
    "utf8",
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fake-profile",
      dsh: { profile: { bundles: ["bundle-only@2.0.0", "bundle-only"] } },
    }),
    "utf8",
  );
  const installed = await listInstalledBundles(dir);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].pkgName, "bundle-only");
  assert.deepEqual(installed[0].entryIds, ["bundle-entry"]);
});

test("listInstalledBundles: link: dependency value contributes its source path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-installed-"));
  const srcDir = join(dir, "fixtures", "sync-crash");
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, "cordis.patch.yml"), SYNC_CRASH_PATCH, "utf8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fake-profile",
      dependencies: { "dshpkg-fixture-sync-crash": `link:${srcDir}` },
    }),
    "utf8",
  );
  const installed = await listInstalledBundles(dir);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].pkgName, "dshpkg-fixture-sync-crash");
  assert.deepEqual(installed[0].realPaths, [await realpath(srcDir)]);
  assert.deepEqual(installed[0].entryIds, ["sync-crash-fixture"]);
  assert.deepEqual(installed[0].moduleNames, ["dshpkg-fixture-sync-crash"]);
});

test("listInstalledBundles: node_modules junction resolves to the link source (deduped)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-installed-"));
  const srcDir = await mkdtemp(join(tmpdir(), "dshpkg-sup-src-"));
  await writeFile(join(srcDir, "cordis.patch.yml"), SYNC_CRASH_PATCH, "utf8");
  const nmDir = join(dir, "node_modules");
  await mkdir(nmDir, { recursive: true });
  try {
    await symlink(
      srcDir,
      join(nmDir, "dshpkg-fixture-sync-crash"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    // junction/symlink creation unsupported in this runner: the link:
    // dependency value below still carries the source path, which exercises
    // the same attribution (the junction form is the Windows E2E reality).
  }
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fake-profile",
      dependencies: { "dshpkg-fixture-sync-crash": `link:${srcDir}` },
    }),
    "utf8",
  );
  const installed = await listInstalledBundles(dir);
  assert.equal(installed.length, 1);
  // Both collection forms (junction + dependency value) collapse into one
  // real path — the true source directory.
  assert.deepEqual(installed[0].realPaths, [await realpath(srcDir)]);
  assert.deepEqual(installed[0].entryIds, ["sync-crash-fixture"]);
});

test("listInstalledBundles: no dependencies/bundles returns []", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-installed-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "fake-profile", dsh: { profile: { bundles: [] } } }),
    "utf8",
  );
  assert.deepEqual(await listInstalledBundles(dir), []);
  // also when package.json is missing entirely
  const empty = await mkdtemp(join(tmpdir(), "dshpkg-sup-installed-"));
  assert.deepEqual(await listInstalledBundles(empty), []);
});

test("attributeFromStack: attributes the real E2E link: stack via the source real path", () => {
  const installed = [
    {
      pkgName: "dshpkg-fixture-sync-crash",
      // Windows realpath returns backslashes: the comparison must normalise.
      realPaths: ["C:\\Users\\Sente\\.dsh\\dshpkg\\dsh-pkg\\fixtures\\sync-crash"],
      entryIds: ["sync-crash-fixture"],
      moduleNames: ["dshpkg-fixture-sync-crash"],
    },
  ];
  assert.deepEqual(attributeFromStack(LINK_CRASH_STACK, installed), {
    entryId: "sync-crash-fixture",
    pkgName: "dshpkg-fixture-sync-crash",
  });
});

test("attributeFromStack: node_modules real-path form still matches", () => {
  const installed = [
    {
      pkgName: "pkg-plain",
      realPaths: ["C:/profiles/web/node_modules/pkg-plain"],
      entryIds: ["plain-entry"],
      moduleNames: ["pkg-plain"],
    },
  ];
  const stack = [
    "Error: boom",
    "    at fn (C:\\profiles\\web\\node_modules\\pkg-plain\\index.js:3:3)",
  ].join("\n");
  assert.deepEqual(attributeFromStack(stack, installed), {
    entryId: "plain-entry",
    pkgName: "pkg-plain",
  });
});

test("attributeFromStack: a path fragment is not confused with a longer sibling name", () => {
  const installed = [
    {
      pkgName: "pkg",
      realPaths: ["C:/x/pkg"],
      entryIds: ["pkg-entry"],
      moduleNames: ["pkg"],
    },
  ];
  const stack = [
    "Error: boom",
    "    at fn (C:\\x\\pkg-v2\\index.js:3:3)",
  ].join("\n");
  assert.deepEqual(attributeFromStack(stack, installed), {
    entryId: null,
    pkgName: null,
  });
});

test("attributeFromStack: an entry-name mention is the fallback signal", () => {
  const installed = [
    {
      pkgName: "dshpkg-fixture-sync-crash",
      realPaths: ["C:/elsewhere/not-in-stack"],
      entryIds: ["sync-crash-fixture"],
      moduleNames: ["dshpkg-fixture-sync-crash"],
    },
  ];
  const stack = "Error: dshpkg-fixture-sync-crash exploded";
  assert.deepEqual(attributeFromStack(stack, installed), {
    entryId: "sync-crash-fixture",
    pkgName: "dshpkg-fixture-sync-crash",
  });
});

test("attributeFromStack: no match returns null entryId and null pkgName", () => {
  assert.deepEqual(attributeFromStack("unrelated noise\n", []), {
    entryId: null,
    pkgName: null,
  });
  assert.deepEqual(attributeFromStack("", []), { entryId: null, pkgName: null });
  assert.deepEqual(attributeFromStack(null, undefined), {
    entryId: null,
    pkgName: null,
  });
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

test("readPatchTopLevel: a bare [] placeholder is an 'array' top level", () => {
  assert.deepEqual(readPatchTopLevel("[]"), { ok: true, kind: "array" });
  assert.deepEqual(readPatchTopLevel("[]\n"), { ok: true, kind: "array" });
  assert.deepEqual(readPatchTopLevel("# comment\n[]"), {
    ok: true,
    kind: "array",
  });
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

test("writeManagedDisable: replaces a bare [] placeholder with a valid YAML array", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  await writeFile(join(dir, "cordis.patch.yml"), "[]\n", "utf8");
  const result = await writeManagedDisable(dir, "crashy");
  assert.deepEqual(result, { written: true });
  const text = await readFile(join(dir, "cordis.patch.yml"), "utf8");
  assert.ok(!text.includes("[]"));
  assert.equal(
    text,
    "# dshpkg:managed:start\n- id: crashy\n  disabled: true\n# dshpkg:managed:end\n",
  );
  // idempotent: the same id is not written twice
  assert.deepEqual(await writeManagedDisable(dir, "crashy"), {
    written: false,
  });
});

test("writeManagedDisable: drops the [] placeholder together with its comment header", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  await writeFile(join(dir, "cordis.patch.yml"), "# user comment\n[]\n", "utf8");
  const result = await writeManagedDisable(dir, "crashy");
  assert.deepEqual(result, { written: true });
  const text = await readFile(join(dir, "cordis.patch.yml"), "utf8");
  assert.ok(!text.includes("[]"));
  assert.ok(!text.includes("# user comment"));
  assert.equal(
    text,
    "# dshpkg:managed:start\n- id: crashy\n  disabled: true\n# dshpkg:managed:end\n",
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

test("removeManagedBlock: restores a bare [] after removing the only block", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-sup-patch-"));
  await writeFile(
    join(dir, "cordis.patch.yml"),
    "# dshpkg:managed:start\n- id: a\n  disabled: true\n# dshpkg:managed:end\n",
    "utf8",
  );
  const removed = await removeManagedBlock(dir);
  assert.equal(removed, 1);
  assert.equal(await readFile(join(dir, "cordis.patch.yml"), "utf8"), "[]\n");
});

// --- Phase 1 wiring: incidents, crash bookkeeping, snapshots ----------------

test("eventToIncident flattens supervise events into incident records", () => {
  assert.deepEqual(
    eventToIncident(
      { type: "healthy", detail: { port: 3080, profile: "web" } },
      { profile: "web", port: 3080 },
    ),
    { type: "healthy", port: 3080, profile: "web" },
  );
  assert.deepEqual(
    eventToIncident({ type: "boot-failed", detail: { code: 1, entryId: "x", detail: "boom" } }),
    { type: "boot-failed", code: 1, entryId: "x", detail: "boom", profile: null, port: null },
  );
  assert.deepEqual(
    eventToIncident({ type: "restarting", detail: { attempt: 2 } }, { profile: "web" }),
    { type: "restarting", attempt: 2, profile: "web", port: null },
  );
});

test("persistCrash records crashes into state.json and opens the circuit (P1-2)", async (t) => {
  const { home } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  await persistCrash("boot-crash-fixture");
  let state = await readState();
  assert.equal(state.packages["boot-crash-fixture"].crashCount, 1);
  assert.equal(state.packages["boot-crash-fixture"].crashTimes.length, 1);

  await persistCrash("boot-crash-fixture");
  await persistCrash("boot-crash-fixture");
  state = await readState();
  // the third crash inside the window opens the circuit
  assert.equal(state.packages["boot-crash-fixture"].crashCount, 3);
  assert.equal(typeof state.packages["boot-crash-fixture"].circuitOpenAt, "number");

  // dangerous keys never touch Object.prototype
  await persistCrash("__proto__");
  assert.equal(Object.prototype.hasOwnProperty.call(state.packages, "__proto__"), false);
});

test("persistCircuitOpen marks the circuit open in state.json (P1-2)", async (t) => {
  const { home } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  await persistCircuitOpen("boot-crash-fixture");
  let state = await readState();
  assert.equal(typeof state.packages["boot-crash-fixture"].circuitOpenAt, "number");
  assert.equal(state.packages["boot-crash-fixture"].crashCount, 3);

  // an already-open circuit keeps its marker
  await persistCircuitOpen("boot-crash-fixture");
  state = await readState();
  assert.equal(typeof state.packages["boot-crash-fixture"].circuitOpenAt, "number");

  // dangerous keys never touch Object.prototype
  await persistCircuitOpen("__proto__");
  assert.equal(Object.prototype.hasOwnProperty.call(state.packages, "__proto__"), false);
});

test("supervise: healthy wires incident + snapshot side effects (P1-1+P1-3)", async (t) => {
  const { home, profileDir } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  // Injected sinks prove the loop calls the wiring functions with the right
  // payloads; the real writers (appendIncident / saveSnapshot) are covered
  // by their own unit tests (state.test.js / snapshot.test.js).
  // The watchdog is stopped by the child's CLEAN EXIT (code 0) instead of
  // SIGINT: the sandbox test runner treats a synthetic SIGINT as an abort
  // signal and cancels every following test.
  const incidents = [];
  const snapshots = [];
  const children = [];
  const events = [];
  const run = supervise({
    profile: "web",
    onEvent: (e) => events.push(e),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => true,
    sleepImpl: async () => {},
    incidentImpl: async (rec) => incidents.push(rec),
    // The snapshot trigger is the first awaited point after healthy: exit the
    // child cleanly there so the loop ends deterministically.
    snapshotImpl: async (dir) => {
      snapshots.push(dir);
      children[0]?.emit("exit", 0, null);
    },
  });
  await waitFor(() => events.some((e) => e.type === "healthy"));
  await run;

  // P1-1: the healthy event was handed to the incident writer (flat record).
  assert.equal(incidents.length, 1);
  assert.deepEqual(incidents[0], { type: "healthy", port: 3080, profile: "web" });
  // P1-3 trigger ②: the known-good profile dir was handed to the snapshotter.
  assert.deepEqual(snapshots, [profileDir]);
});

test("supervise: healthy idle window re-invokes the poll hook (P2-4 wiring)", async (t) => {
  const { home } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  // The first poll "runs" (loop re-checks), the second one emits a clean
  // child exit (code 0) so the watchdog stops deterministically — no SIGINT
  // (the sandbox runner treats a synthetic SIGINT as an abort signal).
  const polls = [];
  const children = [];
  const events = [];
  const run = supervise({
    profile: "web",
    onEvent: (e) => events.push(e),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => true,
    sleepImpl: async () => {},
    incidentImpl: async () => {},
    snapshotImpl: async () => {},
    pollImpl: async () => {
      polls.push(1);
      if (polls.length === 2) children[0]?.emit("exit", 0, null);
      return { ran: polls.length === 1 };
    },
  });
  await waitFor(() => events.some((e) => e.type === "healthy"));
  await run;

  // The hook ran once per idle-window wake-up: the first returned "ran" and
  // the loop re-checked (second call), then the clean exit stopped the loop.
  assert.equal(polls.length, 2);
});

// --- P3-4: unattributable-failure fallbacks ---------------------------------

test("selectSnapshotToRestore walks the chain newest-first, skipping tried ones", () => {
  const snaps = ["c", "b", "a"]; // newest first (listSnapshots convention)
  assert.equal(selectSnapshotToRestore(snaps, []), "c");
  assert.equal(selectSnapshotToRestore(snaps, ["c"]), "b");
  assert.equal(selectSnapshotToRestore(snaps, ["c", "b"]), "a");
  assert.equal(selectSnapshotToRestore(snaps, ["c", "b", "a"]), null);
  assert.equal(selectSnapshotToRestore([], []), null);
});

test("resetToFactoryBaseline removes managed blocks and keeps user content", async (t) => {
  const { home, profileDir } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });
  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    "# dshpkg:managed:start\n- id: x\n  disabled: true\n# dshpkg:managed:end\n- id: user-entry\n",
    "utf8",
  );
  await resetToFactoryBaseline(profileDir);
  const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  assert.equal(patch.includes("dshpkg:managed"), false);
  assert.ok(patch.includes("user-entry"), "user content untouched");
});

test("lockfileHashOf is a stable sha256 of the lockfile content", async (t) => {
  const { home, profileDir } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });
  await writeFile(join(profileDir, "pnpm-lock.yaml"), "lockfile v9\n", "utf8");
  const h = await lockfileHashOf(profileDir);
  assert.equal(h.length, 64);
  assert.equal(h, await lockfileHashOf(profileDir));
  await writeFile(join(profileDir, "pnpm-lock.yaml"), "lockfile v9 changed\n", "utf8");
  assert.notEqual(h, await lockfileHashOf(profileDir));
});

test("supervise: a drifted lockfile triggers the frozen rebuild (P3-4 wiring)", async (t) => {
  const { home, profileDir } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });
  await writeFile(join(profileDir, "pnpm-lock.yaml"), "current lockfile\n", "utf8");
  await writeState({
    lockfileHash: createHash("sha256").update("known good", "utf8").digest("hex"),
  });

  const rebuilds = [];
  const children = [];
  const events = [];
  const run = supervise({
    profile: "web",
    onEvent: (e) => events.push(e),
    spawnImpl: async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probeImpl: async () => true,
    sleepImpl: async () => {},
    incidentImpl: async () => {},
    snapshotImpl: async () => {},
    pollImpl: async () => {
      // stop the loop deterministically via a clean child exit (no SIGINT)
      children[0]?.emit("exit", 0, null);
      return { ran: false };
    },
    pnpmInstallImpl: async (dir) => {
      rebuilds.push(dir);
    },
  });
  await waitFor(() => events.some((e) => e.type === "healthy"));
  await run;

  assert.equal(rebuilds.length, 1, "drifted lockfile rebuilt exactly once");
  assert.equal(rebuilds[0], profileDir);
  // the known-good hash now matches the rebuilt lockfile
  const state = await readState();
  assert.equal(state.lockfileHash, await lockfileHashOf(profileDir));
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

// --- supervise: uncaughtException stack attribution (sync-crash) ------------

test("supervise: sync-crash uncaughtException is attributed and disabled", async (t) => {
  const { home, profileDir } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  // The culprit package lives in the fake profile's node_modules.
  await mkdir(join(profileDir, "node_modules", "dshpkg-fixture-sync-crash"), {
    recursive: true,
  });
  await writeFile(
    join(profileDir, "node_modules", "dshpkg-fixture-sync-crash", "cordis.patch.yml"),
    "- insert:\n    - id: sync-crash-fixture\n      name: dshpkg-fixture-sync-crash\n",
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
    probeImpl: async () => true,
    // First child dies with the real sync-crash uncaughtException stack;
    // every later child stays alive.
    sleepImpl: async () => {
      const index = graceCalls;
      graceCalls += 1;
      const child = children[index];
      if (child && index === 0) {
        child.stderr.emit("data", SYNC_CRASH_STACK);
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
  assert.match(patch, /- id: sync-crash-fixture/);
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
  assert.equal(bootFailed.detail.entryId, "sync-crash-fixture");
  assert.ok(bootFailed.detail.detail.includes("sync-crash fixture"));
  assert.equal(children.length, 2);
});

// --- supervise: link: junction uncaughtException (E2E finding) ---------------

test("supervise: link: junction uncaughtException is attributed via its real path", async (t) => {
  const { home, profileDir } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  // pnpm link: install layout: the sources live outside the profile and
  // node_modules/<pkg> is a junction; the Node stack then shows the TRUE
  // source path (no node_modules segment, no package name), which is exactly
  // what the E2E sync-crash run produced.
  const srcDir = await mkdtemp(join(tmpdir(), "dshpkg-sup-src-"));
  await writeFile(join(srcDir, "cordis.patch.yml"), SYNC_CRASH_PATCH, "utf8");
  const nmDir = join(profileDir, "node_modules");
  await mkdir(nmDir, { recursive: true });
  try {
    await symlink(
      srcDir,
      join(nmDir, "dshpkg-fixture-sync-crash"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    // junction creation unsupported: the link: dependency value below still
    // carries the source path, covering the same attribution.
  }
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({
      name: "web",
      dsh: { profile: { bundles: ["dshpkg-fixture-sync-crash"] } },
      dependencies: { "dshpkg-fixture-sync-crash": `link:${srcDir}` },
    }),
    "utf8",
  );
  const realSrc = (await realpath(srcDir)).replace(/\\/g, "/");
  const linkCrashStack = [
    "Error: sync-crash fixture: intentional uncaughtException",
    `    at Timeout._onTimeout (file:///${realSrc}/index.js:8:11)`,
  ].join("\n");

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
    // First child dies during its grace sleep with the junction-resolved
    // stack; every later child stays alive.
    sleepImpl: async () => {
      const index = graceCalls;
      graceCalls += 1;
      const child = children[index];
      if (child && index === 0) {
        child.stderr.emit("data", linkCrashStack);
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
  assert.match(patch, /- id: sync-crash-fixture/);
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
  assert.equal(bootFailed.detail.entryId, "sync-crash-fixture");
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

// --- parseCliArgs: supervisor flags vs dsh passthrough ---------------------

test("parseCliArgs: --profile/--port parse AND stay in args for dsh passthrough", () => {
  const opts = parseCliArgs(["--profile", "web", "--port", "3199"]);
  assert.equal(opts.profile, "web");
  assert.equal(opts.port, 3199);
  // Both pairs are forwarded verbatim: dsh needs --profile (launcher flag)
  // and --port (web app flag) to bind the same port the supervisor probes.
  assert.deepEqual(opts.args, ["--profile", "web", "--port", "3199"]);
});

test("parseCliArgs: = forms of --profile/--port also stay in args", () => {
  const opts = parseCliArgs(["--profile=web", "--port=3199"]);
  assert.equal(opts.profile, "web");
  assert.equal(opts.port, 3199);
  assert.deepEqual(opts.args, ["--profile=web", "--port=3199"]);
});

test("parseCliArgs: --health-path is supervisor-only and never enters args", () => {
  const opts = parseCliArgs(["--health-path", "/healthz"]);
  assert.equal(opts.healthPath, "/healthz");
  assert.deepEqual(opts.args, []);
  const optsEq = parseCliArgs(["--health-path=/healthz"]);
  assert.equal(optsEq.healthPath, "/healthz");
  assert.deepEqual(optsEq.args, []);
});

// --- supervise: explicit port option reaches the dsh child ------------------

test("supervise: explicit port option appends --port to the spawn args", async (t) => {
  const { home } = await makeProfileHome(t);
  const stateRoot = await makeStateRoot(t);
  useTempEnv(t, { home, stateRoot });

  const events = [];
  const spawnCalls = [];
  const run = supervise({
    profile: "web",
    port: 3199,
    args: [], // no --port pair here: the option must be forwarded on its own
    onEvent: (event) => events.push(event),
    spawnImpl: async (spawnOpts) => {
      spawnCalls.push(spawnOpts);
      return fakeChild();
    },
    probeImpl: async () => true,
    sleepImpl: async () => {},
  });
  await waitFor(() => events.some((e) => e.type === "healthy"));
  process.emit("SIGINT");
  await run;

  assert.equal(spawnCalls.length, 1);
  const idx = spawnCalls[0].args.indexOf("--port");
  assert.notEqual(idx, -1);
  assert.equal(spawnCalls[0].args[idx + 1], "3199");
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
