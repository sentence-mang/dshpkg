// dshpkg — read-only DSH profile bundle introspection (module K).
//
// A real DSH profile is a pnpm-managed npm package: its package.json carries
// `dependencies` (every installed plugin, bundle or not) plus
// `dsh.profile.bundles` (the subset whose manifest declares dsh.bundle.patch
// and therefore joins the bundle layer list). dshpkg's own recipe model is
// completely separate from this npm reality — this module is the READ-ONLY
// bridge that lets a future supervisor inspect what a profile actually has
// installed (e.g. attribute a crash to a just-installed bundle).
//
// Hard guarantees (H1-H6):
//   - pure ESM, node:* only, zero third-party deps;
//   - READ-ONLY: no network, no writes, no state mutation;
//   - the profile dir is an EXPLICIT argument — the default is "disabled"
//     (empty result), never auto-reading a real ~/.dsh/profiles path;
//   - tests point at a temp fixture dir, never a real profile.

import { join } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Read a DSH profile's package.json and split its npm reality into
 * `{ bundles, deps }`.
 *
 * `bundles` is the list of names declared in dsh.profile.bundles (the
 * bundle-layer plugins); `deps` is every name in package.json dependencies
 * (the full installed set). Both are deduplicated and sorted. The result is
 * `{ bundles: [], deps: [] }` when the profile dir is falsy, missing, or its
 * package.json is unreadable/invalid — this is a pure introspection helper
 * and never throws.
 *
 * @param {string} [profileDir] absolute path of the profile directory; when
 *   null/undefined/empty the function is DISABLED and returns empty lists
 *   (it never guesses a real profile location).
 * @returns {Promise<{bundles: string[], deps: string[]}>}
 */
export async function readProfileBundles(profileDir) {
  if (typeof profileDir !== "string" || profileDir.trim() === "") {
    return { bundles: [], deps: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  } catch {
    return { bundles: [], deps: [] };
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { bundles: [], deps: [] };
  }
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((n) => typeof n === "string" && n)
    : [];
  const deps =
    manifest.dependencies && typeof manifest.dependencies === "object"
      ? Object.keys(manifest.dependencies).filter((n) => typeof n === "string" && n)
      : [];
  const uniq = (list) => [...new Set(list)].sort();
  return { bundles: uniq(bundles), deps: uniq(deps) };
}

/**
 * True when a package name is declared as a bundle in the given profile.
 * Convenience over readProfileBundles for single-name attribution checks
 * (read-only, same disabled-by-default semantics).
 *
 * @param {string} [profileDir] profile directory (null/empty = disabled)
 * @param {string} name package name to test
 * @returns {Promise<boolean>}
 */
export async function isBundle(profileDir, name) {
  if (typeof name !== "string" || name === "") return false;
  const { bundles } = await readProfileBundles(profileDir);
  return bundles.includes(name);
}
