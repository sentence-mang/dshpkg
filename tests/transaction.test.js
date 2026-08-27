// Tests for lib/transaction.js (module H).
// Every test injects a fake runner: the real dsh/pnpm binaries are never
// executed. Profile access goes through DSH_HOME pointing at a temp dir with
// a synthetic profiles/web; the real ~/.dsh/profiles/web is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDeps,
  expandDeps,
  install,
  remove,
  autoremove,
  defaultRunner,
} from "../lib/transaction.js";
import { resolveDshLauncher, LAUNCHER_SEGMENTS } from "../lib/launcher.js";

/** Fake runner: records args, returns {status} from the given script. */
function fakeRunner(script = () => 0) {
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    return { status: script(args) };
  };
  return { calls, runner };
}

/** Point the given env vars at values for one test, then restore them. */
function useEnv(t, vars) {
  const prev = new Map();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key)
        ? process.env[key]
        : undefined,
    );
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * Fresh temp DSH_HOME with a synthetic profiles/web manifest. Installed
 * packages can be added under node_modules afterwards (see setupProfile).
 */
async function makeProfileHome(t, dependencies = {}) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-txn-home-"));
  process.env.DSH_HOME = home;
  t.after(() => {
    delete process.env.DSH_HOME;
  });
  const dir = join(home, "profiles", "web");
  await mkdir(dir, { recursive: true });
  const manifest = {
    name: "web-profile",
    version: "1.0.0",
    dsh: { profile: true },
    dependencies,
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  return { home, dir };
}

/** Synthetic profile with the given installed manifests under node_modules. */
async function setupProfile(t, dependencies, nodeModules) {
  const { dir } = await makeProfileHome(t, dependencies);
  for (const [name, manifest] of Object.entries(nodeModules)) {
    const pkgDir = join(dir, "node_modules", name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify(manifest));
  }
  return dir;
}

// ---------------------------------------------------------------- resolveDeps

test("resolveDeps returns the topological closure with deps first", () => {
  const recipe = {
    name: "app",
    source: "dsh-plugin-app",
    deps: ["base", { name: "mid", source: "npm:dsh-mid", deps: ["base"] }],
  };
  assert.deepEqual(resolveDeps(recipe, {}), ["base", "mid"]);
  // installed recipes are skipped
  assert.deepEqual(resolveDeps(recipe, { base: true }), ["mid"]);
  assert.deepEqual(resolveDeps(recipe, { base: true, mid: true }), []);
  // Set form works too
  assert.deepEqual(resolveDeps(recipe, new Set(["base"])), ["mid"]);
});

test("resolveDeps returns [] for a recipe without deps", () => {
  assert.deepEqual(resolveDeps({ name: "solo", source: "dsh-plugin-solo" }, {}), []);
});

test("resolveDeps throws with the cycle path in the message", () => {
  const b = { name: "b", deps: ["a"] };
  const a = { name: "a", deps: [b] };
  assert.throws(() => resolveDeps(a, {}), (err) => {
    assert.match(err.message, /循环依赖/);
    assert.match(err.message, /a → b → a/);
    return true;
  });
  // self-cycle through a string dep
  assert.throws(() => resolveDeps({ name: "x", deps: ["x"] }, {}), (err) => {
    assert.match(err.message, /x → x/);
    return true;
  });
});

// ---------------------------------------------------------------- expandDeps

test("expandDeps resolves string deps through the recipe table recursively", () => {
  const libdep2 = { name: "libdep2", source: { type: "npm", spec: "libdep2@1.0.0" } };
  const libdep = {
    name: "libdep",
    source: { type: "npm", spec: "libdep@1.0.0" },
    deps: ["libdep2"],
  };
  const app = {
    name: "app",
    source: { type: "npm", spec: "app@1.0.0" },
    deps: ["libdep", "unknown-dep"],
  };
  const table = new Map([
    ["libdep", libdep],
    ["libdep2", libdep2],
  ]);
  const expanded = expandDeps(app, table);
  // libdep expanded into its recipe with libdep2 nested; unknown stays a string
  assert.deepEqual(expanded.deps[0], {
    ...libdep,
    deps: [{ ...libdep2, deps: [] }],
  });
  assert.equal(expanded.deps[1], "unknown-dep");
  // a recipe without deps gains an empty deps array (validated shape), nothing else
  const solo = expandDeps(libdep2, table);
  assert.equal(solo.name, "libdep2");
  assert.deepEqual(solo.deps, []);
});

test("expandDeps stays finite on cyclic recipes (resolveEntries reports later)", () => {
  const a = { name: "a", deps: ["b"] };
  const b = { name: "b", deps: ["a"] };
  const table = new Map([
    ["a", a],
    ["b", b],
  ]);
  const expanded = expandDeps(a, table);
  // expansion terminates; the cycle is preserved for resolveEntries to flag
  assert.equal(expanded.deps[0].name, "b");
  assert.equal(expanded.deps[0].deps[0], a); // back-reference, not infinite
  // and the full expanded graph is still rejected by resolveDeps
  assert.throws(() => resolveDeps(expanded, {}), /循环依赖/);
});

test("resolveDeps throws on a recipe without a name", () => {
  assert.throws(() => resolveDeps({ deps: ["a"] }, {}), /缺少 name/);
});

// -------------------------------------------------------------------- install

test("install runs precheck -> add -> smoke and reports the installed name", async () => {
  const { calls, runner } = fakeRunner();
  const res = await install("dsh-plugin-x", { runner });
  assert.deepEqual(res, { ok: true, installed: ["dsh-plugin-x"] });
  assert.deepEqual(calls, [
    ["--profile", "web", "--dump-config"],
    ["plugin", "--profile", "web", "add", "dsh-plugin-x"],
    ["--profile", "web", "--dump-config"],
  ]);
});

test("install installs recipe deps first, then prechecks, then installs self", async () => {
  const { calls, runner } = fakeRunner();
  const recipe = {
    name: "app",
    source: "dsh-plugin-app",
    deps: ["dep-a", { name: "dep-b", source: "npm:dsh-dep-b" }],
  };
  const res = await install(recipe, { runner });
  assert.deepEqual(res, { ok: true, installed: ["dep-a", "dep-b", "app"] });
  assert.deepEqual(calls, [
    ["plugin", "--profile", "web", "add", "dep-a"],
    ["plugin", "--profile", "web", "add", "npm:dsh-dep-b"],
    ["--profile", "web", "--dump-config"],
    ["plugin", "--profile", "web", "add", "dsh-plugin-app"],
    ["--profile", "web", "--dump-config"],
  ]);
});

test("install honors the profile option", async () => {
  const { calls, runner } = fakeRunner();
  await install("dsh-plugin-x", { profile: "dev", runner });
  assert.deepEqual(calls, [
    ["--profile", "dev", "--dump-config"],
    ["plugin", "--profile", "dev", "add", "dsh-plugin-x"],
    ["--profile", "dev", "--dump-config"],
  ]);
});

test("install forces the link: prefix on local path specs", async () => {
  const { calls, runner } = fakeRunner();
  await install("C:\\abs\\plugin", { runner });
  await install("/abs/plugin", { runner });
  await install("./rel/plugin", { runner });
  await install("link:C:\\already", { runner });
  await install("file:C:\\as-file", { runner });
  await install("dsh-plugin-x@1.2.3", { runner });

  // every add command carries the spec as its last arg
  const addSpecs = calls.filter((c) => c[0] === "plugin" && c[3] === "add").map((c) => c[4]);
  assert.deepEqual(addSpecs, [
    "link:C:\\abs\\plugin",
    "link:/abs/plugin",
    "link:./rel/plugin",
    "link:C:\\already", // existing prefix untouched
    "link:C:\\as-file", // file: normalized to link:
    "dsh-plugin-x@1.2.3", // registry spec untouched
  ]);
});

test("install fails on precheck failure before any add runs", async () => {
  const { calls, runner } = fakeRunner((args) => (args.includes("--dump-config") ? 1 : 0));
  const res = await install("dsh-plugin-x", { runner });
  assert.equal(res.ok, false);
  assert.match(res.error, /预检失败/);
  assert.equal(res.rolledBack, true); // nothing installed, state is clean
  assert.ok(calls.every((args) => !args.includes("add")));
});

test("install rolls back installed deps when a dep install fails", async () => {
  const { calls, runner } = fakeRunner((args) => {
    if (args[0] === "plugin" && args[4] === "npm:dsh-dep-b") return 1;
    return 0;
  });
  const recipe = { name: "app", deps: ["dep-a", { name: "dep-b", source: "npm:dsh-dep-b" }] };
  const res = await install(recipe, { runner });
  assert.equal(res.ok, false);
  assert.match(res.error, /dep-b/);
  assert.equal(res.rolledBack, true);
  assert.deepEqual(calls, [
    ["plugin", "--profile", "web", "add", "dep-a"],
    ["plugin", "--profile", "web", "add", "npm:dsh-dep-b"],
    ["plugin", "--profile", "web", "remove", "dep-a"],
  ]);
});

test("install rolls back self and deps when the smoke step fails", async () => {
  let dumpCount = 0;
  const { calls, runner } = fakeRunner((args) => {
    if (args.includes("--dump-config")) {
      dumpCount += 1;
      return dumpCount === 2 ? 1 : 0;
    }
    return 0;
  });
  const res = await install({ name: "app", source: "dsh-plugin-app", deps: ["dep-a"] }, { runner });
  assert.equal(res.ok, false);
  assert.match(res.error, /冒烟测试失败/);
  assert.equal(res.rolledBack, true);
  assert.deepEqual(calls, [
    ["plugin", "--profile", "web", "add", "dep-a"],
    ["--profile", "web", "--dump-config"],
    ["plugin", "--profile", "web", "add", "dsh-plugin-app"],
    ["--profile", "web", "--dump-config"],
    ["plugin", "--profile", "web", "remove", "app"],
    ["plugin", "--profile", "web", "remove", "dep-a"],
  ]);
});

test("install reports rolledBack false when the rollback itself fails", async () => {
  const { runner } = fakeRunner((args) => {
    if (args[0] === "plugin" && args[4] === "dsh-plugin-app") return 1; // self install fails
    if (args[0] === "plugin" && args[3] === "remove") return 1; // rollback fails
    return 0;
  });
  const res = await install({ name: "app", source: "dsh-plugin-app", deps: ["dep-a"] }, { runner });
  assert.equal(res.ok, false);
  assert.match(res.error, /安装失败/);
  assert.equal(res.rolledBack, false);
});

test("install dryRun never invokes the runner and reports the plan", async () => {
  const { calls, runner } = fakeRunner();
  const res = await install({ name: "app", source: "dsh-plugin-app", deps: ["dep-a"] }, { dryRun: true, runner });
  assert.deepEqual(res, { ok: true, installed: ["dep-a", "app"] });
  assert.equal(calls.length, 0);
});

test("install rejects an invalid recipe without invoking the runner", async () => {
  const { calls, runner } = fakeRunner();
  const res = await install({ deps: ["a"] }, { runner });
  assert.equal(res.ok, false);
  assert.match(res.error, /缺少 name/);
  assert.equal(res.rolledBack, false);
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------------------- remove

test("remove succeeds and reports the removed name", async () => {
  const { calls, runner } = fakeRunner();
  const res = await remove("dsh-plugin-x", { runner });
  assert.deepEqual(res, { ok: true, removed: "dsh-plugin-x" });
  assert.deepEqual(calls, [["plugin", "--profile", "web", "remove", "dsh-plugin-x"]]);
});

test("remove fails when dsh exits non-zero", async () => {
  const { runner } = fakeRunner(() => 1);
  const res = await remove("dsh-plugin-x", { runner });
  assert.equal(res.ok, false);
  assert.equal(res.removed, null);
  assert.match(res.error, /移除失败/);
});

test("remove dryRun does not invoke the runner", async () => {
  const { calls, runner } = fakeRunner();
  const res = await remove("dsh-plugin-x", { dryRun: true, runner });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 0);
});

// ----------------------------------------------------------------- autoremove

test("autoremove removes orphans that are neither bundles nor referenced", async (t) => {
  await setupProfile(
    t,
    { a: "1.0.0", b: "1.0.0", c: "1.0.0", d: "1.0.0", e: "1.0.0" },
    {
      a: { name: "a", version: "1.0.0" }, // orphan
      b: { name: "b", version: "1.0.0", dsh: { bundle: { patch: "./patch.yml" } } }, // bundle: keep
      c: { name: "c", version: "1.0.0" }, // referenced by d: keep
      d: { name: "d", version: "1.0.0", dependencies: { c: "1.0.0" } }, // orphan
      // e: no manifest under node_modules -> skipped, cannot judge
    }
  );
  const { calls, runner } = fakeRunner();
  const res = await autoremove({ runner });
  assert.deepEqual(res, { ok: true, removed: ["a", "d"] });
  assert.deepEqual(calls, [
    ["plugin", "--profile", "web", "remove", "a"],
    ["plugin", "--profile", "web", "remove", "d"],
  ]);
});

test("autoremove dryRun reports orphans without invoking the runner", async (t) => {
  await setupProfile(
    t,
    { a: "1.0.0", b: "1.0.0" },
    { a: { name: "a", version: "1.0.0" }, b: { name: "b", version: "1.0.0" } }
  );
  const { calls, runner } = fakeRunner();
  const res = await autoremove({ dryRun: true, runner });
  assert.deepEqual(res, { ok: true, removed: ["a", "b"] });
  assert.equal(calls.length, 0);
});

test("autoremove reports ok false and partial removals when a remove fails", async (t) => {
  await setupProfile(
    t,
    { a: "1.0.0", b: "1.0.0" },
    { a: { name: "a", version: "1.0.0" }, b: { name: "b", version: "1.0.0" } }
  );
  const { runner } = fakeRunner((args) => (args[4] === "b" ? 1 : 0));
  const res = await autoremove({ runner });
  assert.equal(res.ok, false);
  assert.deepEqual(res.removed, ["a"]);
  assert.match(res.error, /孤儿包/);
});

test("autoremove fails when the profile is missing", async (t) => {
  // DSH_HOME points at an empty temp dir: no profiles/web exists there
  const home = await mkdtemp(join(tmpdir(), "dshpkg-txn-empty-"));
  process.env.DSH_HOME = home;
  t.after(() => {
    delete process.env.DSH_HOME;
  });
  const { calls, runner } = fakeRunner();
  const res = await autoremove({ runner });
  assert.equal(res.ok, false);
  assert.match(res.error, /profile/);
  assert.equal(calls.length, 0);
});

// --------------------------------------------- default runner shape (dsh launcher)

// The npm-installed "dsh" on Windows is a .cmd/.ps1 shim without an .exe;
// CreateProcess (shell:false) cannot run it (ENOENT/EINVAL). The default
// runner must therefore invoke `node <launcherBin>` — verified here via an
// injected spawnImpl (a real dsh/node process is never executed).

const LAUNCHER_TAIL = join(...LAUNCHER_SEGMENTS);

test("defaultRunner: DSH_LAUNCHER runs the node + launcherBin form", (t) => {
  const script = "C:/fake/dsh-lib-bin.js";
  useEnv(t, { DSH_BIN: undefined, DSH_LAUNCHER: script });
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0 };
  };
  const res = defaultRunner(["plugin", "--profile", "web", "remove", "x"], {
    spawnImpl,
  });
  assert.equal(res.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [
    script,
    "plugin",
    "--profile",
    "web",
    "remove",
    "x",
  ]);
  // shell is never enabled; the environment is inherited
  assert.deepEqual(calls[0].options, { env: process.env, stdio: "inherit" });
});

test("defaultRunner: a .exe DSH_BIN is spawned directly", (t) => {
  useEnv(t, { DSH_BIN: "dsh.exe", DSH_LAUNCHER: undefined });
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0 };
  };
  const res = defaultRunner(["--profile", "web", "--dump-config"], {
    spawnImpl,
  });
  assert.equal(res.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "dsh.exe");
  assert.deepEqual(calls[0].args, ["--profile", "web", "--dump-config"]);
  assert.deepEqual(calls[0].options, { env: process.env, stdio: "inherit" });
});

test("defaultRunner: a .cmd DSH_BIN shim is skipped in favor of DSH_LAUNCHER", (t) => {
  const script = "C:/fake/dsh-lib-bin.js";
  useEnv(t, { DSH_BIN: "dsh.cmd", DSH_LAUNCHER: script });
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0 };
  };
  const res = defaultRunner(["--profile", "web"], { spawnImpl });
  assert.equal(res.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [script, "--profile", "web"]);
});

test("defaultRunner: an unresolvable launcher errors without spawning", (t) => {
  useEnv(t, { DSH_BIN: undefined, DSH_LAUNCHER: undefined });
  let spawned = 0;
  const spawnImpl = () => {
    spawned += 1;
    return { status: 0 };
  };
  const res = defaultRunner(["--profile", "web"], {
    spawnImpl,
    resolveImpl: () => null,
  });
  assert.equal(res.status, null);
  assert.ok(res.error instanceof Error);
  assert.match(res.error.message, /未找到 dsh 全局入口/);
  assert.equal(spawned, 0);
});

// ------------------------------------ resolveDshLauncher resolution priority

test("resolveDshLauncher: DSH_BIN .exe wins over DSH_LAUNCHER", (t) => {
  useEnv(t, { DSH_BIN: "dsh.exe", DSH_LAUNCHER: "C:/fake/bin.js" });
  assert.deepEqual(resolveDshLauncher(), { kind: "direct", command: "dsh.exe" });
});

test("resolveDshLauncher: a path DSH_BIN .exe must exist, else it falls through", (t) => {
  useEnv(t, { DSH_BIN: "C:/missing/dsh.exe", DSH_LAUNCHER: "C:/fake/bin.js" });
  assert.deepEqual(resolveDshLauncher(), { kind: "node", script: "C:/fake/bin.js" });
});

test("resolveDshLauncher: a .cmd shim DSH_BIN is not directly spawnable", (t) => {
  useEnv(t, { DSH_BIN: "dsh.cmd", DSH_LAUNCHER: "C:/fake/bin.js" });
  assert.deepEqual(resolveDshLauncher(), { kind: "node", script: "C:/fake/bin.js" });
});

test("resolveDshLauncher: a .ps1 shim DSH_BIN is not directly spawnable", (t) => {
  useEnv(t, { DSH_BIN: "dsh.ps1", DSH_LAUNCHER: "C:/fake/bin.js" });
  assert.deepEqual(resolveDshLauncher(), { kind: "node", script: "C:/fake/bin.js" });
});

test("resolveDshLauncher: npm prefix -g auto-detects the launcher script", (t) => {
  useEnv(t, { DSH_BIN: undefined, DSH_LAUNCHER: undefined });
  const prefix = "C:/fake/npm-global";
  const expected = join(prefix, ...LAUNCHER_SEGMENTS);
  const spawnImpl = () => ({ status: 0, stdout: `${prefix}\n` });
  const existsImpl = (p) => p === expected;
  assert.deepEqual(resolveDshLauncher({ spawnImpl, existsImpl }), {
    kind: "node",
    script: expected,
  });
});

test("resolveDshLauncher: static prefixes are probed when npm fails", (t) => {
  useEnv(t, { DSH_BIN: undefined, DSH_LAUNCHER: undefined });
  const probed = [];
  const spawnImpl = () => ({ status: 1, stdout: "" });
  const existsImpl = (p) => {
    probed.push(p);
    return true;
  };
  const resolved = resolveDshLauncher({ spawnImpl, existsImpl });
  assert.equal(resolved.kind, "node");
  assert.equal(resolved.script, probed[0]);
  assert.ok(resolved.script.endsWith(LAUNCHER_TAIL));
});

test("resolveDshLauncher: returns null when nothing resolves", (t) => {
  useEnv(t, { DSH_BIN: undefined, DSH_LAUNCHER: undefined });
  const spawnImpl = () => ({ status: 1, stdout: "" });
  const existsImpl = () => false;
  assert.equal(resolveDshLauncher({ spawnImpl, existsImpl }), null);
});

test("resolveDshLauncher: allowDirect false ignores a DSH_BIN .exe (supervisor)", (t) => {
  useEnv(t, { DSH_BIN: "dsh.exe", DSH_LAUNCHER: "C:/fake/bin.js" });
  assert.deepEqual(resolveDshLauncher({ allowDirect: false }), {
    kind: "node",
    script: "C:/fake/bin.js",
  });
});
