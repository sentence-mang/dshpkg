// dshpkg — update detection (module L).
//
// Compares what is installed against the latest known version from the
// recipe repos, answering "which of my plugins are out of date?" — WITHOUT
// writing anything. The CLI wires this into `dshpkg update --check` (and a
// future `dshpkg upgrade --dry-run`), which is strictly read-only.
//
// Pure functions: installed state and the latest-version table are inputs;
// there is no IO, no state mutation, no network. Version comparison reuses
// recipe.js compareVersions (the same tiny semver implementation the harness
// range matcher already trusts — zero new deps).

import { compareVersions } from "./recipe.js";

/**
 * Strip a trailing range/version qualifier from a dependency value so it can
 * be compared against a concrete latest version. pnpm lockfiles and
 * package.json may store "^1.2.3", "~1.2.3", ">=1.2.3", "workspace:*",
 * "npm:foo@1.2.3" or a git url — all reduce to their bare semver core when
 * present, else null (uncomparable, treated as "unknown current").
 *
 * @param {string} value raw version spec
 * @returns {string|null} bare semver ("1.2.3") or null
 */
export function bareVersion(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  // npm: alias form: "npm:other-pkg@1.2.3" -> "1.2.3"
  const alias = s.match(/@([0-9][^/@]*)$/);
  if (alias && /^\d/.test(alias[1])) return alias[1];
  // bare semver (optionally v-prefixed / prerelease)
  const bare = s.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  if (bare) return bare[1];
  // range operators and workspace/git/link specs have no single version
  if (/^[~^>=<*]/.test(s) || /^workspace:/.test(s) || /^[a-z]+:/.test(s)) return null;
  return null;
}

/**
 * Decide whether `current` is behind `latest`. Unparsable current versions
 * (ranges, git urls, missing) are NOT flagged — we can only report an update
 * when we can prove the installed version is strictly lower.
 *
 * @param {string|null} current installed version (bare semver preferred)
 * @param {string|null} latest latest version from the repo
 * @returns {boolean} true when latest > current
 */
export function isUpdateAvailable(current, latest) {
  if (!current || !latest) return false;
  const c = bareVersion(current);
  const l = bareVersion(latest);
  if (!c || !l) return false;
  return compareVersions(l, c) > 0;
}

/**
 * Build the update report for installed packages against the latest-version
 * table. Pure: no IO. Returns one record per installed package that has a
 * known latest version, flagging `updateable` when it is strictly behind.
 * Packages absent from the latest table are skipped (no repo claims them).
 *
 * @param {object} installed map name -> {version?: string|null, held?: boolean}
 * @param {Map<string,string>|object} latestByName name -> latest version
 * @returns {{name: string, current: string|null, latest: string,
 *   updateable: boolean, held: boolean}[]}
 */
export function checkUpdates(installed, latestByName) {
  const out = [];
  if (!installed || typeof installed !== "object") return out;
  for (const [name, pkg] of Object.entries(installed)) {
    const latest = latestByName?.[name];
    if (typeof latest !== "string" || !latest) continue;
    const current = typeof pkg?.version === "string" ? pkg.version : null;
    out.push({
      name,
      current,
      latest,
      updateable: isUpdateAvailable(current, latest),
      held: pkg?.held === true,
    });
  }
  return out;
}

/**
 * Merge a profile's real npm dependencies into the installed set, backfilling
 * plugins that the official `dsh plugin add` channel installed directly (and
 * dshpkg never recorded). Packages already in `installed` keep their richer
 * record; newly-seen dependency names gain `{ version: null }` (unknown
 * version, still detectable for update checks). Pure: no IO, no mutation —
 * returns a new object.
 *
 * @param {object} installed map name -> {version?, held?, ...} (state.packages)
 * @param {string[]} deps installed package names from the profile package.json
 * @returns {object} a new map name -> record
 */
export function mergeInstalledFromDeps(installed, deps) {
  const out = { ...(installed && typeof installed === "object" ? installed : {}) };
  if (!Array.isArray(deps)) return out;
  for (const depName of deps) {
    if (typeof depName !== "string" || !depName) continue;
    if (out[depName]) continue;
    out[depName] = { version: null };
  }
  return out;
}
