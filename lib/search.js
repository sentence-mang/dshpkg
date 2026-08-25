// dshpkg — three-layer search (module F).
//
// Offline: weighted rank over the local aggregated index —
//   name/packageName exact match +100, prefix +60, contains +30 (the layers
//   are exclusive, the highest one wins); topic hit +20; description hit +10;
//   stars/10000 bonus capped at +10. Entries with no keyword hit at all are
//   filtered out as irrelevant.
// Online (online=true): additionally queries GitHub + npm live through the
//   injected fetcher; live entries merge with (and take precedence over) the
//   local index; a live failure falls back to the local index silently.
// Ecosystem filter (ecosystemOnly=true): keeps only dsh ecosystem entries —
//   packageName starting with "dsh" or a "dsh-plugin"/"deepseek" topic — so
//   generic queries stop surfacing unrelated npm packages.
// Installed detection is a double lookup: dshpkg state.packages AND the
//   profile's package.json dependencies (profile dir resolved via state.js).
// Name collisions keep the highest-scoring entry and mark the rest as
//   `alternates`.
//
// Missing index/state degrades to [] — never throws. Tests must inject a fake
// fetcher; real network is only ever touched when online=true without one.

import { join } from "node:path";
import { readState, resolveProfileDir, readJson } from "./state.js";
import {
  readIndex,
  fetchJson,
  normalizeGitHubItem,
  normalizeNpmItem,
  dedupeItems,
} from "./indexer.js";

/** Weight layers (exclusive: exact > prefix > contains). */
export const SCORE_EXACT = 100;
export const SCORE_PREFIX = 60;
export const SCORE_CONTAINS = 30;
export const SCORE_TOPIC = 20;
export const SCORE_DESCRIPTION = 10;
export const STAR_CAP = 10;

/** Ecosystem topic markers counted by isEcosystemItem (lowercased). */
const ECOSYSTEM_TOPICS = new Set(["dsh-plugin", "deepseek"]);

/**
 * dsh ecosystem membership for ecosystemOnly: a packageName starting with
 * "dsh" (case-insensitive) or a "dsh-plugin"/"deepseek" topic. The bare
 * `name` is deliberately NOT considered — many unrelated packages embed
 * "dsh" in their display name.
 */
export function isEcosystemItem(item) {
  const packageName = String(item?.packageName ?? "").trim().toLowerCase();
  if (packageName.startsWith("dsh")) return true;
  const topics = Array.isArray(item?.topics) ? item.topics : [];
  return topics.some((topic) =>
    ECOSYSTEM_TOPICS.has(String(topic ?? "").trim().toLowerCase()),
  );
}

function githubQueryUrl(query) {
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+topic:dsh-plugin&sort=stars`;
}

function npmQueryUrl(query) {
  return `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=250`;
}

/**
 * Score one item against the query.
 * Returns { keyword, starBonus, total }: `keyword` is the text-match part
 * (0 = no keyword hit), `total` includes the capped star bonus and is the
 * final ranking score.
 */
export function scoreItem(item, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { keyword: 0, starBonus: 0, total: 0 };

  let keyword = 0;
  const fields = [item?.name, item?.packageName]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  for (const field of fields) {
    if (field === q) keyword = Math.max(keyword, SCORE_EXACT);
    else if (field.startsWith(q)) keyword = Math.max(keyword, SCORE_PREFIX);
    else if (field.includes(q)) keyword = Math.max(keyword, SCORE_CONTAINS);
  }

  for (const topic of item?.topics ?? []) {
    if (String(topic).toLowerCase() === q) keyword += SCORE_TOPIC;
  }
  const description = String(item?.description ?? "").toLowerCase();
  if (description.includes(q)) keyword += SCORE_DESCRIPTION;

  const starBonus = Math.min(STAR_CAP, (Number(item?.stars) || 0) / 10000);
  return { keyword, starBonus, total: keyword + starBonus };
}

/** Collect installed names from state.packages and the profile's package.json. */
async function installedNames(state, profile) {
  const names = new Set();
  const st = state ?? (await readState());
  for (const key of Object.keys(st?.packages ?? {})) names.add(key.toLowerCase());

  const dir = await resolveProfileDir(profile);
  if (dir) {
    const manifest = await readJson(join(dir, "package.json"), null);
    for (const dep of Object.keys(manifest?.dependencies ?? {})) {
      names.add(dep.toLowerCase());
    }
  }
  return names;
}

function isInstalled(item, names) {
  const candidates = [
    item?.packageName,
    item?.name,
    String(item?.ownerRepo ?? "").split("/").pop(),
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  return candidates.some((c) => names.has(c));
}

/** Group by name; the highest score survives, the rest become alternates. */
function resolveNameCollisions(results) {
  const groups = new Map();
  const order = [];
  for (const entry of results) {
    const nameKey = String(entry.item?.name ?? entry.item?.key ?? "").toLowerCase();
    if (!groups.has(nameKey)) {
      groups.set(nameKey, []);
      order.push(nameKey);
    }
    groups.get(nameKey).push(entry);
  }
  const out = [];
  for (const nameKey of order) {
    const group = groups.get(nameKey);
    group.sort((a, b) => b.score - a.score);
    const primary = group[0];
    const result = {
      ...primary.item,
      score: primary.score,
      installed: primary.installed,
    };
    if (group.length > 1) {
      result.alternates = group
        .slice(1)
        .map((e) => ({ ...e.item, score: e.score, installed: e.installed }));
    }
    out.push(result);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Search plugins, offline by default.
 *
 * @param {string} query
 * @param {{online?: boolean, ecosystemOnly?: boolean, profile?: string,
 *   state?: object, index?: object[], fetcher?: Function}} opts
 *   ecosystemOnly=true keeps only dsh ecosystem entries (dsh* packageName or
 *   dsh-plugin/deepseek topic), applied to the index AND to online results.
 * @returns {Promise<Array<object>>} [{...item, score, installed}] by
 *   descending score; name collisions keep the top score with `alternates`.
 */
export async function search(
  query,
  { online = false, ecosystemOnly = false, profile = "web", state, index, fetcher } = {},
) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  let items = Array.isArray(index) ? index : await readIndex();
  if (!Array.isArray(items)) items = [];

  if (online) {
    const fetchImpl = fetcher ?? globalThis.fetch;
    const [github, npm] = await Promise.allSettled([
      fetchJson(fetchImpl, githubQueryUrl(q)),
      fetchJson(fetchImpl, npmQueryUrl(q)),
    ]);
    const live = [];
    if (github.status === "fulfilled") {
      for (const repo of github.value?.items ?? []) live.push(normalizeGitHubItem(repo));
    }
    if (npm.status === "fulfilled") {
      for (const obj of npm.value?.objects ?? []) live.push(normalizeNpmItem(obj?.package));
    }
    // Live entries first: freshest fields win; the local index only fills
    // gaps. Live failures degrade silently to the offline index.
    items = dedupeItems([...live, ...items]);
  }

  if (ecosystemOnly) {
    // dsh ecosystem entries only: dsh* package names or dsh topics, so
    // generic queries stop surfacing unrelated npm packages.
    items = items.filter(isEcosystemItem);
  }

  const names = await installedNames(state, profile);
  const results = [];
  for (const item of items) {
    const { keyword, total } = scoreItem(item, q);
    if (keyword === 0) continue; // no keyword hit at all -> irrelevant
    results.push({ item, score: total, installed: isInstalled(item, names) });
  }
  results.sort((a, b) => b.score - a.score);
  return resolveNameCollisions(results);
}

// Stopwords for keyword extraction (English + Chinese).
const STOPWORDS = new Set([
  // english
  "a", "an", "the", "and", "or", "but", "for", "with", "to", "of", "in", "on",
  "at", "by", "is", "are", "was", "were", "be", "it", "its", "this", "that",
  "these", "those", "what", "which", "how", "why", "when", "where", "who",
  "whom", "me", "my", "i", "you", "your", "we", "our", "they", "their", "he",
  "she", "his", "her", "find", "search", "look", "get", "want", "need",
  "please", "can", "could", "would", "should", "do", "does", "use", "using",
  "add", "install", "remove", "list", "show", "give", "help", "plugin",
  "plugins", "dsh", "dshpkg", "harness", "deepseek", "there", "any", "some",
  "not", "as", "from",
  // chinese
  "的", "了", "和", "与", "或", "我", "你", "他", "她", "它", "们", "是",
  "在", "有", "要", "想", "找", "查", "搜", "安装", "卸载", "插件", "一个",
  "一些", "这个", "那个", "什么", "怎么", "如何", "哪些", "可以", "请",
  "帮", "下", "给", "把", "被", "用", "让", "能", "会", "个", "都", "最",
  "帮我", "想找", "帮我找", "推荐", "有没有", "介绍",
]);

/**
 * Keyword extraction for semantic hints: split on whitespace/punctuation,
 * drop stopwords, normalize to lowercase, de-duplicate.
 */
export async function searchSemantic(query) {
  const text = String(query ?? "").toLowerCase();
  const tokens = text.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    const t = token.trim();
    if (!t || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
