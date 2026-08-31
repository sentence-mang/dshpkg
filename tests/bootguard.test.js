// Tests for lib/bootguard.js — the in-process boot guardian (R16).
// Pure logic is tested without IO; the sync IO helpers run against temp
// dirs only (never a real ~/.dsh). No process is ever killed: the exit
// hook is invoked directly as a function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_CONFIRM_MS,
  SAFE_MODE_FAILURES,
  NEVER_DISABLE,
  decideBootDisables,
  hasStaleBootMarker,
  newestInstalled,
  readStateSync,
  writeStateSync,
  appendIncidentSync,
  writeManagedDisableSync,
  createCrashCapture,
  attributeCaptured,
  handleExitSync,
  confirmBootSync,
  cleanShutdownSync,
  handleUncaughtLoaderSync,
  degradeBootSync,
} from "../lib/bootguard.js";

// Exact verified kernel message (CONTRACTS.md) + the nested wrapper form.
const EXACT_CRASH_TEXT =
  "failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure";
const NESTED_CRASH_TEXT = `failed to apply loader entry include (cordis:include): ${EXACT_CRASH_TEXT}`;

const ENTRY_IDS = ["loader", "include", "dshpkg", "dsh-a", "dsh-b", "web-startup"];
const isProtected = (id) => ["loader", "include", "dshpkg", "web-startup"].includes(id);

// --- decideBootDisables -------------------------------------------------------

test("decideBootDisables: no failures -> no disables", () => {
  assert.deepEqual(
    decideBootDisables({ bootFailures: 0, lastCulprit: "dsh-a", entryIds: ENTRY_IDS, isProtected }),
    [],
  );
});

test("decideBootDisables: level 1 disables the attributed culprit only", () => {
  const out = decideBootDisables({
    bootFailures: 1,
    lastCulprit: "dsh-a",
    latestInstalled: ["dsh-b"],
    entryIds: ENTRY_IDS,
    isProtected,
  });
  assert.deepEqual(out, ["dsh-a"]);
});

test("decideBootDisables: level 2 adds the newest installed candidate", () => {
  const out = decideBootDisables({
    bootFailures: 2,
    lastCulprit: "dsh-a",
    latestInstalled: ["dsh-b"],
    entryIds: ENTRY_IDS,
    isProtected,
  });
  assert.deepEqual(out, ["dsh-a", "dsh-b"]);
});

test("decideBootDisables: level 3 is safe mode (all known non-core entries)", () => {
  const out = decideBootDisables({
    bootFailures: SAFE_MODE_FAILURES,
    lastCulprit: null,
    latestInstalled: [],
    entryIds: ENTRY_IDS,
    isProtected,
  });
  // loader/include/web-startup are NEVER_DISABLE; dshpkg is protected but
  // safe mode disables everything non-core.
  assert.deepEqual(out, ["dshpkg", "dsh-a", "dsh-b"]);
});

test("decideBootDisables: proven attribution overrides protection (except kernel-core)", () => {
  // culprit is protected (dshpkg) but proven -> disabled at level 1
  const out = decideBootDisables({
    bootFailures: 1,
    lastCulprit: "dshpkg",
    entryIds: ENTRY_IDS,
    isProtected,
  });
  assert.deepEqual(out, ["dshpkg"]);
  // culprit in NEVER_DISABLE is refused even when proven
  const out2 = decideBootDisables({
    bootFailures: 1,
    lastCulprit: "loader",
    entryIds: ENTRY_IDS,
    isProtected,
  });
  assert.deepEqual(out2, []);
});

test("decideBootDisables: candidates unknown to the loader are dropped", () => {
  const out = decideBootDisables({
    bootFailures: 2,
    lastCulprit: "ghost-entry",
    latestInstalled: ["another-ghost"],
    entryIds: ENTRY_IDS,
    isProtected,
  });
  assert.deepEqual(out, []);
});

test("decideBootDisables constants are sane", () => {
  assert.equal(BOOT_CONFIRM_MS, 45_000);
  assert.equal(SAFE_MODE_FAILURES, 3);
  assert.ok(NEVER_DISABLE.has("loader"));
  assert.ok(!NEVER_DISABLE.has("dshpkg")); // self-sacrifice stays possible
});

// --- marker + suspect helpers --------------------------------------------------

test("hasStaleBootMarker: true only with a startedAt marker", () => {
  assert.equal(hasStaleBootMarker({ boot: { startedAt: "x" } }), true);
  assert.equal(hasStaleBootMarker({ boot: {} }), false);
  assert.equal(hasStaleBootMarker({}), false);
  assert.equal(hasStaleBootMarker(null), false);
});

test("newestInstalled: sorts by installedAt descending, skips dangerous keys", () => {
  const state = {
    packages: {
      "dsh-old": { installedAt: "2026-01-01T00:00:00.000Z" },
      "dsh-new": { installedAt: "2026-08-01T00:00:00.000Z" },
      "dsh-mid": { installedAt: "2026-04-01T00:00:00.000Z" },
      __proto__: { installedAt: "2026-09-01T00:00:00.000Z" },
    },
  };
  const out = newestInstalled(state);
  assert.deepEqual(out.slice(0, 3), ["dsh-new", "dsh-mid", "dsh-old"]);
  assert.ok(!out.includes("__proto__"));
  assert.deepEqual(newestInstalled(null), []);
});

// --- sync IO helpers -------------------------------------------------------------

async function tempDir(prefix) {
  return await mkdtemp(join(tmpdir(), prefix));
}

test("readStateSync/writeStateSync roundtrip + tolerance", async () => {
  const dir = await tempDir("dshpkg-bg-state-");
  const file = join(dir, "state.json");
  assert.equal(readStateSync(file), null); // missing
  writeStateSync(file, { version: 1, bootFailures: 2 });
  assert.deepEqual(readStateSync(file), { version: 1, bootFailures: 2 });
  await writeFile(file, "not json{{", "utf8");
  assert.equal(readStateSync(file), null); // corrupt
});

test("writeManagedDisableSync appends once and is idempotent", async () => {
  const dir = await tempDir("dshpkg-bg-patch-");
  const patchFile = join(dir, "cordis.patch.yml");
  await writeFile(patchFile, "[]\n", "utf8");
  assert.equal(writeManagedDisableSync(patchFile, "dsh-a"), true);
  const text = readFileSync(patchFile, "utf8");
  assert.match(text, /# dshpkg:managed:start/);
  assert.match(text, /- id: dsh-a/);
  assert.match(text, /disabled: true/);
  assert.match(text, /# dshpkg:managed:end/);
  // second write: unchanged
  assert.equal(writeManagedDisableSync(patchFile, "dsh-a"), false);
  assert.equal(readFileSync(patchFile, "utf8"), text);
});

test("appendIncidentSync appends one JSON line per call", async () => {
  const dir = await tempDir("dshpkg-bg-inc-");
  const file = join(dir, "incidents.jsonl");
  appendIncidentSync(file, { type: "a" });
  appendIncidentSync(file, { type: "b" });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { type: "a" });
});

// --- stderr capture + attribution --------------------------------------------------

test("createCrashCapture collects loader-error lines only and restores", () => {
  const writes = [];
  const originalWrite = function write(chunk, ...rest) {
    writes.push(chunk);
    return true;
  };
  const stderr = { write: originalWrite };
  const { captured, restore } = createCrashCapture({ stderr });
  assert.notEqual(stderr.write, originalWrite); // wrapped
  stderr.write("some normal log\n");
  stderr.write(EXACT_CRASH_TEXT + "\n");
  stderr.write("trailing noise\n");
  assert.deepEqual(captured, [EXACT_CRASH_TEXT + "\n"]);
  assert.equal(writes.length, 3); // original writer saw everything
  restore();
  assert.equal(stderr.write, originalWrite); // restored
});

test("attributeCaptured picks the innermost match of a nested crash", () => {
  assert.equal(attributeCaptured([NESTED_CRASH_TEXT]), "boot-crash-fixture");
  assert.equal(attributeCaptured([EXACT_CRASH_TEXT]), "boot-crash-fixture");
  assert.equal(attributeCaptured(["unrelated noise"]), null);
  assert.equal(attributeCaptured([]), null);
});

// --- handleExitSync -------------------------------------------------------------

test("handleExitSync: no marker -> no-op", async () => {
  const dir = await tempDir("dshpkg-bg-exit-");
  const stateFile = join(dir, "state.json");
  writeStateSync(stateFile, { version: 1, bootFailures: 0 });
  handleExitSync(
    { stateFile, incidentsFile: join(dir, "incidents.jsonl"), patchFile: join(dir, "cordis.patch.yml"), captured: [] },
    1,
  );
  assert.deepEqual(readStateSync(stateFile), { version: 1, bootFailures: 0 });
});

test("handleExitSync: clean exit clears the marker quietly", async () => {
  const dir = await tempDir("dshpkg-bg-exit-");
  const stateFile = join(dir, "state.json");
  writeStateSync(stateFile, { version: 1, bootFailures: 1, boot: { startedAt: "t" } });
  handleExitSync(
    { stateFile, incidentsFile: join(dir, "incidents.jsonl"), patchFile: null, captured: [] },
    0,
  );
  const state = readStateSync(stateFile);
  assert.equal(state.boot, undefined);
  assert.equal(state.bootFailures, 1); // untouched: not a crash
});

test("handleExitSync: crash exit attributes, disables and records", async () => {
  const dir = await tempDir("dshpkg-bg-exit-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  const patchFile = join(dir, "cordis.patch.yml");
  writeStateSync(stateFile, { version: 1, bootFailures: 1, boot: { startedAt: "t" } });
  await writeFile(patchFile, "[]\n", "utf8");
  handleExitSync(
    { stateFile, incidentsFile, patchFile, captured: [NESTED_CRASH_TEXT] },
    1,
  );
  // the culprit's managed disable block is on disk (before process death)
  const patch = readFileSync(patchFile, "utf8");
  assert.match(patch, /- id: boot-crash-fixture/);
  assert.match(patch, /disabled: true/);
  // the incident is recorded and the attribution survives in state
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "boot-crash");
  assert.equal(incident.entryId, "boot-crash-fixture");
  const state = readStateSync(stateFile);
  assert.equal(state.boot.lastCulprit, "boot-crash-fixture");
  assert.ok(state.boot.crashedAt);
});

test("handleExitSync: crash without attribution still records the incident", async () => {
  const dir = await tempDir("dshpkg-bg-exit-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  writeStateSync(stateFile, { version: 1, boot: { startedAt: "t" } });
  handleExitSync({ stateFile, incidentsFile, patchFile: null, captured: [] }, 1);
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "boot-crash");
  assert.equal(incident.entryId, null);
  assert.equal(readStateSync(stateFile).boot.lastCulprit, null);
});

test("handleExitSync: a protected culprit is recorded but never disabled (R18)", async () => {
  const dir = await tempDir("dshpkg-bg-exit-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  const patchFile = join(dir, "cordis.patch.yml");
  writeStateSync(stateFile, { version: 1, bootFailures: 1, boot: { startedAt: "t" } });
  await writeFile(patchFile, "[]\n", "utf8");
  // The captured stderr blames the protected "webserver" entry (the
  // EADDRINUSE shape). Defense in depth: the incident is recorded and the
  // culprit survives in state, but NO managed disable block is written.
  const captured = [
    "failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): Error: listen EADDRINUSE: address already in use 127.0.0.1:3080",
  ];
  handleExitSync({ stateFile, incidentsFile, patchFile, captured }, 1);
  const patch = readFileSync(patchFile, "utf8");
  assert.equal(patch.includes("dshpkg:managed"), false);
  assert.equal(patch.includes("disabled: true"), false);
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "boot-crash");
  assert.equal(incident.entryId, "webserver");
  assert.equal(readStateSync(stateFile).boot.lastCulprit, "webserver");
});

test("handleExitSync: loader stays protected on the exit path too (R18)", async () => {
  const dir = await tempDir("dshpkg-bg-exit-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  const patchFile = join(dir, "cordis.patch.yml");
  writeStateSync(stateFile, { version: 1, boot: { startedAt: "t" } });
  await writeFile(patchFile, "[]\n", "utf8");
  handleExitSync(
    {
      stateFile,
      incidentsFile,
      patchFile,
      captured: ["failed to apply loader entry loader (cordis:loader): kernel broken"],
    },
    1,
  );
  const patch = readFileSync(patchFile, "utf8");
  assert.equal(patch.includes("dshpkg:managed"), false);
  assert.equal(JSON.parse(readFileSync(incidentsFile, "utf8").trim()).entryId, "loader");
});

// --- cleanShutdownSync (R19) -----------------------------------------------

test("cleanShutdownSync clears the boot marker and records clean-shutdown", async () => {
  const dir = await tempDir("dshpkg-bg-shutdown-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  writeStateSync(stateFile, { version: 1, bootFailures: 2, boot: { startedAt: "t" } });
  cleanShutdownSync({ stateFile, incidentsFile });
  const state = readStateSync(stateFile);
  assert.equal(state.boot, undefined, "marker cleared: this stop was not a crash");
  assert.equal(state.bootFailures, 2, "failure counter untouched by a clean stop");
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "clean-shutdown");
});

test("cleanShutdownSync without a marker still records the event and never throws", async () => {
  const dir = await tempDir("dshpkg-bg-shutdown-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  writeStateSync(stateFile, { version: 1, bootFailures: 0 });
  cleanShutdownSync({ stateFile, incidentsFile });
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "clean-shutdown");
});

test("cleanShutdownSync with a missing state file is a silent no-op (only the event)", async () => {
  const dir = await tempDir("dshpkg-bg-shutdown-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  cleanShutdownSync({ stateFile, incidentsFile });
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "clean-shutdown");
});

// --- handleUncaughtLoaderSync (R20) ----------------------------------------

test("handleUncaughtLoaderSync attributes and disables the culprit immediately", async () => {
  const dir = await tempDir("dshpkg-bg-uncaught-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  const patchFile = join(dir, "cordis.patch.yml");
  writeStateSync(stateFile, { version: 1, bootFailures: 0, boot: { startedAt: "t" } });
  await writeFile(patchFile, "[]\n", "utf8");
  const errText =
    "dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): " +
    "failed to import loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): Cannot find package 'x'";
  handleUncaughtLoaderSync({ stateFile, incidentsFile, patchFile }, errText);
  // the disable block lands NOW (a hard-killed zombie still converges)
  const patch = readFileSync(patchFile, "utf8");
  assert.match(patch, /- id: boot-crash-fixture/);
  assert.match(patch, /disabled: true/);
  // the culprit is persisted for the next boot's preemptive decision
  assert.equal(readStateSync(stateFile).boot.lastCulprit, "boot-crash-fixture");
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "boot-tree-crash");
  assert.equal(incident.entryId, "boot-crash-fixture");
});

test("handleUncaughtLoaderSync with unattributable text only records the event", async () => {
  const dir = await tempDir("dshpkg-bg-uncaught-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  const patchFile = join(dir, "cordis.patch.yml");
  writeStateSync(stateFile, { version: 1, bootFailures: 0, boot: { startedAt: "t" } });
  await writeFile(patchFile, "[]\n", "utf8");
  handleUncaughtLoaderSync({ stateFile, incidentsFile, patchFile }, "some unrelated runtime error");
  assert.equal(readFileSync(patchFile, "utf8"), "[]\n");
  assert.equal(readStateSync(stateFile).boot.lastCulprit, undefined);
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "boot-tree-crash");
  assert.equal(incident.entryId, null);
});

test("handleUncaughtLoaderSync never disables a protected entry", async () => {
  const dir = await tempDir("dshpkg-bg-uncaught-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  const patchFile = join(dir, "cordis.patch.yml");
  writeStateSync(stateFile, { version: 1, boot: { startedAt: "t" } });
  await writeFile(patchFile, "[]\n", "utf8");
  handleUncaughtLoaderSync(
    { stateFile, incidentsFile, patchFile },
    "failed to apply loader entry loader (cordis:loader): kernel broken",
  );
  assert.equal(readFileSync(patchFile, "utf8"), "[]\n", "loader stays enabled");
  assert.equal(readStateSync(stateFile).boot.lastCulprit, "loader");
});

// --- degradeBootSync (R20) ---------------------------------------------------

test("degradeBootSync keeps the marker, bumps failures, records boot-degraded", async () => {
  const dir = await tempDir("dshpkg-bg-degrade-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  writeStateSync(stateFile, { version: 1, bootFailures: 0, boot: { startedAt: "t" } });
  degradeBootSync({ stateFile, incidentsFile });
  const state = readStateSync(stateFile);
  assert.ok(state.boot?.startedAt, "marker kept: next boot escalates");
  assert.equal(state.bootFailures, 1);
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "boot-degraded");
});

test("degradeBootSync without a marker is a silent no-op", async () => {
  const dir = await tempDir("dshpkg-bg-degrade-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  writeStateSync(stateFile, { version: 1, bootFailures: 0 });
  degradeBootSync({ stateFile, incidentsFile });
  assert.equal(readStateSync(stateFile).bootFailures, 0);
  assert.equal(existsSync(incidentsFile), false);
});

// --- confirmBootSync -------------------------------------------------------------

test("confirmBootSync: confirms a live boot (marker cleared, failures reset)", async () => {
  const dir = await tempDir("dshpkg-bg-confirm-");
  const stateFile = join(dir, "state.json");
  const incidentsFile = join(dir, "incidents.jsonl");
  writeStateSync(stateFile, { version: 1, bootFailures: 2, boot: { startedAt: "t" } });
  assert.equal(confirmBootSync({ stateFile, incidentsFile, at: "NOW" }), true);
  const state = readStateSync(stateFile);
  assert.equal(state.boot, undefined);
  assert.equal(state.bootFailures, 0);
  assert.equal(state.lastBootOkAt, "NOW");
  const incident = JSON.parse(readFileSync(incidentsFile, "utf8").trim());
  assert.equal(incident.type, "boot-confirmed");
});

test("confirmBootSync: no marker -> false (nothing to confirm)", async () => {
  const dir = await tempDir("dshpkg-bg-confirm-");
  const stateFile = join(dir, "state.json");
  writeStateSync(stateFile, { version: 1, bootFailures: 0 });
  assert.equal(confirmBootSync({ stateFile, incidentsFile: join(dir, "incidents.jsonl") }), false);
});
