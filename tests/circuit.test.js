// dshpkg — tests for lib/circuit.js (crash circuit breaker).
// Pure in-memory state machine, so no filesystem and no profiles are
// touched; the `state` object mirrors the packages map of lib/state.js.

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, recordCrash, isOpen, closeCircuit } from "../lib/circuit.js";

const T0 = 1_000_000; // fixed base timestamp, keeps assertions deterministic

function freshState() {
  return { packages: {} };
}

test("DEFAULTS match the contract", () => {
  assert.deepEqual(DEFAULTS, { threshold: 3, windowMs: 600_000 });
});

test("recordCrash increments crashCount and appends crashTimes", () => {
  const state = freshState();
  assert.equal(recordCrash(state, "a", T0), state); // same reference back
  recordCrash(state, "a", T0 + 1000);
  assert.deepEqual(state.packages.a.crashTimes, [T0, T0 + 1000]);
  assert.equal(state.packages.a.crashCount, 2);
  assert.equal(state.packages.a.circuitOpenAt, undefined); // not open yet
  assert.equal(isOpen(state, "a", T0 + 2000), false);
});

test("recordCrash opens the circuit at the threshold", () => {
  const state = freshState();
  recordCrash(state, "a", T0);
  recordCrash(state, "a", T0 + 1);
  assert.equal(isOpen(state, "a", T0 + 2), false);
  recordCrash(state, "a", T0 + 2);
  assert.equal(state.packages.a.circuitOpenAt, T0 + 2);
  assert.equal(isOpen(state, "a", T0 + 3), true);
  // later crashes keep the original open timestamp
  recordCrash(state, "a", T0 + 3);
  assert.equal(state.packages.a.circuitOpenAt, T0 + 2);
});

test("crash history decays outside windowMs", () => {
  const state = freshState();
  recordCrash(state, "a", T0);
  recordCrash(state, "a", T0 + 1000);
  assert.equal(state.packages.a.crashCount, 2);
  // one more crash far beyond the window prunes both old records
  const late = T0 + DEFAULTS.windowMs + 5000;
  recordCrash(state, "a", late);
  assert.deepEqual(state.packages.a.crashTimes, [late]);
  assert.equal(state.packages.a.crashCount, 1);
  assert.equal(state.packages.a.circuitOpenAt, undefined);
});

test("isOpen is false for unknown entries and null-safe states", () => {
  assert.equal(isOpen(null, "a"), false);
  assert.equal(isOpen({}, "a"), false);
  assert.equal(isOpen({ packages: {} }, "a"), false);
  assert.equal(isOpen({ packages: { a: {} } }, "a"), false);
  assert.equal(isOpen(freshState(), "a"), false);
});

test("isOpen falls back to a full window of crashTimes (legacy state)", () => {
  const state = {
    packages: { a: { crashCount: 3, crashTimes: [T0, T0 + 1, T0 + 2] } },
  };
  assert.equal(isOpen(state, "a", T0 + 3), true);
  // ...but only inside the window
  assert.equal(isOpen(state, "a", T0 + DEFAULTS.windowMs + 100), false);
});

test("closeCircuit resets the entry, returns the state, and allows re-open", () => {
  const state = freshState();
  recordCrash(state, "a", T0);
  recordCrash(state, "a", T0 + 1);
  recordCrash(state, "a", T0 + 2);
  assert.equal(isOpen(state, "a"), true);
  assert.equal(closeCircuit(state, "a"), state);
  assert.equal(isOpen(state, "a"), false);
  assert.deepEqual(state.packages.a, {
    crashCount: 0,
    crashTimes: [],
    circuitOpenAt: null,
  });
  // a fresh crash cycle can re-open the circuit
  recordCrash(state, "a", T0 + 100);
  recordCrash(state, "a", T0 + 101);
  recordCrash(state, "a", T0 + 102);
  assert.equal(isOpen(state, "a", T0 + 103), true);
});

test("closeCircuit on unknown entries is a no-op", () => {
  const state = freshState();
  assert.equal(closeCircuit(state, "nope"), state);
  assert.deepEqual(state, { packages: {} });
});

test("defensive: missing state / entryId / packages", () => {
  assert.equal(recordCrash(null, "a", T0), null);
  assert.equal(recordCrash(undefined, "a", T0), null);
  assert.equal(closeCircuit(null, "a"), null);
  const noEntry = {};
  assert.equal(recordCrash(noEntry, "", T0), noEntry);
  assert.deepEqual(noEntry, {}); // invalid entryId: untouched
  // packages created on demand
  recordCrash(noEntry, "a", T0);
  assert.deepEqual(noEntry.packages.a.crashTimes, [T0]);
});

test("defensive: Date instance and invalid timestamps", () => {
  const state = freshState();
  recordCrash(state, "a", new Date(T0));
  assert.deepEqual(state.packages.a.crashTimes, [T0]);
  const before = Date.now();
  recordCrash(state, "a", "not-a-number");
  const t = state.packages.a.crashTimes.at(-1);
  assert.ok(Number.isFinite(t) && t >= before);
});

test("recordCrash does not leak state across calls (no module-level state)", () => {
  const s1 = freshState();
  const s2 = freshState();
  recordCrash(s1, "a", T0);
  recordCrash(s2, "b", T0 + 5);
  assert.equal(s2.packages.a, undefined);
  assert.equal(s1.packages.b, undefined);
});

test("recordCrash rejects dangerous keys without polluting Object.prototype", () => {
  for (const key of ["__proto__", "constructor", "prototype", "Constructor", "PROTOtype"]) {
    const state = freshState();
    recordCrash(state, key, T0);
    // The canonical pollution check: the shared prototype stays clean.
    assert.equal(({}).crashTimes, undefined, key);
    assert.equal(({}).crashCount, undefined, key);
    assert.equal(({}).circuitOpenAt, undefined, key);
    // The state object did not gain an own property for the dangerous key.
    assert.equal(Object.prototype.hasOwnProperty.call(state.packages, key), false, key);
    // state.packages is still a plain empty object (prototype not swapped).
    assert.deepEqual(state.packages, {});
  }
});

test("isOpen and closeCircuit never read or write through a dangerous key", () => {
  const state = freshState();
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.equal(isOpen(state, key, T0), false, key);
    assert.equal(closeCircuit(state, key), state, key);
  }
  // Neither read nor write touched Object.prototype.
  assert.equal(({}).crashTimes, undefined);
  assert.equal(({}).crashCount, undefined);
  assert.equal(({}).circuitOpenAt, undefined);
  assert.deepEqual(state.packages, {});
  // Non-dangerous entries still work normally after the guard.
  recordCrash(state, "a", T0);
  recordCrash(state, "a", T0 + 1);
  recordCrash(state, "a", T0 + 2);
  assert.equal(isOpen(state, "a", T0 + 3), true);
});
