// Tests for lib/diag.js — crash evidence + failure classification.
// Golden strings are the REAL incident details from the 2026-08-31/09-03
// dsh web crash storms (gateway authority, workspaceRegistry pending,
// missing fixture package, session compression mismatch).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  culpritCandidates,
  collectBootEvidence,
  suggestAction,
  FAILURE_CLASSES,
} from "../lib/diag.js";

// --- real incident golden strings -------------------------------------------

const GATEWAY_CRASH = `dsh: plugin tree failed to load: failed to apply loader entry dsh-remote-web-gateway (dsh-remote-web-gateway): Cannot read properties of undefined (reading 'authority')
TypeError: Cannot read properties of undefined (reading 'authority')
    at Proxy.register (file:///C:/Users/Sente/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:243:32)
    at Object.apply (file:///C:/Users/Sente/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:120:36)
    at dsh-remote-web-gateway/lib/index.js:94:44`;

const PENDING_CRASH = `dsh: plugin tree failed to load: dsh: 2 entries did not activate
@deepseek-ai/dsh-host-apiproxy: pending (waiting for service: workspaceRegistry)
dsh-memory-evolve: pending (waiting for service: workspaceRegistry)`;

const MISSING_PKG = `dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): Cannot find package 'dshpkg-fixture-boot-crash' imported from C:\\Users\\Sente\\.dsh\\profiles\\web\\
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dshpkg-fixture-boot-crash'`;

const SESSION_FORMAT = `dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry workspace (@deepseek-ai/dsh-workspace): session artifact "C:\\Users\\Sente\\.dsh\\sessions\\--C-Users-Sente-.dsh--\\session-cfabeccd-8c7f-46e2-bb91-b929736b2ba9\\session.jsonl" uses .jsonl, but this backend is configured for compression "zstd"; use a separate root or select the matching compression mode`;

const FIXTURE_CRASH = `dsh: plugin tree failed to load: failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure`;

// --- classification ----------------------------------------------------------

test("classifyFailure: gateway authority crash → upgrade-incompat", () => {
  const { clazz, hint } = classifyFailure(GATEWAY_CRASH);
  assert.equal(clazz, "upgrade-incompat");
  assert.ok(hint.includes("authority"));
  assert.ok(hint.includes("升级"), "hint should recommend upgrade, not disable");
  assert.ok(!hint.includes("建议禁用"), "must NOT recommend disabling the culprit");
});

test("classifyFailure: workspaceRegistry pending → service-pending", () => {
  const { clazz, hint } = classifyFailure(PENDING_CRASH);
  assert.equal(clazz, "service-pending");
  assert.ok(hint.includes("workspaceRegistry"));
});

test("classifyFailure: missing fixture package → missing-package", () => {
  const { clazz } = classifyFailure(MISSING_PKG);
  assert.equal(clazz, "missing-package");
});

test("classifyFailure: session zstd mismatch → session-format", () => {
  const { clazz } = classifyFailure(SESSION_FORMAT);
  assert.equal(clazz, "session-format");
});

test("classifyFailure: intentional boot failure → fixture", () => {
  const { clazz } = classifyFailure(FIXTURE_CRASH);
  assert.equal(clazz, "fixture");
});

test("classifyFailure: garbage/empty → unknown", () => {
  assert.equal(classifyFailure("").clazz, "unknown");
  assert.equal(classifyFailure("some random noise").clazz, "unknown");
  assert.equal(classifyFailure(undefined).clazz, "unknown");
});

test("FAILURE_CLASSES contains all five concrete classes + unknown", () => {
  for (const c of ["upgrade-incompat", "service-pending", "missing-package", "session-format", "fixture", "unknown"]) {
    assert.ok(FAILURE_CLASSES.includes(c), c);
  }
});

// --- culprit extraction ------------------------------------------------------

test("culpritCandidates: loader entry named in the message first", () => {
  const ids = culpritCandidates(GATEWAY_CRASH);
  assert.ok(ids.includes("dsh-remote-web-gateway"));
});

test("culpritCandidates: pending-entries named for service-pending", () => {
  const ids = culpritCandidates(PENDING_CRASH);
  assert.ok(ids.includes("@deepseek-ai/dsh-host-apiproxy"));
  assert.ok(ids.includes("dsh-memory-evolve"));
});

test("culpritCandidates: dedupes and handles missing text", () => {
  assert.deepEqual(culpritCandidates(""), []);
  const ids = culpritCandidates(GATEWAY_CRASH + GATEWAY_CRASH);
  assert.equal(ids.filter((x) => x === "dsh-remote-web-gateway").length, 1);
});

// --- evidence aggregation ----------------------------------------------------

test("collectBootEvidence: aggregates crashes, ranks culprits, counts classes", () => {
  const incidents = [
    { type: "uncaught-exception", at: "2026-09-03T04:00Z", detail: GATEWAY_CRASH },
    { type: "boot-tree-crash", at: "2026-09-03T04:00Z" },
    { type: "uncaught-exception", at: "2026-09-03T05:00Z", detail: PENDING_CRASH },
    { type: "uncaught-exception", at: "2026-09-03T06:00Z", detail: PENDING_CRASH },
    { type: "boot-confirmed", at: "2026-09-03T07:00Z" }, // non-crash: ignored
    { type: "uncaught-exception", at: "2026-09-03T06:30Z", detail: MISSING_PKG },
  ];
  const ev = collectBootEvidence({ incidents, state: { lastBootOkAt: "2026-09-03T07:00Z", bootFailures: 3 } });
  assert.equal(ev.total, 6);
  assert.equal(ev.crashes.length, 5); // boot-confirmed excluded
  assert.equal(ev.lastBootOkAt, "2026-09-03T07:00Z");
  assert.equal(ev.bootFailures, 3);
  assert.equal(ev.classCounts["upgrade-incompat"], 1);
  assert.equal(ev.classCounts["service-pending"], 2);
  assert.equal(ev.classCounts["missing-package"], 1);
  // top culprit: apiproxy + memory-evolve appear twice via pending blocks,
  // gateway once — but ranking is by occurrence count; apiproxy wins
  assert.ok(ev.topCulprits.includes("@deepseek-ai/dsh-host-apiproxy"));
  assert.ok(ev.topCulprits.length <= 8);
});

test("collectBootEvidence: tolerant of malformed incident lines", () => {
  const ev = collectBootEvidence({ incidents: [null, "junk", { type: "uncaught-exception" }, {}] });
  assert.equal(ev.crashes.length, 1);
  assert.equal(ev.classCounts["unknown"], 1);
});

// --- suggestions -------------------------------------------------------------

test("suggestAction: upgrade-incompat → upgrade (not disable)", () => {
  const a = suggestAction("upgrade-incompat", { name: "dsh-remote-web-gateway" });
  assert.equal(a.kind, "upgrade");
  assert.equal(a.reversible, true);
});

test("suggestAction: service-pending → check-service (never disable dependents)", () => {
  const a = suggestAction("service-pending", { name: "dsh-host-apiproxy" });
  assert.equal(a.kind, "check-service");
  assert.equal(a.reversible, true);
});

test("suggestAction: missing-package → install-dep; fixture → disable; unknown/session → manual", () => {
  assert.equal(suggestAction("missing-package").kind, "install-dep");
  assert.equal(suggestAction("fixture").kind, "disable");
  assert.equal(suggestAction("session-format").kind, "manual");
  assert.equal(suggestAction("unknown").kind, "manual");
  assert.equal(suggestAction("nonsense").kind, "manual");
});