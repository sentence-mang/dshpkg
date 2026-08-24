// dshpkg — four-source aggregation index (module E).
//
// Pulls four sources:
//   1. GitHub search API  (topic:dsh-plugin, sorted by stars)
//   2. npm registry search (text=dsh-plugin)
//   3. awesome-dsh-plugins curated README ("- [owner/repo](url) — description")
//   4. dsh.so verification index (best-effort only; its failure is ignored)
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
// lastError). A 24h freshness gate skips non-forced refreshes. Any failure of
// the three core sources (GitHub/npm/awesome) is a negative cache: the old
// index stays on disk and lastError records the attempt. dsh.so failures are
// ignored entirely.
//
// All fetches: 10s timeout (AbortSignal.timeout), UA "dshpkg/0.1", no auth.
// `fetcher` is injectable (defaults to globalThis.fetch); DSH_PKG_HOME
// overrides the state root (see lib/state.js).

import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { statePath, readJson } from "./state.js";

/** Source URLs. dshso is best-effort: endpoint not part of the contract. */
export const SOURCES = {
  github: "https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars",
  npm: "https://registry.npmjs.org/-/v1/search?text=dsh-plugin&size=250",
  awesome:
    "https://raw.githubusercontent.com/AdamPlatin123/awesome-dsh-plugins/main/README.md",
  dshso: "https://www.dsh.so/api/plugins/index.json",
};

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

function verificationRank(v) {
  return VERIFICATION_RANK[v?.level] ?? 0;
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
 * Refresh the four-source index.
 *
 * @param {{force?: boolean, fetcher?: Function}} opts
 * @returns {Promise<{ok: boolean, skipped: boolean, count: number,
 *   fetchedAt: string|null, lastError: string|null}>}
 */
export async function refreshIndex({ force = false, fetcher } = {}) {
  const fetchImpl = fetcher ?? globalThis.fetch;
  const meta = await readJson(statePath("index", "meta.json"), null);
  const now = Date.now();
  const lastFetch = meta?.fetchedAt ? Date.parse(meta.fetchedAt) : NaN;

  // Freshness gate: a non-forced refresh within 24h of the last successful
  // pull is skipped entirely (no network calls).
  if (!force && Number.isFinite(lastFetch) && now - lastFetch < FRESH_MS) {
    return {
      ok: true,
      skipped: true,
      count: Number(meta?.count) || 0,
      fetchedAt: meta.fetchedAt,
      lastError: meta?.lastError ?? null,
    };
  }

  const settled = await Promise.allSettled([
    fetchJson(fetchImpl, SOURCES.github),
    fetchJson(fetchImpl, SOURCES.npm),
    fetchText(fetchImpl, SOURCES.awesome),
    fetchJson(fetchImpl, SOURCES.dshso), // best-effort, failure ignored below
  ]);
  const [github, npm, awesome, dshso] = settled;

  // Negative cache: any core-source failure keeps the previous items.json
  // untouched and records the attempt in meta.json lastError, so the next
  // non-forced refresh still retries.
  const failed = [github, npm, awesome].filter((s) => s.status === "rejected");
  if (failed.length > 0) {
    const lastError = String(failed[0].reason?.message ?? failed[0].reason);
    const nextMeta = {
      fetchedAt: meta?.fetchedAt ?? null,
      count: Number(meta?.count) || 0,
      lastError,
    };
    await atomicWriteJson(statePath("index", "meta.json"), nextMeta);
    return {
      ok: false,
      skipped: false,
      count: nextMeta.count,
      fetchedAt: nextMeta.fetchedAt,
      lastError,
    };
  }

  const maps = createMaps();
  for (const repo of github.value?.items ?? []) {
    insertItem(maps, normalizeGitHubItem(repo));
  }
  for (const obj of npm.value?.objects ?? []) {
    insertItem(maps, normalizeNpmItem(obj?.package));
  }
  for (const entry of parseAwesomeMarkdown(awesome.value)) {
    insertItem(maps, normalizeAwesomeItem(entry));
  }
  if (dshso.status === "fulfilled") {
    for (const entry of extractDshSoItems(dshso.value)) {
      insertItem(maps, normalizeDshSoItem(entry));
    }
  }

  const items = collectItems(maps);
  const fetchedAt = new Date().toISOString();
  await atomicWriteJson(statePath("index", "items.json"), items);
  await atomicWriteJson(statePath("index", "meta.json"), {
    fetchedAt,
    count: items.length,
    lastError: null,
  });
  return { ok: true, skipped: false, count: items.length, fetchedAt, lastError: null };
}

/**
 * Read the local index items. Returns null when missing or unparsable,
 * [] for a valid empty index.
 */
export async function readIndex() {
  const items = await readJson(statePath("index", "items.json"), null);
  return Array.isArray(items) ? items : null;
}
