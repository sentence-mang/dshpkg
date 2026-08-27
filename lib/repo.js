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
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  statePath,
  readRepos,
  writeRepos,
  readJson,
  writeTextAtomic,
  readState,
  writeState,
  appendIncident,
  acquireSyncLock,
  releaseSyncLock,
} from "./state.js";
import { validateRecipe } from "./recipe.js";
import { defaultRepos } from "./defaults.js";
import { refreshIndex } from "./indexer.js";

// Characters that must never appear in repo names / urls we pass to git.
const FORBIDDEN_CHARS = /[\s"'`\\<>|;]/;

// A repo name must look like a package name: an alphanumeric first character,
// then alphanumerics / dot / underscore / dash. This rejects `..` traversal,
// path separators, whitespace and a leading dash (git option injection).
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Supported repo formats: git checkout (default) or a static index JSON. */
const REPO_FORMATS = ["git", "index"];

/** Reject empty or unsafe repo urls (user-facing Chinese error). */
function assertSafe(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}不能为空`);
  }
  if (FORBIDDEN_CHARS.test(value)) {
    throw new Error(`${label}不能包含空格、引号等特殊字符`);
  }
}

/** A repo url is safe for the git runner: no shell metacharacters (assertSafe)
 * and never a leading dash (a "-u …" url would be parsed as a git option). */
function assertSafeUrl(value) {
  assertSafe(value, "仓库地址");
  if (String(value).trim().startsWith("-")) {
    throw new Error("仓库地址不能以 - 开头");
  }
}

/** A repo name must satisfy the package-like whitelist (rejects `..`, path
 * separators, whitespace and a leading dash). */
function assertSafeRepoName(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("仓库名称不能为空");
  }
  if (!REPO_NAME_RE.test(value)) {
    throw new Error(
      "仓库名称不合法（只允许字母/数字/./_/-，且不能以 . 或 - 开头，不能含空格/引号等特殊字符）",
    );
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

// --- static index sources (R2, design §2) -----------------------------------
//
// A static index is a single JSON document ({ format: "dshpkg-index/v1",
// plugins: [...] }) served over HTTPS. On sync it is fetched (10s timeout,
// injected fetcher — never shell:true) and cached atomically under
// <stateRoot>/sources/<name>/index.json; recipes are then loaded from the
// cache like any git checkout. A broken/offline index is a per-repo error,
// never a block for the other sources.

/** Default fetcher: global fetch with a 10s timeout. */
function defaultFetcher(url) {
  return fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { "user-agent": "dshpkg/0.1", accept: "application/json" },
  });
}

/** Validate a static index payload ({ format, plugins[] }) — shape only. */
export function parseStaticIndex(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "索引内容不是对象" };
  }
  if (payload.format !== "dshpkg-index/v1") {
    return { ok: false, error: `未知的索引格式: ${payload.format ?? "缺失"}` };
  }
  if (!Array.isArray(payload.plugins)) {
    return { ok: false, error: "索引缺少 plugins 数组" };
  }
  return { ok: true, value: payload };
}

/** Fetch + validate + cache one static index source. */
async function syncIndexRepo(repo, fetcher) {
  const url = repo.url;
  const res = await fetcher(url);
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? "unknown"} for ${url}`);
  const payload = await res.json();
  const check = parseStaticIndex(payload);
  if (!check.ok) throw new Error(check.error);
  await writeTextAtomic(
    statePath("sources", repo.name, "index.json"),
    JSON.stringify(payload, null, 2),
  );
  return check.value.plugins.length;
}

/**
 * Copy <checkout>/pubkeys/*.pub into the shared pubkeys cache (P3-1, design
 * signing.md §3.1): each synced repo may ship the public keys of the
 * signatures it distributes. Best-effort — a missing pubkeys/ dir or a
 * broken file is not an error.
 */
async function syncRepoPubkeys(dir) {
  try {
    const pubDir = join(dir, "pubkeys");
    const entries = await readdir(pubDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".pub")) continue;
      const text = await readFile(join(pubDir, entry.name), "utf8");
      await writeTextAtomic(statePath("pubkeys", entry.name), text);
    }
  } catch {
    // no pubkeys/ directory in this repo — fine
  }
}

/**
 * Register a recipe repository. When name is omitted it is derived from the
 * url's last path segment. `format` selects the source kind: "git" (default,
 * AUR-style checkout) or "index" (publisher static index.json, R2). Returns
 * the stored repos.json entry.
 */
export async function repoAdd(url, name, format = "git") {
  assertSafeUrl(url);
  const resolvedName = name === undefined ? deriveNameFromUrl(url) : name;
  assertSafeRepoName(resolvedName);
  if (!REPO_FORMATS.includes(format)) {
    throw new Error(`仓库格式必须是 ${REPO_FORMATS.join(" 或 ")}`);
  }
  const config = await readRepos();
  if (config.repos.some((repo) => repo.name === resolvedName)) {
    throw new Error(`仓库 ${resolvedName} 已存在`);
  }
  const entry = { url, name: resolvedName, enabled: true, format };
  config.repos.push(entry);
  await writeRepos(config);
  return entry;
}

/** Remove a repository by name (keeps the synced checkout on disk). */
export async function repoRemove(name) {
  assertSafeRepoName(name);
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
async function syncOneRepo(repo, runner, fetcher) {
  const dir = statePath("recipes", repo.name);
  try {
    // Re-validate the repo entry from repos.json: it could have been tampered
    // with on disk outside repoAdd(), and a malicious name/url must never
    // reach a git spawn or a filesystem join. Rejected as a per-repo error so
    // the other repos still sync.
    assertSafeRepoName(repo.name);
    assertSafeUrl(repo.url);
    if (repo.format === "index") {
      await syncIndexRepo(repo, fetcher);
      return { name: repo.name, status: "ok", format: "index" };
    }
    if (existsSync(join(dir, ".git"))) {
      const fetch = await runner(["fetch", "--depth", "1", "origin"], { cwd: dir });
      if (runFailed(fetch)) throw new Error(fetch.stderr || "git fetch 失败");
      const reset = await runner(["reset", "--hard", "origin/HEAD"], { cwd: dir });
      if (runFailed(reset)) throw new Error(reset.stderr || "git reset 失败");
      await syncRepoPubkeys(dir);
    } else {
      const clone = await runner(["clone", "--depth", "1", "--", repo.url, dir], {});
      if (runFailed(clone)) throw new Error(clone.stderr || "git clone 失败");
      await syncRepoPubkeys(dir);
    }
    return { name: repo.name, status: "ok" };
  } catch (error) {
    return { name: repo.name, status: "error", error: String(error?.message ?? error) };
  }
}

/**
 * Sync all enabled repositories (git clone or fetch + reset; index sources
 * are fetched and cached). The runner and fetcher are injectable for tests;
 * the defaults spawn real git via spawnSync (shell:false) and use global
 * fetch. Returns per-repo outcomes.
 */
export async function syncRepos({ runner = defaultGitRunner, fetcher } = {}) {
  const config = await readRepos();
  const outcomes = [];
  for (const repo of config.repos) {
    if (repo.enabled === false) continue;
    outcomes.push(await syncOneRepo(repo, runner, fetcher ?? defaultFetcher));
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
    if (repo.format === "index") {
      // Static index source: recipes come from the cached plugins[] array.
      const payload = await readJson(
        statePath("sources", repo.name, "index.json"),
        null,
      );
      const check = parseStaticIndex(payload);
      if (!check.ok) continue;
      for (const entry of check.value.plugins) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const result = validateRecipe(entry);
        if (!result.ok) continue;
        const key = result.value.name;
        if (byName.has(key)) continue; // higher-priority repo (earlier) wins
        // `raw` is the published object (pre-validation): signature checks
        // MUST run against it — default-filling would change the payload.
        byName.set(key, { recipe: result.value, raw: entry, origin: repo.name });
      }
      continue;
    }
    const dir = statePath("recipes", repo.name);
    const names = await repoRecipeNames(repo);
    for (const name of names) {
      const raw = await readJson(join(dir, "recipes", `${name}.json`), null);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const result = validateRecipe(raw);
      if (!result.ok) continue;
      const key = result.value.name;
      if (byName.has(key)) continue; // higher-priority repo (earlier) wins
      byName.set(key, { recipe: result.value, raw, origin: repo.name });
    }
  }
  return [...byName.values()];
}

/**
 * First-use bootstrap (R5, design §3): add every default repo when none is
 * configured. `noDefault` skips without writing; `repos` overrides the
 * defaults (tests inject their own list via DSH_DEFAULT_REPOS instead).
 *
 * @returns {Promise<{added: number, skipped: boolean}>}
 */
export async function repoInit({ noDefault = false, repos } = {}) {
  const config = await readRepos();
  if (config.repos.length > 0) return { added: 0, skipped: true };
  if (noDefault) return { added: 0, skipped: true };
  const list = Array.isArray(repos) ? repos : defaultRepos();
  let added = 0;
  for (const entry of list) {
    try {
      await repoAdd(entry?.url, entry?.name, entry?.format ?? "git");
      added += 1;
    } catch {
      // one broken default must not block the rest
    }
  }
  return { added, skipped: false };
}

// --- automatic polling (P2-4, design §4) -------------------------------------
//
// The supervisor (or any caller) invokes autoPoll() on an idle interval. It
// runs a full sync only when the poll is due AND no other caller is syncing
// (sync.lock). Failures back off exponentially (interval * 2^failures, capped
// at 24h); three consecutive failures suspend automatic polling until a
// manual sync succeeds or pollIntervalMs is set to 0 (each successful poll
// resets the counter). All of it is best-effort — a broken poll must never
// disturb the watchdog loop.

/** Default poll interval (24h, matching the index freshness gate). */
export const DEFAULT_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Exponential backoff cap. */
export const MAX_POLL_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** Consecutive failures that suspend automatic polling. */
export const POLL_SUSPEND_LIMIT = 3;

/**
 * Evaluate whether an automatic poll is due. Pure-ish (reads state/repos;
 * no network, no lock). Exported for tests.
 *
 * @returns {Promise<{due: boolean, reason: string}>}
 */
export async function autoPollDue({ now = Date.now() } = {}) {
  const state = await readState();
  // pollIntervalMs 0 (or any non-positive value) disables automatic polling;
  // only an absent field falls back to the default interval.
  const raw = state.pollIntervalMs;
  const interval =
    raw === undefined || raw === null ? DEFAULT_POLL_INTERVAL_MS : Number(raw);
  if (!(interval > 0)) return { due: false, reason: "disabled" };
  if (state.pollSuspendedAt) return { due: false, reason: "suspended" };
  const repos = await readRepos();
  if (!Array.isArray(repos.repos) || repos.repos.length === 0) {
    return { due: false, reason: "no-repos" };
  }
  const last = repos.lastSyncAt ? Date.parse(repos.lastSyncAt) : 0;
  const backoffMs = Math.min(
    interval * 2 ** (Number(state.pollFailures) || 0),
    MAX_POLL_BACKOFF_MS,
  );
  if (Number.isFinite(last) && now - last < backoffMs) {
    return { due: false, reason: "fresh" };
  }
  return { due: true, reason: "overdue" };
}

/**
 * Run one automatic poll (due check → lock → syncRepos + refreshIndex →
 * backoff/suspend bookkeeping). Never throws: every failure is recorded and
 * returned. Injectable fetcher/runner keep tests offline.
 *
 * @returns {Promise<{ran: boolean, ok: boolean|null, reason: string}>}
 */
export async function autoPoll({ fetcher, runner, now = Date.now() } = {}) {
  const due = await autoPollDue({ now });
  if (!due.due) return { ran: false, ok: null, reason: due.reason };
  const lock = await acquireSyncLock({ now });
  if (!lock.ok) return { ran: false, ok: null, reason: lock.reason };
  try {
    const outcomes = await syncRepos({ runner, fetcher });
    const index = await refreshIndex(fetcher ? { fetcher } : {});
    const repoOk = !outcomes.some((o) => o.status === "error");
    const indexOk = index.ok !== false;
    const ok = repoOk && indexOk;
    const state = await readState();
    if (ok) {
      state.pollFailures = 0;
    } else {
      state.pollFailures = (Number(state.pollFailures) || 0) + 1;
      if (state.pollFailures >= POLL_SUSPEND_LIMIT) {
        state.pollSuspendedAt = new Date(now).toISOString();
      }
    }
    await writeState(state);
    if (!ok) {
      const detail =
        outcomes.find((o) => o.status === "error")?.error ??
        index.lastError ??
        "poll failed";
      await appendIncident({
        type: "poll-failed",
        failures: state.pollFailures,
        detail: String(detail).slice(0, 300),
      });
    }
    return { ran: true, ok, reason: ok ? "ok" : "failed" };
  } finally {
    await releaseSyncLock();
  }
}
