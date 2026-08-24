// dshpkg — tests for lib/triage.js (crash log parsing + attribution).
// No live dsh profile is booted. The only filesystem IO writes an incidents
// stream into an fs.mkdtemp temp dir (via DSH_PKG_HOME) so the shared state
// helpers are exercised against real files, never ~/.dsh.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseLoaderErrors, attributeCrash } from "../lib/triage.js";
import { appendIncident, readIncidents } from "../lib/state.js";

// Exact message captured from dsh 0.1.1-rc.2 (Node 24.19) — the contract
// string the triage regex was designed against.
const INNER =
  "failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure";

// The include wrapper adds one nesting level around the culprit.
const WRAPPED =
  "failed to apply loader entry include (cordis:include): " + INNER;

test("parseLoaderErrors: exact dsh 0.1.1-rc.2 boot message", () => {
  assert.deepEqual(parseLoaderErrors(INNER), [
    {
      stage: "apply",
      entryId: "boot-crash-fixture",
      entryName: "dshpkg-fixture-boot-crash",
      detail: "boot-crash fixture: intentional boot failure",
    },
  ]);
});

test("parseLoaderErrors: nested wrapper — all matches, innermost last", () => {
  assert.deepEqual(parseLoaderErrors(WRAPPED), [
    {
      stage: "apply",
      entryId: "include",
      entryName: "cordis:include",
      detail: "",
    },
    {
      stage: "apply",
      entryId: "boot-crash-fixture",
      entryName: "dshpkg-fixture-boot-crash",
      detail: "boot-crash fixture: intentional boot failure",
    },
  ]);
});

test("parseLoaderErrors: multi-line stderr with noise and other stages", () => {
  const text = [
    "[2026-08-24 10:00:00] booting profile web",
    WRAPPED,
    "    at apply (file:///C:/Users/Sente/.dsh/plugins/x/index.js:12:11)",
    "failed to dispose loader entry stale (pkg-stale): cleanup failed",
  ].join("\n");
  assert.deepEqual(parseLoaderErrors(text), [
    {
      stage: "apply",
      entryId: "include",
      entryName: "cordis:include",
      detail: "",
    },
    {
      stage: "apply",
      entryId: "boot-crash-fixture",
      entryName: "dshpkg-fixture-boot-crash",
      detail: "boot-crash fixture: intentional boot failure",
    },
    {
      stage: "dispose",
      entryId: "stale",
      entryName: "pkg-stale",
      detail: "cleanup failed",
    },
  ]);
});

test("parseLoaderErrors: null / empty / non-string input", () => {
  assert.deepEqual(parseLoaderErrors(""), []);
  assert.deepEqual(parseLoaderErrors(null), []);
  assert.deepEqual(parseLoaderErrors(undefined), []);
  assert.deepEqual(parseLoaderErrors(42), []);
});

test("attributeCrash: 1) innermost loader error wins over stats and incidents", () => {
  const result = attributeCrash({
    stderrTail: WRAPPED,
    incidents: [{ t: "2026-08-24T10:00:00Z", entryId: "other" }],
    state: { packages: { loud: { crashCount: 9 } } },
  });
  assert.deepEqual(result, {
    entryId: "boot-crash-fixture",
    reason:
      "启动日志定位到崩溃条目 boot-crash-fixture（apply）：boot-crash fixture: intentional boot failure",
  });
});

test("attributeCrash: 2) highest crashCount when stderr has no loader error", () => {
  const result = attributeCrash({
    stderrTail: "some unrelated stderr noise\n",
    incidents: [{ t: "2026-08-24T10:00:00Z", entryId: "recent" }],
    state: {
      packages: { a: { crashCount: 2 }, b: { crashCount: 5 }, c: { crashCount: 5 } },
    },
  });
  // first of the tied-highest wins (stable insertion order)
  assert.deepEqual(result, {
    entryId: "b",
    reason: "状态中崩溃次数最高：b（5 次）",
  });
});

test("attributeCrash: 3) newest incident record with an entryId", () => {
  const result = attributeCrash({
    stderrTail: "",
    incidents: [
      { t: "2026-08-24T09:00:00Z", entryId: "old" },
      { t: "2026-08-24T10:00:00Z", entryId: "newest" },
    ],
    state: { packages: {} },
  });
  assert.deepEqual(result, {
    entryId: "newest",
    reason: "最近一次崩溃记录指向：newest",
  });
});

test("attributeCrash: skips incident records without entryId", () => {
  const result = attributeCrash({
    stderrTail: null,
    incidents: [
      { t: "2026-08-24T09:00:00Z", entryId: "old" },
      { t: "2026-08-24T10:00:00Z", note: "no entryId here" },
    ],
    state: null,
  });
  assert.deepEqual(result, {
    entryId: "old",
    reason: "最近一次崩溃记录指向：old",
  });
});

test("attributeCrash: zero crashCount packages are not evidence", () => {
  const result = attributeCrash({
    stderrTail: "",
    incidents: [],
    state: { packages: { quiet: { crashCount: 0 } } },
  });
  assert.equal(result.entryId, null);
});

test("attributeCrash: 4) gives up with null entryId", () => {
  assert.deepEqual(attributeCrash(), {
    entryId: null,
    reason: "未能定位崩溃来源",
  });
  assert.deepEqual(attributeCrash({}), {
    entryId: null,
    reason: "未能定位崩溃来源",
  });
  assert.deepEqual(
    attributeCrash({ stderrTail: "", incidents: [], state: { packages: {} } }),
    { entryId: null, reason: "未能定位崩溃来源" },
  );
});

test("attributeCrash: real incidents stream via state helpers (temp dir)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-triage-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = dir;
  try {
    await appendIncident({ entryId: "net-broken", reason: "apply failed" });
    const incidents = await readIncidents();
    const result = attributeCrash({ stderrTail: "", incidents, state: { packages: {} } });
    assert.deepEqual(result, {
      entryId: "net-broken",
      reason: "最近一次崩溃记录指向：net-broken",
    });
  } finally {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
