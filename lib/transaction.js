// dshpkg — transactional install/remove (module H).
//
// A transaction runs: resolve dependency closure -> install deps first ->
// precheck (dsh --profile X --dump-config, exit 0) -> install self
// (dsh plugin --profile X add <spec>, `link:` prefix forced for local paths)
// -> smoke (dump-config again). Any failing step rolls back everything the
// transaction installed (dsh plugin --profile X remove <name>, reverse
// order) and returns { ok: false, error, rolledBack }.
//
// All shelling goes through an injected runner: the shared dsh launcher
// resolver (lib/launcher.js) — DSH_BIN .exe direct, else `node <bin.js>`
// with DSH_LAUNCHER / auto-detected @deepseek-ai/dsh/lib/bin.js — with the
// inherited environment, never through a shell. dryRun prints the planned
// commands (Chinese, user-facing) and never invokes the runner. Tests inject
// a fake runner and never execute a real dsh/pnpm or touch a real profile.

import { isAbsolute, join } from "node:path";
import { resolveProfileDir, readJson } from "./state.js";
import { runDshSync } from "./launcher.js";

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

/** Human-readable failure detail for a runner result. */
function failDetail(res) {
  if (res && res.error && res.error.message) return `错误: ${res.error.message}`;
  if (res && typeof res.status === "number") return `退出码 ${res.status}`;
  return "命令未产生结果";
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
 * Resolve the install entries of a recipe/spec: dependency closure first
 * (topological order, deps before dependents), the recipe itself last.
 * String deps are treated as plain specs; object deps are recipes and are
 * expanded recursively. Cycles throw with a Chinese message containing the
 * cycle path. Installed recipes are skipped entirely.
 *
 * @returns {{name: string, spec: string}[]}
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
    out.push({ name, spec: sourceOf(node) });
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
 * Transactional install.
 *
 * Accepts either a plain spec string (installed as-is, no dep closure) or a
 * recipe object {name, source?, deps?}. Steps: install dep closure -> precheck
 * -> install self -> smoke. On any failure every package installed by this
 * transaction is removed again (reverse order).
 *
 * @param {string|object} specOrRecipe
 * @param {{profile?: string, dryRun?: boolean, runner?: Function}} [opts]
 * @returns {Promise<{ok: true, installed: string[]} | {ok: false, error: string, rolledBack: boolean}>}
 */
export async function install(specOrRecipe, { profile = "web", dryRun = false, runner = defaultRunner } = {}) {
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

  // 1. install the dependency closure first (deps before dependents)
  for (const entry of entries.slice(0, -1)) {
    const spec = withLinkPrefix(entry.spec);
    if (dryRun) {
      console.log(`[dry-run] 将安装依赖: dsh plugin --profile ${profile} add ${spec}`);
      rollbackNames.push(entry.name);
      installedNames.push(entry.name);
      continue;
    }
    const res = runner(["plugin", "--profile", profile, "add", spec]);
    if (!res || res.status !== 0) {
      return fail(`依赖安装失败: ${entry.name} (${failDetail(res)})`);
    }
    rollbackNames.push(entry.name);
    installedNames.push(entry.name);
  }

  const self = entries[entries.length - 1];
  const selfSpec = withLinkPrefix(self.spec);

  // 2. precheck: the composed config must still dump cleanly
  if (dryRun) {
    console.log(`[dry-run] 预检: dsh --profile ${profile} --dump-config`);
  } else {
    const res = runner(["--profile", profile, "--dump-config"]);
    if (!res || res.status !== 0) {
      return fail(`预检失败: dsh --profile ${profile} --dump-config ${failDetail(res)}`);
    }
  }

  // 3. install self (official channel)
  if (dryRun) {
    console.log(`[dry-run] 将安装: dsh plugin --profile ${profile} add ${selfSpec}`);
  } else {
    const res = runner(["plugin", "--profile", profile, "add", selfSpec]);
    if (!res || res.status !== 0) {
      return fail(`安装失败: ${self.name} (${failDetail(res)})`);
    }
  }
  rollbackNames.push(self.name);
  installedNames.push(self.name);

  // 4. smoke: dump again after the final add
  if (dryRun) {
    console.log(`[dry-run] 冒烟: dsh --profile ${profile} --dump-config`);
  } else {
    const res = runner(["--profile", profile, "--dump-config"]);
    if (!res || res.status !== 0) {
      return fail(`冒烟测试失败: dsh --profile ${profile} --dump-config ${failDetail(res)}`);
    }
  }

  return { ok: true, installed: installedNames };
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
