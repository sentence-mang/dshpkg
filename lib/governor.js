// dshpkg — resource governor (module P): memory-budget policy + bundle load
// order orchestration.
//
// Pure decision logic, zero third-party dependencies (node:* only). It decides
// WHAT to do when the dsh process approaches its memory budget and HOW to order
// bundles for a fast, stable startup — but never performs the actions itself:
// callers (CLI / host) are responsible for writing the reversible
// cordis.patch.yml disable block or reordering dsh.profile.bundles.
//
// Boundaries (project contract): this module only governs the dsh plugin set —
// it never touches OS-level settings, spawns services, or caps the dsh core's
// own memory. 500 MiB is a configurable budget constant, not a hard process
// limit.

/** Base/guard bundle names that must stay at the front of the load order. */
export const DEFAULT_GUARD_BUNDLES = [
  "dshpkg",
  "loader",
  "include",
  "cordis-host-runner",
  "web-startup",
  "web-runtime",
  "api-gateway",
];

/** Budget ratio bands: >= yellow starts warning, >= red triggers relief. */
export const BUDGET_LEVELS = { yellow: 0.7, red: 1.0 };

/**
 * Memory pressure level from RSS vs budget.
 *
 * @param {{rss?: number, budget?: number}} input
 * @returns {"green"|"yellow"|"red"}
 */
export function budgetLevel({ rss = 0, budget = 0 } = {}) {
  if (!(budget > 0)) return "green";
  const ratio = rss / budget;
  if (ratio >= BUDGET_LEVELS.red) return "red";
  if (ratio >= BUDGET_LEVELS.yellow) return "yellow";
  return "green";
}

/**
 * Which installed plugins to consider relieving first: the heaviest
 * non-protected, non-held entries with a known positive disk size, sorted by
 * size descending (ties by name). Pure decision — returns a recommendation.
 *
 * @param {{scores?: Array, isProtected?: Function, heldNames?: Array|Set, limit?: number}} input
 *   scores: scorePlugins() output, each {name, bytes, held, score}
 * @returns {Array<{name: string, bytes: number, score: number, reason: string}>}
 */
export function reliefCandidates({
  scores = [],
  isProtected = null,
  heldNames = [],
  limit = 3,
} = {}) {
  const held = new Set(heldNames ?? []);
  const protect = typeof isProtected === "function" ? isProtected : () => false;
  return scores
    .filter((e) => Number.isFinite(e?.bytes) && e.bytes > 0)
    .filter((e) => !protect(e.name) && !e.held && !held.has(e.name))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((e) => ({
      name: e.name,
      bytes: e.bytes,
      score: e.score ?? 0,
      reason: `体积 ${e.bytes} 字节，建议禁用以释放内存（dshpkg enable ${e.name} 可恢复）`,
    }));
}

/**
 * One-round eviction plan: when the budget is red, disable the heaviest
 * candidates. Reversible by construction (the caller writes a disable block).
 *
 * @param {{rss?: number, budget?: number, scores?: Array, isProtected?: Function, heldNames?: Array, limit?: number}} input
 * @returns {{level: "green"|"yellow"|"red", actions: Array<{kind: "disable", name: string, reason: string}>, summary: string}}
 */
export function evictionPlan({
  rss = 0,
  budget = 0,
  scores = [],
  isProtected = null,
  heldNames = [],
  limit = 3,
} = {}) {
  const level = budgetLevel({ rss, budget });
  if (level === "green") {
    return { level, actions: [], summary: "内存充足（绿区）" };
  }
  if (level === "yellow") {
    return {
      level,
      actions: [],
      summary: "接近内存预算（黄区），暂不自动卸载；可在超预算前手动处理重插件",
    };
  }
  const candidates = reliefCandidates({ scores, isProtected, heldNames, limit });
  return {
    level,
    actions: candidates.map((c) => ({ kind: "disable", name: c.name, reason: c.reason })),
    summary:
      candidates.length > 0
        ? `超出内存预算，建议禁用 ${candidates.length} 个最重的空闲插件`
        : "超出内存预算但无非保护可禁用插件",
  };
}

/**
 * Order bundles for a fast, stable startup: guard/base layer first (in
 * declaration order), then the remaining bundles by dependency topological
 * sort (Kahn's algorithm). Cycles and unknown entries are appended in input
 * order — the orchestration must never drop a bundle, only reorder it.
 *
 * @param {{bundles?: Array<string>, deps?: object, guardNames?: Array<string>}} input
 *   bundles: current dsh.profile.bundles (plain names)
 *   deps: { [name]: string | string[] } declared dependency of each bundle
 *   guardNames: names that must stay first (default DEFAULT_GUARD_BUNDLES)
 * @returns {{ordered: Array<string>, missing: Array<string>, cycles: Array<string>}}
 */
export function composeBundleOrder({
  bundles = [],
  deps = {},
  guardNames = DEFAULT_GUARD_BUNDLES,
} = {}) {
  const names = [...new Set(bundles)];
  const guard = guardNames.filter((g) => names.includes(g));
  const rest = names.filter((n) => !guard.includes(n));
  const inRest = new Set(rest);

  // edge n -> deps of n that are themselves in `rest` (self-loops ignored)
  const edges = new Map();
  for (const n of rest) {
    const raw = deps[n];
    const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    edges.set(n, new Set(list.filter((d) => inRest.has(d) && d !== n)));
  }

  const indeg = new Map(rest.map((n) => [n, 0]));
  for (const n of rest) {
    indeg.set(n, edges.get(n).size);
  }

  const ordered = [];
  const queued = new Set();
  const queue = rest.filter((n) => indeg.get(n) === 0);
  for (const n of queue) queued.add(n);
  while (queue.length > 0) {
    const n = queue.shift();
    ordered.push(n);
    for (const m of rest) {
      if (m === n || !edges.get(m).has(n)) continue;
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0 && !queued.has(m)) {
        queue.push(m);
        queued.add(m);
      }
    }
  }

  const cycles = rest.filter((n) => !ordered.includes(n));

  // deps referenced that are not in the bundle set at all
  const known = new Set(names);
  const missing = [];
  for (const n of rest) {
    const raw = deps[n];
    const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    for (const d of list) {
      if (d !== n && !known.has(d) && !missing.includes(d)) missing.push(d);
    }
  }

  return { ordered: [...guard, ...ordered, ...cycles], missing, cycles };
}
