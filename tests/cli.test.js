// Tests for bin/dshpkg.js (integration CLI).
// Every external call is injected (runner / dshRun / fetcher / spawnImpl /
// ask), so the suite stays offline and never touches a real profile:
// DSH_HOME and DSH_PKG_HOME both point at fresh temp dirs per test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

import { runCli, parseArgs, helpText, HOST_PORT, defaultDshRun } from "../bin/dshpkg.js";
import {
  readState,
  writeState,
  statePath,
  writeJsonAtomic,
  addTrustedKey,
} from "../lib/state.js";
import { canonicalJson } from "../lib/recipe.js";

// ------------------------------------------------------------- test plumbing

/** Capture ctx.log / ctx.error lines into arrays. */
function captureIo(overrides = {}) {
  const logs = [];
  const errors = [];
  const io = {
    log: (...a) => logs.push(a.join(" ")),
    error: (...a) => errors.push(a.join(" ")),
    ...overrides,
  };
  return { io, logs, errors };
}

/** Fresh DSH_HOME (profiles/web) + DSH_PKG_HOME (state root) per test. */
async function makeEnv(t, { deps = {}, packages = {}, patch = "" } = {}) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-cli-home-"));
  const root = await mkdtemp(join(tmpdir(), "dshpkg-cli-state-"));
  process.env.DSH_HOME = home;
  process.env.DSH_PKG_HOME = root;
  const cleanup = () => {
    delete process.env.DSH_HOME;
    delete process.env.DSH_PKG_HOME;
  };
  if (t && typeof t.after === "function") t.after(cleanup);
  // Otherwise (no test context): env stays set until the next makeEnv call
  // overwrites it — each test always sets both variables itself.
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({
      name: "web-profile",
      version: "1.0.0",
      dsh: { profile: true },
      dependencies: deps,
    }),
  );
  if (patch) {
    await writeFile(join(profileDir, "cordis.patch.yml"), patch);
  }
  if (Object.keys(packages).length > 0) {
    await writeState({ ...(await readState()), packages });
  }
  return { home, root, profileDir };
}

/** Fake dsh runner: records args, returns {status} from the script. */
function fakeRunner(script = () => 0) {
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    return { status: script(args) };
  };
  return { calls, runner };
}

/** Fetcher that never reaches a host: every probe throws (host down). */
const noHostFetcher = async () => {
  throw new Error("ECONNREFUSED");
};

/** Fetcher faking a running dshpkg host: /dshpkg/status + POST /managed/*. */
function fakeHostFetcher({ managed = [], postResults = {} } = {}) {
  const posts = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/dshpkg/status")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, managed }) };
    }
    if (init.method === "POST") {
      posts.push({ url: u, body: init.body ? JSON.parse(init.body) : {} });
      return {
        ok: true,
        status: 200,
        json: async () => postResults[u] ?? { ok: true },
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetcher, posts };
}

/** Index fetcher for refreshIndex: all four sources answer empty. */
function emptyIndexFetcher() {
  const urls = [];
  const fetcher = async (url) => {
    urls.push(String(url));
    if (String(url).includes("raw.githubusercontent")) {
      return { ok: true, status: 200, text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetcher, urls };
}

/** Write a recipe repo checkout (index.json + recipes/<name>.json). */
async function seedRecipeRepo(name, recipes, repos = [{ url: `https://example.com/${name}.git`, name, enabled: true }]) {
  const dir = statePath("recipes", name, "recipes");
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(
    statePath("recipes", name, "index.json"),
    { recipes: Object.keys(recipes) },
  );
  for (const [recipeName, recipe] of Object.entries(recipes)) {
    await writeJsonAtomic(join(dir, `${recipeName}.json`), recipe);
  }
  await writeJsonAtomic(statePath("repos.json"), { repos });
}

/** A valid recipe shape (module B schema; verify.level is a number). */
function recipeOf(name, sourceSpec, extra = {}) {
  return {
    name,
    kind: "bundle",
    source: { type: "npm", spec: sourceSpec },
    harnessRange: "*",
    pin: { allow: true },
    verify: { level: 2, label: "自动验证", risk: "low" },
    deps: [],
    ...extra,
  };
}

/** A circuit-open package record (3 crashes inside the window). */
function openPackage() {
  const now = Date.now();
  return {
    source: "npm",
    version: "1.0.0",
    crashCount: 3,
    crashTimes: [now - 3, now - 2, now - 1],
    circuitOpenAt: now - 1,
    held: false,
  };
}

/** Build a recipeOf with a valid minisign signature (P3-2). */
function signedRecipeOf(name, sourceSpec, extra = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = "aabbccddeeff0011";
  const recipe = recipeOf(name, sourceSpec, extra);
  const data = Buffer.from(canonicalJson(recipe), "utf8");
  const sig = sign(null, data, privateKey);
  const signature = Buffer.concat([
    Buffer.from([0x45, 0x64]),
    Buffer.from(keyId, "hex"),
    sig,
  ]).toString("base64");
  return {
    recipe: {
      ...recipe,
      signatures: { minisign: { keyId, algo: "ed25519", signature } },
    },
    rawPub,
    keyId,
  };
}

// ------------------------------------------------------------------- usage

test("no arguments prints the help text and exits 0", async () => {
  await makeEnv(globalThis);
  const { io, logs } = captureIo();
  const code = await runCli([], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("用法: dshpkg <命令>"));
  assert.ok(logs.join("\n").includes("search"));
});

test("-h and --help both print the full help", async () => {
  await makeEnv(globalThis);
  for (const flag of ["-h", "--help"]) {
    const { io, logs } = captureIo();
    const code = await runCli([flag], io);
    assert.equal(code, 0);
    assert.ok(logs.join("\n").includes("install <名称"));
    assert.ok(logs.join("\n").includes("fix-broken"));
  }
});

test("unknown command prints Chinese help and exits 2", async () => {
  await makeEnv(globalThis);
  const { io, errors } = captureIo();
  const code = await runCli(["frobnicate"], io);
  assert.equal(code, 2);
  assert.ok(errors.join("\n").includes("未知命令"));
  assert.ok(errors.join("\n").includes("用法: dshpkg"));
});

test("unknown option exits 2 with a Chinese message", async () => {
  await makeEnv(globalThis);
  const { io, errors } = captureIo();
  const code = await runCli(["search", "--bogus", "x"], io);
  assert.equal(code, 2);
  assert.ok(errors.join("\n").includes("未知选项: --bogus"));
});

test("parseArgs handles flags before and after the command", () => {
  const opts = parseArgs(["--online", "search", "foo", "--profile", "dev"]);
  assert.equal(opts.command, "search");
  assert.deepEqual(opts.positionals, ["foo"]);
  assert.equal(opts.online, true);
  assert.equal(opts.profile, "dev");

  const opts2 = parseArgs(["install", "x", "--dry-run", "--port=9999"]);
  assert.equal(opts2.command, "install");
  assert.equal(opts2.dryRun, true);
  assert.equal(opts2.port, 9999);
});

test("parseArgs rejects a non-numeric --port", () => {
  assert.throws(() => parseArgs(["status", "x", "--port", "abc"]), /--port 必须是正整数/);
});

// ------------------------------------------------------------------- search

test("search prints the offline three-layer table (installed marked)", async (t) => {
  await makeEnv(t, { packages: { "dsh-plugin-git": { version: "1.0.0" } } });
  await writeJsonAtomic(statePath("index", "items.json"), [
    {
      name: "dsh-plugin-git",
      packageName: "dsh-plugin-git",
      description: "git helpers for dsh",
      topics: ["dsh-plugin"],
      stars: 120,
      latestVersion: "1.2.0",
      verification: { level: "trusted", label: "可信" },
      security: { riskLevel: "low" },
    },
    {
      name: "dsh-plugin-notes",
      packageName: "dsh-plugin-notes",
      description: "note taking",
      topics: ["dsh-plugin"],
      stars: 10,
      latestVersion: "0.3.0",
      verification: { level: "auto", label: "自动验证" },
      security: { riskLevel: "unknown" },
    },
  ]);
  const { io, logs } = captureIo();
  const code = await runCli(["search", "dsh-plugin"], io);
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("名称"));
  assert.ok(text.includes("验证等级"));
  assert.ok(text.includes("dsh-plugin-git"));
  assert.ok(text.includes("dsh-plugin-notes"));
  assert.ok(text.includes("已安装")); // dsh-plugin-git is in state.packages
});

test("search with no keyword exits 1", async () => {
  await makeEnv(globalThis);
  const { io, errors } = captureIo();
  const code = await runCli(["search", "  "], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("用法: dshpkg search"));
});

test("search with no results reports 未找到匹配的插件", async (t) => {
  await makeEnv(t);
  await writeJsonAtomic(statePath("index", "items.json"), []);
  const { io, logs } = captureIo();
  const code = await runCli(["search", "nothing-here"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("未找到匹配的插件"));
});

// ------------------------------------------------------------------ install

test("install --dry-run prints the plan and never invokes dsh", async (t) => {
  await makeEnv(t);
  const { calls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["install", "dsh-plugin-x", "--dry-run"], io);
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.ok(logs.join("\n").includes("[dry-run]"));
});

test("install a bare spec installs it and records bookkeeping", async (t) => {
  await makeEnv(t);
  const { calls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["install", "dsh-plugin-x@2.0.0"], io);
  assert.equal(code, 0);
  assert.deepEqual(calls[0], ["--profile", "web", "--dump-config"]); // precheck
  assert.deepEqual(calls[1], ["plugin", "--profile", "web", "add", "dsh-plugin-x@2.0.0"]);
  assert.deepEqual(calls[2], ["--profile", "web", "--dump-config"]); // smoke
  const state = await readState();
  assert.equal(state.packages["dsh-plugin-x"].version, "2.0.0");
  assert.equal(state.packages["dsh-plugin-x"].held, false);
  assert.ok(logs.join("\n").includes("已安装 dsh-plugin-x"));
});

test("install success snapshots the profile (P1-3 trigger ①)", async (t) => {
  await makeEnv(t);
  const { runner } = fakeRunner();
  const { io } = captureIo({ runner });
  const code = await runCli(["install", "dsh-plugin-x@2.0.0"], io);
  assert.equal(code, 0);
  const dirs = await readdir(statePath("snapshots"));
  assert.equal(dirs.length, 1);
  const manifest = JSON.parse(
    await readFile(join(statePath("snapshots", dirs[0]), "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "web-profile");
});

// -------------------------------------------------- trust gate (P3-2)

test("install refuses an unsigned non-pinned recipe without --yes (P3-2)", async (t) => {
  await makeEnv(t);
  await seedRecipeRepo("repo1", {
    app: recipeOf("app", "app@1.0.0", { pin: { allow: false } }),
  });
  const { calls, runner } = fakeRunner();
  const { io, errors } = captureIo({ runner }); // no ask -> non-interactive
  const code = await runCli(["install", "app"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("拒绝安装"), errors.join("\n"));
  assert.equal(calls.length, 0); // never reached dsh
});

test("install --yes installs an unsigned non-pinned recipe (P3-2)", async (t) => {
  await makeEnv(t);
  await seedRecipeRepo("repo1", {
    app: recipeOf("app", "app@1.0.0", { pin: { allow: false } }),
  });
  const { runner } = fakeRunner();
  const { io } = captureIo({ runner });
  const code = await runCli(["install", "app", "--yes"], io);
  assert.equal(code, 0);
  const state = await readState();
  assert.ok(state.packages["app"]);
});

test("install proceeds for an unsigned recipe with pin.allow (repo-level trust)", async (t) => {
  await makeEnv(t);
  await seedRecipeRepo("repo1", { app: recipeOf("app", "app@1.0.0") }); // pin.allow true
  const { runner } = fakeRunner();
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["install", "app"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("pin.allow"), "repo-level trust note shown");
});

test("install auto-proceeds for a validly signed + trusted recipe (P3-2)", async (t) => {
  await makeEnv(t);
  const { recipe, rawPub, keyId } = signedRecipeOf("app", "app@1.0.0");
  await addTrustedKey(
    keyId,
    "test",
    Buffer.concat([Buffer.from([0x45, 0x64]), Buffer.from(keyId, "hex"), rawPub]).toString("base64"),
  );
  await seedRecipeRepo("repo1", { app: recipe });
  const { runner } = fakeRunner();
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["install", "app"], io); // no --yes needed
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("已验证"), logs.join("\n"));
});

test("install refuses a tampered signature even with --yes (P3-2)", async (t) => {
  await makeEnv(t);
  const { recipe, rawPub, keyId } = signedRecipeOf("app", "app@1.0.0");
  const tampered = { ...recipe, name: "evil" }; // payload changed, sig kept
  await addTrustedKey(
    keyId,
    "test",
    Buffer.concat([Buffer.from([0x45, 0x64]), Buffer.from(keyId, "hex"), rawPub]).toString("base64"),
  );
  await seedRecipeRepo("repo1", { evil: tampered });
  const { calls, runner } = fakeRunner();
  const { io, errors } = captureIo({ runner });
  const code = await runCli(["install", "evil", "--yes"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("签名无效"), errors.join("\n"));
  assert.equal(calls.length, 0);
});

test("install declines an unsigned recipe when the user answers no (P3-2)", async (t) => {
  await makeEnv(t);
  await seedRecipeRepo("repo1", {
    app: recipeOf("app", "app@1.0.0", { pin: { allow: false } }),
  });
  const { calls, runner } = fakeRunner();
  const { io } = captureIo({ runner, ask: async () => "n" }); // interactive, says no
  const code = await runCli(["install", "app"], io);
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  const state = await readState();
  assert.ok(!state.packages["app"]);
});

// -------------------------------------------------- key management (P3-2)

test("key add/list/remove manage the trusted-key set", async (t) => {
  await makeEnv(t);
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = "0f1e2d3c4b5a6978";
  const pubFile = join(tmpdir(), `dshpkg-test-key-${Date.now()}.pub`);
  await writeFile(
    pubFile,
    `untrusted comment: minisign public key ${keyId}\n` +
      Buffer.concat([Buffer.from([0x45, 0x64]), Buffer.from(keyId, "hex"), raw]).toString("base64"),
    "utf8",
  );
  const { io, logs } = captureIo();
  assert.equal(await runCli(["key", "add", pubFile, "my key"], io), 0);
  assert.ok(logs.join("\n").includes(keyId));
  assert.equal(await runCli(["key", "list"], io), 0);
  assert.ok(logs.join("\n").includes("my key"));
  assert.equal(await runCli(["key", "remove", keyId], io), 0);
  const { readTrustedKeys } = await import("../lib/state.js");
  assert.equal((await readTrustedKeys()).keys.length, 0);
});

test("key add rejects a garbage public key", async (t) => {
  await makeEnv(t);
  const { io, errors } = captureIo();
  const code = await runCli(["key", "add", "definitely-not-a-key"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("公钥"), errors.join("\n"));
});

// ------------------------------------------------ self-upgrade (P4-2)

test("self-upgrade snapshots, applies, smokes and reports success (P4-2)", async (t) => {
  await makeEnv(t);
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    return { status: 0 };
  };
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["self-upgrade"], io);
  assert.equal(code, 0);
  assert.deepEqual(calls[0], ["add", "-g", "dshpkg@latest"]);
  assert.deepEqual(calls[1], ["help"]);
  assert.ok(logs.join("\n").includes("已升级"));
  assert.equal((await readdir(statePath("snapshots"))).length, 1);
});

test("self-upgrade rolls back to the previous version when smoke fails (P4-2)", async (t) => {
  await makeEnv(t);
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    return { status: args[0] === "help" ? 1 : 0, stderr: args[0] === "help" ? "crash" : "" };
  };
  const { io, errors } = captureIo({ runner });
  const code = await runCli(["self-upgrade"], io);
  assert.equal(code, 1);
  assert.deepEqual(calls[1], ["help"]);
  assert.deepEqual(calls[2], ["add", "-g", "dshpkg@0.1.0"]); // rollback to current
  assert.ok(errors.join("\n").includes("回退"), errors.join("\n"));
});

test("self-upgrade reports a failed apply without rolling back (P4-2)", async (t) => {
  await makeEnv(t);
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    return { status: 1, stderr: "boom" };
  };
  const { io, errors } = captureIo({ runner });
  const code = await runCli(["self-upgrade"], io);
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.ok(errors.join("\n").includes("升级失败"), errors.join("\n"));
});

// ------------------------------------------------------ daemon (P4-1)

test("daemon install registers the scheduled task via schtasks (P4-1)", async (t) => {
  await makeEnv(t);
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    return { status: 0 };
  };
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["daemon", "install"], io);
  assert.equal(code, 0);
  assert.equal(calls[0][0], "schtasks");
  assert.ok(calls[0].includes("/Create"), calls[0].join(" "));
  assert.ok(calls[0].includes("dshpkg-supervisor"));
  assert.ok(calls[0].includes("/SC") && calls[0].includes("MINUTE"));
  assert.ok(logs.join("\n").includes("已注册计划任务"));
});

test("daemon status reflects the task registration (P4-1)", async (t) => {
  await makeEnv(t);
  const { io } = captureIo({ runner: () => ({ status: 0 }) });
  assert.equal(await runCli(["daemon", "status"], io), 0);
  const { io: io2 } = captureIo({ runner: () => ({ status: 1 }) });
  assert.equal(await runCli(["daemon", "status"], io2), 1);
});

test("install a local path probes package.json and adds link: prefixed", async (t) => {
  const { home } = await makeEnv(t);
  const pluginDir = join(home, "my-plugin");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: "my-local-plugin", version: "1.0.0", dsh: { bundle: { patch: true } } }),
  );
  const { calls, runner } = fakeRunner();
  const { io } = captureIo({ runner });
  const code = await runCli(["install", pluginDir], io);
  assert.equal(code, 0);
  const addCall = calls.find((c) => c[0] === "plugin");
  assert.ok(addCall, "expected a plugin add call");
  assert.equal(addCall[4], `link:${pluginDir}`);
  const state = await readState();
  assert.ok(state.packages["my-local-plugin"]);
});

test("install from a recipe repo resolves deps first and records all entries", async (t) => {
  await makeEnv(t);
  await seedRecipeRepo("repo1", {
    app: recipeOf("app", "app@1.0.0", { deps: ["libdep"] }),
    libdep: recipeOf("libdep", "libdep@0.5.0"),
  });
  const { calls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["install", "app"], io);
  assert.equal(code, 0);
  const adds = calls.filter((c) => c[0] === "plugin");
  assert.equal(adds.length, 2);
  // deps resolve through the recipe library: libdep installs with its recipe
  // version (full closure), self last
  assert.equal(adds[0][4], "libdep@0.5.0");
  assert.equal(adds[1][4], "app@1.0.0");
  const state = await readState();
  assert.ok(state.packages["app"]);
  assert.ok(state.packages["libdep"]);
  assert.ok(logs.join("\n").includes("已安装 app"));
});

test("install failure rolls back the dep closure and reports Chinese error", async (t) => {
  await makeEnv(t);
  await seedRecipeRepo("repo1", {
    app: recipeOf("app", "app@1.0.0", { deps: ["libdep"] }),
    libdep: recipeOf("libdep", "libdep@0.5.0"),
  });
  const { calls, runner } = fakeRunner((args) => {
    if (args[0] === "plugin" && args[3] === "add" && args[4] === "app@1.0.0") return 1;
    return 0;
  });
  const { io, errors } = captureIo({ runner });
  const code = await runCli(["install", "app"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("安装失败"));
  const state = await readState();
  assert.ok(!state.packages["app"]);
  // the installed dep is rolled back after the failed self install
  const removes = calls.filter((c) => c[0] === "plugin" && c[3] === "remove");
  assert.equal(removes.length, 1);
  assert.equal(removes[0][4], "libdep");
});

test("install with --profile forwards the profile to dsh", async (t) => {
  await makeEnv(t);
  const { calls, runner } = fakeRunner();
  const { io } = captureIo({ runner });
  const code = await runCli(["install", "dsh-plugin-x", "--profile", "dev"], io);
  assert.equal(code, 0);
  assert.ok(calls.every((c) => c.includes("dev")));
});

// --------------------------------------------- smart install (fuzzy resolution)

/** Fake search: records every call, returns per-call results from the script. */
function fakeSearch(script = () => []) {
  const calls = [];
  const search = async (query, opts = {}) => {
    calls.push({ query, opts });
    return script(query, opts, calls.length);
  };
  return { calls, search };
}

/** A search-result-shaped candidate (module F result shape). */
function searchItem(over = {}) {
  return {
    name: "dsh-at-file",
    packageName: "dsh-at-file",
    description: "余额文件管理插件",
    latestVersion: "1.2.0",
    verification: { level: "auto", label: "自动验证" },
    security: { riskLevel: "low" },
    score: 95,
    ...over,
  };
}

/** Force stdin to look non-interactive for one test (restored afterwards). */
function forceNonTty(t) {
  const prev = process.stdin.isTTY;
  process.stdin.isTTY = false;
  t.after(() => {
    if (prev === undefined) delete process.stdin.isTTY;
    else process.stdin.isTTY = prev;
  });
}

test("parseArgs accepts --yes before or after the command", () => {
  assert.equal(parseArgs(["install", "foo", "--yes"]).yes, true);
  assert.equal(parseArgs(["--yes", "install", "foo"]).yes, true);
  assert.equal(parseArgs(["install", "foo"]).yes, false);
});

test("install a fuzzy word with a single strong match installs it directly", async (t) => {
  await makeEnv(t);
  const { calls, search } = fakeSearch(() => [searchItem()]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner, search });
  const code = await runCli(["install", "at-file"], io);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "at-file");
  assert.equal(calls[0].opts.online, false);
  assert.equal(calls[0].opts.ecosystemOnly, true); // duck-typed hint to search.js
  const add = runCalls.find((c) => c[0] === "plugin");
  assert.deepEqual(add, ["plugin", "--profile", "web", "add", "dsh-at-file"]);
  assert.ok(logs.join("\n").includes("已匹配：dsh-at-file（来自搜索）"));
  const state = await readState();
  assert.equal(state.packages["dsh-at-file"].source, "dsh-at-file");
  assert.equal(state.packages["dsh-at-file"].version, null);
});

test("install an exact-name hit inside the search chain wins over score", async (t) => {
  await makeEnv(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "at-file", packageName: "", score: 100 }),
    searchItem({ score: 90 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner, search });
  const code = await runCli(["install", "at-file"], io);
  assert.equal(code, 0);
  const add = runCalls.find((c) => c[0] === "plugin");
  assert.equal(add[4], "at-file"); // packageName empty -> derived from the name
  assert.ok(logs.join("\n").includes("已匹配：at-file（来自搜索）"));
});

test("install auto-picks a lone ecosystem candidate 30+ points ahead", async (t) => {
  await makeEnv(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "dsh-balance", packageName: "dsh-balance", score: 100 }),
    searchItem({ name: "other-tool", packageName: "other-tool", score: 50 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner, search });
  const code = await runCli(["install", "balance"], io);
  assert.equal(code, 0);
  const add = runCalls.find((c) => c[0] === "plugin");
  assert.equal(add[4], "dsh-balance");
  assert.ok(logs.join("\n").includes("已匹配：dsh-balance（来自搜索）"));
});

test("install lists candidates when the ecosystem leader is not 30 points ahead", async (t) => {
  await makeEnv(t);
  forceNonTty(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "dsh-balance", packageName: "dsh-balance", score: 90 }),
    searchItem({ name: "other-tool", packageName: "other-tool", score: 80 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs, errors } = captureIo({ runner, search });
  const code = await runCli(["install", "balance"], io);
  assert.equal(code, 2);
  assert.equal(runCalls.length, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("dsh-balance"));
  assert.ok(text.includes("other-tool"));
  assert.ok(errors.join("\n").includes("多个候选，请用完整名安装"));
});

test("install with multiple candidates and no TTY lists them and exits 2", async (t) => {
  await makeEnv(t);
  forceNonTty(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "dsh-balance", packageName: "dsh-balance", description: "余额查询", score: 90 }),
    searchItem({ name: "dsh-balance-plus", packageName: "dsh-balance-plus", score: 60 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs, errors } = captureIo({ runner, search });
  const code = await runCli(["install", "余额"], io);
  assert.equal(code, 2);
  assert.equal(runCalls.length, 0); // nothing installed without a choice
  const text = logs.join("\n");
  assert.ok(text.includes("为 \"余额\" 找到 2 个候选"));
  assert.ok(text.includes("dsh-balance"));
  assert.ok(text.includes("dsh-balance-plus"));
  assert.ok(text.includes("余额查询")); // description column
  assert.ok(text.includes("自动验证")); // verification column
  assert.ok(errors.join("\n").includes("多个候选，请用完整名安装"));
  const state = await readState();
  assert.equal(Object.keys(state.packages ?? {}).length, 0);
});

test("install shows at most 10 candidates in the list", async (t) => {
  await makeEnv(t);
  forceNonTty(t);
  const items = Array.from({ length: 12 }, (_, i) =>
    searchItem({ name: `dsh-balance-${i + 1}`, packageName: `dsh-balance-${i + 1}`, score: 100 - i }));
  const { search } = fakeSearch(() => items);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner, search });
  const code = await runCli(["install", "balance"], io);
  assert.equal(code, 2);
  assert.equal(runCalls.length, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("显示前 10 个"));
  assert.ok(text.includes("[10]"));
  assert.ok(!text.includes("[11]"));
});

test("install with zero candidates prints the refresh hint and exits 1", async (t) => {
  await makeEnv(t);
  const { calls, search } = fakeSearch(() => []);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, errors } = captureIo({ runner, search });
  const code = await runCli(["install", "不存在的东西"], io);
  assert.equal(code, 1);
  assert.equal(runCalls.length, 0);
  const text = errors.join("\n");
  assert.ok(text.includes("未找到"));
  assert.ok(text.includes("dshpkg search"));
  assert.ok(text.includes("dshpkg update"));
  // empty local index -> exactly one automatic online retry
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.online, false);
  assert.equal(calls[1].opts.online, true);
});

test("install does not retry online when the local index is not empty", async (t) => {
  await makeEnv(t);
  await writeJsonAtomic(statePath("index", "items.json"), [
    searchItem({ name: "dsh-unrelated", packageName: "dsh-unrelated" }),
  ]);
  const { calls, search } = fakeSearch(() => []);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, errors } = captureIo({ runner, search });
  const code = await runCli(["install", "不存在的东西"], io);
  assert.equal(code, 1);
  assert.equal(runCalls.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.online, false);
  assert.ok(errors.join("\n").includes("未找到"));
});

test("install retries online once when the local index is empty and hits", async (t) => {
  await makeEnv(t);
  const { calls, search } = fakeSearch((_q, opts) => (opts.online ? [searchItem()] : []));
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner, search });
  const code = await runCli(["install", "at-file"], io);
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.online, false);
  assert.equal(calls[1].opts.online, true);
  assert.equal(calls[1].opts.ecosystemOnly, undefined); // online pass stays broad
  const add = runCalls.find((c) => c[0] === "plugin");
  assert.equal(add[4], "dsh-at-file");
  assert.ok(logs.join("\n").includes("已匹配：dsh-at-file（来自搜索）"));
});

test("install --yes picks the first candidate without prompting", async (t) => {
  await makeEnv(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "dsh-balance", packageName: "dsh-balance", score: 90 }),
    searchItem({ name: "dsh-balance-plus", packageName: "dsh-balance-plus", score: 60 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner, search });
  const code = await runCli(["install", "余额", "--yes"], io);
  assert.equal(code, 0);
  const add = runCalls.find((c) => c[0] === "plugin");
  assert.equal(add[4], "dsh-balance");
  const text = logs.join("\n");
  assert.ok(text.includes("已匹配：dsh-balance（来自搜索，--yes 自动选择第 1 名）"));
  const state = await readState();
  assert.ok(state.packages["dsh-balance"]);
});

test("install interactive pick installs the chosen candidate", async (t) => {
  await makeEnv(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "dsh-balance", packageName: "dsh-balance", score: 90 }),
    searchItem({ name: "dsh-balance-plus", packageName: "dsh-balance-plus", score: 60 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const asked = [];
  const { io, logs } = captureIo({
    runner,
    search,
    ask: async (prompt) => {
      asked.push(prompt);
      return "2";
    },
  });
  const code = await runCli(["install", "余额"], io);
  assert.equal(code, 0);
  assert.equal(asked.length, 1);
  const add = runCalls.find((c) => c[0] === "plugin");
  assert.equal(add[4], "dsh-balance-plus");
  assert.ok(logs.join("\n").includes("已选择：dsh-balance-plus（来自搜索）"));
});

test("install interactive pick cancels on q", async (t) => {
  await makeEnv(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "dsh-balance", packageName: "dsh-balance", score: 90 }),
    searchItem({ name: "dsh-balance-plus", packageName: "dsh-balance-plus", score: 60 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner, search, ask: async () => "q" });
  const code = await runCli(["install", "余额"], io);
  assert.equal(code, 0);
  assert.equal(runCalls.length, 0);
  assert.ok(logs.join("\n").includes("已取消"));
  const state = await readState();
  assert.equal(Object.keys(state.packages ?? {}).length, 0);
});

test("install interactive pick rejects an out-of-range number", async (t) => {
  await makeEnv(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "dsh-balance", packageName: "dsh-balance", score: 90 }),
    searchItem({ name: "dsh-balance-plus", packageName: "dsh-balance-plus", score: 60 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, errors } = captureIo({ runner, search, ask: async () => "99" });
  const code = await runCli(["install", "余额"], io);
  assert.equal(code, 1);
  assert.equal(runCalls.length, 0);
  assert.ok(errors.join("\n").includes("编号无效"));
});

test("install of an exact npm name never enters the search chain", async (t) => {
  await makeEnv(t);
  const { calls, search } = fakeSearch(() => {
    throw new Error("search must not run for direct specs");
  });
  for (const [spec, added] of [
    ["dsh-plugin-x", "dsh-plugin-x"], // ecosystem bare name
    ["some-pkg@1.2.3", "some-pkg@1.2.3"], // version pin
    ["npm:other-pkg", "npm:other-pkg"], // explicit npm: prefix
  ]) {
    const { calls: runCalls, runner } = fakeRunner();
    const { io, logs } = captureIo({ runner, search });
    const code = await runCli(["install", spec], io);
    assert.equal(code, 0);
    assert.equal(calls.length, 0); // search chain bypassed
    const add = runCalls.find((c) => c[0] === "plugin");
    assert.equal(add[4], added);
    assert.ok(logs.join("\n").includes("已安装")); // original direct-install flow
  }
});

test("install resolves a search hit through the recipe repo (dependency closure)", async (t) => {
  await makeEnv(t);
  await seedRecipeRepo("repo1", {
    "dsh-at-file": recipeOf("dsh-at-file", "dsh-at-file@1.0.0", { deps: ["dsh-lib"] }),
    "dsh-lib": recipeOf("dsh-lib", "dsh-lib@0.5.0"),
  });
  const { search } = fakeSearch(() => [searchItem()]);
  const { calls: runCalls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner, search });
  const code = await runCli(["install", "at-file"], io);
  assert.equal(code, 0);
  const adds = runCalls.filter((c) => c[0] === "plugin");
  assert.equal(adds.length, 2);
  assert.equal(adds[0][4], "dsh-lib"); // string deps install by name, deps first
  assert.equal(adds[1][4], "dsh-at-file@1.0.0");
  const state = await readState();
  assert.ok(state.packages["dsh-at-file"]);
  assert.ok(state.packages["dsh-lib"]);
  assert.equal(state.packages["dsh-at-file"].version, "1.0.0"); // from the recipe spec
  assert.ok(logs.join("\n").includes("已匹配：dsh-at-file（来自搜索）"));
});

test("install derives a github: spec for a GitHub-only search hit", async (t) => {
  await makeEnv(t);
  const { search } = fakeSearch(() => [
    searchItem({ name: "dsh-tools", packageName: "", ownerRepo: "alice/dsh-tools", score: 100 }),
  ]);
  const { calls: runCalls, runner } = fakeRunner();
  const gitCalls = [];
  const gitRunner = (args) => {
    gitCalls.push([...args]);
    return { status: 0, stdout: "", stderr: "" };
  };
  const { io, logs } = captureIo({ runner, search, gitRunner });
  const code = await runCli(["install", "tools"], io);
  assert.equal(code, 0);
  assert.equal(gitCalls.length, 1); // clone into the git cache
  assert.equal(gitCalls[0][0], "clone");
  const add = runCalls.find((c) => c[0] === "plugin");
  assert.ok(add[4].startsWith("link:")); // installed from the cache via link:
  assert.ok(add[4].includes("github.com-alice-dsh-tools"));
  assert.ok(logs.join("\n").includes("已匹配：dsh-tools（来自搜索）"));
  const state = await readState();
  assert.equal(state.packages["dsh-tools"].source, "github:alice/dsh-tools");
});

// ------------------------------------------------------------------- remove

test("remove uninstalls and deletes bookkeeping", async (t) => {
  await makeEnv(t, { packages: { "dsh-plugin-x": { version: "1.0.0" } } });
  const { calls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["remove", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  assert.deepEqual(calls[0], ["plugin", "--profile", "web", "remove", "dsh-plugin-x"]);
  const state = await readState();
  assert.ok(!state.packages["dsh-plugin-x"]);
  assert.ok(logs.join("\n").includes("已移除 dsh-plugin-x"));
});

// ------------------------------------------------------------- hold / unhold

test("hold and unhold flip state.packages[name].held", async (t) => {
  await makeEnv(t, { packages: { "dsh-plugin-x": { version: "1.0.0", held: false } } });
  const { io, logs } = captureIo();
  assert.equal(await runCli(["hold", "dsh-plugin-x"], io), 0);
  let state = await readState();
  assert.equal(state.packages["dsh-plugin-x"].held, true);
  assert.ok(logs.join("\n").includes("已保持"));

  assert.equal(await runCli(["unhold", "dsh-plugin-x"], io), 0);
  state = await readState();
  assert.equal(state.packages["dsh-plugin-x"].held, false);
});

test("hold on an unknown package exits 1", async (t) => {
  await makeEnv(t);
  const { io, errors } = captureIo();
  const code = await runCli(["hold", "ghost"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("未找到已安装插件"));
});

test("hold refuses dangerous package names (prototype-pollution guard)", async (t) => {
  await makeEnv(t);
  const { io, errors } = captureIo();
  for (const bad of ["__proto__", "constructor", "prototype"]) {
    const code = await runCli(["hold", bad], io);
    assert.equal(code, 1, bad);
    assert.ok(errors.join("\n").includes("非法的插件名"), bad);
  }
  // state.packages gained no own property for the dangerous keys.
  const state = await readState();
  for (const bad of ["__proto__", "constructor", "prototype"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(state.packages, bad), false, bad);
  }
});

// -------------------------------------------------------- enable / disable

test("disable writes a managed block into cordis.patch.yml (file mode)", async (t) => {
  await makeEnv(t, { patch: "plugins:\n  foo:\n" });
  const { io, logs } = captureIo({ fetcher: noHostFetcher });
  const code = await runCli(["disable", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  const patch = await readFile(join(process.env.DSH_HOME, "profiles", "web", "cordis.patch.yml"), "utf8");
  assert.ok(patch.includes("dshpkg:managed:start"));
  assert.ok(patch.includes("dsh-plugin-x"));
  assert.ok(patch.includes("disabled: true"));
  assert.ok(logs.join("\n").includes("cordis.patch.yml"));
});

test("enable removes the managed block (file mode)", async (t) => {
  const patch = [
    "plugins:",
    "  foo:",
    "# dshpkg:managed:start",
    "- id: dsh-plugin-x",
    "  disabled: true",
    "# dshpkg:managed:end",
    "",
  ].join("\n");
  const { home } = await makeEnv(t, { patch });
  const { io, logs } = captureIo({ fetcher: noHostFetcher });
  const code = await runCli(["enable", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  const updated = await readFile(join(home, "profiles", "web", "cordis.patch.yml"), "utf8");
  assert.ok(!updated.includes("dshpkg:managed:start"));
  assert.ok(logs.join("\n").includes("启用"));
});

test("disable goes through the running host when probe succeeds", async (t) => {
  await makeEnv(t);
  const { fetcher, posts } = fakeHostFetcher({ managed: [] });
  const { io, logs } = captureIo({ fetcher });
  const code = await runCli(["disable", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith(`/dshpkg/managed/disable`));
  assert.deepEqual(posts[0].body, { name: "dsh-plugin-x" });
  assert.ok(logs.join("\n").includes("dshpkg host"));
});

test("enable goes through the running host when probe succeeds", async (t) => {
  await makeEnv(t);
  const { fetcher, posts } = fakeHostFetcher({ managed: [{ name: "dsh-plugin-x", enabled: false }] });
  const { io } = captureIo({ fetcher });
  const code = await runCli(["enable", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith(`/dshpkg/managed/enable`));
});

// --- enable / disable protect list (Spec section 9) ------------------------

test("disable rejects a protected core entry and leaves the patch untouched", async (t) => {
  const patch = "- id: user-entry\n  disabled: false\n";
  const { home } = await makeEnv(t, { patch });
  const { io, errors } = captureIo({ fetcher: noHostFetcher });
  const code = await runCli(["disable", "loader", "--profile", "web"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("核心条目受保护，禁止熔断/禁用"));
  const after = await readFile(join(home, "profiles", "web", "cordis.patch.yml"), "utf8");
  assert.equal(after, patch); // nothing was written
});

test("disable a protected core entry never reaches the running host either", async (t) => {
  await makeEnv(t);
  const { fetcher, posts } = fakeHostFetcher({ managed: [] });
  const { io, errors } = captureIo({ fetcher });
  const code = await runCli(["disable", "cordis-host-runner"], io);
  assert.equal(code, 1);
  assert.equal(posts.length, 0); // gate fires before the host probe/route
  assert.ok(errors.join("\n").includes("核心条目受保护，禁止熔断/禁用"));
});

test("disable a non-protected entry is not blocked by the protect list", async (t) => {
  await makeEnv(t, { patch: "- id: user-entry\n  disabled: false\n" });
  const { io, logs } = captureIo({ fetcher: noHostFetcher });
  const code = await runCli(["disable", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  const patch = await readFile(join(process.env.DSH_HOME, "profiles", "web", "cordis.patch.yml"), "utf8");
  assert.ok(patch.includes("dshpkg:managed:start"));
  assert.ok(patch.includes("dsh-plugin-x"));
  assert.ok(logs.join("\n").includes("禁用"));
});

test("enable restores a protected core entry (restore is never blocked)", async (t) => {
  const patch = [
    "- id: user-entry",
    "  disabled: false",
    "# dshpkg:managed:start",
    "- id: loader",
    "  disabled: true",
    "# dshpkg:managed:end",
    "",
  ].join("\n");
  const { home } = await makeEnv(t, { patch });
  const { io, logs } = captureIo({ fetcher: noHostFetcher });
  const code = await runCli(["enable", "loader"], io);
  assert.equal(code, 0);
  const updated = await readFile(join(home, "profiles", "web", "cordis.patch.yml"), "utf8");
  assert.ok(!updated.includes("dshpkg:managed:start"));
  assert.ok(logs.join("\n").includes("启用"));
});

// ------------------------------------------------------------------- status

test("status reports circuit-open for a tripped package", async (t) => {
  await makeEnv(t, { packages: { "dsh-plugin-x": openPackage() } });
  const { io, logs } = captureIo({ fetcher: noHostFetcher });
  const code = await runCli(["status", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("circuit-open"));
});

test("status reports disabled when the managed block exists (file mode)", async (t) => {
  const patch = "# dshpkg:managed:start\n- id: dsh-plugin-x\n  disabled: true\n# dshpkg:managed:end\n";
  await makeEnv(t, { patch });
  const { io, logs } = captureIo({ fetcher: noHostFetcher });
  const code = await runCli(["status", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("disabled"));
});

test("status reports running when nothing disables it", async (t) => {
  await makeEnv(t);
  const { io, logs } = captureIo({ fetcher: noHostFetcher });
  const code = await runCli(["status", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("running"));
});

test("status prefers host managed state over the file", async (t) => {
  await makeEnv(t);
  const { fetcher } = fakeHostFetcher({ managed: [{ name: "dsh-plugin-x", enabled: false }] });
  const { io, logs } = captureIo({ fetcher });
  const code = await runCli(["status", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("disabled"));
});

// --------------------------------------------------------------------- list

test("list merges state, profile deps and recipe repo", async (t) => {
  await makeEnv(t, {
    deps: { "dsh-plugin-profile-dep": "1.0.0" },
    packages: { "dsh-plugin-state": { version: "2.0.0", source: "npm" } },
  });
  await seedRecipeRepo("repo1", { "dsh-plugin-repo": recipeOf("dsh-plugin-repo", "dsh-plugin-repo@3.0.0") });
  const { io, logs } = captureIo();
  const code = await runCli(["list"], io);
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("dsh-plugin-state"));
  assert.ok(text.includes("dsh-plugin-profile-dep"));
  assert.ok(text.includes("dsh-plugin-repo"));
  assert.ok(text.includes("repo1"));
});

test("list --installed hides recipe-only packages", async (t) => {
  await makeEnv(t, { packages: { "dsh-plugin-state": { version: "2.0.0" } } });
  await seedRecipeRepo("repo1", { "dsh-plugin-repo": recipeOf("dsh-plugin-repo", "dsh-plugin-repo@3.0.0") });
  const { io, logs } = captureIo();
  const code = await runCli(["list", "--installed"], io);
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("dsh-plugin-state"));
  assert.ok(!text.includes("dsh-plugin-repo"));
});

test("list marks held and circuit-open status", async (t) => {
  await makeEnv(t, {
    packages: {
      "dsh-plugin-held": { version: "1.0.0", held: true },
      "dsh-plugin-open": openPackage(),
    },
  });
  const { io, logs } = captureIo();
  const code = await runCli(["list", "--installed"], io);
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("held"));
  assert.ok(text.includes("circuit-open"));
});

// --------------------------------------------------------------------- info

test("info prints recipe detail plus crash count", async (t) => {
  await makeEnv(t, { packages: { app: { version: "1.0.0", crashCount: 2, held: false } } });
  await seedRecipeRepo("repo1", {
    app: recipeOf("app", "app@1.0.0", { deps: ["libdep"], verify: { level: 1, label: "人工验证", risk: "low" } }),
  });
  const { io, logs } = captureIo();
  const code = await runCli(["info", "app"], io);
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("libdep"));
  assert.ok(text.includes("repo1"));
  assert.ok(text.includes("崩溃计数"));
  assert.ok(text.includes("2"));
});

// ---------------------------------------------------------------------- why

test("why finds recipes that depend on the package", async (t) => {
  await makeEnv(t);
  await seedRecipeRepo("repo1", {
    app: recipeOf("app", "app@1.0.0", { deps: ["libdep"] }),
    other: recipeOf("other", "other@0.1.0", { deps: [] }),
  });
  const { io, logs } = captureIo();
  const code = await runCli(["why", "libdep"], io);
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("app"));
  assert.ok(!text.includes("other"));
});

// ------------------------------------------------------------------- doctor

test("doctor passes with a clean dump-config and healthy dep graph", async (t) => {
  await makeEnv(t, { packages: { app: { version: "1.0.0" }, libdep: { version: "0.5.0" } } });
  await seedRecipeRepo("repo1", { app: recipeOf("app", "app@1.0.0", { deps: ["libdep"] }) });
  const dshRun = () => ({ status: 0, stdout: "ok", stderr: "" });
  const { io, logs } = captureIo({ dshRun });
  const code = await runCli(["doctor"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("组合树校验通过"));
});

test("doctor fails on a broken dump-config and shows the tail", async (t) => {
  await makeEnv(t);
  const dshRun = () => ({ status: 1, stdout: "", stderr: "boom line" });
  const { io, errors } = captureIo({ dshRun });
  const code = await runCli(["doctor"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("组合树校验失败"));
  assert.ok(errors.join("\n").includes("boom line"));
});

test("doctor flags missing dependencies in the graph", async (t) => {
  await makeEnv(t, { packages: { app: { version: "1.0.0" } } });
  await seedRecipeRepo("repo1", { app: recipeOf("app", "app@1.0.0", { deps: ["libdep"] }) });
  const dshRun = () => ({ status: 0, stdout: "", stderr: "" });
  const { io, errors } = captureIo({ dshRun });
  const code = await runCli(["doctor"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("app 缺少依赖 libdep"));
});

test("doctor --fix installs missing dependencies automatically", async (t) => {
  await makeEnv(t, { packages: { app: { version: "1.0.0" } } });
  await seedRecipeRepo("repo1", {
    app: recipeOf("app", "app@1.0.0", { deps: ["libdep"] }),
    libdep: recipeOf("libdep", "libdep@0.5.0"),
  });
  const { calls, runner } = fakeRunner();
  const dshRun = () => ({ status: 0, stdout: "ok", stderr: "" });
  const { io, logs } = captureIo({ dshRun, runner });
  const code = await runCli(["doctor", "--fix"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("已安装缺失依赖 libdep"), logs.join("\n"));
  const addCall = calls.find((c) => c[0] === "plugin" && c.includes("add"));
  assert.ok(addCall, "libdep installed via the official channel");
  assert.ok(addCall.some((a) => a.includes("libdep")), addCall.join(" "));
});

// ----------------------------------------------------------------- autoremove

test("autoremove removes orphan packages and keeps bundles (CLI)", async (t) => {
  const { profileDir } = await makeEnv(t);
  // app is a bundle (never autoremoved); orphan is plain and unreferenced
  await mkdir(join(profileDir, "node_modules", "app"), { recursive: true });
  await writeFile(
    join(profileDir, "node_modules", "app", "package.json"),
    JSON.stringify({ name: "app", dsh: { bundle: { patch: "cordis.patch.yml" } } }),
  );
  await mkdir(join(profileDir, "node_modules", "orphan"), { recursive: true });
  await writeFile(
    join(profileDir, "node_modules", "orphan", "package.json"),
    JSON.stringify({ name: "orphan" }),
  );
  const manifestPath = join(profileDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies = { app: "1.0.0", orphan: "1.0.0" };
  await writeFile(manifestPath, JSON.stringify(manifest));

  const { calls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["autoremove"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("已清理 1 个孤儿包"), logs.join("\n"));
  const removeCall = calls.find((c) => c[0] === "plugin" && c.includes("remove"));
  assert.ok(removeCall && removeCall.includes("orphan"), removeCall?.join(" "));
  assert.ok(
    !calls.some((c) => c.includes("remove") && c.includes("app")),
    "bundle untouched",
  );
});

test("autoremove --dry-run lists orphans without invoking dsh", async (t) => {
  const { profileDir } = await makeEnv(t);
  await mkdir(join(profileDir, "node_modules", "orphan"), { recursive: true });
  await writeFile(
    join(profileDir, "node_modules", "orphan", "package.json"),
    JSON.stringify({ name: "orphan" }),
  );
  const manifestPath = join(profileDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies = { orphan: "1.0.0" };
  await writeFile(manifestPath, JSON.stringify(manifest));

  const { calls, runner } = fakeRunner();
  const { io, logs } = captureIo({ runner });
  const code = await runCli(["autoremove", "--dry-run"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("将清理 1 个孤儿包"), logs.join("\n"));
  assert.equal(calls.length, 0);
});

// -------------------------------------------------------------------- audit

test("audit summarizes circuits and recent incidents", async (t) => {
  await makeEnv(t, { packages: { "dsh-plugin-x": openPackage() } });
  await writeFile(statePath("incidents.jsonl"), `{"t":"2026-08-24T00:00:00.000Z","entryId":"dsh-plugin-x","detail":"crash 1"}\n`);
  const { io, logs } = captureIo();
  const code = await runCli(["audit"], io);
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.ok(text.includes("circuit-open"));
  assert.ok(text.includes("dsh-plugin-x"));
});

// -------------------------------------------------------------- fix-broken

test("fix-broken closes the circuit and removes the managed block", async (t) => {
  const patch = "# dshpkg:managed:start\n- id: dsh-plugin-x\n  disabled: true\n# dshpkg:managed:end\n";
  await makeEnv(t, { packages: { "dsh-plugin-x": openPackage() }, patch });
  const { io, logs } = captureIo({ fetcher: noHostFetcher, ask: async () => "1" });
  const code = await runCli(["fix-broken"], io);
  assert.equal(code, 0);
  const state = await readState();
  assert.equal(state.packages["dsh-plugin-x"].crashCount, 0);
  assert.equal(state.packages["dsh-plugin-x"].circuitOpenAt, null);
  const updated = await readFile(join(process.env.DSH_HOME, "profiles", "web", "cordis.patch.yml"), "utf8");
  assert.ok(!updated.includes("dshpkg:managed:start"));
  assert.ok(logs.join("\n").includes("已闭合"));
});

test("fix-broken with nothing open says so", async (t) => {
  await makeEnv(t);
  const { io, logs } = captureIo();
  const code = await runCli(["fix-broken"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("没有处于 circuit-open"));
});

// ---------------------------------------------------------------------- log

test("log streams incidents as JSON lines", async (t) => {
  await makeEnv(t);
  await writeFile(
    statePath("incidents.jsonl"),
    '{"t":"2026-08-24T00:00:00.000Z","entryId":"a","detail":"one"}\n',
  );
  const { io, logs } = captureIo();
  const code = await runCli(["log"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("entryId"));
});

// --------------------------------------------------------------------- repo

test("repo add / list / remove round-trip", async (t) => {
  await makeEnv(t);
  const { io, logs } = captureIo();
  assert.equal(await runCli(["repo", "add", "https://example.com/recipes.git"], io), 0);
  let repos = JSON.parse(await readFile(statePath("repos.json"), "utf8"));
  assert.equal(repos.repos[0].name, "recipes");

  assert.equal(await runCli(["repo", "list"], io), 0);
  assert.ok(logs.join("\n").includes("recipes"));

  assert.equal(await runCli(["repo", "remove", "recipes"], io), 0);
  repos = JSON.parse(await readFile(statePath("repos.json"), "utf8"));
  assert.equal(repos.repos.length, 0);
});

test("repo add rejects unsafe urls", async (t) => {
  await makeEnv(t);
  const { io, errors } = captureIo();
  const code = await runCli(["repo", "add", "https://x.com/a b.git"], io);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("仓库地址不能包含"));
});

test("repo init adds the default repos from the env override (R5)", async (t) => {
  await makeEnv(t);
  const prev = process.env.DSH_DEFAULT_REPOS;
  process.env.DSH_DEFAULT_REPOS = JSON.stringify([
    { url: "https://example.com/community.git", name: "community", format: "git" },
  ]);
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_DEFAULT_REPOS;
    else process.env.DSH_DEFAULT_REPOS = prev;
  });
  const { io, logs } = captureIo();
  assert.equal(await runCli(["repo", "init"], io), 0);
  assert.ok(logs.join("\n").includes("已添加 1 个默认仓库"));
  const repos = JSON.parse(await readFile(statePath("repos.json"), "utf8"));
  assert.equal(repos.repos.length, 1);
  assert.equal(repos.repos[0].name, "community");
});

test("repo init --no-default writes nothing", async (t) => {
  await makeEnv(t);
  const { io } = captureIo();
  assert.equal(await runCli(["repo", "init", "--no-default"], io), 0);
  assert.equal(existsSync(statePath("repos.json")), false);
});

// ------------------------------------------------------------------- update

test("update skips a fresh index (24h) and reports it", async (t) => {
  await makeEnv(t);
  await writeJsonAtomic(statePath("index", "meta.json"), {
    fetchedAt: new Date().toISOString(),
    count: 7,
    lastError: null,
  });
  const { io, logs } = captureIo({ fetcher: emptyIndexFetcher().fetcher });
  const code = await runCli(["update"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("24 小时内已刷新过"));
});

test("update refreshes a stale index from all sources (injected fetcher)", async (t) => {
  await makeEnv(t);
  await writeJsonAtomic(statePath("index", "meta.json"), {
    fetchedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    count: 0,
    lastError: null,
  });
  const { fetcher, urls } = emptyIndexFetcher();
  const { io, logs } = captureIo({ fetcher });
  const code = await runCli(["update"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("索引已更新"));
  assert.ok(urls.some((u) => u.includes("github")));
  assert.ok(urls.some((u) => u.includes("npm")));
});

test("sync is an alias of update", async (t) => {
  await makeEnv(t);
  await writeJsonAtomic(statePath("index", "meta.json"), {
    fetchedAt: new Date().toISOString(),
    count: 3,
    lastError: null,
  });
  const { io, logs } = captureIo({ fetcher: emptyIndexFetcher().fetcher });
  const code = await runCli(["sync"], io);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("24 小时内已刷新过"));
});

// ----------------------------------------------------------------- upgrade

test("upgrade upgrades every non-held installed package", async (t) => {
  await makeEnv(t, {
    packages: {
      "dsh-plugin-a": { version: "1.0.0", held: false },
      "dsh-plugin-b": { version: "1.0.0", held: true },
    },
  });
  const { calls, runner } = fakeRunner();
  const { io } = captureIo({ runner });
  const code = await runCli(["upgrade"], io);
  assert.equal(code, 0);
  const adds = calls.filter((c) => c[0] === "plugin");
  assert.equal(adds.length, 1); // held package skipped
  assert.equal(adds[0][4], "dsh-plugin-a@latest");
});

test("upgrade skips circuit-open packages with a hint", async (t) => {
  await makeEnv(t, { packages: { "dsh-plugin-a": openPackage() } });
  const { calls, runner } = fakeRunner();
  const { io, errors } = captureIo({ runner });
  const code = await runCli(["upgrade"], io);
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
  assert.ok(errors.join("\n").includes("fix-broken"));
});

// ---------------------------------------------------------------------- run

test("run spawns the supervisor via node with stdio inherit", async (t) => {
  await makeEnv(t);
  const spawns = [];
  const spawnImpl = (cmd, args, options) => {
    spawns.push({ cmd, args, options });
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const { io, logs } = captureIo({ spawnImpl });
  const code = await runCli(["run", "--port", "4567", "--profile", "dev"], io);
  assert.equal(code, 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, process.execPath);
  assert.ok(spawns[0].args.some((a) => a.endsWith("supervisor.js")));
  assert.ok(spawns[0].args.includes("--port"));
  assert.equal(spawns[0].options.stdio, "inherit");
  assert.ok(logs.join("\n").includes("启动看门狗"));
});

test("run forwards --port to the supervisor only when given", async (t) => {
  await makeEnv(t);
  const spawns = [];
  const spawnImpl = (cmd, args) => {
    spawns.push(args);
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const { io } = captureIo({ spawnImpl });
  const code = await runCli(["run"], io);
  assert.equal(code, 0);
  assert.ok(!spawns[0].includes("--port"));
  assert.ok(!spawns[0].includes("--profile"));
});

// -------------------------------------------------------------- host probe

test("host probe respects --port when choosing the HTTP target", async (t) => {
  await makeEnv(t);
  const seen = [];
  const fetcher = async (url) => {
    seen.push(String(url));
    throw new Error("down");
  };
  const { io } = captureIo({ fetcher });
  await runCli(["status", "x", "--port", "9999"], io);
  assert.ok(seen.every((u) => u.includes("9999")));
  assert.ok(!seen.some((u) => u.includes(String(HOST_PORT))));
});

test("every host request carries the x-dshpkg-token matching the api-token file", async (t) => {
  await makeEnv(t);
  const seen = [];
  const posts = [];
  const fetcher = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} });
    if (String(url).endsWith("/dshpkg/status")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, managed: [] }) };
    }
    if (init.method === "POST") {
      posts.push({ url: String(url), body: init.body ? JSON.parse(init.body) : {} });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { io, logs } = captureIo({ fetcher });
  const code = await runCli(["disable", "dsh-plugin-x"], io);
  assert.equal(code, 0);
  // token generated lazily under the isolated DSH_PKG_HOME
  const token = (await readFile(statePath("api-token"), "utf8")).trim();
  assert.ok(token.length >= 32, "a 32-byte hex token was written");
  // the probe (GET) and the write (POST) both carried the token
  assert.ok(seen.length >= 2, "probe + POST both hit the host");
  for (const call of seen) {
    assert.equal(call.headers["x-dshpkg-token"], token);
  }
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { name: "dsh-plugin-x" });
});

// -------------------------------------------------------- dsh launcher

test("defaultDshRun spawns node with the resolved launcher script", (t) => {
  // The real dsh binary on Windows is a .cmd shim; the CLI must route
  // through `node <launcherBin>` instead of spawning "dsh" directly.
  const fakeLauncher = join(tmpdir(), "dshpkg-fake-launcher-bin.js");
  process.env.DSH_LAUNCHER = fakeLauncher;
  delete process.env.DSH_BIN;
  t.after(() => {
    delete process.env.DSH_LAUNCHER;
  });
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = defaultDshRun(["--version"], { spawnImpl });
  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [fakeLauncher, "--version"]);
  assert.equal(calls[0].options.encoding, "utf8");
  assert.equal(calls[0].options.shell, undefined); // never shell:true
});

test("helpText lists every documented command", () => {
  const text = helpText();
  for (const cmd of [
    "search", "install", "remove", "update", "upgrade", "hold", "unhold",
    "enable", "disable", "status", "list", "info", "why", "doctor", "audit",
    "fix-broken", "log", "run", "repo", "sync",
  ]) {
    assert.ok(text.includes(cmd), `help must mention ${cmd}`);
  }
});
