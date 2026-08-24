// dshpkg — recipe repository unit tests.
// Every test runs against a fresh fs.mkdtemp dir selected via DSH_PKG_HOME
// and a fake git runner; no network, no real profile access.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { repoAdd, repoRemove, repoList, syncRepos, loadAllRecipes } from "../lib/repo.js";

let home;

beforeEach(async () => {
  // Fresh temp dir per test. DSH_PKG_HOME selects the state root. We chdir
  // into the temp dir and use a relative state root so that state.js's
  // writeJsonAtomic tmp-file name stays free of drive-letter colons
  // (its tmp name is derived from the full path; an absolute Windows path
  // would yield "C:" inside the name and break the atomic rename).
  home = await mkdtemp(join(tmpdir(), "dshpkg-recipe-"));
  process.chdir(home);
  process.env.DSH_PKG_HOME = ".";
});

/**
 * Fake git runner. contents: repoName -> { "index.json": object,
 * "recipes/<name>.json": object|string }. "clone" materializes the files
 * (like a checkout); "fetch"/"reset" succeed silently. All calls recorded.
 */
function fakeRunner(contents = {}) {
  const calls = [];
  const run = async (args, opts = {}) => {
    calls.push({ args, opts });
    if (args[0] === "clone") {
      const dest = args[args.length - 1];
      const content = contents[basename(dest)];
      if (!content) {
        return { status: 1, stdout: "", stderr: `remote ${basename(dest)} 不存在`, error: null };
      }
      await mkdir(join(dest, ".git"), { recursive: true });
      for (const [rel, data] of Object.entries(content)) {
        const file = join(dest, rel);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, typeof data === "string" ? data : JSON.stringify(data));
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    return { status: 0, stdout: "", stderr: "", error: null };
  };
  return { run, calls };
}

function makeRecipe(name, sourceSpec) {
  return { name, kind: "host-only", source: { type: "npm", spec: sourceSpec } };
}

// ---------- repoAdd / repoRemove / repoList ----------

test("repoAdd derives the name from the url and persists", async () => {
  const entry = await repoAdd("https://github.com/owner/dsh-recipes.git");
  assert.equal(entry.name, "dsh-recipes");
  assert.equal(entry.url, "https://github.com/owner/dsh-recipes.git");
  assert.equal(entry.enabled, true);

  const list = await repoList();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "dsh-recipes");
});

test("repoAdd accepts an explicit name", async () => {
  const entry = await repoAdd("git@github.com:owner/x.git", "my-mirror");
  assert.equal(entry.name, "my-mirror");
  const list = await repoList();
  assert.equal(list[0].name, "my-mirror");
});

test("repoAdd rejects duplicate names", async () => {
  await repoAdd("https://example.com/a.git", "dup");
  await assert.rejects(
    () => repoAdd("https://example.com/b.git", "dup"),
    /已存在/,
  );
});

test("repoAdd rejects urls/names with spaces or quotes", async () => {
  await assert.rejects(() => repoAdd("https://example.com/a b.git"), /空格/);
  await assert.rejects(() => repoAdd('https://example.com/a"b.git'), /特殊字符/);
  await assert.rejects(() => repoAdd("https://example.com/ok.git", "bad name"), /空格/);
  await assert.rejects(() => repoAdd("https://example.com/ok.git", "bad'quote"), /特殊字符/);
  await assert.rejects(() => repoAdd(""), /不能为空/);
  await assert.rejects(() => repoAdd("https://example.com/ok.git", ""), /不能为空/);
});

test("repoRemove removes by name; unknown name throws", async () => {
  await repoAdd("https://example.com/a.git", "one");
  await repoAdd("https://example.com/b.git", "two");
  await repoRemove("one");
  const list = await repoList();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "two");
  await assert.rejects(() => repoRemove("nope"), /不存在/);
});

// ---------- syncRepos ----------

test("syncRepos clones enabled repos and skips disabled ones", async () => {
  await repoAdd("https://example.com/high.git", "high");
  await repoAdd("https://example.com/disabled.git", "off");
  const config = await readReposFile();
  config.repos[1].enabled = false;
  await writeFile(join(home, "repos.json"), JSON.stringify(config));

  const runner = fakeRunner({
    high: { "index.json": { recipes: ["alpha"] }, "recipes/alpha.json": makeRecipe("alpha", "alpha@1.0.0") },
    off: { "index.json": { recipes: ["beta"] }, "recipes/beta.json": makeRecipe("beta", "beta@1.0.0") },
  });
  const outcomes = await syncRepos({ runner: runner.run });

  assert.deepEqual(outcomes, [{ name: "high", status: "ok" }]);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].args[0], "clone");
  assert.equal(runner.calls[0].args[1], "--depth");
  // clone dest is <stateRoot>/recipes/<name> (state root is the temp dir)
  assert.equal(resolve(runner.calls[0].args.at(-1)), join(home, "recipes", "high"));
  // checkout materialized on disk
  const index = JSON.parse(await readFile(join(home, "recipes", "high", "index.json"), "utf8"));
  assert.deepEqual(index, { recipes: ["alpha"] });
  // lastSyncAt persisted
  const after = await readReposFile();
  assert.ok(after.lastSyncAt, "lastSyncAt should be set");
});

test("syncRepos fetches and resets existing checkouts", async () => {
  await repoAdd("https://example.com/r.git", "r");
  const runner = fakeRunner({ r: { "index.json": { recipes: [] } } });
  await syncRepos({ runner: runner.run });

  const second = fakeRunner({ r: { "index.json": { recipes: [] } } });
  const outcomes = await syncRepos({ runner: second.run });
  assert.deepEqual(outcomes, [{ name: "r", status: "ok" }]);
  const kinds = second.calls.map((c) => c.args[0]);
  assert.deepEqual(kinds, ["fetch", "reset"]);
  assert.equal(second.calls[0].args[1], "--depth");
  assert.equal(second.calls[0].args[3], "origin");
  assert.equal(resolve(second.calls[0].opts.cwd), join(home, "recipes", "r"));
  assert.deepEqual(second.calls[1].args.slice(0, 2), ["reset", "--hard"]);
  assert.equal(second.calls[1].args[2], "origin/HEAD");
});

test("syncRepos reports per-repo failures without throwing", async () => {
  await repoAdd("https://example.com/broken.git", "broken");
  await repoAdd("https://example.com/ok.git", "ok");
  const runner = fakeRunner({ ok: { "index.json": { recipes: [] } } });
  const outcomes = await syncRepos({ runner: runner.run });
  assert.equal(outcomes.length, 2);
  const broken = outcomes.find((o) => o.name === "broken");
  assert.equal(broken.status, "error");
  assert.ok(broken.error.includes("不存在"));
  assert.equal(outcomes.find((o) => o.name === "ok").status, "ok");
});

// ---------- loadAllRecipes ----------

/** Materialize a synced checkout on disk directly (no git at all). */
async function writeRepo(name, files) {
  const dir = join(home, "recipes", name);
  await mkdir(join(dir, ".git"), { recursive: true });
  for (const [rel, data] of Object.entries(files)) {
    const file = join(dir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof data === "string" ? data : JSON.stringify(data));
  }
}

test("loadAllRecipes parses index.json and recipes/*.json", async () => {
  await repoAdd("https://example.com/a.git", "a");
  await writeRepo("a", {
    "index.json": { recipes: ["alpha", "beta.json"] }, // suffix tolerated
    "recipes/alpha.json": makeRecipe("alpha", "alpha@1.0.0"),
    "recipes/beta.json": makeRecipe("beta", "beta@2.0.0"),
  });
  const recipes = await loadAllRecipes();
  assert.equal(recipes.length, 2);
  const alpha = recipes.find((r) => r.recipe.name === "alpha");
  assert.equal(alpha.origin, "a");
  assert.equal(alpha.recipe.source.spec, "alpha@1.0.0");
});

test("loadAllRecipes: earlier repo wins same-name recipes (priority = order)", async () => {
  await repoAdd("https://example.com/high.git", "high");
  await repoAdd("https://example.com/low.git", "low");
  await writeRepo("high", {
    "index.json": { recipes: ["shared", "high-only"] },
    "recipes/shared.json": makeRecipe("shared", "from-high"),
    "recipes/high-only.json": makeRecipe("high-only", "x"),
  });
  await writeRepo("low", {
    "index.json": { recipes: ["shared", "low-only"] },
    "recipes/shared.json": makeRecipe("shared", "from-low"),
    "recipes/low-only.json": makeRecipe("low-only", "x"),
  });
  const recipes = await loadAllRecipes();
  const names = recipes.map((r) => r.recipe.name).sort();
  assert.deepEqual(names, ["high-only", "low-only", "shared"]);
  const shared = recipes.find((r) => r.recipe.name === "shared");
  assert.equal(shared.origin, "high");
  assert.equal(shared.recipe.source.spec, "from-high");
  assert.equal(recipes.find((r) => r.recipe.name === "high-only").origin, "high");
  assert.equal(recipes.find((r) => r.recipe.name === "low-only").origin, "low");
});

test("loadAllRecipes falls back to directory scan without index.json", async () => {
  await repoAdd("https://example.com/a.git", "a");
  await writeRepo("a", {
    "recipes/one.json": makeRecipe("one", "one@1"),
    "recipes/README.md": "not a recipe",
  });
  const recipes = await loadAllRecipes();
  assert.deepEqual(recipes.map((r) => r.recipe.name), ["one"]);
});

test("loadAllRecipes skips invalid or missing recipe files", async () => {
  await repoAdd("https://example.com/a.git", "a");
  await writeRepo("a", {
    "index.json": { recipes: ["good", "bad", "missing"] },
    "recipes/good.json": makeRecipe("good", "good@1"),
    "recipes/bad.json": { kind: "nope" }, // no name -> invalid
  });
  const recipes = await loadAllRecipes();
  assert.deepEqual(recipes.map((r) => r.recipe.name), ["good"]);
});

test("loadAllRecipes skips disabled repos and tolerates unsynced repos", async () => {
  await repoAdd("https://example.com/off.git", "off");
  await repoAdd("https://example.com/never-synced.git", "never-synced");
  const config = await readReposFile();
  config.repos[0].enabled = false;
  await writeFile(join(home, "repos.json"), JSON.stringify(config));
  await writeRepo("off", { "index.json": { recipes: ["hidden"] }, "recipes/hidden.json": makeRecipe("hidden", "h") });
  const recipes = await loadAllRecipes();
  assert.deepEqual(recipes, []);
});

// ---------- helpers ----------

async function readReposFile() {
  return JSON.parse(await readFile(join(home, "repos.json"), "utf8"));
}
