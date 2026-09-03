// dshpkg — dependency-aware disable protection (module S).
//
// Prevents the exact failure class seen in the 2026-09-03 incident: the
// bootguard auto-disabled dsh-remote-web-gateway (a crash culprit) without
// checking that it underpins the workspaceRegistry service used by other
// entries — cascading the whole tree into a crash loop. This module makes
// disable decisions dependency-aware and conservative:
//
//   reverseDeps    — package-level reverse dependency graph (who depends on X)
//   activeBaseline — entries that started fine at the last boot-confirmed
//   guardDisable   — refuse auto-disable when it would break working dependents
//
// All pure / DI; node:* only. The service-level relation is approximated by
// "the entry was alive in the last known-good boot" (baseline membership) —
// deliberately conservative: if we cannot prove a disable is safe, we refuse
// it and let the operator decide (upgrade / manual).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Package-level reverse dependency graph for the installed bundles.
 *
 * @param {string} profileDir profile directory (node_modules lives under it)
 * @returns {Promise<Record<string, string[]>>} map depName -> deduped sorted dependents
 */
export async function reverseDeps(profileDir) {
  const reverse = {};
  if (typeof profileDir !== "string" || profileDir === "") return reverse;
  const add = (dependent, depName) => {
    if (!depName || typeof depName !== "string") return;
    reverse[depName] ??= [];
    if (!reverse[depName].includes(dependent)) reverse[depName].push(dependent);
  };
  let dirEntries = [];
  try {
    const { readdir } = await import("node:fs/promises");
    dirEntries = await readdir(profileDir);
  } catch {
    return reverse;
  }
  // walk the top-level node_modules: <profileDir>/node_modules/<pkg>
  const nmDir = join(profileDir, "node_modules");
  let pkgDirs = [];
  try {
    const { readdir } = await import("node:fs/promises");
    pkgDirs = await readdir(nmDir);
  } catch {
    // no node_modules → empty graph
    return reverse;
  }
  const { stat } = await import("node:fs/promises");
  for (const entry of pkgDirs) {
    let manifestPath = join(nmDir, entry, "package.json");
    try {
      const st = await stat(manifestPath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== "object") continue;
    const dependent = entry;
    for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[section];
      if (deps && typeof deps === "object") {
        for (const dep of Object.keys(deps)) add(dependent, dep);
      }
    }
  }
  for (const key of Object.keys(reverse)) reverse[key].sort();
  return reverse;
}

/**
 * Approximate "entries that were alive at the last known-good boot":
 * names NOT implicated in the most recent crash cycle (they were working).
 * The last boot-confirmed incident marks the tree composing; entries named
 * as culprits before it are the "problem set" — everything else we know from
 * the stream is presumed healthy.
 *
 * @param {{incidents?: Array<object>, knownEntries?: string[]}} input
 *   incidents: parsed incident objects (type, detail, at/t)
 *   knownEntries: optional full entry id set (loader/bundles); when provided,
 *     the baseline is `knownEntries minus problemNames`.
 * @returns {Set<string>}
 */
export function activeBaseline({ incidents = [], knownEntries = [] } = {}) {
  const problem = new Set();
  for (const inc of incidents) {
    if (!inc || typeof inc !== "object") continue;
    if (inc.type === "uncaught-exception" || inc.type === "boot-failed") {
      const detail = typeof inc.detail === "string" ? inc.detail : "";
      for (const m of detail.matchAll(/loader entry (\S+?) \(/g)) problem.add(m[1]);
      for (const m of detail.matchAll(/^(@?[\w][\w./-]*): pending/gm)) problem.add(m[1]);
    }
  }
  if (Array.isArray(knownEntries) && knownEntries.length > 0) {
    const base = new Set();
    for (const id of knownEntries) {
      if (!problem.has(id) && typeof id === "string" && id) base.add(id);
    }
    return base;
  }
  return problem; // without a known set, treat "never-problem" signal as empty-ish
}

/**
 * Decide whether an auto-disable is SAFE.
 *
 * @param {string} candidate entry id to disable
 * @param {object} input
 * @param {Record<string, string[]>} [input.reverse] reverseDeps() output
 * @param {Set<string>} [input.baseline] activeBaseline() output
 * @param {(id: string) => boolean} [input.isProtected]
 * @param {boolean} [input.allowCulprit] when true, a stable culprit may still
 *   be disabled even if it has baseline dependents (operator override)
 * @returns {{allowed: boolean, risk: string[]}}
 */
export function guardDisable(candidate, {
  reverse = {},
  baseline = new Set(),
  isProtected = () => false,
  allowCulprit = false,
} = {}) {
  const name = String(candidate ?? "");
  const risk = [];
  if (!name) return { allowed: false, risk: ["空条目名"] };
  if (isProtected(name)) {
    risk.push(`核心保护条目（${name}），禁止自动禁用`);
    return { allowed: false, risk };
  }
  const dependents = (reverse[name] ?? []).filter((d) => baseline.has(d));
  if (dependents.length > 0 && !allowCulprit) {
    risk.push(
      `禁用 ${name} 会波及 ${dependents.length} 个基线内依赖方（${dependents.slice(0, 5).join("、")}），可能引发连锁崩溃；建议先 upgrade 或人工排查`,
    );
    return { allowed: false, risk };
  }
  if (dependents.length > 0) {
    risk.push(`注意：仍有 ${dependents.length} 个基线内依赖方（${dependents.slice(0, 3).join("、")}），allowCulprit 已放行`);
  }
  return { allowed: true, risk };
}