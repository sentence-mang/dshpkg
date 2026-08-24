// dshpkg — AUR-like recipe repositories.
// A repo is a git checkout containing index.json ({ recipes: string[] })
// plus recipes/<name>.json files. syncRepos clones (first sync) or
// fetch + reset --hard origin/HEAD (later syncs) each enabled repo into
// <stateRoot>/recipes/<name>/. loadAllRecipes reads them back; priority =
// repos.json order, so for same-name recipes the earlier repo wins.
//
// git runs through an injected runner (default: spawnSync, never shell:true);
// tests inject a fake runner, so this module is network-free under test.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { statePath, readRepos, writeRepos, readJson } from "./state.js";
import { validateRecipe } from "./recipe.js";

// Characters that must never appear in repo names / urls we pass to git.
const FORBIDDEN_CHARS = /[\s"'`\\<>|;]/;

/** Reject empty or unsafe repo names / urls (user-facing Chinese error). */
function assertSafe(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}不能为空`);
  }
  if (FORBIDDEN_CHARS.test(value)) {
    throw new Error(`${label}不能包含空格、引号等特殊字符`);
  }
}

/** Derive a short repo name from a git url ("…/owner/repo.git" -> "repo"). */
function deriveNameFromUrl(url) {
  const cleaned = String(url).trim().replace(/\.git$/, "").replace(/[\\/]+$/, "");
  const match = cleaned.match(/[^/:\\]+$/);
  return match ? match[0] : "";
}

/** Default runner: spawn git synchronously, never through a shell. */
function defaultGitRunner(args, opts = {}) {
  return spawnSync("git", args, {
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    ...opts,
  });
}

function runFailed(result) {
  return Boolean(result.error) || result.status !== 0;
}

/**
 * Register a recipe repository. When name is omitted it is derived from the
 * url's last path segment. Returns the stored repos.json entry.
 */
export async function repoAdd(url, name) {
  assertSafe(url, "仓库地址");
  const resolvedName = name === undefined ? deriveNameFromUrl(url) : name;
  assertSafe(resolvedName, "仓库名称");
  const config = await readRepos();
  if (config.repos.some((repo) => repo.name === resolvedName)) {
    throw new Error(`仓库 ${resolvedName} 已存在`);
  }
  const entry = { url, name: resolvedName, enabled: true };
  config.repos.push(entry);
  await writeRepos(config);
  return entry;
}

/** Remove a repository by name (keeps the synced checkout on disk). */
export async function repoRemove(name) {
  assertSafe(name, "仓库名称");
  const config = await readRepos();
  const index = config.repos.findIndex((repo) => repo.name === name);
  if (index === -1) throw new Error(`仓库 ${name} 不存在`);
  config.repos.splice(index, 1);
  await writeRepos(config);
}

/** List registered repositories in priority order (repos.json order). */
export async function repoList() {
  const config = await readRepos();
  return config.repos;
}

/**
 * Sync one enabled repo: clone on first sync, fetch + reset --hard
 * origin/HEAD on later syncs. Failures are reported per-repo, never thrown,
 * so one broken repo does not block the others.
 */
async function syncOneRepo(repo, runner) {
  const dir = statePath("recipes", repo.name);
  try {
    if (existsSync(join(dir, ".git"))) {
      const fetch = await runner(["fetch", "--depth", "1", "origin"], { cwd: dir });
      if (runFailed(fetch)) throw new Error(fetch.stderr || "git fetch 失败");
      const reset = await runner(["reset", "--hard", "origin/HEAD"], { cwd: dir });
      if (runFailed(reset)) throw new Error(reset.stderr || "git reset 失败");
    } else {
      const clone = await runner(["clone", "--depth", "1", repo.url, dir], {});
      if (runFailed(clone)) throw new Error(clone.stderr || "git clone 失败");
    }
    return { name: repo.name, status: "ok" };
  } catch (error) {
    return { name: repo.name, status: "error", error: String(error?.message ?? error) };
  }
}

/**
 * Sync all enabled repositories (git clone or fetch + reset). The runner is
 * injectable for tests; the default spawns real git via spawnSync with
 * shell:false. Returns per-repo outcomes.
 */
export async function syncRepos({ runner = defaultGitRunner } = {}) {
  const config = await readRepos();
  const outcomes = [];
  for (const repo of config.repos) {
    if (repo.enabled === false) continue;
    outcomes.push(await syncOneRepo(repo, runner));
  }
  await writeRepos({ ...config, lastSyncAt: new Date().toISOString() });
  return outcomes;
}

/**
 * Recipe names declared by a repo: index.json ({ recipes: string[] }) when
 * present, otherwise a directory scan of recipes/*.json as a fallback.
 */
async function repoRecipeNames(repo) {
  const dir = statePath("recipes", repo.name);
  const index = await readJson(join(dir, "index.json"), null);
  if (index && Array.isArray(index.recipes)) {
    return index.recipes
      .map((name) => (typeof name === "string" ? name.replace(/\.json$/, "") : null))
      .filter(Boolean);
  }
  try {
    const files = await readdir(join(dir, "recipes"));
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Load all recipes from synced repos. Priority = repos.json order: for a
 * recipe with the same name in several repos, the first repo (highest
 * priority) wins. Invalid or unreadable recipe files are skipped.
 * Returns [{ recipe, origin }] where origin is the repo name.
 */
export async function loadAllRecipes() {
  const config = await readRepos();
  const byName = new Map();
  for (const repo of config.repos) {
    if (repo.enabled === false) continue;
    const dir = statePath("recipes", repo.name);
    const names = await repoRecipeNames(repo);
    for (const name of names) {
      const raw = await readJson(join(dir, "recipes", `${name}.json`), null);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const result = validateRecipe(raw);
      if (!result.ok) continue;
      const key = result.value.name;
      if (byName.has(key)) continue; // higher-priority repo (earlier) wins
      byName.set(key, { recipe: result.value, origin: repo.name });
    }
  }
  return [...byName.values()];
}
