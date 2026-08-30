// dshpkg — transactional install/remove (module H).
//
// A transaction runs: resolve dependency closure -> install deps first ->
// precheck (dsh --profile X --dump-config, exit 0) -> install self
// (dsh plugin --profile X add <spec>, `link:` prefix forced for local paths)
// -> optional AUR-style build commands -> smoke (dump-config again). Any
// failing step rolls back everything the transaction installed (dsh plugin
// --profile X remove <name>, reverse order) and returns
// { ok: false, error, rolledBack }.
//
// Git-backed specs (github:/git+/git+https:/.git urls) are cloned once into
// <stateRoot>/cache/git/<sanitized>/ via lib/gitcache.js and installed from
// there with a `link:` spec — the pulled source is what gets installed, not
// a second pnpm clone. pnpm allowBuilds rejections are handled automatically
// (write <profile>/pnpm-workspace.yaml, retry once); GitHub connection
// failures surface the SSH switching hint.
//
// All shelling goes through injected runners: the shared dsh launcher
// resolver (lib/launcher.js) for dsh commands, lib/gitcache.js's git runner
// for clone/fetch, and an injected execBuild for build commands — every one
// with shell:false. dryRun prints the planned commands (Chinese, user-facing)
// and never invokes any runner. Tests inject fakes and never execute a real
// dsh/pnpm/git or touch a real profile.

import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { resolveProfileDir, readJson } from "./state.js";
import { runDshSync } from "./launcher.js";
import {
  SSH_HINT,
  defaultGitRunner,
  isGitSpec,
  parseGitSpec,
  ensureGitCache,
  resolveGitCache,
  isGitNetworkError,
} from "./gitcache.js";

/**
 * Default runner: resolve the dsh launcher (DSH_BIN .exe direct, else
 * DSH_LAUNCHER / auto-detected bin.js via `node <bin.js>`) and run it
 * synchronously, inheriting the environment, stdio inherit, never through
 * a shell. Dependencies are injectable for tests (a real dsh is never
 * executed).
 *
 * @param {string[]} args dsh arguments (without the binary itself)
 * @param {object} [deps] {spawnImpl, resolveImpl, execPath}
 * @returns {{status: number|null, error?: Error}}
 */
export function defaultRunner(args, deps = {}) {
  return runDshSync(args, { options: { stdio: "inherit" }, ...deps });
}

/**
 * Install-step runner: same launcher resolution as defaultRunner but with
 * output CAPTURED (encoding utf8, piped stdio) so the transaction can
 * inspect pnpm's output — the allowBuilds hint and network errors are only
 * detectable this way. Used for `dsh plugin add` steps.
 *
 * @param {string[]} args dsh arguments (without the binary itself)
 * @param {object} [deps] {spawnImpl, resolveImpl, execPath}
 * @returns {{status: number|null, stdout: string, stderr: string, error?: Error}}
 */
export function defaultInstallRunner(args, deps = {}) {
  return runDshSync(args, { options: { encoding: "utf8" }, ...deps });
}

/**
 * Split a build command string into [executable, ...args] by whitespace.
 * Simple commands only (no quoting/pipes) — this is deliberate: build
 * commands never run through shell:true. Returns null for empty input.
 */
export function splitCommand(command) {
  const tokens = String(command).trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens : null;
}

/**
 * Default build executor: run one simple command in the given directory via
 * spawnSync with shell:false (the first token is the executable, the rest
 * are arguments). Injected in tests; a real build binary never runs there.
 *
 * @param {{command: string, cwd: string, spawnImpl?: Function}} call
 * @returns {{status: number|null, error?: Error}}
 */
export function defaultExecBuild({ command, cwd, spawnImpl = spawnSync }) {
  const tokens = splitCommand(command);
  if (!tokens) return { status: 0 }; // empty command = no-op
  const [cmd, ...args] = tokens;
  return spawnImpl(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
    windowsHide: true,
    timeout: 600_000,
    env: process.env,
  });
}

/** Human-readable failure detail for a runner result. */
function failDetail(res) {
  if (res && res.error && res.error.message) return `错误: ${res.error.message}`;
  if (res && typeof res.status === "number") return `退出码 ${res.status}`;
  return "命令未产生结果";
}

/** Read a text file; a missing file reads as "". */
async function readTextOrEmpty(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** Extract a package name from a spec ("dsh-plugin-x@1.2.3" -> "dsh-plugin-x"). */
function pkgNameOf(spec) {
  const s = String(spec).trim().replace(/^(link:|file:|npm:)/, "");
  const match = s.match(/^(@[^/]+\/[^@/]+|[^@/]+)/);
  return match ? match[1] : s;
}

/**
 * Force the `link:` prefix for local path specs (official reconciler skips
 * bundle detection for bare absolute paths, see CONTRACTS.md verified facts).
 * An existing `link:` prefix is kept; `file:` is normalized to `link:`.
 */
function withLinkPrefix(spec) {
  const s = String(spec).trim();
  if (s.startsWith("link:")) return s;
  if (s.startsWith("file:")) return "link:" + s.slice(5);
  if (isAbsolute(s)) return "link:" + s;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return "link:" + s; // windows drive path
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith(".\\") || s.startsWith("..\\") || s === "." || s === "..") {
    return "link:" + s;
  }
  return s;
}

function isInstalled(installed, name) {
  if (installed instanceof Set) return installed.has(name);
  return Boolean(installed && installed[name]);
}

/**
 * Extract an install spec from a recipe node. The transaction contract used
 * a plain string `source`; lib/recipe.js recipes carry `source: {type, spec}`.
 * Both shapes are accepted (see CONTRACTS.md rulings): a string passes
 * through, an object resolves to its `spec`.
 */
function sourceOf(node) {
  const s = node?.source;
  if (typeof s === "string" && s.trim()) return s;
  if (s && typeof s === "object" && typeof s.spec === "string" && s.spec.trim()) {
    return s.spec;
  }
  return node?.name ?? "";
}

/**
 * Best-effort package name for a git spec: the repository url's basename
 * ("https://github.com/owner/repo.git" -> "repo"). The pulled manifest's
 * name wins whenever it can be read; this is the display/rollback fallback
 * (pkgNameOf is hopeless on urls — it would cut "github:owner/repo" at the
 * first slash and yield "github:owner").
 */
function repoBasenameOf(repoUrl) {
  const base = String(repoUrl).replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = base.split(/[\\/]+/);
  return parts[parts.length - 1] || "repo";
}

/**
 * Resolve the install entries of a recipe/spec: dependency closure first
 * (topological order, deps before dependents), the recipe itself last.
 * String deps are treated as plain specs; object deps are recipes and are
 * expanded recursively. Cycles throw with a Chinese message containing the
 * cycle path. Installed recipes are skipped entirely.
 *
 * Each entry carries {name, spec, build} — `build` is the recipe's optional
 * AUR-style build block (only object recipes can declare it).
 *
 * @returns {{name: string, spec: string, build?: object}[]}
 */
function resolveEntries(specOrRecipe, installedRecipes = {}) {
  if (typeof specOrRecipe === "string") {
    const spec = String(specOrRecipe).trim();
    return [{ name: pkgNameOf(spec), spec }];
  }
  if (!specOrRecipe || typeof specOrRecipe !== "object" || !specOrRecipe.name) {
    throw new Error("无效的配方: 缺少 name 字段");
  }

  const out = [];
  const stack = []; // DFS path, for cycle detection
  const addDep = (depName) => {
    if (isInstalled(installedRecipes, depName)) return;
    if (out.some((entry) => entry.name === depName)) return;
    if (stack.includes(depName)) {
      const cycle = [...stack.slice(stack.indexOf(depName)), depName];
      throw new Error(`检测到循环依赖: ${cycle.join(" → ")}`);
    }
    out.push({ name: depName, spec: depName });
  };
  const visit = (node) => {
    const name = node && node.name;
    if (!name) throw new Error("配方依赖缺少 name 字段");
    if (isInstalled(installedRecipes, name)) return;
    if (out.some((entry) => entry.name === name)) return;
    if (stack.includes(name)) {
      const cycle = [...stack.slice(stack.indexOf(name)), name];
      throw new Error(`检测到循环依赖: ${cycle.join(" → ")}`);
    }
    stack.push(name);
    for (const dep of node.deps || []) {
      if (typeof dep === "string") addDep(dep);
      else visit(dep);
    }
    stack.pop();
    const entry = { name, spec: sourceOf(node) };
    if (node.build && typeof node.build === "object") entry.build = node.build;
    out.push(entry);
  };

  visit(specOrRecipe);
  return out;
}

/**
 * Resolve a recipe's dependency closure into recipe names in install order
 * (deps first). The recipe itself is NOT included — callers install the
 * closure, then the recipe. Detects cycles: throws with a Chinese message
 * containing the cycle path (e.g. "检测到循环依赖: a → b → a").
 *
 * @param {object} recipe recipe object {name, source?, deps?: (string|recipe)[]}
 * @param {object|Set} [installedRecipes] map/set of already-installed recipe names
 * @returns {string[]} recipe names in topological install order
 */
export function resolveDeps(recipe, installedRecipes = {}) {
  const entries = resolveEntries(recipe, installedRecipes);
  return entries.slice(0, -1).map((entry) => entry.name);
}

/**
 * Expand a recipe's string deps into full recipe objects wherever a recipe
 * exists in the library, recursively — so the transaction installs the
 * COMPLETE closure (deps of deps included) instead of treating string deps
 * as bare specs. Deps without a known recipe stay as plain specs (their own
 * deps cannot be looked up; pnpm still resolves the package's declared
 * dependencies natively). Pure: the recipe table is an input; cycle guards
 * keep the expansion finite (resolveEntries reports the cycle later).
 *
 * @param {object} recipe validated recipe {name, source, deps, ...}
 * @param {Map<string, object>} recipeByName name -> validated recipe
 * @returns {object} recipe with deps expanded
 */
export function expandDeps(recipe, recipeByName, seen = new Set()) {
  if (!recipe || typeof recipe !== "object") return recipe;
  const name = recipe.name;
  const guard = new Set(seen);
  if (name) {
    if (guard.has(name)) return recipe; // cycle: keep the ref, resolveEntries detects it
    guard.add(name);
  }
  const deps = Array.isArray(recipe.deps) ? recipe.deps : [];
  const expanded = deps.map((dep) => {
    if (typeof dep === "string") {
      const sub = recipeByName?.get(dep);
      return sub ? expandDeps(sub, recipeByName, guard) : dep;
    }
    if (dep && typeof dep === "object" && dep.name) {
      const sub = recipeByName?.get(dep.name) ?? dep;
      return expandDeps(sub, recipeByName, guard);
    }
    return dep;
  });
  return { ...recipe, deps: expanded };
}

/**
 * Detect dependency references that resolve to nothing in the recipe library.
 * Two distinct cases, reported separately so callers can hard-fail or warn:
 *
 *   - `missing` (object deps): an OBJECT dep `{ name }` whose `name` has no
 *     recipe in the library. An object dep is a deliberate "install THIS
 *     recipe's closure" request, so a missing recipe is a hard error — it
 *     cannot fall back to a bare npm spec.
 *   - `unresolved` (string deps): a STRING dep that matches no recipe name.
 *     Per CONTRACTS.md R9 a string dep is legal as a bare npm spec (pnpm
 *     resolves its own deps natively), so this is a WARNING, not an error —
 *     but it is exactly the silent gap the user complained about, so it must
 *     at least be surfaced.
 *
 * Recursion follows the same shape as expandDeps; the recipe table is an
 * input (pure). Cycles are guarded so the walk stays finite.
 *
 * @param {object} recipe validated recipe {name, deps}
 * @param {Map<string, object>} [recipeByName] name -> recipe
 * @returns {{missing: string[], unresolved: string[]}}
 */
export function findMissingDeps(recipe, recipeByName) {
  const missing = [];
  const unresolved = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const name = node.name;
    if (!name || seen.has(name)) return;
    seen.add(name);
    for (const dep of node.deps ?? []) {
      if (typeof dep === "string") {
        if (!recipeByName?.has(dep)) unresolved.push(dep);
        else walk(recipeByName.get(dep));
      } else if (dep && typeof dep === "object" && dep.name) {
        const sub = recipeByName?.get(dep.name);
        if (!sub) missing.push(dep.name);
        else walk(sub);
      }
    }
  };
  walk(recipe);
  return { missing: [...new Set(missing)], unresolved: [...new Set(unresolved)] };
}

/** Roll back the transaction: remove each name in reverse install order. */
async function rollback(runner, names, profile) {
  let ok = true;
  for (const name of [...names].reverse()) {
    const res = runner(["plugin", "--profile", profile, "remove", name]);
    if (!res || res.status !== 0) ok = false;
  }
  return ok; // true when there is nothing to remove
}

/**
 * True when the text is pnpm's allowBuilds rejection: it names both the
 * allowBuilds list and the pnpm-workspace.yaml file it lives in.
 */
export function hasAllowBuildsHint(text) {
  const t = String(text ?? "");
  return t.includes("allowBuilds") && t.includes("pnpm-workspace.yaml");
}

// Words that can appear on the allowBuilds message line but are never keys.
const KEY_STOPWORDS = new Set([
  "allowbuilds", "pnpm", "workspace", "yaml", "allow", "allowed",
  "build", "builds", "script", "scripts", "the", "to", "run", "is",
  "in", "not", "of", "for", "with", "dependency", "dependencies",
  "ignored", "failed", "error", "err", "list",
]);

/**
 * Extract dependency keys from pnpm's allowBuilds error text. Handles an
 * inline list (`allowBuilds: [a, b]`), YAML block items, and plain tokens on
 * the mentioning line. Falls back to `fallbackName` when nothing is found.
 *
 * @param {string} text pnpm output
 * @param {string} [fallbackName] package name to use when extraction fails
 * @returns {string[]} deduplicated keys
 */
export function extractAllowBuildsKeys(text, fallbackName) {
  const t = String(text ?? "");
  const keys = new Set();

  // 1. inline list form: allowBuilds: [a, b]
  for (const m of t.matchAll(/allowBuilds[:\s]*\[([^\]]*)\]/gi)) {
    for (const tok of m[1].split(/[\s,]+/)) {
      const clean = tok.trim().replace(/^["'`]+|["'`]+$/g, "");
      if (/^[@A-Za-z0-9._/-]+$/.test(clean)) keys.add(clean);
    }
  }

  // 2. YAML block items right after an `allowBuilds:` line
  const lines = t.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/allowBuilds\s*:/i.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s*["']?([@A-Za-z0-9._/-]+)["']?\s*$/);
      if (item) keys.add(item[1]);
      else if (/^\s*-\s*/.test(lines[j])) continue; // list item with more content
      else break;
    }
  }

  // 3. tokens on any line mentioning allowBuilds — a LAST-RESORT fallback, so
  // a token must look like a package name (hyphen, slash or @ present; pnpm's
  // message prose like "missing from" is pure words) and must not be a file
  // name or a pnpm error code.
  for (const line of lines) {
    if (!/allowBuilds/i.test(line)) continue;
    for (const tok of line.split(/[^\w@./-]+/)) {
      const clean = tok.replace(/^["'`]+|["'`]+$/g, "");
      if (!clean || !/^[A-Za-z0-9._/-]+$/.test(clean)) continue;
      if (!/[-/@]/.test(clean)) continue; // prose word, not a package name
      if (/\.(ya?ml|json)$/i.test(clean)) continue; // file name, not a key
      if (/^ERR_PNPM/i.test(clean)) continue; // pnpm error code, not a key
      if (KEY_STOPWORDS.has(clean.toLowerCase())) continue;
      keys.add(clean);
    }
  }

  const out = [...keys];
  // the fallback only applies when pnpm output actually mentions allowBuilds
  // (callers pre-check with hasAllowBuildsHint, but keep the guard local too)
  const mentionsAllowBuilds = /allowBuilds/i.test(String(text ?? ""));
  if (out.length === 0 && mentionsAllowBuilds && fallbackName) out.push(fallbackName);
  return out;
}

/**
 * Merge keys into a pnpm-workspace.yaml `allowBuilds` list without a YAML
 * parser: comments and unrelated lines are preserved verbatim, existing keys
 * are deduplicated, and a missing file/inline list form is handled.
 * Returns the updated text (equal to the input when nothing changes).
 */
export function mergeAllowBuildsKeys(text, keys) {
  const keyList = [...new Set((keys ?? []).filter((k) => typeof k === "string" && k.trim()))];
  if (keyList.length === 0) return text;
  const original = String(text ?? "");
  const lines = original.split(/\r?\n/);

  const idx = lines.findIndex((line) => /^\s*allowBuilds\s*:/.test(line));
  if (idx === -1) {
    const head = original.trimEnd();
    const body = ["allowBuilds:", ...keyList.map((k) => `  - ${k}`)].join("\n");
    return head ? `${head}\n\n${body}\n` : `${body}\n`;
  }

  // Collect keys already listed in the block (until a top-level line).
  const existing = new Set();
  for (let j = idx + 1; j < lines.length; j++) {
    const line = lines[j];
    const item = line.match(/^\s*-\s*["']?([@A-Za-z0-9._/-]+)["']?\s*$/);
    if (item) existing.add(item[1]);
    else if (/^\s*(#.*)?$/.test(line)) continue; // blank / comment
    else if (/^\s/.test(line)) continue; // other indented content
    else break;
  }
  const missing = keyList.filter((k) => !existing.has(k));
  if (missing.length === 0) return text;

  // Inline form `allowBuilds: [a, b]` -> block form (comment kept on the line).
  const inline = lines[idx].match(/^(\s*)allowBuilds\s*:\s*\[([^\]]*)\](.*)$/);
  if (inline) {
    const indent = inline[1];
    const items = inline[2].split(/[\s,]+/).filter(Boolean).map((i) => i.replace(/^["'`]+|["'`]+$/g, ""));
    const all = [...items, ...missing];
    const rest = inline[3].trim();
    lines[idx] = `${indent}allowBuilds:\n${all.map((k) => `${indent}  - ${k}`).join("\n")}${rest ? ` ${rest}` : ""}`;
    return lines.join("\n");
  }

  // Block form: append the missing keys after the LAST existing list item in
  // the block (original order kept, new keys at the end of the list).
  const indent = (lines[idx].match(/^(\s*)/) || ["", ""])[1];
  let insertAt = idx + 1;
  for (let j = idx + 1; j < lines.length; j++) {
    const line = lines[j];
    const item = line.match(/^\s*-\s*["']?([A-Za-z0-9._/-]+)["']?\s*$/);
    if (item) {
      insertAt = j + 1;
      continue;
    }
    if (/^\s*(#.*)?$/.test(line)) continue; // blank / comment line
    if (/^\s/.test(line)) continue; // other indented content
    break; // top-level line: the block ends here
  }
  lines.splice(insertAt, 0, ...missing.map((k) => `${indent}  - ${k}`));
  return lines.join("\n");
}

/**
 * Run the recipe's build commands inside the installed package directory.
 * The package dir is resolved through fs.realpath so pnpm junctions/symlinks
 * point at the real source. Any failing command returns the Chinese error.
 *
 * @param {string} name installed package name
 * @param {{commands: string[], cwd?: string}} build
 * @param {string} profile profile name
 * @param {Function} execBuild ({command, cwd}) -> {status, error?}
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function runBuildSteps(name, build, profile, execBuild) {
  const profileDir = await resolveProfileDir(profile);
  if (!profileDir) {
    return { ok: false, error: `找不到 profile "${profile}"（无法定位已安装包目录）` };
  }
  let pkgDir;
  try {
    pkgDir = await realpath(join(profileDir, "node_modules", name));
  } catch {
    return { ok: false, error: `已安装包目录不存在: ${join(profileDir, "node_modules", name)}` };
  }
  const base = build.cwd
    ? isAbsolute(build.cwd) || /^[a-zA-Z]:[\\/]/.test(build.cwd)
      ? build.cwd
      : join(pkgDir, build.cwd)
    : pkgDir;
  for (const command of build.commands) {
    // await keeps both sync (default spawnSync) and async injected executors valid
    const res = await execBuild({ command, cwd: base });
    if (res && res.status === 0) continue;
    return { ok: false, error: `命令执行失败: "${command}"（${failDetail(res)}）` };
  }
  return { ok: true };
}

/**
 * Transactional install.
 *
 * Accepts either a plain spec string (installed as-is, no dep closure) or a
 * recipe object {name, source?, deps?, build?}. Steps: resolve dep closure ->
 * install deps -> precheck -> install self -> build commands (when the
 * recipe declares them) -> smoke. On any failure every package installed by
 * this transaction is removed again (reverse order).
 *
 * Git-backed specs are cloned into the git cache and installed from there
 * via `link:` (subdir selectable with `#path:subdir`). pnpm allowBuilds
 * rejections auto-write <profile>/pnpm-workspace.yaml and retry once;
 * GitHub connection failures report the SSH switching hint.
 *
 * @param {string|object} specOrRecipe
 * @param {object} [opts]
 * @param {string} [opts.profile="web"]
 * @param {boolean} [opts.dryRun=false]
 * @param {Function} [opts.runner=defaultRunner] dsh runner (precheck/smoke/rollback)
 * @param {Function} [opts.installRunner] dsh runner for add steps (defaults to runner)
 * @param {Function} [opts.gitRunner=defaultGitRunner] git runner (clone/fetch/reset)
 * @param {Function} [opts.execBuild=defaultExecBuild] build command executor
 * @returns {Promise<{ok: true, installed: string[]} | {ok: false, error: string, rolledBack: boolean}>}
 */
export async function install(
  specOrRecipe,
  {
    profile = "web",
    dryRun = false,
    runner = defaultRunner,
    installRunner,
    gitRunner = defaultGitRunner,
    execBuild = defaultExecBuild,
  } = {},
) {
  const addRunner = installRunner ?? runner;

  let entries;
  try {
    entries = resolveEntries(specOrRecipe);
  } catch (err) {
    return { ok: false, error: err.message, rolledBack: false };
  }

  const installedNames = [];
  const rollbackNames = []; // install order; rolled back in reverse
  const fail = async (error) => {
    const rolledBack = await rollback(runner, rollbackNames, profile);
    return { ok: false, error, rolledBack };
  };

  // Resolve git-backed entries: clone into the cache and install from there
  // via `link:`. Specs with unsupported refs (#branch/#tag/…) pass through
  // unchanged — pnpm resolves those natively. A cache-pull failure falls back
  // to the ORIGINAL spec through the official channel (result usedCache:
  // false); only a missing #path: subdirectory aborts outright, because pnpm
  // would not understand the fragment either.
  let usedCache = null; // null = no git entries involved; false = fell back
  const resolved = [];
  for (const entry of entries) {
    const git = isGitSpec(entry.spec) ? parseGitSpec(entry.spec) : null;
    if (!git || git.unsupportedRef) {
      resolved.push({ ...entry, git: null, spec: withLinkPrefix(entry.spec) });
      continue;
    }
    if (usedCache !== false) usedCache = true;
    const repoName = repoBasenameOf(git.repoUrl);
    // pkgNameOf guesses on urls leave colon leftovers ("github:owner") — not
    // a valid npm name; the repo basename is the better fallback then. A
    // recipe's declared name never contains a colon and stays authoritative.
    const labelName = /:/.test(entry.name) ? repoName : entry.name;
    // A #path: subdirectory must stay inside the cache checkout: reject ".."
    // segments (traversal that would escape the cache dir) and absolute /
    // drive-letter paths, which carry join() far outside it. Enforced before
    // any git operation, so a hostile spec never even triggers a clone.
    if (git.subdir) {
      const segments = git.subdir.split(/[\\/]+/);
      if (
        segments.some((s) => s === "..") ||
        isAbsolute(git.subdir) ||
        /^[a-zA-Z]:[\\/]/.test(git.subdir)
      ) {
        return {
          ok: false,
          error: `git 仓库子目录不合法: ${labelName}（#path:${git.subdir} 不允许 .. 或绝对路径）`,
          rolledBack: false,
        };
      }
    }
    if (!dryRun) {
      try {
        await ensureGitCache(git.repoUrl, gitRunner);
      } catch (err) {
        // Cache pull failed (no git, network, corrupted cache, …): hand the
        // ORIGINAL spec to the official pnpm channel — it clones on its own.
        usedCache = false;
        console.log(`git 缓存拉取失败，回退官方通道直传: ${String(err?.message ?? err)}`);
        resolved.push({ ...entry, name: labelName, git: null, spec: entry.spec });
        continue;
      }
    }
    const cacheDir = resolveGitCache(git.repoUrl);
    const target = git.subdir ? join(cacheDir, ...git.subdir.split(/[\\/]+/)) : cacheDir;
    if (!dryRun && git.subdir && !existsSync(target)) {
      return {
        ok: false,
        error: `git 仓库子目录不存在: ${labelName}（#path:${git.subdir} 在缓存中未找到，请检查配方）`,
        rolledBack: false,
      };
    }
    // A `link:` install registers the pulled manifest's name with pnpm, so
    // rollback and bookkeeping must use THAT name when it is readable;
    // otherwise the recipe's declared name (or the repo basename for raw
    // url specs) — dryRun pulls nothing and keeps the declared/derived name.
    let name = labelName;
    if (!dryRun) {
      const manifest = await readJson(join(target, "package.json"), null);
      if (manifest && typeof manifest.name === "string" && manifest.name.trim()) {
        name = manifest.name.trim();
      }
    }
    resolved.push({ ...entry, name, git, spec: `link:${target}` });
  }

  // Install one entry through the official channel, handling pnpm's
  // allowBuilds rejection and network failures with Chinese guidance.
  const addStep = async (entry, { isDep }) => {
    const label = isDep ? "依赖安装失败" : "安装失败";
    let res = addRunner(["plugin", "--profile", profile, "add", entry.spec]);
    if (res && res.status === 0) {
      // echo the captured pnpm output (production UX; fake runners have none)
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      if (out.trim()) console.log(out);
      return { ok: true };
    }
    const output = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;

    if (hasAllowBuildsHint(output)) {
      const keys = extractAllowBuildsKeys(output, entry.name);
      const profileDir = await resolveProfileDir(profile);
      if (profileDir) {
        const wsPath = join(profileDir, "pnpm-workspace.yaml");
        const prev = await readTextOrEmpty(wsPath);
        const next = mergeAllowBuildsKeys(prev, keys);
        if (next !== prev) await writeFile(wsPath, next, "utf8");
        res = addRunner(["plugin", "--profile", profile, "add", entry.spec]); // single retry
        if (res && res.status === 0) return { ok: true, allowBuildsHandled: true };
      }
      return {
        ok: false,
        error: `${label}: ${entry.name}（pnpm 因 allowBuilds 拒绝构建脚本，已自动写入 pnpm-workspace.yaml 并重试一次，仍失败: ${failDetail(res)}）`,
      };
    }

    if (isGitNetworkError(output)) {
      return { ok: false, error: `${label}: ${entry.name}（${SSH_HINT}）` };
    }
    return { ok: false, error: `${label}: ${entry.name} (${failDetail(res)})` };
  };

  // Run the recipe's build commands after a successful install (dryRun
  // prints the plan). Returns null on success, a Chinese error otherwise.
  const buildAfterInstall = async (entry) => {
    const build = entry?.build;
    const hasCommands = build && Array.isArray(build.commands) && build.commands.length > 0;
    if (!hasCommands) return null;
    if (dryRun) {
      for (const command of build.commands) {
        console.log(`[dry-run] 将执行构建: ${command}（cwd: <profile>/node_modules/${entry.name}${build.cwd ? `/${build.cwd}` : ""}）`);
      }
      return null;
    }
    const result = await runBuildSteps(entry.name, build, profile, execBuild);
    return result.ok ? null : `构建失败: ${entry.name}（${result.error}）`;
  };

  // 1. install the dependency closure first (deps before dependents)
  for (const entry of resolved.slice(0, -1)) {
    if (dryRun) {
      if (entry.git) {
        console.log(`[dry-run] git 缓存: clone --depth 1 ${entry.git.repoUrl} → ${resolveGitCache(entry.git.repoUrl)}`);
      }
      console.log(`[dry-run] 将安装依赖: dsh plugin --profile ${profile} add ${entry.spec}`);
      rollbackNames.push(entry.name);
      installedNames.push(entry.name);
      continue;
    }
    const outcome = await addStep(entry, { isDep: true });
    if (!outcome.ok) return fail(outcome.error);
    rollbackNames.push(entry.name);
    installedNames.push(entry.name);
    const buildError = await buildAfterInstall(entry);
    if (buildError) return fail(buildError);
  }

  const self = resolved[resolved.length - 1];

  // 2. precheck: the composed config must still dump cleanly
  if (dryRun) {
    console.log(`[dry-run] 预检: dsh --profile ${profile} --dump-config`);
  } else {
    const res = runner(["--profile", profile, "--dump-config"]);
    if (!res || res.status !== 0) {
      return fail(`预检失败: dsh --profile ${profile} --dump-config ${failDetail(res)}`);
    }
  }

  // 3. install self (official channel; git specs already point at the cache)
  if (dryRun) {
    if (self.git) {
      console.log(`[dry-run] git 缓存: clone --depth 1 ${self.git.repoUrl} → ${resolveGitCache(self.git.repoUrl)}`);
    }
    console.log(`[dry-run] 将安装: dsh plugin --profile ${profile} add ${self.spec}`);
  } else {
    const outcome = await addStep(self, { isDep: false });
    if (!outcome.ok) return fail(outcome.error);
  }
  rollbackNames.push(self.name);
  installedNames.push(self.name);

  // 3.5 AUR-style build commands (recipe build field; PKGBUILD build()/package())
  const selfBuildError = await buildAfterInstall(self);
  if (selfBuildError) return fail(selfBuildError);

  // 4. smoke: dump again after the final add
  if (dryRun) {
    console.log(`[dry-run] 冒烟: dsh --profile ${profile} --dump-config`);
  } else {
    const res = runner(["--profile", profile, "--dump-config"]);
    if (!res || res.status !== 0) {
      return fail(`冒烟测试失败: dsh --profile ${profile} --dump-config ${failDetail(res)}`);
    }
  }

  // usedCache is reported only when a git spec was involved: true = pulled
  // from <stateRoot>/cache/git, false = a cache failure fell back to the
  // official channel with the original spec.
  return { ok: true, installed: installedNames, ...(usedCache !== null ? { usedCache } : {}) };
}

/**
 * Remove a package from the profile via the official CLI.
 *
 * @param {string} name package name to remove
 * @param {{profile?: string, dryRun?: boolean, runner?: Function}} [opts]
 * @returns {Promise<{ok: boolean, removed: string|null, error?: string}>}
 */
export async function remove(name, { profile = "web", dryRun = false, runner = defaultRunner } = {}) {
  if (!name || typeof name !== "string") {
    return { ok: false, removed: null, error: "缺少包名" };
  }
  if (dryRun) {
    console.log(`[dry-run] 将移除: dsh plugin --profile ${profile} remove ${name}`);
    return { ok: true, removed: name };
  }
  const res = runner(["plugin", "--profile", profile, "remove", name]);
  if (!res || res.status !== 0) {
    return { ok: false, removed: null, error: `移除失败: ${name} (${failDetail(res)})` };
  }
  return { ok: true, removed: name };
}

/**
 * Autoremove orphan packages.
 *
 * Scans the profile's package.json dependencies; a package is an orphan when
 * its installed manifest declares no `dsh.bundle` AND no other installed
 * package lists it in its own dependencies (cross-reference over every
 * installed package.json in the profile's node_modules). Orphans are removed
 * one by one through the official CLI; a package whose manifest is missing
 * from node_modules is skipped (cannot be judged). The first failed removal
 * stops the run and reports the removals that already succeeded.
 *
 * @param {{profile?: string, dryRun?: boolean, runner?: Function}} [opts]
 * @returns {Promise<{ok: boolean, removed: string[], error?: string}>}
 */
export async function autoremove({ profile = "web", dryRun = false, runner = defaultRunner } = {}) {
  const profileDir = await resolveProfileDir(profile);
  if (!profileDir) {
    return { ok: false, removed: [], error: `找不到 profile "${profile}" 或它没有 dsh.profile 声明` };
  }

  const manifest = await readJson(join(profileDir, "package.json"), null);
  const deps = (manifest && manifest.dependencies) || {};

  const bundled = new Set(); // packages with dsh.bundle: never autoremoved
  const referenced = new Set(); // packages referenced by another installed pkg
  const judged = new Set(); // packages whose installed manifest we could read
  for (const name of Object.keys(deps)) {
    const pkgJson = await readJson(join(profileDir, "node_modules", name, "package.json"), null);
    if (!pkgJson) continue; // not installed (or broken): skip, cannot judge
    judged.add(name);
    if (pkgJson.dsh && pkgJson.dsh.bundle) bundled.add(name);
    for (const depName of Object.keys(pkgJson.dependencies || {})) referenced.add(depName);
  }

  const orphans = Object.keys(deps).filter((name) => judged.has(name) && !bundled.has(name) && !referenced.has(name));

  const removed = [];
  for (const name of orphans) {
    if (dryRun) {
      console.log(`[dry-run] 将移除孤儿包: dsh plugin --profile ${profile} remove ${name}`);
      removed.push(name);
      continue;
    }
    const res = runner(["plugin", "--profile", profile, "remove", name]);
    if (!res || res.status !== 0) {
      return { ok: false, removed, error: `移除孤儿包失败: ${name} (${failDetail(res)})` };
    }
    removed.push(name);
  }
  return { ok: true, removed };
}
