// dshpkg — profile bundle ordering (module M).
//
// The DSH kernel composes the entry tree by applying each bundle's patch
// layer in `dsh.profile.bundles` ORDER (verified dsh-app-boot fact); the
// official `dsh plugin add` reconciler only APPENDS new bundles at the end,
// so load order is uncontrolled there. This module is the package-manager
// side of the ordering contract: after every successful transaction the
// bundles list is re-layered deterministically:
//
//   1. kernel layer  — @deepseek-ai/* bundles first, relative order kept;
//   2. guardian layer — dshpkg itself and boot-guard-class plugins next,
//      in declared guardian order;
//   3. everything else — stable topological order over the bundle
//      dependency graph (a bundle that depends on another bundle loads
//      after it), original relative order as the tie-break; cycle members
//      keep their original relative order (ordering must never block boot).
//
// Bundles no longer present in the profile dependencies are dropped (the
// installed dependency set is the single source of truth). All pure
// functions take their inputs as arguments; the two IO helpers read/write
// the profile package.json atomically (tmp + rename, same convention as
// state.js) and only touch an EXPLICITLY passed profile directory — tests
// use temp dirs, never the real ~/.dsh/profiles.

import { join, dirname, basename } from "node:path";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { pkgRoot, withSyncLock } from "./state.js";

/** Package-name prefix of the kernel (in-box) bundles. */
export const KERNEL_PREFIX = "@deepseek-ai/";

/**
 * Kernel layer templates by profile name (dsh-app-boot PROFILE_TEMPLATES
 * parity). Used to COMPLETE a bundles list whose kernel layer is entirely
 * missing — a profile without any kernel bundle cannot boot. A partial
 * kernel layer is kept as-is (adding a single kernel to a custom profile
 * could break it).
 */
export const KERNEL_TEMPLATES = {
  web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
  headless: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
};

/** Kernel fallback for profiles with no shipped template. */
export const KERNEL_FALLBACK = ["@deepseek-ai/dsh-base"];

/**
 * Default guardian layer: dshpkg itself first (it must be in-process before
 * any other third-party bundle applies patches), then the boot-guard class.
 * Only guardians actually present in the bundles list are layered.
 */
export const DEFAULT_GUARDIANS = ["@sentencemang/dshpkg", "dsh-boot-guard"];

/** Read a JSON file; missing or unparsable content reads as the fallback. */
async function readJsonOr(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Stable topological order (deps before dependents) via Kahn's algorithm.
 * Readiness is scanned in ORIGINAL order, so independent bundles keep their
 * relative order — an empty/missing graph returns the input unchanged.
 * Cycle members are appended at the end in original relative order (the
 * guard is reported so callers can surface a warning; a bundle-ordering
 * helper must never fail outright).
 *
 * @param {string[]} names nodes to order
 * @param {Map<string, Set<string>>} graph node -> set of nodes it depends on
 * @returns {{order: string[], guard: string[]}}
 */
export function topoStable(names, graph) {
  const list = names.filter((n) => typeof n === "string" && n);
  const nodeSet = new Set(list);
  const indegree = new Map();
  const dependents = new Map(); // dependency -> dependents (original edge order)
  for (const name of list) {
    indegree.set(name, 0);
    dependents.set(name, []);
  }
  for (const name of list) {
    const deps = graph?.get(name);
    if (!deps) continue;
    for (const dep of deps) {
      if (typeof dep !== "string" || dep === name) continue;
      if (!nodeSet.has(dep)) continue; // dep outside the node set: ignore
      indegree.set(name, indegree.get(name) + 1);
      dependents.get(dep).push(name);
    }
  }
  const order = [];
  const done = new Set();
  const ready = list.filter((name) => indegree.get(name) === 0);
  for (let i = 0; i < ready.length; i++) {
    const name = ready[i];
    order.push(name);
    done.add(name);
    for (const dependent of dependents.get(name)) {
      if (done.has(dependent)) continue;
      const left = indegree.get(dependent) - 1;
      indegree.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }
  const guard = list.filter((name) => !done.has(name));
  return { order: [...order, ...guard], guard };
}

/**
 * Re-layer a profile bundles list deterministically (pure, never throws):
 * kernel (@deepseek-ai/*) first, then the guardian layer, then the rest in
 * stable topological order over depGraph. Non-kernel entries absent from
 * `deps` are dropped (pass deps: null to keep every entry); kernel bundles
 * are NEVER dep-filtered — in-box template bundles are not profile
 * dependencies by kernel design. Duplicates are removed (first occurrence
 * wins); malformed inputs degrade to best-effort output.
 *
 * @param {string[]} bundles current dsh.profile.bundles list
 * @param {string[]|null} deps installed dependency names (null = no filtering)
 * @param {Map<string, Set<string>>} [depGraph] bundle -> bundles it depends on
 * @param {{guardians?: string[]}} [opts] guardian layer override
 * @returns {string[]} the re-layered bundles list
 */
export function orderBundles(bundles, deps, depGraph, opts = {}) {
  const raw = Array.isArray(bundles)
    ? bundles.filter((n) => typeof n === "string" && n.trim() !== "")
    : [];
  const seen = new Set();
  const deduped = [];
  for (const name of raw) {
    if (seen.has(name)) continue;
    seen.add(name);
    deduped.push(name);
  }
  const depSet = Array.isArray(deps) ? new Set(deps) : null;
  // Kernel bundles are exempt from the dependency filter: in-box template
  // bundles (dsh-base, dsh-web-app, ...) are never profile dependencies.
  const kept = depSet
    ? deduped.filter(
        (name) => name.startsWith(KERNEL_PREFIX) || depSet.has(name),
      )
    : deduped;

  const guardians = (
    Array.isArray(opts.guardians) && opts.guardians.length > 0
      ? opts.guardians
      : DEFAULT_GUARDIANS
  ).filter((g) => typeof g === "string" && g);

  const kernel = kept.filter((name) => name.startsWith(KERNEL_PREFIX));
  const guardianSet = new Set(guardians);
  const guardianLayer = guardians.filter(
    (g) => kept.includes(g) && !g.startsWith(KERNEL_PREFIX),
  );
  const rest = kept.filter(
    (name) => !name.startsWith(KERNEL_PREFIX) && !guardianSet.has(name),
  );
  const { order } = topoStable(rest, depGraph);
  return [...kernel, ...guardianLayer, ...order];
}

/**
 * Build the bundle dependency graph from the profile's node_modules: for
 * each bundle that is installed, its manifest's `dependencies` keys that are
 * THEMSELVES bundles become edges. A missing manifest contributes no edges.
 *
 * @param {string} profileDir absolute profile directory
 * @param {string[]} bundles bundle names to inspect
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function buildDepGraph(profileDir, bundles) {
  const graph = new Map();
  if (typeof profileDir !== "string" || profileDir.trim() === "") return graph;
  const bundleSet = new Set(Array.isArray(bundles) ? bundles : []);
  for (const name of bundleSet) {
    if (typeof name !== "string" || !name) continue;
    const manifest = await readJsonOr(
      join(profileDir, "node_modules", ...name.split("/"), "package.json"),
      null,
    );
    const edges = new Set();
    const deps = manifest?.dependencies;
    if (deps && typeof deps === "object") {
      for (const depName of Object.keys(deps)) {
        if (bundleSet.has(depName)) edges.add(depName);
      }
    }
    graph.set(name, edges);
  }
  return graph;
}

/**
 * Scan the installed face (the profile's node_modules) and return every
 * dependency whose manifest declares `dsh.bundle.patch` — the kernel's
 * exportsPatch semantics, reimplemented locally so dshpkg never trusts the
 * official reconciler's bookkeeping. Reads only, never throws; an unreadable
 * manifest contributes nothing. Scoped names resolve through their directory
 * segments (node_modules/@scope/name/package.json).
 *
 * @param {string} profileDir absolute profile directory (explicit; no guessing)
 * @returns {Promise<string[]>} installed dependency names that are bundles
 */
export async function collectDeclaredBundles(profileDir) {
  if (typeof profileDir !== "string" || profileDir.trim() === "") return [];
  const manifest = await readJsonOr(join(profileDir, "package.json"), null);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const depNames =
    manifest.dependencies && typeof manifest.dependencies === "object"
      ? Object.keys(manifest.dependencies)
      : [];
  const out = [];
  for (const name of depNames) {
    if (typeof name !== "string" || !name) continue;
    const depManifest = await readJsonOr(
      join(profileDir, "node_modules", ...name.split("/"), "package.json"),
      null,
    );
    if (
      depManifest &&
      typeof depManifest === "object" &&
      depManifest.dsh?.bundle?.patch !== undefined
    ) {
      out.push(name);
    }
  }
  return out;
}

/**
 * Atomic package.json write: stage next to the target, rename into place.
 * 2-space indentation + trailing newline, matching the kernel's
 * writeProfileManifest output so a reorder is the ONLY visible change.
 */
async function writeProfileManifestAtomic(profileDir, manifest) {
  const file = join(profileDir, "package.json");
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

/**
 * Compute the registration-reconcile + re-layer plan WITHOUT writing: the
 * installed face is the single source of truth — any installed dependency
 * declaring dsh.bundle that is missing from dsh.profile.bundles gets
 * registered (the `registered` output), the kernel layer is completed when
 * entirely absent, and the union is re-layered. `changed` compares the
 * computed order against the on-disk list, so a pure registration add
 * always counts as a change. Never throws.
 *
 * @param {string} profileDir absolute profile directory
 * @param {{guardians?: string[]}} [opts]
 * @returns {Promise<{changed: boolean, order: string[], registered: string[], manifest: object|null}>}
 */
export async function computeReorder(profileDir, opts = {}) {
  if (typeof profileDir !== "string" || profileDir.trim() === "") {
    return { changed: false, order: [], registered: [], manifest: null };
  }
  const manifest = await readJsonOr(join(profileDir, "package.json"), null);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { changed: false, order: [], registered: [], manifest: null };
  }
  let bundles = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((n) => typeof n === "string" && n)
    : [];
  // The on-disk list is the baseline for the "did anything change" check;
  // kernel completion and registration below are themselves changes and
  // must not be masked. COPY it: the registration loop mutates `bundles`
  // in place below.
  const original = [...bundles];
  // Complete a MISSING kernel layer from the profile's shipped template
  // (profile name = the directory basename). Only an entirely absent
  // kernel layer is completed; a partial one stays untouched.
  if (!bundles.some((n) => n.startsWith(KERNEL_PREFIX))) {
    bundles = [
      ...(KERNEL_TEMPLATES[basename(profileDir)] ?? KERNEL_FALLBACK),
      ...bundles,
    ];
  }
  // Registration reconciliation: an installed bundle the official reconciler
  // never registered (or one installed outside dshpkg entirely) is added
  // here — the re-layer below puts it in its proper place.
  const registered = [];
  for (const name of await collectDeclaredBundles(profileDir)) {
    if (!bundles.includes(name)) {
      bundles.push(name);
      registered.push(name);
    }
  }
  const depNames =
    manifest.dependencies && typeof manifest.dependencies === "object"
      ? Object.keys(manifest.dependencies)
      : [];
  const graph = await buildDepGraph(profileDir, bundles);
  const order = orderBundles(bundles, depNames, graph, opts);

  const changed =
    order.length !== original.length ||
    !order.every((n, i) => n === original[i]);
  return { changed, order, registered, manifest };
}

/**
 * Dry-run variant of reorderProfileBundles: computes the reconcile plan
 * (registration adds + re-layered order) without touching the manifest.
 */
export async function planReorder(profileDir, opts = {}) {
  const { changed, order, registered } = await computeReorder(profileDir, opts);
  return { changed, order, registered };
}

/**
 * Reconcile registrations and re-layer the profile's `dsh.profile.bundles`
 * in place (installed face = single source of truth). The write is atomic
 * and SKIPPED entirely when the computed order equals the current one. A
 * missing/unparsable package.json returns { changed: false } — this helper
 * never throws.
 *
 * @param {string} profileDir absolute profile directory (explicit; no guessing)
 * @param {{guardians?: string[]}} [opts]
 * @returns {Promise<{changed: boolean, order: string[], registered: string[]}>}
 */
export async function reorderProfileBundles(profileDir, opts = {}) {
  // R19: the profile manifest is shared with the CLI and the watchdog —
  // serialize the read-compute-write under the sync lock.
  return withSyncLock(() => reorderProfileBundlesImpl(profileDir, opts));
}

async function reorderProfileBundlesImpl(profileDir, opts = {}) {
  const plan = await computeReorder(profileDir, opts);
  if (!plan.manifest) return { changed: false, order: [], registered: [] };
  if (!plan.changed) {
    return { changed: false, order: plan.order, registered: plan.registered };
  }
  const next = {
    ...plan.manifest,
    dsh: {
      ...plan.manifest.dsh,
      profile: {
        ...plan.manifest.dsh?.profile,
        bundles: plan.order,
      },
    },
  };
  await writeProfileManifestAtomic(profileDir, next);
  return { changed: true, order: plan.order, registered: plan.registered };
}

/**
 * R2 bootstrap: make sure dshpkg ITSELF is declared as a bundle in the
 * profile, then re-layer so it lands right after the kernel. The package
 * name comes from this package's own manifest (pkgRoot()), never hardcoded.
 * Appending at the end before the reorder is safe: the reorder places it in
 * the guardian layer regardless of where it entered the list.
 *
 * @param {string} profileDir absolute profile directory (explicit; no guessing)
 * @param {{guardians?: string[]}} [opts]
 * @returns {Promise<{ok: boolean, added: boolean, order: string[], error?: string}>}
 */
export async function ensureDshpkgBundle(profileDir, opts = {}) {
  const ownManifest = await readJsonOr(join(pkgRoot(), "package.json"), null);
  const selfName =
    typeof ownManifest?.name === "string" ? ownManifest.name.trim() : "";
  if (!selfName) {
    return { ok: false, added: false, order: [], error: "无法读取 dshpkg 自身的包名" };
  }
  const manifest = await readJsonOr(join(profileDir, "package.json"), null);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, added: false, order: [], error: `profile 清单不可读: ${profileDir}` };
  }
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((n) => typeof n === "string" && n)
    : [];
  let added = false;
  if (!bundles.includes(selfName)) {
    bundles.push(selfName);
    added = true;
    const next = {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles,
        },
      },
    };
    await writeProfileManifestAtomic(profileDir, next);
  }
  const { order } = await reorderProfileBundles(profileDir, opts);
  return { ok: true, added, order };
}

/**
 * R20 name drift: a declared dependency whose installed package.json carries
 * a DIFFERENT name (typically a link:/github: install registered under a
 * foreign key) breaks dsh's runtime bundle resolution — the loader imports
 * the REAL name, which is absent from node_modules. Pure read; never throws.
 *
 * @param {string} profileDir absolute profile directory
 * @returns {Promise<Array<{key: string, realName: string}>>}
 */
export async function detectNameDrift(profileDir) {
  const manifest = await readJsonOr(join(profileDir, "package.json"), null);
  const deps = manifest?.dependencies;
  if (!deps || typeof deps !== "object") return [];
  const drift = [];
  for (const key of Object.keys(deps)) {
    const installed = await readJsonOr(
      join(profileDir, "node_modules", ...key.split("/"), "package.json"),
      null,
    );
    const realName = typeof installed?.name === "string" ? installed.name.trim() : "";
    if (realName && realName !== key) drift.push({ key, realName });
  }
  return drift;
}

/**
 * R20 --fix: rewrite the profile manifest so the dependency key AND the
 * bundles entry use the package's REAL name (the version spec is kept).
 * dsh re-links the junction under the correct name on its next boot. The
 * repair refuses to clobber an existing dependency with the real name.
 * Atomic write; never throws.
 *
 * @param {string} profileDir absolute profile directory
 * @returns {Promise<{repaired: string[]}>} entries like "key -> realName"
 */
export async function repairNameDrift(profileDir) {
  const drift = await detectNameDrift(profileDir);
  if (drift.length === 0) return { repaired: [] };
  const manifest = await readJsonOr(join(profileDir, "package.json"), null);
  if (!manifest || typeof manifest !== "object") return { repaired: [] };
  const repaired = [];
  for (const { key, realName } of drift) {
    if (!manifest.dependencies || !(key in manifest.dependencies)) continue;
    if (realName in manifest.dependencies) continue; // never clobber
    manifest.dependencies[realName] = manifest.dependencies[key];
    delete manifest.dependencies[key];
    const bundles = manifest.dsh?.profile?.bundles;
    if (Array.isArray(bundles)) {
      for (let i = 0; i < bundles.length; i += 1) {
        if (bundles[i] === key) bundles[i] = realName;
      }
    }
    repaired.push(`${key} -> ${realName}`);
  }
  if (repaired.length > 0) {
    await writeProfileManifestAtomic(profileDir, manifest);
  }
  return { repaired };
}
