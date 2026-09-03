// Tests for lib/governor.js (resource governor) + the memory helpers added to
// lib/perf.js (sampleMemory / memoryBudget). Pure functions, temp-free,
// fully offline.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  budgetLevel,
  reliefCandidates,
  evictionPlan,
  composeBundleOrder,
  DEFAULT_GUARD_BUNDLES,
} from "../lib/governor.js";
import {
  sampleMemory,
  memoryBudget,
  DEFAULT_MEMORY_BUDGET,
} from "../lib/perf.js";

// --- budgetLevel -------------------------------------------------------------

test("budgetLevel: green / yellow / red bands", () => {
  const budget = 1000;
  assert.equal(budgetLevel({ rss: 600, budget }), "green");
  assert.equal(budgetLevel({ rss: 700, budget }), "yellow"); // exactly 0.7
  assert.equal(budgetLevel({ rss: 999, budget }), "yellow");
  assert.equal(budgetLevel({ rss: 1000, budget }), "red");
  assert.equal(budgetLevel({ rss: 1500, budget }), "red");
});

test("budgetLevel: non-positive budget degrades to green", () => {
  assert.equal(budgetLevel({ rss: 1, budget: 0 }), "green");
  assert.equal(budgetLevel({ rss: 1, budget: -5 }), "green");
  assert.equal(budgetLevel({ rss: 0, budget: 0 }), "green");
});

// --- memoryBudget / sampleMemory (lib/perf.js) --------------------------------

test("memoryBudget: computes ratio/remaining/over/pct", () => {
  const budget = 500 * 1024 * 1024;
  const rss = 250 * 1024 * 1024;
  const res = memoryBudget({ memory: { rss }, budget });
  assert.equal(res.rss, rss);
  assert.equal(res.budget, budget);
  assert.ok(Math.abs(res.ratio - 0.5) < 1e-9);
  assert.equal(res.remaining, budget - rss);
  assert.equal(res.over, false);
  assert.equal(res.pct, 50);
});

test("memoryBudget: over budget flags over=true", () => {
  const res = memoryBudget({ memory: { rss: 600 * 1024 * 1024 }, budget: 500 * 1024 * 1024 });
  assert.equal(res.over, true);
  assert.equal(res.pct, 120);
});

test("memoryBudget: defaults to DEFAULT_MEMORY_BUDGET when budget invalid", () => {
  const res = memoryBudget({ memory: { rss: 0 }, budget: 0 });
  assert.equal(res.budget, DEFAULT_MEMORY_BUDGET);
  assert.equal(res.rss, 0);
});

test("memoryBudget: missing/invalid rss treated as 0", () => {
  assert.equal(memoryBudget({}).rss, 0);
  assert.equal(memoryBudget({ memory: { rss: NaN } }).rss, 0);
});

test("sampleMemory: uses injected sampler", async () => {
  const fake = () => ({ rss: 111, heapUsed: 22, heapTotal: 33, external: 4, arrayBuffers: 5 });
  const m = await sampleMemory({ memoryUsage: fake });
  assert.deepEqual(m, { rss: 111, heapUsed: 22, heapTotal: 33, external: 4, arrayBuffers: 5 });
});

test("sampleMemory: tolerates a sampler returning partial data", async () => {
  const m = await sampleMemory({ memoryUsage: () => ({ rss: 1 }) });
  assert.equal(m.rss, 1);
  assert.equal(m.heapUsed, 0);
});

// --- reliefCandidates ---------------------------------------------------------

function scoresOf(entries) {
  return entries.map((e) => ({
    name: e.name,
    bytes: e.bytes,
    held: Boolean(e.held),
    score: e.score ?? 0,
    reasons: [],
  }));
}

test("reliefCandidates: heaviest non-protected non-held first, limited", () => {
  const scores = scoresOf([
    { name: "big", bytes: 900 },
    { name: "bigger", bytes: 1000 },
    { name: "tiny", bytes: 10 },
    { name: "held", bytes: 5000, held: true },
    { name: "core", bytes: 8000 },
  ]);
  const out = reliefCandidates({
    scores,
    isProtected: (n) => n === "core",
    limit: 2,
  });
  assert.deepEqual(out.map((c) => c.name), ["bigger", "big"]);
  assert.ok(out[0].reason.includes("dshpkg enable"));
});

test("reliefCandidates: skips zero/unknown bytes and protects + held", () => {
  const scores = scoresOf([
    { name: "a", bytes: 0 },
    { name: "b", bytes: null },
    { name: "c", bytes: 500 },
  ]);
  const out = reliefCandidates({ scores, heldNames: ["c"] });
  assert.deepEqual(out, []);
});

test("reliefCandidates: default limit is 3 and ties break by name", () => {
  const scores = scoresOf([
    { name: "z", bytes: 100 },
    { name: "a", bytes: 100 },
    { name: "m", bytes: 100 },
    { name: "n", bytes: 100 },
  ]);
  const out = reliefCandidates({ scores });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.name), ["a", "m", "n"]);
});

// --- evictionPlan -------------------------------------------------------------

test("evictionPlan: green → no actions", () => {
  const plan = evictionPlan({ rss: 100, budget: 1000, scores: scoresOf([{ name: "big", bytes: 900 }]) });
  assert.equal(plan.level, "green");
  assert.deepEqual(plan.actions, []);
  assert.ok(plan.summary.includes("绿区"));
});

test("evictionPlan: yellow → no auto actions", () => {
  const plan = evictionPlan({ rss: 800, budget: 1000, scores: scoresOf([{ name: "big", bytes: 900 }]) });
  assert.equal(plan.level, "yellow");
  assert.deepEqual(plan.actions, []);
});

test("evictionPlan: red → disable heaviest candidates", () => {
  const plan = evictionPlan({
    rss: 1100,
    budget: 1000,
    scores: scoresOf([
      { name: "huge", bytes: 900 },
      { name: "core", bytes: 800 },
      { name: "small", bytes: 50 },
    ]),
    isProtected: (n) => n === "core",
  });
  assert.equal(plan.level, "red");
  assert.deepEqual(plan.actions.map((a) => a.name), ["huge", "small"]);
  assert.equal(plan.actions[0].kind, "disable");
});

test("evictionPlan: red but nothing removable → explanatory summary", () => {
  const plan = evictionPlan({
    rss: 1100,
    budget: 1000,
    scores: scoresOf([{ name: "core", bytes: 900 }]),
    isProtected: () => true,
  });
  assert.equal(plan.level, "red");
  assert.deepEqual(plan.actions, []);
  assert.ok(plan.summary.includes("无非保护可禁用"));
});

// --- composeBundleOrder ---------------------------------------------------------

test("composeBundleOrder: empty input", () => {
  assert.deepEqual(composeBundleOrder({}), { ordered: [], missing: [], cycles: [] });
});

test("composeBundleOrder: guard layer stays first in declaration order", () => {
  const out = composeBundleOrder({
    bundles: ["alpha", "dshpkg", "loader", "beta"],
    deps: {},
  });
  assert.deepEqual(out.ordered, ["dshpkg", "loader", "alpha", "beta"]);
  assert.deepEqual(out.cycles, []);
});

test("composeBundleOrder: dependency topological sort (dep first)", () => {
  const out = composeBundleOrder({
    bundles: ["app", "lib", "core-lib"],
    deps: {
      app: "lib",
      lib: "core-lib",
    },
    guardNames: [],
  });
  // core-lib has no deps -> first; lib depends on core-lib; app depends on lib
  assert.deepEqual(out.ordered, ["core-lib", "lib", "app"]);
});

test("composeBundleOrder: accepts string or array deps", () => {
  const a = composeBundleOrder({
    bundles: ["x", "y"],
    deps: { x: "y" },
    guardNames: [],
  });
  const b = composeBundleOrder({
    bundles: ["x", "y"],
    deps: { x: ["y"] },
    guardNames: [],
  });
  assert.deepEqual(a.ordered, b.ordered);
});

test("composeBundleOrder: cycle appended, never dropped", () => {
  const out = composeBundleOrder({
    bundles: ["a", "b", "c"],
    deps: { a: "b", b: "a", c: "a" },
    guardNames: [],
  });
  assert.equal(out.ordered.length, 3);
  assert.deepEqual(new Set(out.ordered), new Set(["a", "b", "c"]));
  assert.ok(out.cycles.includes("a") || out.cycles.length >= 1);
});

test("composeBundleOrder: missing deps reported, self-loop ignored", () => {
  const out = composeBundleOrder({
    bundles: ["a", "b"],
    deps: { a: "missing-pkg", b: "b" },
    guardNames: [],
  });
  assert.deepEqual(out.missing, ["missing-pkg"]);
  assert.deepEqual(out.cycles, []);
  assert.deepEqual(out.ordered, ["a", "b"]); // self-loop on b ignored
});

test("composeBundleOrder: keeps every input bundle (reorder only)", () => {
  const bundles = ["z", "y", "x", "w"];
  const out = composeBundleOrder({ bundles, deps: { z: "x" }, guardNames: [] });
  assert.deepEqual(new Set(out.ordered), new Set(bundles));
});

test("DEFAULT_GUARD_BUNDLES includes the core protect names", () => {
  for (const name of ["dshpkg", "loader", "include", "cordis-host-runner"]) {
    assert.ok(DEFAULT_GUARD_BUNDLES.includes(name), name);
  }
});
