// Tests for lib/selfheal.js — closed-loop recovery executor: per-action
// verification, rollback on failure, incident recording, manual routing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { heal, executablePlan } from "../lib/selfheal.js";

const okRunner = () => ({ status: 0, stdout: "", stderr: "" });
const badRunner = () => ({ status: 1, stdout: "", stderr: "boom" });

function track() {
  const calls = { apply: [], remove: [], upgrade: [], incidents: [] };
  return {
    calls,
    deps: {
      dshRun: okRunner,
      applyDisable: async (n) => calls.apply.push(n),
      removeBlock: async (n) => calls.remove.push(n),
      upgradePkg: async (n) => calls.upgrade.push(n),
      incident: async (e) => calls.incidents.push(e),
    },
  };
}

test("heal: disable verifies ok and does not rollback", async () => {
  const { calls, deps } = track();
  const out = await heal({
    profile: "web",
    plan: [{ kind: "disable", name: "dsh-foo" }],
    ...deps,
  });
  assert.deepEqual(calls.apply, ["dsh-foo"]);
  assert.deepEqual(calls.remove, []);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].ok, true);
  assert.equal(out.actions[0].rolledBack, false);
  assert.equal(out.verified, true);
  assert.equal(calls.incidents[0].type, "heal-ok");
});

test("heal: disable that breaks the tree rolls back and records heal-failed", async () => {
  const { calls, deps } = track();
  deps.dshRun = badRunner;
  const out = await heal({
    profile: "web",
    plan: [{ kind: "disable", name: "dsh-gateway" }],
    ...deps,
  });
  assert.deepEqual(calls.apply, ["dsh-gateway"]);
  assert.deepEqual(calls.remove, ["dsh-gateway"], "failed disable must be rolled back");
  assert.equal(out.actions[0].ok, false);
  assert.equal(out.actions[0].rolledBack, true);
  assert.equal(out.verified, false);
  assert.equal(calls.incidents[0].type, "heal-failed");
});

test("heal: manual and check-service actions are never executed", async () => {
  const { calls, deps } = track();
  const out = await heal({
    profile: "web",
    plan: [
      { kind: "manual", name: "session-thing" },
      { kind: "check-service", name: "workspaceRegistry" },
      { kind: "disable", name: "dsh-fixture" },
    ],
    ...deps,
  });
  assert.deepEqual(calls.apply, ["dsh-fixture"]);
  assert.deepEqual(calls.upgrade, []);
  assert.deepEqual(out.needsManual.map((m) => m.kind), ["manual", "check-service"]);
  assert.equal(out.verified, true);
});

test("heal: upgrade routes through upgradePkg and verifies", async () => {
  const { calls, deps } = track();
  const out = await heal({
    profile: "web",
    plan: [{ kind: "upgrade", name: "dsh-remote-web-gateway" }],
    ...deps,
  });
  assert.deepEqual(calls.upgrade, ["dsh-remote-web-gateway"]);
  assert.equal(out.actions[0].ok, true);
  assert.equal(out.verified, true);
});

test("heal: missing applyDisable injection surfaces an error, no crash", async () => {
  const { calls } = track();
  const out = await heal({
    profile: "web",
    plan: [{ kind: "disable", name: "x" }],
    dshRun: okRunner(),
    removeBlock: async () => calls.remove.push("x"),
    incident: async () => {},
  });
  assert.equal(out.actions[0].ok, false);
  assert.ok(out.actions[0].error?.includes("applyDisable"));
});

test("heal: empty plan → verified false, no actions", async () => {
  const { deps } = track();
  const out = await heal({ profile: "web", plan: [], ...deps });
  assert.deepEqual(out.actions, []);
  assert.equal(out.verified, false);
});

test("executablePlan: keeps only runnable kinds, dedupes, caps", () => {
  const plan = executablePlan([
    { kind: "manual", name: "m" },
    { kind: "check-service", name: "c" },
    { kind: "disable", name: "a" },
    { kind: "disable", name: "a" },
    { kind: "upgrade", name: "b" },
    { kind: "nonsense", name: "z" },
    { kind: "install-dep", name: "d" },
  ], { max: 10 });
  assert.deepEqual(plan.map((p) => `${p.kind}:${p.name}`), ["disable:a", "upgrade:b", "install-dep:d"]);
});

test("executablePlan: empty/max=0", () => {
  assert.deepEqual(executablePlan([]), []);
  assert.deepEqual(executablePlan([{ kind: "disable", name: "a" }], { max: 0 }), []);
});