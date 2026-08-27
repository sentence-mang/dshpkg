// dshpkg — multi-source aggregation index (module E).
//
// Pulls three core public network sources (R1: no self-hosted service):
//   1. GitHub search API  (topic:dsh-plugin, sorted by stars)
//   2. npm registry search (text=dsh-plugin)
//   3. awesome-dsh-plugins curated README ("- [owner/repo](url) — description")
// (the dsh.so endpoint is no longer fetched by default — users can re-add it
// explicitly as a static index source, see OPTIONAL_SOURCES)
// plus two offline import sources under <DSH_HOME>/plugin-manager-cache
// (both never fail — a missing or corrupt file just contributes nothing,
// and both are re-read on every refresh because other tools update them):
//   4. marketplace.json — the full dsh ecosystem snapshot (ownerRepo as
//      items[].name, displayName, numeric dsh.so verification levels)
//   5. dshso-index.json — local dsh.so verification/security verdicts
//      overlaid onto the aggregated entries by name match (applied last)
//
// Every entry is normalized to one shape:
//   { key, name, ownerRepo, packageName, description, topics[], stars, url,
//     latestVersion, verification: {level, label}, security: {riskLevel, status} }
//
// De-duplication is dual-key: entries sharing an ownerRepo OR a packageName
// merge (gaps in the existing entry get filled from the newcomer). The key
// prefers packageName over ownerRepo.
//
// Writes <stateRoot>/index/items.json + index/meta.json (fetchedAt, count,
// lastError, sources). A 24h freshness gate skips non-forced refreshes. Any
// failure of the three core network sources is a negative cache UNLESS the
// local marketplace contributed entries — then the refresh still succeeds
// (offline-first: the anonymous GitHub API rate limit cannot starve the
// index) and meta.sources records each source's contribution. dsh.so network
// failures are ignored entirely.
//
// All fetches: 10s timeout (AbortSignal.timeout), UA "dshpkg/0.1", no auth.
// `fetcher` is injectable (defaults to globalThis.fetch); DSH_PKG_HOME
// overrides the state root, DSH_HOME locates the local cache (lib/state.js).

import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { statePath, readJson, dshHome } from "./state.js";

/** Default network sources (R1: no self-hosted service dependency). */
export const SOURCES = {
  github: "https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars",
  npm: "https://registry.npmjs.org/-/v1/search?text=dsh-plugin&size=250",
  awesome:
    "https://raw.githubusercontent.com/AdamPlatin123/awesome-dsh-plugins/main/README.md",
};

/**
 * Optional network sources, NOT fetched by default (R1, design §5). Users who
 * want the dsh.so index can add it explicitly as a static index source:
 *   dshpkg repo add https://www.dsh.so/api/plugins/index.json --format index
 */
export const OPTIONAL_SOURCES = {
  dshso: "https://www.dsh.so/api/plugins/index.json",
};

/**
 * Local cache files maintained by the dsh plugin-manager UI under DSH_HOME.
 * Both are optional offline sources; their absence is a skip, never an error.
 */
export function localMarketplacePath() {
  return join(dshHome(), "plugin-manager-cache", "marketplace.json");
}

export function localDshSoIndexPath() {
  return join(dshHome(), "plugin-manager-cache", "dshso-index.json");
}

/**
 * Atomic JSON write: temp file in the same directory, then rename. Uses a
 * collision-free temp name instead of state.js writeJsonAtomic — that helper
 * embeds the full (colon-containing) path in the temp file name, which
 * `rename` rejects on Windows (EINVAL).
 */
async function atomicWriteJson(filePath, value, space = 2) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await writeFile(tmp, JSON.stringify(value, null, space), "utf8");
  await rename(tmp, filePath);
}

export const FRESH_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 10_000;
export const USER_AGENT = "dshpkg/0.1";

/** Verification level ordering; higher wins during a merge. */
const VERIFICATION_RANK = { unknown: 0, unverified: 1, awesome: 2, verified: 3 };

/** Empty unified item with safe defaults. */
function baseItem() {
  return {
    key: "",
    name: "",
    ownerRepo: "",
    packageName: "",
    description: "",
    topics: [],
    stars: 0,
    url: "",
    latestVersion: null,
    verification: { level: "unknown", label: "未知" },
    security: { riskLevel: "unknown", status: "unreviewed" },
  };
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** JSON GET with 10s timeout + dshpkg UA; throws on non-2xx or bad JSON. */
export async function fetchJson(fetcher, url) {
  const res = await fetcher(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? "unknown"} for ${url}`);
  return await res.json();
}

/** Plain-text GET with 10s timeout + dshpkg UA (awesome README). */
export async function fetchText(fetcher, url) {
  const res = await fetcher(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/plain,text/markdown" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? "unknown"} for ${url}`);
  return await res.text();
}

/** Map one GitHub search API repo object to the unified item shape. */
export function normalizeGitHubItem(repo) {
  const ownerRepo = repo?.full_name ?? "";
  const item = baseItem();
  item.ownerRepo = ownerRepo;
  item.name = repo?.name ?? ownerRepo.split("/").pop() ?? "";
  item.description = repo?.description ?? "";
  item.topics = Array.isArray(repo?.topics)
    ? repo.topics.filter((t) => typeof t === "string")
    : [];
  item.stars = Number(repo?.stargazers_count) || 0;
  item.url = repo?.html_url ?? (ownerRepo ? `https://github.com/${ownerRepo}` : "");
  item.latestVersion = null; // the GitHub search API carries no version field
  item.verification = { level: "unverified", label: "未验证" };
  item.key = item.packageName || item.ownerRepo;
  return item;
}

/** Extract "owner/repo" from an npm links.repository/homepage value. */
function repoFromLinks(links) {
  const raw = String(links?.repository ?? links?.homepage ?? "");
  const m = raw.match(/github\.com[/:]([^/\s#]+)\/([^/\s#]+?)(?:\.git)?(?:[/#]|$)/i);
  return m ? `${m[1]}/${m[2]}` : "";
}

/** Map one npm search API package object to the unified item shape. */
export function normalizeNpmItem(pkg) {
  const item = baseItem();
  item.packageName = pkg?.name ?? "";
  item.name = item.packageName;
  item.description = pkg?.description ?? "";
  item.latestVersion = pkg?.version ?? null;
  item.url =
    pkg?.links?.npm ??
    (item.packageName
      ? `https://www.npmjs.com/package/${encodeURIComponent(item.packageName)}`
      : "");
  item.ownerRepo = repoFromLinks(pkg?.links);
  item.topics = Array.isArray(pkg?.keywords)
    ? pkg.keywords.filter((k) => typeof k === "string")
    : [];
  item.stars = 0; // the registry search carries no star count
  item.verification = { level: "unverified", label: "未验证" };
  item.key = item.packageName || item.ownerRepo;
  return item;
}

const ENTRY_LINE = /^\s*[-*+]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?:[—–-]\s*(.*?))?\s*$/;
const CATEGORY_LINE = /^\s*#{3,4}\s+(.+?)\s*$/;

/**
 * Parse the awesome-dsh-plugins README into [{ownerRepo, url, description,
 * category}]. Only "- [owner/repo](url) — description" lines count; table-of-
 * contents lines (no "/") and badge images are skipped. "owner/repo#subpkg"
 * entries keep the repo part only. Both "—" and "-" separators are accepted
 * (the real list mixes them).
 */
export function parseAwesomeMarkdown(text) {
  const items = [];
  let category = "";
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const section = line.match(CATEGORY_LINE);
    if (section) {
      category = section[1].replace(/[`*_~]/g, "").trim();
      continue;
    }
    const m = line.match(ENTRY_LINE);
    if (!m) continue;
    const title = m[1].trim();
    if (!title.includes("/")) continue; // curated entries are "owner/repo"
    items.push({
      ownerRepo: title.split("#")[0].trim(),
      url: m[2],
      description: (m[3] ?? "").trim(),
      category,
    });
  }
  return items;
}

/** Map one parsed awesome entry to the unified item shape. */
export function normalizeAwesomeItem(entry) {
  const item = baseItem();
  item.ownerRepo = entry.ownerRepo;
  item.name = entry.ownerRepo.split("/").pop() ?? entry.ownerRepo;
  item.description = entry.description ?? "";
  item.url = entry.url ?? "";
  item.topics = entry.category ? [entry.category] : [];
  item.stars = 0; // the curated list carries no star counts
  item.verification = { level: "awesome", label: "社区精选" };
  item.key = item.packageName || item.ownerRepo;
  return item;
}

/** Map one dsh.so verification entry to the unified item shape. */
export function normalizeDshSoItem(entry) {
  const item = baseItem();
  item.packageName = entry?.packageName ?? "";
  item.ownerRepo = entry?.ownerRepo ?? entry?.repo ?? "";
  item.name =
    entry?.name ?? item.packageName ?? item.ownerRepo.split("/").pop() ?? "";
  item.description = entry?.description ?? "";
  item.topics = Array.isArray(entry?.topics)
    ? entry.topics.filter((t) => typeof t === "string")
    : [];
  item.stars = Number(entry?.stars) || 0;
  item.url = entry?.url ?? "";
  item.latestVersion = entry?.latestVersion ?? entry?.version ?? null;
  item.verification = {
    level: entry?.verification?.level ?? "verified",
    label: entry?.verification?.label ?? "dsh.so 已验证",
  };
  item.security = {
    riskLevel: entry?.security?.riskLevel ?? "unknown",
    status: entry?.security?.status ?? "reviewed",
  };
  item.key = item.packageName || item.ownerRepo;
  return item;
}

/**
 * Map one marketplace.json cache item to the unified item shape. The cache
 * entry carries `name` as "owner/repo", `displayName` as the human name, and
 * numeric dsh.so verification levels (1=L1 Found, 2=L2 Structured,
 * 3=L3 Install spec); verification/security are passed through verbatim.
 */
export function normalizeLocalMarketplaceItem(entry) {
  const item = baseItem();
  item.ownerRepo = String(entry?.name ?? "").trim();
  item.packageName = String(entry?.packageName ?? "").trim();
  const repoName = item.ownerRepo.split("/").pop() ?? "";
  item.name =
    String(entry?.displayName ?? "").trim() || repoName || item.packageName;
  item.description = entry?.description ?? "";
  item.topics = Array.isArray(entry?.topics)
    ? entry.topics.filter((t) => typeof t === "string")
    : [];
  item.stars = Number(entry?.stars) || 0;
  item.url = entry?.url ?? "";
  item.latestVersion = entry?.latestVersion || null;
  if (isRecord(entry?.verification)) item.verification = { ...entry.verification };
  if (isRecord(entry?.security)) item.security = { ...entry.security };
  item.key = item.packageName || item.ownerRepo;
  return item;
}

function verificationRank(v) {
  const level = v?.level;
  // Local marketplace / dsh.so entries carry numeric levels (1..3) which
  // line up with the string scale (unverified=1, awesome=2, verified=3);
  // ties keep the earlier entry, strictly higher wins.
  if (typeof level === "number" && Number.isFinite(level)) return level;
  return VERIFICATION_RANK[level] ?? 0;
}

/**
 * Merge `incoming` into `acc`: existing non-empty fields win, gaps get filled,
 * topics union, stars take the max, the higher verification level wins and a
 * "reviewed" security status replaces an unreviewed one.
 */
export function mergeItems(acc, incoming) {
  const merged = { ...acc };
  for (const field of [
    "name",
    "ownerRepo",
    "packageName",
    "description",
    "url",
    "latestVersion",
  ]) {
    if (!merged[field] && incoming[field]) merged[field] = incoming[field];
  }
  merged.topics = [...new Set([...(acc.topics ?? []), ...(incoming.topics ?? [])])];
  merged.stars = Math.max(Number(acc.stars) || 0, Number(incoming.stars) || 0);
  if (verificationRank(incoming.verification) > verificationRank(acc.verification)) {
    merged.verification = incoming.verification;
  }
  const accReviewed = acc.security?.status === "reviewed";
  const incReviewed = incoming.security?.status === "reviewed";
  if (!accReviewed && incReviewed) {
    merged.security = incoming.security;
  } else if (
    incoming.security &&
    acc.security?.riskLevel === "unknown" &&
    incoming.security?.riskLevel !== "unknown"
  ) {
    merged.security = incoming.security;
  }
  merged.key = merged.packageName || merged.ownerRepo;
  return merged;
}

function createMaps() {
  return { byKey: new Map(), byOwnerRepo: new Map(), byPackageName: new Map() };
}

/** Insert one item into the dual-key maps, merging on key/ownerRepo/packageName. */
export function insertItem(maps, item) {
  const key = item.key?.toLowerCase();
  const ownerRepo = item.ownerRepo?.toLowerCase();
  const packageName = item.packageName?.toLowerCase();
  const existing =
    (key && maps.byKey.get(key)) ||
    (ownerRepo && maps.byOwnerRepo.get(ownerRepo)) ||
    (packageName && maps.byPackageName.get(packageName)) ||
    null;
  const merged = existing ? mergeItems(existing, item) : item;
  if (existing && merged !== existing) {
    // A merge can change the key (e.g. packageName fills in and outranks
    // ownerRepo); drop every stale reference to the pre-merge object so it
    // cannot leak into the collected items.
    for (const [k, v] of maps.byKey) {
      if (v === existing) maps.byKey.delete(k);
    }
    for (const [k, v] of maps.byOwnerRepo) {
      if (v === existing) maps.byOwnerRepo.delete(k);
    }
    for (const [k, v] of maps.byPackageName) {
      if (v === existing) maps.byPackageName.delete(k);
    }
  }
  if (merged.key) maps.byKey.set(merged.key.toLowerCase(), merged);
  if (merged.ownerRepo) maps.byOwnerRepo.set(merged.ownerRepo.toLowerCase(), merged);
  if (merged.packageName) maps.byPackageName.set(merged.packageName.toLowerCase(), merged);
  return merged;
}

function collectItems(maps) {
  const seen = new Set();
  const out = [];
  for (const item of maps.byKey.values()) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  for (const item of maps.byOwnerRepo.values()) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  for (const item of maps.byPackageName.values()) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** Merge a raw list of items with the same dual-key semantics. */
export function dedupeItems(items) {
  const maps = createMaps();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    insertItem(maps, item);
  }
  return collectItems(maps);
}

/** Extract verification entries from a dsh.so payload of unknown shape. */
function extractDshSoItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.plugins)) return value.plugins;
  return [];
}

/**
 * Import the local dsh marketplace cache
 * (<DSH_HOME>/plugin-manager-cache/marketplace.json) into unified items.
 * The source can never fail: a missing, corrupt or wrong-shaped file yields
 * { items: [], count: 0 }. Entries without both ownerRepo and packageName
 * are skipped (no usable key).
 */
export async function importLocalMarketplace() {
  const payload = await readJson(localMarketplacePath(), null);
  const entries = Array.isArray(payload?.items) ? payload.items : [];
  const items = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const item = normalizeLocalMarketplaceItem(entry);
    if (!item.key) continue;
    items.push(item);
  }
  return { items, count: items.length };
}

/**
 * Read the local dsh.so verification index
 * (<DSH_HOME>/plugin-manager-cache/dshso-index.json). Best-effort like the
 * network endpoint: missing or corrupt files read as [].
 */
export async function readLocalDshSoIndex() {
  const payload = await readJson(localDshSoIndexPath(), null);
  return Array.isArray(payload?.entries) ? payload.entries : [];
}

/**
 * Overlay the authoritative dsh.so verification/security verdicts onto the
 * aggregated items. An entry matches when its `name` equals an item's name
 * or packageName (case-insensitive); matched items get verification/security
 * replaced outright — even downward, dsh.so is the source of truth. Returns
 * the number of entries that matched at least one item.
 */
export function applyDshSoOverlay(items, entries) {
  if (!Array.isArray(items) || !Array.isArray(entries)) return 0;
  const byName = new Map();
  for (const item of items) {
    for (const field of [item?.name, item?.packageName]) {
      const key = String(field ?? "").trim().toLowerCase();
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(item);
    }
  }
  let applied = 0;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const key = String(entry?.name ?? "").trim().toLowerCase();
    const matches = key ? byName.get(key) : null;
    if (!matches || matches.length === 0) continue;
    const verification = isRecord(entry.verification)
      ? { ...entry.verification }
      : null;
    const security = isRecord(entry.security) ? { ...entry.security } : null;
    if (!verification && !security) continue;
    for (const item of matches) {
      if (verification) item.verification = verification;
      if (security) item.security = security;
    }
    applied += 1;
  }
  return applied;
}

/**
 * Refresh the index from the three core public network sources (GitHub / npm
 * / awesome) and the two local import sources under
 * <DSH_HOME>/plugin-manager-cache. The dsh.so network endpoint is NOT
 * fetched by default (R1); its LOCAL cache file still overlays verification
 * verdicts. The local sources never fail and are re-imported on every
 * refresh. When every network source fails but the local marketplace
 * contributed entries, the refresh still succeeds — offline-first, the
 * anonymous GitHub rate limit cannot starve the index (the network error is
 * still recorded in lastError).
 *
 * @param {{force?: boolean, fetcher?: Function}} opts
 * @returns {Promise<{ok: boolean, skipped: boolean, count: number,
 *   fetchedAt: string|null, lastError: string|null, sources: object|null}>}
 *   `sources` counts each source's contribution: github/npm/awesome = entries
 *   pulled, local = marketplace items imported, dshso = local dshso-index
 *   entries applied. Null when the freshness gate skipped the refresh.
 */
export async function refreshIndex({ force = false, fetcher } = {}) {
  const fetchImpl = fetcher ?? globalThis.fetch;
  const meta = await readJson(statePath("index", "meta.json"), null);
  const now = Date.now();
  const lastFetch = meta?.fetchedAt ? Date.parse(meta.fetchedAt) : NaN;

  // Freshness gate: a non-forced refresh within 24h of the last successful
  // pull is skipped entirely (no network calls, no local re-import).
  if (!force && Number.isFinite(lastFetch) && now - lastFetch < FRESH_MS) {
    return {
      ok: true,
      skipped: true,
      count: Number(meta?.count) || 0,
      fetchedAt: meta.fetchedAt,
      lastError: meta?.lastError ?? null,
      sources: meta?.sources ?? null,
    };
  }

  // Local import sources first (they never fail; missing files just skip).
  // Both files are re-read on every refresh — other tools may update them
  // between runs.
  const local = await importLocalMarketplace();
  const dshsoLocal = await readLocalDshSoIndex();

  const settled = await Promise.allSettled([
    fetchJson(fetchImpl, SOURCES.github),
    fetchJson(fetchImpl, SOURCES.npm),
    fetchText(fetchImpl, SOURCES.awesome),
  ]);
  const [github, npm, awesome] = settled;

  // Negative cache: with no local marketplace entries, any core-source
  // failure keeps the previous items.json untouched and records the attempt
  // in meta.json lastError, so the next non-forced refresh still retries.
  // With local entries the refresh succeeds offline instead.
  const failed = [github, npm, awesome].filter((s) => s.status === "rejected");
  if (failed.length > 0 && local.count === 0) {
    const lastError = String(failed[0].reason?.message ?? failed[0].reason);
    const nextMeta = {
      fetchedAt: meta?.fetchedAt ?? null,
      count: Number(meta?.count) || 0,
      lastError,
      sources: meta?.sources ?? null,
    };
    await atomicWriteJson(statePath("index", "meta.json"), nextMeta);
    return {
      ok: false,
      skipped: false,
      count: nextMeta.count,
      fetchedAt: nextMeta.fetchedAt,
      lastError,
      sources: nextMeta.sources,
    };
  }

  const maps = createMaps();
  const sources = { github: 0, npm: 0, awesome: 0, local: local.count, dshso: 0 };
  // Local items first: the full ecosystem snapshot is the base layer, the
  // network sources only fill gaps and add entries the cache lacks.
  for (const item of local.items) {
    insertItem(maps, item);
  }
  if (github.status === "fulfilled") {
    for (const repo of github.value?.items ?? []) {
      insertItem(maps, normalizeGitHubItem(repo));
      sources.github += 1;
    }
  }
  if (npm.status === "fulfilled") {
    for (const obj of npm.value?.objects ?? []) {
      insertItem(maps, normalizeNpmItem(obj?.package));
      sources.npm += 1;
    }
  }
  if (awesome.status === "fulfilled") {
    for (const entry of parseAwesomeMarkdown(awesome.value)) {
      insertItem(maps, normalizeAwesomeItem(entry));
      sources.awesome += 1;
    }
  }

  const items = collectItems(maps);
  // Authoritative dsh.so verification overlay, applied last so it wins over
  // every merged verdict (including the network dsh.so entries above).
  sources.dshso = applyDshSoOverlay(items, dshsoLocal);

  const fetchedAt = new Date().toISOString();
  // A network failure with local entries still counts as a successful
  // refresh, but the error stays visible for diagnostics.
  const lastError =
    failed.length > 0 ? String(failed[0].reason?.message ?? failed[0].reason) : null;
  await atomicWriteJson(statePath("index", "items.json"), items);
  await atomicWriteJson(statePath("index", "meta.json"), {
    fetchedAt,
    count: items.length,
    lastError,
    sources,
  });
  return {
    ok: true,
    skipped: false,
    count: items.length,
    fetchedAt,
    lastError,
    sources,
  };
}

/**
 * Read the local index items. Returns null when missing or unparsable,
 * [] for a valid empty index.
 */
export async function readIndex() {
  const items = await readJson(statePath("index", "items.json"), null);
  return Array.isArray(items) ? items : null;
}
