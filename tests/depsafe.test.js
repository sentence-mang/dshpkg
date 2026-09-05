// Tests for lib/depsafe.js — dependency-aware disable protection.
// The 2026-09-03 incident reproduction: auto-disabling the gateway crash
// culprit would break baseline dependents (workspaceRegistry chain); the
// guard must refuse that disable and let an upgrade/manual path take over.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reverseDeps, activeBaseline, guardDisable } from "../lib/depsafe.js";

// --- reverseDeps -------------------------------------------------------------

test("reverseDeps: builds dep -> dependents from package.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-revdeps-"));
  await mkdir(join(dir, "node_modules", "app-a"), { recursive: true });
  await mkdir(join(dir, "node_modules", "app-b"), { recursive: true });
  await mkdir(join(dir, "node_modules", "gateway"), { recursive: true });
  await writeFile(join(dir, "node_modules", "app-a", "package.json"), JSON.stringify({
    name: "app-a", dependencies: { "@deepseek-ai/dsh-client-connection": "1.0.0" },
  }));
  await writeFile(join(dir, "node_modules", "app-b", "package.json"), JSON.stringify({
    name: "app-b", peerDependencies: { "@deepseek-ai/dsh-client-connection": "1.0.0" },
  }));
  await writeFile(join(dir, "node_modules", "gateway", "package.json"), JSON.stringify({ name: "gateway" }));

  const rev = await reverseDeps(dir);
  assert.deepEqual(rev["@deepseek-ai/dsh-client-connection"], ["app-a", "app-b"]);
  assert.equal(rev["gateway"], undefined);
});

test("reverseDeps: empty/missing profile → empty graph, never throws", async () => {
  assert.deepEqual(await reverseDeps(""), {});
  assert.deepEqual(await reverseDeps("C:/does/not/exist"), {});
});

// --- activeBaseline ----------------------------------------------------------

test("activeBaseline: keeps known entries that were never implicated", () => {
  const incidents = [
    { type: "uncaught-exception", detail: "failed to apply loader entry dsh-remote-web-gateway (dsh-remote-web-gateway): Cannot read properties of undefined (reading 'authority')" },
    { type: "uncaught-exception", detail: "dsh: 2 entries did not activate\n@deepseek-ai/dsh-host-apiproxy: pending (waiting for service: workspaceRegistry)" },
    { type: "boot-confirmed" },
  ];
  const base = activeBaseline({ incidents, knownEntries: ["dsh-base", "dsh-mnemon", "dsh-remote-web-gateway", "@deepseek-ai/dsh-host-apiproxy"] });
  assert.ok(base.has("dsh-base"), "healthy entry stays in baseline");
  assert.ok(base.has("dsh-mnemon"));
  assert.ok(!base.has("dsh-remote-web-gateway"), "crash culprit excluded from baseline");
  assert.ok(!base.has("@deepseek-ai/dsh-host-apiproxy"), "pending dependent excluded");
});

test("activeBaseline: without knownEntries returns the problem set", () => {
  const incidents = [
    { type: "uncaught-exception", detail: "loader entry bad-plugin (bad): boom" },
    { type: "boot-tree-crash" },
  ];
  const base = activeBaseline({ incidents });
  assert.ok(base.has("bad-plugin"));
});

// --- guardDisable (incident reproduction) ------------------------------------

test("guardDisable: refuses to auto-disable a culprit with baseline dependents", () => {
  // gateway is the culprit, AND app-a/app-b depend on it and are alive in
  // the baseline → auto-disable would cascade → must refuse.
  const reverse = {
    "gateway": ["app-a", "app-b"],
  };
  const baseline = new Set(["app-a", "app-b"]);
  const res = guardDisable("gateway", { reverse, baseline, isProtected: () => false });
  assert.equal(res.allowed, false, "must NOT allow cascading auto-disable");
  assert.ok(res.risk.some((r) => r.includes("依赖方")), "risk should name the dependents");
  assert.ok(res.risk[0].includes("连锁崩溃"), "risk should warn about cascade");
});

test("guardDisable: allowCulprit override lets an explicit operator force it", () => {
  const reverse = { "gateway": ["app-a"] };
  const baseline = new Set(["app-a"]);
  const res = guardDisable("gateway", { reverse, baseline, allowCulprit: true });
  assert.equal(res.allowed, true);
  assert.ok(res.risk.length > 0, "still warns about remaining dependents");
});

test("guardDisable: protected entries are always refused", () => {
  const res = guardDisable("loader", { isProtected: (n) => n === "loader" });
  assert.equal(res.allowed, false);
  assert.ok(res.risk[0].includes("核心保护条目"));
});

test("guardDisable: no dependents in baseline → allowed", () => {
  const res = guardDisable("dsh-foo", { reverse: { "dsh-foo": ["other"] }, baseline: new Set(["unrelated"]), isProtected: () => false });
  assert.equal(res.allowed, true);
});

test("guardDisable: empty/garbage candidate → refused", () => {
  assert.equal(guardDisable("").allowed, false);
  assert.equal(guardDisable(undefined, {}).allowed, false);
});