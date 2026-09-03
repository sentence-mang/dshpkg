// Tests for the dshpkg optimize command (bin/dshpkg.js cmdOptimize) and its
// --apply / --budget parsing. Offline by construction: dshRun is injected
// (never spawns a real dsh) and DSH_HOME / DSH_PKG_HOME point at fresh temp
// dirs per test, so no real profile or state is ever touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, parseArgs } from "../bin/dshpkg.js";
import { readState, writeState } from "../lib/state.js";

// --- test plumbing (mirrors tests/cli.test.js conventions) ----------------

function captureIo(overrides = {}) {
  const logs = [];
  const errors = [];
  return {
    io: {
      log: (...a) => logs.push(a.join(" ")),
      error: (...a) => errors.push(a.join(" ")),
      ...overrides,
    },
    logs,
    errors,
  };
}

async function makeEnv(t, { packages = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-opt-home-"));
  const root = await mkdtemp(join(tmpdir(), "dshpkg-opt-state-"));
  process.env.DSH_HOME = home;
  process.env.DSH_PKG_HOME = root;
  if (t && typeof t.after === "function") {
    t.after(() => {
      delete process.env.DSH_HOME;
      delete process.env.DSH_PKG_HOME;
    });
  }
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "web-profile", version: "1.0.0", dsh: { profile: true } }),
  );
  if (Object.keys(packages).length > 0) {
    await writeState({ ...(await readState()), packages });
  }
  return { home, root, profileDir };
}

function fakeDshRun() {
  const calls = [];
  return {
    calls,
    dshRun: (args) => {
      calls.push([...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

// --- tests ------------------------------------------------------------------

test("parseArgs recognizes --apply and --budget for optimize", () => {
  const o = parseArgs(["optimize", "--apply", "--budget", "400"]);
  assert.equal(o.command, "optimize");
  assert.equal(o.apply, true);
  assert.equal(o.budget, 400);
  const o2 = parseArgs(["optimize", "--budget=350"]);
  assert.equal(o2.budget, 350);
});

test("parseArgs rejects a non-positive --budget", () => {
  assert.throws(() => parseArgs(["optimize", "--budget", "0"]));
  assert.throws(() => parseArgs(["optimize", "--budget", "-5"]));
});

test("optimize without --apply reports diagnostics incl memory and exits 0", async () => {
  await makeEnv(globalThis, {
    packages: {
      ok: { source: "npm", version: "1.0.0", crashCount: 0, crashTimes: [], held: false },
    },
  });
  const { io, logs } = captureIo();
  const { dshRun } = fakeDshRun();
  assert.equal(await runCli(["optimize"], { ...io, dshRun }), 0);
  const text = logs.join("\n");
  assert.ok(text.includes("[性能诊断]"), "should print 性能诊断");
  assert.ok(text.includes("组合耗时"), "should print 组合耗时");
  assert.ok(text.includes("缓存占用"), "should print 缓存占用");
  assert.ok(text.includes("内存"), "should print memory governance");
});

test("optimize --apply disables unstable and skips protected", async () => {
  const { profileDir } = await makeEnv(globalThis, {
    packages: {
      slow: { source: "npm", version: "1.0.0", crashCount: 5, crashTimes: [], held: false },
      loader: { source: "npm", version: "1.0.0", crashCount: 9, crashTimes: [], held: false },
    },
  });
  const { io, logs } = captureIo();
  const { dshRun } = fakeDshRun();
  assert.equal(await runCli(["optimize", "--apply"], { ...io, dshRun }), 0);
  const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  assert.ok(patch.includes("dshpkg:managed:start"), "managed disable block written");
  assert.ok(patch.includes("slow"), "unstable plugin disabled");
  assert.ok(!patch.includes("loader"), "protected core plugin must not be disabled");
  assert.ok(logs.join("\n").includes("已禁用"));
});

test("optimize with no packages reports healthy and exits 0", async () => {
  await makeEnv(globalThis, { packages: {} });
  const { io, logs } = captureIo();
  const { dshRun } = fakeDshRun();
  assert.equal(await runCli(["optimize"], { ...io, dshRun }), 0);
  assert.ok(logs.join("\n").includes("未发现高负载/不稳定插件"));
});
