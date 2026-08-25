// Tests for AUR-style source installs (transaction.js + gitcache.js):
// git cache clone + link: install, #path: subdirectory selection, build
// command execution, pnpm allowBuilds auto-handling and SSH network hints.
// Fully offline: DSH_HOME and DSH_PKG_HOME point at temp dirs, all runners
// (dsh / git / execBuild) are fakes, no real profile or process is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  install,
  splitCommand,
  defaultExecBuild,
  hasAllowBuildsHint,
  extractAllowBuildsKeys,
  mergeAllowBuildsKeys,
} from "../lib/transaction.js";

/** Point the given env vars at values for one test, then restore them. */
function useEnv(t, vars) {
  const prev = new Map();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined,
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
 * Fresh temp DSH_HOME (profiles/web) + DSH_PKG_HOME (state root, git cache).
 * Returns {home, root, profileDir}.
 */
async function makeEnv(t) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-src-home-"));
  const root = await mkdtemp(join(tmpdir(), "dshpkg-src-state-"));
  useEnv(t, { DSH_HOME: home, DSH_PKG_HOME: root });
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "web-profile", version: "1.0.0", dsh: { profile: true }, dependencies: {} }),
  );
  return { home, root, profileDir };
}

/** Fake dsh runner: records calls, status from the script, optional output. */
function fakeDsh(script = () => 0) {
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    const out = script(args);
    if (out && typeof out === "object") return out; // {status, stdout?, stderr?}
    return { status: out ?? 0 };
  };
  return { calls, runner };
}

/**
 * Fake git runner: "clone" materializes the cache dir (with .git marker and
 * the given files); fetch/reset succeed silently. All calls recorded.
 */
function fakeGit({ files = {}, failWith = null } = {}) {
  const calls = [];
  const run = async (args, opts = {}) => {
    calls.push({ args, opts });
    if (args[0] === "clone") {
      if (failWith) return { status: 128, stdout: "", stderr: failWith, error: null };
      const dest = args[args.length - 1];
      await mkdir(join(dest, ".git"), { recursive: true });
      for (const [rel, data] of Object.entries(files)) {
        const file = join(dest, rel);
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, typeof data === "string" ? data : JSON.stringify(data));
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    return { status: 0, stdout: "", stderr: "", error: null };
  };
  return { run, calls };
}

// ----------------------------------------------------------- git cache + link

test("git specs are cloned into the cache and installed via link:", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh();
  const git = fakeGit({ files: { "package.json": { name: "dsh-plugin-src" } } });
  const res = await install("github:owner/repo", {
    runner: dsh.runner,
    gitRunner: git.run,
  });

  assert.deepEqual(res, { ok: true, installed: ["dsh-plugin-src"] });

  // the clone ran once, with --depth 1
  const cacheDir = join(process.env.DSH_PKG_HOME, "cache", "git", "github.com-owner-repo");
  assert.equal(git.calls.length, 1);
  assert.deepEqual(git.calls[0].args, ["clone", "--depth", "1", "https://github.com/owner/repo.git", cacheDir]);

  // the add step linked the pulled source, not the original git url
  const add = dsh.calls.find((c) => c[0] === "plugin" && c[3] === "add");
  assert.equal(add[4], `link:${cacheDir}`);
});

test("git specs installed from the cache take the fetch+reset fast path", async (t) => {
  await makeEnv(t);
  const cacheDir = join(process.env.DSH_PKG_HOME, "cache", "git", "github.com-owner-repo");
  await mkdir(join(cacheDir, ".git"), { recursive: true }); // pre-existing cache

  const dsh = fakeDsh();
  const git = fakeGit();
  const res = await install("github:owner/repo", { runner: dsh.runner, gitRunner: git.run });

  assert.equal(res.ok, true);
  const kinds = git.calls.map((c) => c.args[0]);
  assert.deepEqual(kinds, ["fetch", "reset"]);
  assert.deepEqual(git.calls[0].args, ["fetch", "--depth", "1", "origin"]);
  assert.equal(git.calls[0].opts.cwd, cacheDir);
  assert.deepEqual(git.calls[1].args, ["reset", "--hard", "origin/HEAD"]);
  assert.equal(dsh.calls.find((c) => c[0] === "plugin")[4], `link:${cacheDir}`);
});

test("git+https specs strip the prefix and install from the cache", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh();
  const git = fakeGit();
  const res = await install("git+https://github.com/owner/repo.git", {
    runner: dsh.runner,
    gitRunner: git.run,
  });
  assert.equal(res.ok, true);
  assert.equal(git.calls[0].args[0], "clone");
  assert.equal(git.calls[0].args[3], "https://github.com/owner/repo.git");
  const cacheDir = join(process.env.DSH_PKG_HOME, "cache", "git", "github.com-owner-repo");
  assert.equal(dsh.calls.find((c) => c[0] === "plugin")[4], `link:${cacheDir}`);
});

test("#path: subdirectory becomes the link target (monorepo)", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh();
  const git = fakeGit({ files: { "packages/core/package.json": { name: "core" } } });
  const res = await install("github:owner/mono#path:packages/core", {
    runner: dsh.runner,
    gitRunner: git.run,
  });
  assert.equal(res.ok, true);
  const cacheDir = join(process.env.DSH_PKG_HOME, "cache", "git", "github.com-owner-mono");
  assert.equal(dsh.calls.find((c) => c[0] === "plugin")[4], `link:${join(cacheDir, "packages", "core")}`);
});

test("a missing #path: subdirectory fails with a Chinese error before any install", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh();
  const git = fakeGit({ files: { "package.json": { name: "mono" } } }); // no packages/core
  const res = await install("github:owner/mono#path:packages/core", {
    runner: dsh.runner,
    gitRunner: git.run,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /子目录不存在/);
  assert.match(res.error, /packages\/core/);
  assert.equal(dsh.calls.filter((c) => c[0] === "plugin").length, 0);
});

test("unsupported refs (#branch) pass through to pnpm unchanged", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh();
  const git = fakeGit();
  const res = await install("github:owner/repo#main", { runner: dsh.runner, gitRunner: git.run });
  assert.equal(res.ok, true);
  assert.equal(git.calls.length, 0); // no cache involvement
  assert.equal(dsh.calls.find((c) => c[0] === "plugin")[4], "github:owner/repo#main");
});

test("git specs in dryRun print the plan and invoke no runner", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh();
  const git = fakeGit();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  t.after(() => {
    console.log = orig;
  });
  const res = await install("github:owner/repo", {
    dryRun: true,
    runner: dsh.runner,
    gitRunner: git.run,
  });
  console.log = orig;
  assert.deepEqual(res, { ok: true, installed: ["dsh-plugin-src"] });
  assert.equal(dsh.calls.length, 0);
  assert.equal(git.calls.length, 0);
  assert.ok(logs.some((l) => l.includes("git 缓存")));
  assert.ok(logs.some((l) => l.includes("link:")));
});

// ------------------------------------------------------------------- build

/** Materialize the installed package dir (real dir, resolved via realpath). */
async function materializeInstalledPkg(profileDir, name) {
  const target = join(profileDir, "node_modules", name);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), JSON.stringify({ name }));
  return target;
}

test("build commands run in the realpath-resolved installed package dir", async (t) => {
  const { profileDir } = await makeEnv(t);
  const target = await materializeInstalledPkg(profileDir, "dsh-plugin-src");
  const dsh = fakeDsh();
  const git = fakeGit({ files: { "package.json": { name: "dsh-plugin-src" } } });
  const buildCalls = [];
  const execBuild = (call) => {
    buildCalls.push(call);
    return { status: 0 };
  };

  const recipe = {
    name: "dsh-plugin-src",
    source: { type: "git", spec: "github:owner/repo" },
    build: { commands: ["npm run build", "node ./scripts/post.js"], cwd: "packages/core" },
  };
  const res = await install(recipe, { runner: dsh.runner, gitRunner: git.run, execBuild });
  assert.equal(res.ok, true);

  assert.equal(buildCalls.length, 2);
  assert.equal(buildCalls[0].command, "npm run build");
  assert.equal(buildCalls[1].command, "node ./scripts/post.js");
  // cwd = realpath(<profile>/node_modules/<name>) + build.cwd
  assert.equal(buildCalls[0].cwd, join(target, "packages", "core"));
});

test("a failing build command rolls the package back with a Chinese error", async (t) => {
  const { profileDir } = await makeEnv(t);
  await materializeInstalledPkg(profileDir, "dsh-plugin-src");
  const dsh = fakeDsh((args) => (args[3] === "remove" ? 0 : 0));
  const git = fakeGit();
  const buildCalls = [];
  const execBuild = (call) => {
    buildCalls.push(call);
    return { status: call.command.startsWith("node ./scripts") ? 1 : 0 };
  };

  const recipe = {
    name: "dsh-plugin-src",
    source: { type: "git", spec: "github:owner/repo" },
    build: { commands: ["npm run build", "node ./scripts/post.js"] },
  };
  const res = await install(recipe, { runner: dsh.runner, gitRunner: git.run, execBuild });
  assert.equal(res.ok, false);
  assert.match(res.error, /构建失败/);
  assert.match(res.error, /node \.\/scripts\/post\.js/);
  assert.equal(res.rolledBack, true);
  assert.equal(buildCalls.length, 2); // second command failed after the first ran
  const removes = dsh.calls.filter((c) => c[0] === "plugin" && c[3] === "remove");
  assert.deepEqual(removes.map((c) => c[4]), ["dsh-plugin-src"]);
});

test("recipes without a build field never invoke execBuild", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh();
  const git = fakeGit();
  let buildCalls = 0;
  const execBuild = () => {
    buildCalls += 1;
    return { status: 0 };
  };
  const res = await install("github:owner/repo", {
    runner: dsh.runner,
    gitRunner: git.run,
    execBuild,
  });
  assert.equal(res.ok, true);
  assert.equal(buildCalls, 0);
});

test("splitCommand tokenizes simple commands; empty input is null", () => {
  assert.deepEqual(splitCommand("npm run build"), ["npm", "run", "build"]);
  assert.deepEqual(splitCommand("node ./scripts/post.js"), ["node", "./scripts/post.js"]);
  assert.deepEqual(splitCommand("  make  -j4  "), ["make", "-j4"]);
  assert.equal(splitCommand("   "), null);
  assert.equal(splitCommand(""), null);
});

test("defaultExecBuild spawns without a shell and passes the cwd", () => {
  const spawned = [];
  const spawnImpl = (cmd, args, options) => {
    spawned.push({ cmd, args, options });
    return { status: 0 };
  };
  const res = defaultExecBuild({
    command: "npm run build",
    cwd: "C:\\fake\\pkg",
    spawnImpl,
  });
  assert.equal(res.status, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "npm");
  assert.deepEqual(spawned[0].args, ["run", "build"]);
  assert.equal(spawned[0].options.cwd, "C:\\fake\\pkg");
  assert.equal(spawned[0].options.shell, false);

  // an empty command is a no-op that never spawns
  const noop = defaultExecBuild({ command: "  ", cwd: "C:\\fake\\pkg", spawnImpl });
  assert.equal(noop.status, 0);
  assert.equal(spawned.length, 1);
});

// -------------------------------------------------------- allowBuilds handling

test("allowBuilds rejection auto-writes pnpm-workspace.yaml and retries once", async (t) => {
  const { profileDir } = await makeEnv(t);
  let addCount = 0;
  const dsh = fakeDsh((args) => {
    if (args[0] === "plugin" && args[3] === "add") {
      addCount += 1;
      if (addCount === 1) {
        return {
          status: 1,
          stdout: "",
          stderr: "ERR_PNPM_BUILD_SCRIPTS_NOT_ALLOWED dsh-plugin-x is not in the allowBuilds list of pnpm-workspace.yaml",
        };
      }
      return { status: 0 };
    }
    return 0;
  });
  const res = await install("dsh-plugin-x", { runner: dsh.runner });
  assert.equal(res.ok, true);
  assert.equal(addCount, 2); // the retry happened

  const ws = await readFile(join(profileDir, "pnpm-workspace.yaml"), "utf8");
  assert.match(ws, /allowBuilds/);
  assert.match(ws, /dsh-plugin-x/);
});

test("allowBuilds merge keeps existing content, comments and deduplicates keys", async (t) => {
  const { profileDir } = await makeEnv(t);
  await writeFile(
    join(profileDir, "pnpm-workspace.yaml"),
    [
      "# 保留这条注释",
      "packages:",
      "  - packages/*",
      "allowBuilds:",
      "  - dsh-plugin-x",
      "",
    ].join("\n"),
    "utf8",
  );
  let addCount = 0;
  const dsh = fakeDsh((args) => {
    if (args[0] === "plugin" && args[3] === "add") {
      addCount += 1;
      if (addCount === 1) {
        return {
          status: 1,
          stderr: "dsh-plugin-y is not in the allowBuilds list of pnpm-workspace.yaml",
        };
      }
      return { status: 0 };
    }
    return 0;
  });
  const res = await install("dsh-plugin-y", { runner: dsh.runner });
  assert.equal(res.ok, true);

  const ws = await readFile(join(profileDir, "pnpm-workspace.yaml"), "utf8");
  assert.ok(ws.includes("# 保留这条注释"), "comments preserved");
  assert.ok(ws.includes("packages:"));
  const items = [...ws.matchAll(/^\s*-\s*([@A-Za-z0-9._/-]+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(items, ["dsh-plugin-x", "dsh-plugin-y"]); // deduplicated merge
});

test("allowBuilds retry that fails again returns a Chinese error with the hint", async (t) => {
  const { profileDir } = await makeEnv(t);
  const dsh = fakeDsh((args) => {
    if (args[0] === "plugin" && args[3] === "add") {
      return {
        status: 1,
        stderr: "ERR_PNPM dsh-plugin-x is not in the allowBuilds list of pnpm-workspace.yaml",
      };
    }
    return 0;
  });
  const res = await install("dsh-plugin-x", { runner: dsh.runner });
  assert.equal(res.ok, false);
  assert.match(res.error, /allowBuilds/);
  assert.match(res.error, /重试一次/);
  const ws = await readFile(join(profileDir, "pnpm-workspace.yaml"), "utf8");
  assert.match(ws, /dsh-plugin-x/); // still written before the failed retry
});

test("hasAllowBuildsHint requires both markers", () => {
  assert.equal(hasAllowBuildsHint("x is not in the allowBuilds list of pnpm-workspace.yaml"), true);
  assert.equal(hasAllowBuildsHint("allowBuilds alone"), false);
  assert.equal(hasAllowBuildsHint("pnpm-workspace.yaml alone"), false);
  assert.equal(hasAllowBuildsHint(""), false);
  assert.equal(hasAllowBuildsHint(null), false);
});

test("extractAllowBuildsKeys pulls keys from inline lists, blocks and lines", () => {
  // inline list form
  assert.deepEqual(
    extractAllowBuildsKeys("missing from allowBuilds: [core-js, esbuild] in pnpm-workspace.yaml"),
    ["core-js", "esbuild"],
  );
  // yaml block form
  assert.deepEqual(
    extractAllowBuildsKeys("ignored:\nallowBuilds:\n  - @scope/pkg\n  - other\n"),
    ["@scope/pkg", "other"],
  );
  // plain message line, ERR_PNPM error code is skipped
  assert.deepEqual(
    extractAllowBuildsKeys("ERR_PNPM_BUILD_SCRIPTS_NOT_ALLOWED dsh-plugin-x is not in the allowBuilds list of pnpm-workspace.yaml"),
    ["dsh-plugin-x"],
  );
  // fallback to the package name when nothing is extractable
  assert.deepEqual(extractAllowBuildsKeys("allowBuilds check failed, see pnpm-workspace.yaml", "fallback-name"), [
    "fallback-name",
  ]);
  assert.deepEqual(extractAllowBuildsKeys("no hint at all", "fallback-name"), []);
});

test("mergeAllowBuildsKeys creates the minimal structure for a missing file", () => {
  assert.equal(mergeAllowBuildsKeys("", ["dsh-plugin-x"]), "allowBuilds:\n  - dsh-plugin-x\n");
  assert.equal(mergeAllowBuildsKeys(null, ["a", "a", "b"]), "allowBuilds:\n  - a\n  - b\n");
});

test("mergeAllowBuildsKeys converts an inline allowBuilds list to block form", () => {
  const text = "allowBuilds: [core-js]\nother: 1\n";
  const out = mergeAllowBuildsKeys(text, ["esbuild"]);
  assert.equal(out, "allowBuilds:\n  - core-js\n  - esbuild\nother: 1\n");
});

test("mergeAllowBuildsKeys is a no-op when the key already exists", () => {
  const text = "# 注释\nallowBuilds:\n  - dsh-plugin-x\n";
  assert.equal(mergeAllowBuildsKeys(text, ["dsh-plugin-x"]), text);
});

test("mergeAllowBuildsKeys appends to a file without an allowBuilds section", () => {
  const out = mergeAllowBuildsKeys("packages:\n  - packages/*\n", ["dsh-plugin-x"]);
  assert.ok(out.startsWith("packages:\n  - packages/*\n"), "existing lines kept");
  assert.ok(out.includes("allowBuilds:\n  - dsh-plugin-x"));
});

// ------------------------------------------------------------- SSH network hint

test("a GitHub connection failure during add reports the SSH switching hint", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh((args) => {
    if (args[0] === "plugin" && args[3] === "add") {
      return { status: 1, stderr: "ssh: Could not connect to github.com: Connection refused" };
    }
    return 0;
  });
  const git = fakeGit({ files: { "package.json": { name: "dsh-plugin-src" } } });
  const res = await install("github:owner/repo", { runner: dsh.runner, gitRunner: git.run });
  assert.equal(res.ok, false);
  assert.match(res.error, /网络无法直连 GitHub/);
  assert.match(res.error, /insteadOf/);
});

test("a failed clone with a connection error reports the SSH hint too", async (t) => {
  await makeEnv(t);
  const dsh = fakeDsh();
  const git = fakeGit({ failWith: "fatal: Failed to connect to github.com port 443" });
  const res = await install("github:owner/repo", { runner: dsh.runner, gitRunner: git.run });
  assert.equal(res.ok, false);
  assert.match(res.error, /git 仓库拉取失败/);
  assert.match(res.error, /网络无法直连 GitHub/);
  assert.match(res.error, /insteadOf/);
  assert.equal(res.rolledBack, false);
  assert.equal(dsh.calls.filter((c) => c[0] === "plugin").length, 0);
});
