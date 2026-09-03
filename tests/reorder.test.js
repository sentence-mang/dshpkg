// Tests for lib/transaction.js reorderBundles (bundle load-order
// orchestration after install). Uses a fake profile dir + injected runner;
// never touches a real profile or spawns dsh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reorderBundles } from "../lib/transaction.js";

/** Build a fake profile with the given bundles + optional per-bundle deps. */
async function fakeProfile(t, { bundles = [], deps = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-reorder-home-"));
  process.env.DSH_HOME = home;
  if (t && typeof t.after === "function") {
    t.after(() => {
      delete process.env.DSH_HOME;
    });
  }
  const profileDir = join(home, "profiles", "web");
  await mkdir(join(profileDir, "node_modules"), { recursive: true });
  const manifest = {
    name: "web-profile",
    version: "1.0.0",
    dsh: { profile: { bundles } },
  };
  await writeFile(join(profileDir, "package.json"), JSON.stringify(manifest, null, 2));
  for (const [name, depNames] of Object.entries(deps)) {
    await mkdir(join(profileDir, "node_modules", name), { recursive: true });
    const dependencies = {};
    for (const d of depNames) dependencies[d] = "1.0.0";
    await writeFile(
      join(profileDir, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0", dependencies }, null, 2),
    );
  }
  return { home, profileDir };
}

function okRunner() {
  return (args) => ({ status: 0, stdout: "", stderr: "" });
}
function failRunner() {
  return (args) => ({ status: 1, stdout: "", stderr: "boom" });
}

test("reorderBundles: no-op when fewer than 2 bundles", async () => {
  await fakeProfile(globalThis, { bundles: ["dshpkg"] });
  const res = await reorderBundles("web", { runner: okRunner() });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
});

test("reorderBundles: no-op when order already optimal", async () => {
  await fakeProfile(globalThis, {
    bundles: ["dshpkg", "loader", "a"],
    deps: { a: ["loader"] },
  });
  const res = await reorderBundles("web", { runner: okRunner() });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
});

test("reorderBundles: dependency reorder puts dep first and writes back", async () => {
  const { profileDir } = await fakeProfile(globalThis, {
    bundles: ["app", "lib"],
    deps: { app: ["lib"] },
  });
  const res = await reorderBundles("web", { runner: okRunner() });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, ["lib", "app"]);
});

test("reorderBundles: guard layer moved to front (dshpkg first)", async () => {
  const { profileDir } = await fakeProfile(globalThis, {
    bundles: ["zeta", "dshpkg", "alpha"],
    deps: {},
  });
  const res = await reorderBundles("web", { runner: okRunner() });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  assert.equal(manifest.dsh.profile.bundles[0], "dshpkg");
});

test("reorderBundles: smoke failure restores original order", async () => {
  const { profileDir } = await fakeProfile(globalThis, {
    bundles: ["app", "lib"],
    deps: { app: ["lib"] },
  });
  const res = await reorderBundles("web", { runner: failRunner() });
  assert.equal(res.ok, false);
  assert.equal(res.changed, false);
  assert.ok(res.error.includes("已恢复原顺序"));
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, ["app", "lib"], "original order restored");
});

test("reorderBundles: missing profile dir → safe no-op", async () => {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-reorder-empty-"));
  process.env.DSH_HOME = home;
  const res = await reorderBundles("nope", { runner: okRunner() });
  delete process.env.DSH_HOME;
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
});
