// dshpkg — recipe repository unit tests.
// Every test runs against a fresh fs.mkdtemp dir selected via DSH_PKG_HOME
// and a fake git runner; no network, no real profile access.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { repoAdd, repoRemove, repoList, syncRepos, loadAllRecipes, repoInit, autoPoll, autoPollDue } from "../lib/repo.js";
import { readState, writeState, readIncidents, statePath } from "../lib/state.js";
import { SOURCES } from "../lib/indexer.js";

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

test("repoAdd rejects a repo url starting with a dash (git option injection)", async () => {
  // A dash-prefixed url with no other forbidden chars reaches the leading-dash
  // guard (a spacey "-u https://…" would already trip the whitespace guard).
  await assert.rejects(() => repoAdd("--upload-pack=evil", "evil"), /不能以 - 开头/);
  await assert.rejects(() => repoAdd("-u", "evil"), /不能以 - 开头/);
});

test("repoAdd rejects names that are not package-like (traversal, separators, leading dot/dash)", async () => {
  for (const bad of ["..", "../x", "a/b", "a\\b", ".hidden", "-flag", "a:b"]) {
    await assert.rejects(
      () => repoAdd("https://example.com/ok.git", bad),
      /仓库名称不合法/,
      bad,
    );
  }
  // Derived names follow the same whitelist rule.
  await assert.rejects(() => repoAdd("https://example.com/-evil.git"), /仓库名称不合法/);
  await assert.rejects(() => repoAdd("https://example.com/.hidden.git"), /仓库名称不合法/);
});

test("repoRemove removes by name; unknown name throws", async () => {
  await repoAdd("https://example.com/a.git", "one");
  await repoAdd("https://example.com/b.git", "two");
  await repoRemove("one");
  const list = await repoList();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "two");
  await assert.rejects(() => repoRemove("nope"), /不存在/);
  // The name whitelist applies on remove too (alignment with repoAdd).
  await assert.rejects(() => repoRemove("../x"), /仓库名称不合法/);
  await assert.rejects(() => repoRemove("a/b"), /仓库名称不合法/);
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
  // the "--" separator guarantees url/dest can never parse as git options
  assert.equal(runner.calls[0].args[3], "--");
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

test("syncRepos copies pubkeys/*.pub into the shared cache (P3-1)", async () => {
  await repoAdd("https://example.com/pk.git", "pk");
  const runner = fakeRunner({
    pk: {
      "index.json": { recipes: [] },
      "pubkeys/0102030405060708.pub":
        "untrusted comment: test key\nRWRBQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=\n",
    },
  });
  const outcomes = await syncRepos({ runner: runner.run });
  assert.equal(outcomes[0].status, "ok");
  const cached = await readFile(
    join(home, "pubkeys", "0102030405060708.pub"),
    "utf8",
  );
  assert.ok(cached.includes("RWR"), "pubkey cached verbatim");
});

test("syncRepos tolerates repos without a pubkeys/ directory", async () => {
  await repoAdd("https://example.com/plain.git", "plain");
  const runner = fakeRunner({ plain: { "index.json": { recipes: [] } } });
  const outcomes = await syncRepos({ runner: runner.run });
  assert.equal(outcomes[0].status, "ok");
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

test("syncRepos re-validates tampered repos.json entries (name/url) per-repo", async () => {
  await repoAdd("https://example.com/good.git", "good");
  await repoAdd("https://example.com/evil.git", "evil");
  // On-disk tamper that bypassed repoAdd(): a traversal name and a url that
  // git would parse as an option. The re-validation must reject both.
  const config = await readReposFile();
  config.repos[1].name = "../evil";
  config.repos[1].url = "-u malicious";
  await writeFile(join(home, "repos.json"), JSON.stringify(config));

  const runner = fakeRunner({ good: { "index.json": { recipes: [] } } });
  const outcomes = await syncRepos({ runner: runner.run });

  assert.equal(outcomes.length, 2);
  const evil = outcomes.find((o) => o.name === "../evil");
  assert.equal(evil.status, "error");
  assert.ok(evil.error.includes("仓库名称不合法"), evil.error);
  assert.equal(outcomes.find((o) => o.name === "good").status, "ok");
  // The evil entry never reached git: only the good repo was cloned.
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0].args.at(-1).endsWith("good"));
});

// ---------- static index sources (R2, design §2) ----------

/** Fake HTTP fetcher: url -> payload object (or a function returning it).
 * Supports both json() and text() consumers (indexer + repo index sources). */
function fakeFetcher(routes = {}) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    const route = routes[String(url)];
    if (route === undefined) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    }
    if (typeof route === "function") return route();
    return {
      ok: true,
      status: 200,
      json: async () => (typeof route === "string" ? { items: [] } : route),
      text: async () => (typeof route === "string" ? route : JSON.stringify(route)),
    };
  };
  return { fetcher, calls };
}

test("repoAdd rejects an unknown format", async () => {
  await assert.rejects(
    () => repoAdd("https://example.com/x.json", "x", "zip"),
    /仓库格式/,
  );
});

test("repoAdd persists the index format on the entry", async () => {
  const entry = await repoAdd("https://example.com/awesome.json", "awesome", "index");
  assert.equal(entry.format, "index");
  const config = await readReposFile();
  assert.equal(config.repos[0].format, "index");
});

test("syncRepos fetches and caches a static index source", async () => {
  await repoAdd("https://example.com/awesome.json", "awesome", "index");
  const { fetcher, calls } = fakeFetcher({
    "https://example.com/awesome.json": {
      format: "dshpkg-index/v1",
      plugins: [makeRecipe("alpha", "alpha@1.0.0")],
    },
  });
  const outcomes = await syncRepos({ fetcher });
  assert.deepEqual(outcomes, [{ name: "awesome", status: "ok", format: "index" }]);
  assert.equal(calls.length, 1);
  const cached = JSON.parse(
    await readFile(join(home, "sources", "awesome", "index.json"), "utf8"),
  );
  assert.equal(cached.plugins.length, 1);
});

test("syncRepos reports a broken/offline index source per-repo", async () => {
  await repoAdd("https://example.com/down.json", "down", "index");
  const { fetcher } = fakeFetcher({}); // 404 for everything
  const outcomes = await syncRepos({ fetcher });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "error");
  assert.ok(outcomes[0].error.includes("HTTP 404"), outcomes[0].error);
});

test("syncRepos rejects a wrong-shaped index payload per-repo", async () => {
  await repoAdd("https://example.com/bad.json", "bad", "index");
  const { fetcher } = fakeFetcher({
    "https://example.com/bad.json": { format: "other/v2", plugins: [] },
  });
  const outcomes = await syncRepos({ fetcher });
  assert.equal(outcomes[0].status, "error");
  assert.ok(outcomes[0].error.includes("未知的索引格式"), outcomes[0].error);
});

test("loadAllRecipes reads recipes from a cached static index", async () => {
  await repoAdd("https://example.com/awesome.json", "awesome", "index");
  await mkdir(join(home, "sources", "awesome"), { recursive: true });
  await writeFile(
    join(home, "sources", "awesome", "index.json"),
    JSON.stringify({
      format: "dshpkg-index/v1",
      plugins: [makeRecipe("alpha", "alpha@1.0.0"), { kind: "nope" }], // invalid skipped
    }),
  );
  const recipes = await loadAllRecipes();
  assert.deepEqual(recipes.map((r) => r.recipe.name), ["alpha"]);
  assert.equal(recipes[0].origin, "awesome");
});

// ---------- repoInit (R5, design §3) ----------

test("repoInit adds the default repos on first use (env-overridable)", async () => {
  const prev = process.env.DSH_DEFAULT_REPOS;
  process.env.DSH_DEFAULT_REPOS = JSON.stringify([
    { url: "https://example.com/community.git", name: "community", format: "git" },
    { url: "https://example.com/idx.json", name: "idx", format: "index" },
  ]);
  try {
    const result = await repoInit();
    assert.deepEqual(result, { added: 2, skipped: false });
    const config = await readReposFile();
    assert.equal(config.repos.length, 2);
    assert.equal(config.repos[1].format, "index");
    // idempotent: a second init skips
    const again = await repoInit();
    assert.deepEqual(again, { added: 0, skipped: true });
  } finally {
    if (prev === undefined) delete process.env.DSH_DEFAULT_REPOS;
    else process.env.DSH_DEFAULT_REPOS = prev;
  }
});

test("repoInit with noDefault writes nothing", async () => {
  const result = await repoInit({ noDefault: true });
  assert.deepEqual(result, { added: 0, skipped: true });
  assert.equal(existsSync(join(home, "repos.json")), false);
});

// ---------- autoPoll (P2-4, design §4) ----------

/** Make the repos.json lastSyncAt 25h old (overdue for the 24h interval). */
async function makeOverdue() {
  const cfg = await readReposFile();
  await writeFile(
    join(home, "repos.json"),
    JSON.stringify({
      ...cfg,
      lastSyncAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    }),
  );
}

/** All three index sources answer empty (keeps refreshIndex offline-green). */
function emptyIndexFetcher() {
  return fakeFetcher({
    [SOURCES.github]: { items: [] },
    [SOURCES.npm]: { objects: [] },
    [SOURCES.awesome]: "# none\n",
  });
}

test("autoPollDue respects repo emptiness, freshness, backoff, disable and suspend", async () => {
  assert.deepEqual(await autoPollDue(), { due: false, reason: "no-repos" });
  await repoAdd("https://example.com/a.git", "a");
  const runner = fakeRunner({ a: { "index.json": { recipes: [] } } });
  await syncRepos({ runner: runner.run }); // lastSyncAt = now -> fresh
  assert.equal((await autoPollDue()).reason, "fresh");

  // Backoff semantics: 1h base interval, lastSyncAt 1.5h ago.
  const cfg = await readReposFile();
  const lastSync1hAgo = JSON.stringify({
    ...cfg,
    lastSyncAt: new Date(Date.now() - 90 * 60_000).toISOString(),
  });
  await writeFile(join(home, "repos.json"), lastSync1hAgo);
  await writeState({ pollIntervalMs: 3600_000, pollFailures: 0 });
  assert.equal((await autoPollDue()).reason, "overdue"); // 1.5h > 1h base
  await writeState({ pollIntervalMs: 3600_000, pollFailures: 1 });
  assert.equal((await autoPollDue()).reason, "fresh"); // 1.5h < 2h backoff

  // The 24h cap bounds the backoff: 25h-old data is overdue even with 10
  // recorded failures (uncapped it would be a 1024h window).
  await writeFile(
    join(home, "repos.json"),
    JSON.stringify({
      ...cfg,
      lastSyncAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    }),
  );
  await writeState({ pollIntervalMs: 3600_000, pollFailures: 10 });
  assert.equal((await autoPollDue()).reason, "overdue");

  await writeState({ pollFailures: 0, pollIntervalMs: 0 });
  assert.deepEqual(await autoPollDue(), { due: false, reason: "disabled" });
  await writeState({
    pollFailures: 0,
    pollIntervalMs: undefined,
    pollSuspendedAt: new Date().toISOString(),
  });
  assert.deepEqual(await autoPollDue(), { due: false, reason: "suspended" });
});

test("autoPoll runs an overdue sync, refreshes lastSyncAt and resets failures", async () => {
  await repoAdd("https://example.com/a.git", "a");
  await makeOverdue();
  await writeState({ pollFailures: 2 });

  const runner = fakeRunner({ a: { "index.json": { recipes: [] } } });
  const { fetcher, calls } = emptyIndexFetcher();
  const result = await autoPoll({ fetcher, runner: runner.run });
  assert.equal(result.ran, true);
  assert.equal(result.ok, true);
  // git clone ran and the index sources were fetched (locked, exclusive)
  assert.equal(runner.calls.length, 1);
  assert.equal(calls.length, 3);
  // success resets the failure counter and refreshes freshness
  assert.equal((await readState()).pollFailures, 0);
  assert.equal((await autoPollDue()).reason, "fresh");
  // the lock was released
  assert.equal(existsSync(statePath("sync.lock")), false);
});

test("autoPoll backs off, suspends after three failures and records incidents", async () => {
  await repoAdd("https://example.com/a.git", "a");
  await makeOverdue();
  await writeState({ pollFailures: 0 });

  const broken = fakeFetcher({}); // every network call 404s
  for (let i = 0; i < 3; i += 1) {
    // Push lastSyncAt to the epoch between attempts: the growing backoff
    // window would otherwise make the retry look "fresh".
    const cfg = await readReposFile();
    await writeFile(
      join(home, "repos.json"),
      JSON.stringify({ ...cfg, lastSyncAt: "1970-01-01T00:00:00.000Z" }),
    );
    const result = await autoPoll({ fetcher: broken.fetcher });
    assert.equal(result.ran, true, `attempt ${i + 1}`);
    assert.equal(result.ok, false);
  }
  const state = await readState();
  assert.equal(state.pollFailures, 3);
  assert.ok(state.pollSuspendedAt, "polling suspends after 3 failures");
  assert.deepEqual(await autoPollDue(), { due: false, reason: "suspended" });
  // one poll-failed incident per failure
  const incidents = await readIncidents(10);
  assert.equal(incidents.filter((i) => i.type === "poll-failed").length, 3);
});

test("autoPoll skips when the lock is held by another caller", async () => {
  await repoAdd("https://example.com/a.git", "a");
  await makeOverdue();
  const { acquireSyncLock } = await import("../lib/state.js");
  await acquireSyncLock();
  try {
    const result = await autoPoll({ fetcher: emptyIndexFetcher().fetcher });
    assert.deepEqual(result, { ran: false, ok: null, reason: "locked" });
  } finally {
    const { releaseSyncLock } = await import("../lib/state.js");
    await releaseSyncLock();
  }
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
