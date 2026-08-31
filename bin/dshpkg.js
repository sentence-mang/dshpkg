#!/usr/bin/env node
// dshpkg — apt-style CLI (integration layer).
//
// Wires every lib/* module into one command surface, aligned with Linux
// package-manager conventions: search/install/remove/update/upgrade/hold/
// enable/disable/status/list/info/why/doctor/audit/fix-broken/log/run/
// repo/sync.
//
// Hard constraints honoured here (see CONTRACTS.md):
//   - plain ESM, zero third-party dependencies (node:* + lib/* only);
//   - every external call (dsh / git / node) spawns WITHOUT shell:true;
//   - comments in English, user-facing output in Chinese;
//   - log/error/ask/runner/fetcher are injectable so tests stay offline.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readState,
  writeState,
  readIncidents,
  resolveProfileDir,
  readJson,
  readApiToken,
  readTrustedKeys,
  addTrustedKey,
  removeTrustedKey,
  resolvePublicKey,
  recordManagedInstall,
  removeManagedEntry,
  listSnapshots,
  statePath,
  withSyncLock,
  appendIncident,
} from "../lib/state.js";
import { search } from "../lib/search.js";
import {
  repoAdd,
  repoRemove,
  repoList,
  repoInit,
  syncRepos,
  loadAllRecipes,
} from "../lib/repo.js";
import { refreshIndex, readIndex } from "../lib/indexer.js";
import { install, remove, defaultRunner, defaultInstallRunner, autoremove, expandDeps, findMissingDeps } from "../lib/transaction.js";
import { checkUpdates, mergeInstalledFromDeps } from "../lib/update.js";
import { readProfileBundles } from "../lib/bundle.js";
import { isOpen, closeCircuit, isDangerousKey } from "../lib/circuit.js";
import { isProtected } from "../lib/protect.js";
import { runDshSync } from "../lib/launcher.js";
import {
  hasManagedBlock,
  applyDisableToPatch,
  removeManagedBlock,
} from "../lib/rescue.js";
import { recipeFromPackageJson, verifyRecipeSig, parseMinisignPublicKey, matchesHarnessRange } from "../lib/recipe.js";
import { saveSnapshot, restoreSnapshot, SNAPSHOT_FILES } from "../lib/snapshot.js";
import { npmGlobalPrefix, staticNpmPrefixes, LAUNCHER_SEGMENTS } from "../lib/launcher.js";
import {
  ensureDshpkgBundle,
  planReorder,
  reorderProfileBundles,
  detectNameDrift,
  repairNameDrift,
  DEFAULT_GUARDIANS,
  KERNEL_PREFIX,
} from "../lib/order-bundles.js";

// --- constants --------------------------------------------------------------

/** Port probed for a running dshpkg host (`--port` overrides). */
export const HOST_PORT = 3080;
/** Host HTTP probe timeout (ms); on timeout the CLI falls back to file mode. */
export const HOST_TIMEOUT_MS = 2_000;

// --- small helpers ----------------------------------------------------------

/** Read a text file; missing file reads as "". */
async function readTextOrEmpty(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve the installed dsh harness version (READ-ONLY). Probes the npm
 * global prefix first (`npm prefix -g` when npm answers; launcher.js already
 * tolerates its Windows .cmd shim), then the well-known static prefixes; the
 * first readable @deepseek-ai/dsh manifest wins. Both the prefix probe and
 * the manifest reader are injectable so tests stay offline. Returns null
 * when nothing is readable — callers SKIP the compatibility check then.
 *
 * @param {{spawnImpl?: Function, readImpl?: Function}} [deps]
 * @returns {Promise<string|null>} semver string or null
 */
export async function resolveHarnessVersion({ spawnImpl, readImpl = readJson } = {}) {
  const prefixes = [];
  try {
    const prefix = npmGlobalPrefix(spawnImpl ? { spawnImpl } : {});
    if (prefix) prefixes.push(prefix);
  } catch {
    // npm unavailable: static prefixes still get probed
  }
  for (const p of staticNpmPrefixes()) prefixes.push(p);
  for (const prefix of prefixes) {
    const manifest = await readImpl(
      join(prefix, ...LAUNCHER_SEGMENTS.slice(0, 3), "package.json"),
      null,
    );
    const version = typeof manifest?.version === "string" ? manifest.version.trim() : "";
    if (version) return version;
  }
  return null;
}

/** Package name of a spec ("dsh-plugin-x@1.2.3" -> "dsh-plugin-x"). */
function pkgNameOf(spec) {
  const s = String(spec).trim().replace(/^(link:|file:|npm:)/, "");
  const match = s.match(/^(@[^/]+\/[^@/]+|[^@/]+)/);
  return match ? match[1] : s;
}

/** Trailing version of a spec ("x@1.2.3" -> "1.2.3"), else null. */
function versionOf(spec) {
  const match = String(spec).trim().match(/@([^@/]+)$/);
  return match ? match[1] : null;
}

/** Human name for state bookkeeping, handling npm/git/path specs. */
function displayNameOf(spec) {
  const s = String(spec).trim().replace(/^(link:|file:)/, "");
  if (/^(https?:\/\/|git@|git\+|ssh:|github:)/i.test(s)) {
    const tail = s.replace(/\.git$/, "").replace(/[\\/]+$/, "").match(/[^\/:\\]+$/);
    return tail ? tail[0] : s;
  }
  if (
    /^[a-zA-Z]:[\\/]/.test(s) ||
    s.startsWith("/") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith(".\\") ||
    s.startsWith("..\\")
  ) {
    const base = basename(s.replace(/[\\/]+$/, ""));
    return base || s;
  }
  return pkgNameOf(s);
}

/** Display width treating CJK / full-width chars as two columns. */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  }
  return width;
}

function padCell(text, width) {
  return String(text) + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** Print a simple aligned table (CJK-aware padding). */
function printTable(ctx, headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => displayWidth(String(r[i] ?? "")))),
  );
  ctx.log(headers.map((h, i) => padCell(h, widths[i])).join("  "));
  for (const row of rows) {
    ctx.log(row.map((c, i) => padCell(String(c ?? ""), widths[i])).join("  "));
  }
}

/** Last `n` lines of a text blob (for doctor output summaries). */
function tailOf(text, n) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-n)
    .join("\n");
}

// --- host probing (running dshpkg L2 host on 127.0.0.1:<port>) --------------

/**
 * Read the local API token once for a host request. The token is generated on
 * first use under the dshpkg state root (state.js readApiToken); both the
 * read-only probe and the write POSTs carry it so the host's no-Origin gate
 * (which requires a token) accepts the CLI.
 */
async function hostToken() {
  try {
    return await readApiToken();
  } catch {
    return ""; // never block the CLI on a token-store failure
  }
}

/** GET /dshpkg/status with a 2s timeout; null when no host answers. */
async function probeHost(ctx, port) {
  const fetcher = ctx.fetcher ?? globalThis.fetch;
  const token = await hostToken();
  try {
    const res = await fetcher(`http://127.0.0.1:${port}/dshpkg/status`, {
      headers: token ? { "x-dshpkg-token": token } : {},
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    if (!res?.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** POST a JSON body to a /dshpkg/* route; never throws. */
async function hostPost(ctx, port, path, body) {
  const fetcher = ctx.fetcher ?? globalThis.fetch;
  const token = await hostToken();
  try {
    const res = await fetcher(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-dshpkg-token": token } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    if (!res?.ok) return { ok: false, error: `HTTP ${res?.status ?? "unknown"}` };
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// --- recipe probing ---------------------------------------------------------

/**
 * Probe a recipe for a spec: git/remote specs and plain names pass through
 * (null), local paths probe their package.json via recipeFromPackageJson,
 * bare names look the recipe up in the synced recipe repos.
 */
async function probeRecipe(spec) {
  const s = String(spec).trim();
  if (!s) return null;
  if (/^(https?:\/\/|git@|git\+|ssh:|github:)/i.test(s) || /\.git(?:[#@/]|$)/.test(s)) {
    return null; // remote git spec — pnpm handles it, no probe needed
  }
  const localPath = s.replace(/^(link:|file:)/, "");
  const looksLikePath =
    /^[a-zA-Z]:[\\/]/.test(localPath) ||
    localPath.startsWith("/") ||
    localPath.startsWith("./") ||
    localPath.startsWith("../") ||
    localPath.startsWith(".\\") ||
    localPath.startsWith("..\\");
  if (looksLikePath) {
    if (!existsSync(localPath)) return null; // let dsh report the error
    const manifest = await readJson(join(localPath, "package.json"), null);
    const probed = recipeFromPackageJson(manifest);
    if (!probed.ok) return null;
    return { ...probed.value, source: { type: "path", spec: localPath } };
  }
  const base = s.replace(/@[^@/]+$/, ""); // strip a trailing @version
  const recipes = await loadAllRecipes();
  const found = recipes.find(({ recipe }) => recipe.name === base);
  return found ? found.recipe : null;
}

/** Normalize a recipe for transaction.install (source -> plain spec). */
function transactionRecipe(recipe) {
  const source = recipe?.source;
  const spec =
    typeof source === "string"
      ? source
      : source?.spec
        ? source.spec
        : recipe?.name ?? "";
  const entry = { name: recipe.name, source: spec, deps: recipe.deps ?? [] };
  if (recipe.build && typeof recipe.build === "object") entry.build = recipe.build;
  return entry;
}

/**
 * Expand a recipe's string deps through the recipe library (recursively), so
 * the transaction installs the COMPLETE closure — deps of deps included —
 * without anyone having to install them by hand.
 */
async function expandRecipeClosure(recipe) {
  if (!recipe) return recipe;
  const recipeByName = new Map(
    (await loadAllRecipes()).map(({ recipe: r }) => [r.name, r]),
  );
  return expandDeps(recipe, recipeByName);
}

// --- smart install resolution (fuzzy word -> candidate -> install) ---------

/** True for remote git specs (github:/git+/git@/ssh:/https:/ .git urls). */
function isRemoteGitSpec(spec) {
  const s = String(spec).trim();
  return /^(https?:\/\/|git@|git\+|ssh:|github:)/i.test(s) || /\.git(?:[#@\/]|$)/.test(s);
}

/** True for local filesystem path specs (absolute, drive or ./ ../ relative). */
function isLocalPathSpec(spec) {
  const s = String(spec).trim().replace(/^(link:|file:)/, "");
  return (
    /^[a-zA-Z]:[\\/]/.test(s) ||
    s.startsWith("/") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith(".\\") ||
    s.startsWith("..\\")
  );
}

/**
 * True for specs that unambiguously target npm and must bypass the fuzzy
 * search chain: an explicit `npm:` prefix, a scoped `@scope/name`, a version
 * pin (`name@version`), or a bare word already following the dsh ecosystem
 * naming convention (dsh-prefixed or containing "dsh-") — such words ARE the
 * exact package names, so historical direct-install behaviour is preserved.
 */
function isDirectNpmSpec(spec) {
  const s = String(spec).trim();
  if (!s) return false;
  if (/^npm:/i.test(s)) return true;
  if (/^@[^/\s]+\//.test(s)) return true; // scoped package
  if (!s.startsWith("@") && versionOf(s)) return true; // name@version pin
  const lower = s.toLowerCase();
  return lower.startsWith("dsh") || lower.includes("dsh-");
}

/** dsh-ecosystem search candidate: packageName starts with "dsh" or name has it. */
function isEcosystemCandidate(item) {
  const pkg = String(item?.packageName ?? "").toLowerCase();
  const name = String(item?.name ?? item?.key ?? "").toLowerCase();
  return pkg.startsWith("dsh") || name.includes("dsh");
}

/** Display name of a search result entry (name > packageName > key). */
function candidateNameOf(item) {
  return String(item?.name ?? item?.packageName ?? item?.key ?? "").trim();
}

/**
 * Install spec derived from a search result: the npm package name when it has
 * one, else `github:owner/repo` for GitHub-hosted hits, else the bare name.
 */
function candidateSpecOf(item) {
  const pkg = String(item?.packageName ?? "").trim();
  if (pkg) return pkg;
  const ownerRepo = String(item?.ownerRepo ?? "").trim().replace(/\.git$/i, "");
  if (ownerRepo) return `github:${ownerRepo}`;
  return candidateNameOf(item);
}

/** Truncate text to a display width (CJK-aware), appending an ellipsis. */
function truncateDisplay(text, maxWidth) {
  const s = String(text ?? "");
  if (displayWidth(s) <= maxWidth) return s;
  let width = 0;
  let out = "";
  for (const ch of s) {
    const w = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
    if (width + w > maxWidth - 1) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

/**
 * Resolve a bare fuzzy word into an install target via the search chain:
 * local index first (ecosystemOnly passed duck-typed — search.js ignores
 * unknown options until it adopts the parameter), one automatic online retry
 * when the local index is empty, then a strong-match check (exact name hit,
 * or a lone dsh-ecosystem candidate leading the runner-up by >= 30 points).
 * Multiple candidates fall back to an interactive numbered list (max 10;
 * non-TTY prints the list and exits 2, --yes auto-picks the first).
 *
 * @returns {Promise<number|{target: string|object, name: string,
 *   recipe: object|null, recordSpec: string}>} a number is an exit code
 *   (0 cancelled, 1 zero candidates, 2 ambiguous in non-interactive mode).
 */
async function resolveSmartInstall(ctx, spec, profile, opts) {
  const searchImpl = ctx.search ?? search;
  const doSearch = (online) =>
    searchImpl(spec, {
      online,
      profile,
      // Duck-typed hint for the offline pass: search.js ignores unknown
      // options until it adopts the parameter, so this stays crash-free.
      // The online retry stays broad — CLI-side ordering handles it.
      ...(online ? {} : { ecosystemOnly: true }),
      ...(ctx.fetcher ? { fetcher: ctx.fetcher } : {}),
    });

  let candidates = await doSearch(false);
  if (!Array.isArray(candidates)) candidates = [];
  if (candidates.length === 0) {
    // Empty local index (never refreshed / fresh install): retry online once.
    // Inside search, a GitHub failure degrades to npm, and a total online
    // failure degrades back to the (empty) local result — never throws.
    const index = await readIndex();
    if (!Array.isArray(index) || index.length === 0) {
      const online = await doSearch(true);
      if (Array.isArray(online)) candidates = online;
    }
  }

  if (candidates.length === 0) {
    ctx.error(
      `未找到匹配 "${spec}" 的插件，试试 dshpkg search ${spec} 或先运行 dshpkg update 刷新索引`,
    );
    return 1;
  }

  // CLI-side ecosystem ordering: dsh candidates first, score order kept.
  const eco = candidates.filter(isEcosystemCandidate);
  const ordered = [...eco, ...candidates.filter((r) => !isEcosystemCandidate(r))];
  const q = String(spec).toLowerCase();

  let pick = ordered.find(
    (r) =>
      String(r?.packageName ?? "").toLowerCase() === q ||
      candidateNameOf(r).toLowerCase() === q,
  ) ?? null;
  if (!pick && eco.length === 1) {
    const runnerUp = ordered.length > 1 ? ordered[1] : null;
    if (!runnerUp || (Number(eco[0].score) || 0) >= (Number(runnerUp.score) || 0) + 30) {
      pick = eco[0];
    }
  }

  if (pick) {
    ctx.log(`已匹配：${candidateNameOf(pick)}（来自搜索）`);
  } else if (opts.yes) {
    pick = ordered[0];
    ctx.log(`已匹配：${candidateNameOf(pick)}（来自搜索，--yes 自动选择第 1 名）`);
  } else {
    // Multiple viable candidates: numbered list (max 10), interactive pick.
    const shown = ordered.slice(0, 10);
    const rows = shown.map((r, i) => [
      `[${i + 1}]`,
      candidateNameOf(r),
      r?.latestVersion ?? "-",
      truncateDisplay(r?.description ?? "", 30),
      r?.verification?.label ?? "未知",
    ]);
    ctx.log(
      `为 "${spec}" 找到 ${ordered.length} 个候选${ordered.length > 10 ? "（显示前 10 个）" : ""}:`,
    );
    printTable(ctx, ["#", "名称", "版本", "描述", "验证等级"], rows);
    if (!ctx.canPrompt) {
      ctx.error("多个候选，请用完整名安装（或加 --yes 自动选择第 1 名）");
      return 2;
    }
    const answer = String(await ctx.ask("输入编号安装（q 取消）: ") ?? "")
      .trim()
      .toLowerCase();
    if (!answer || answer === "q") {
      ctx.log("已取消");
      return 0;
    }
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= shown.length) {
      throw new Error("编号无效");
    }
    pick = shown[index];
    ctx.log(`已选择：${candidateNameOf(pick)}（来自搜索）`);
  }

  // Derive the install target: a matching recipe wins (dependency closure
  // is installed with it), otherwise the candidate's own install spec.
  const pickName = candidateNameOf(pick) || candidateSpecOf(pick);
  const pickRecipe = await probeRecipe(pickName);
  if (pickRecipe) {
    return {
      target: transactionRecipe(pickRecipe),
      name: pickRecipe.name,
      recipe: pickRecipe,
      recordSpec: pickName,
    };
  }
  const pickSpec = candidateSpecOf(pick);
  return { target: pickSpec, name: pickName, recipe: null, recordSpec: pickSpec };
}

// --- command handlers (each wraps its body; errors are Chinese) -------------

async function cmdSearch(ctx, args, opts) {
  try {
    const query = args.join(" ").trim();
    if (!query) throw new Error("用法: dshpkg search <关键词> [--online] [--ecosystem]");
    const results = await search(query, {
      online: Boolean(opts.online),
      ecosystemOnly: Boolean(opts.ecosystem),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(ctx.fetcher ? { fetcher: ctx.fetcher } : {}),
    });
    if (results.length === 0) {
      ctx.log("未找到匹配的插件");
      return 0;
    }
    const rows = results.map((r) => [
      r.name ?? r.key ?? "",
      r.latestVersion ?? "-",
      r.verification?.label ?? "未知",
      r.security?.riskLevel ?? "unknown",
      r.installed ? "已安装" : "-",
    ]);
    printTable(ctx, ["名称", "版本", "验证等级", "风险", "是否已装"], rows);
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdInstall(ctx, args, opts) {
  try {
    const spec = String(args[0] ?? "").trim();
    if (!spec) {
      throw new Error(
        "用法: dshpkg install <名称|npm名|git地址|本地路径>[@版本] [--dry-run] [--profile <名>] [--yes]",
      );
    }
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    let recipe = await probeRecipe(spec);
    // Full dependency closure: string deps resolve through the recipe
    // library recursively, so deps of deps install automatically too.
    recipe = await expandRecipeClosure(recipe);
    let target = recipe ? transactionRecipe(recipe) : spec;
    let name = recipe?.name ?? displayNameOf(spec);
    let recordSpec = spec; // what state.packages[].source records

    // Smart resolution: a bare fuzzy word that is neither a recipe, a
    // git/path spec, nor an unambiguous npm target goes through search —
    // apt-style "type anything, get the package". Everything else keeps the
    // historical direct-install path (backward compatibility).
    if (!recipe && !isRemoteGitSpec(spec) && !isLocalPathSpec(spec) && !isDirectNpmSpec(spec)) {
      const resolved = await resolveSmartInstall(ctx, spec, profile, opts);
      if (typeof resolved === "number") return resolved;
      target = resolved.target;
      name = resolved.name;
      recipe = await expandRecipeClosure(resolved.recipe);
      recordSpec = resolved.recordSpec;
    }

    // Dependency-missing validation (P4-5): after the closure is expanded,
    // surface deps that resolve to nothing. An OBJECT dep whose name has no
    // recipe is a hard error (it asks to install a specific recipe's closure,
    // so a missing recipe cannot fall back to a bare spec); a STRING dep with
    // no recipe is only a warning (CONTRACTS.md R9 — legal as a bare npm
    // spec). Both were previously silent.
    if (recipe) {
      const recipeByName = new Map(
        (await loadAllRecipes()).map(({ recipe: r }) => [r.name, r]),
      );
      const { missing, unresolved } = findMissingDeps(recipe, recipeByName);
      if (missing.length > 0) {
        throw new Error(
          `依赖缺失: ${missing.join("、")}（配方依赖了不存在的 recipe，无法安装）`,
        );
      }
      for (const dep of unresolved) {
        ctx.log(`提示: 依赖 "${dep}" 在配方库中无对应 recipe，将按裸 npm 包名安装`);
      }
    }

    // Harness compatibility gate: a recipe declaring harnessRange must match
    // the installed dsh version. An unreadable harness version SKIPS the
    // check (never blocks on missing metadata); --force overrides a real
    // mismatch (explicit user intent).
    if (recipe && !opts.force && recipe.harnessRange && recipe.harnessRange !== "*") {
      const harnessVersion = ctx.harnessVersionImpl
        ? await ctx.harnessVersionImpl()
        : await resolveHarnessVersion();
      if (harnessVersion === null) {
        ctx.log("提示: 无法读取 dsh harness 版本，跳过 harnessRange 兼容性检查");
      } else if (!matchesHarnessRange(recipe.harnessRange, harnessVersion)) {
        throw new Error(
          `配方 ${recipe.name} 声明 harnessRange ${recipe.harnessRange}，当前 harness ${harnessVersion}，版本不兼容（--force 可强制安装）`,
        );
      }
    }

    // P3-2: recipe-based installs pass the trust gate (signature check +
    // confirmation card, signing.md §4-5). Direct specs (npm/git) and local
    // paths are explicit user intent and stay ungated; --dry-run never
    // blocks. The signature is verified against the RAW published recipe:
    // validateRecipe's default-filling must never change the signed payload.
    if (recipe && !opts.dryRun && !isLocalPathSpec(spec)) {
      const entry = (await loadAllRecipes()).find((e) => e.recipe.name === name);
      const gate = await confirmRecipeInstall(ctx, entry?.raw ?? recipe, opts);
      if (gate === "declined") return 0;
      if (gate === "refused") return 1;
    }

    const result = await install(target, {
      profile,
      dryRun: Boolean(opts.dryRun),
      runner: ctx.runner,
      installRunner: ctx.installRunner ?? ctx.runner,
      gitRunner: ctx.gitRunner ?? undefined,
    });
    if (!result.ok) throw new Error(result.error);
    if (opts.dryRun) {
      ctx.log("[dry-run] 安装计划已输出，未做任何修改");
      return 0;
    }
    // Bookkeeping: record every package this transaction installed.
    for (const installedName of result.installed) {
      // A __proto__/constructor/prototype installedName would resolve to the
      // shared prototype and pollute Object.prototype on the assignment below.
      if (isDangerousKey(installedName)) {
        throw new Error(`非法的插件名: ${installedName}`);
      }
      const existing = state.packages?.[installedName] ?? {};
      const version =
        installedName === name
          ? versionOf(recordSpec) ?? recipe?.source?.spec?.match(/@([^@/]+)$/)?.[1] ?? null
          : existing.version ?? null;
      state.packages[installedName] = {
        ...existing,
        source: existing.source ?? (installedName === name ? recordSpec : installedName),
        version,
        kind: installedName === name ? recipe?.kind ?? "unknown" : existing.kind ?? "unknown",
        installedAt: new Date().toISOString(),
        held: existing.held ?? false,
        crashCount: 0,
        crashTimes: [],
        circuitOpenAt: null,
      };
      // Managed ledger: dshpkg itself installed this package (state.managed).
      recordManagedInstall(state, installedName, { version });
    }
    await writeState(state);
    // P1-3 trigger ①: snapshot the known-good profile right after a
    // successful install (best-effort — a snapshot failure must not fail the
    // install, but it is surfaced so the user knows).
    try {
      const profileDir = await resolveProfileDir(profile);
      if (profileDir) await saveSnapshot(profileDir);
    } catch (err) {
      ctx.error(`警告: 安装成功，但保存快照失败（${err?.message ?? err}）`);
    }
    ctx.log(`已安装 ${name}`);
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdRemove(ctx, args, opts) {
  try {
    const name = String(args[0] ?? "").trim();
    if (!name) throw new Error("用法: dshpkg remove <名称> [--dry-run] [--profile <名>]");
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const result = await remove(name, {
      profile,
      dryRun: Boolean(opts.dryRun),
      runner: ctx.runner,
    });
    if (!result.ok) throw new Error(result.error);
    if (opts.dryRun) {
      ctx.log("[dry-run] 移除计划已输出，未做任何修改");
      return 0;
    }
    if (state.packages?.[name] || state.managed?.[name]) {
      delete state.packages[name];
      removeManagedEntry(state, name);
      await writeState(state);
    }
    ctx.log(`已移除 ${name}`);
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

/**
 * P3-2 (signing.md §4-5): recipe trust gate. Shows the source / verification
 * level / signature status card, then decides:
 *   - valid + trusted key  -> auto-proceed (no prompt);
 *   - invalid signature    -> refuse, fail-closed;
 *   - unsigned / key-missing -> pin.allow (repo-level trust) shows a note and
 *     proceeds; otherwise an interactive confirm (enter = yes) or --yes is
 *     required; non-interactive without --yes refuses.
 * Returns "proceed" | "declined" (cancel, exit 0) | "refused" (exit 1).
 */
async function confirmRecipeInstall(ctx, recipe, opts) {
  const verdict = await verifyRecipeSig(recipe, { publicKeyOf: resolvePublicKey });
  const source = recipe.source
    ? `${recipe.source.type}:${recipe.source.spec}`
    : "?";
  const sigText =
    verdict.status === "valid"
      ? "✓ 已验证（minisign）"
      : verdict.status === "invalid"
        ? "✗ 签名无效（配方可能被篡改）"
        : verdict.status === "key-missing"
          ? "⚠ 有签名但公钥不可信/缺失"
          : "⚠ 未签名，无法验证来源";
  ctx.log(`来源:         ${source}`);
  ctx.log(
    `验证等级:     ${recipe.verify?.label ?? "?"}（风险 ${recipe.verify?.risk ?? "?"}）`,
  );
  ctx.log(`签名状态:     ${sigText}`);

  if (verdict.status === "valid") return "proceed"; // auto-allow (card shown)
  if (verdict.status === "invalid") {
    ctx.error("签名无效，拒绝安装（配方可能被篡改）");
    return "refused";
  }
  // unsigned / key-missing
  if (opts.yes) return "proceed";
  if (recipe.pin?.allow === true) {
    // design §4.4 exception: repo-level trust — the source info above is
    // always shown (approval ruling ②), then the install proceeds.
    ctx.log("提示: 该配方未签名，但声明 pin.allow（仓库级信任），放行安装");
    return "proceed";
  }
  if (!ctx.canPrompt) {
    ctx.error("拒绝安装: 未签名/不可信配方在非交互环境必须使用 --yes 明确确认");
    return "refused";
  }
  const answer = String(
    await ctx.ask("该配方未签名，无法验证来源，确认安装？[Y/n] "),
  )
    .trim()
    .toLowerCase();
  if (answer === "n" || answer === "no") {
    ctx.log("已取消");
    return "declined";
  }
  return "proceed";
}

/**
 * `dshpkg key` — manage the explicit trusted-public-key set (signing.md §3):
 *   key add <公钥文件|URL|base64行> [标签]
 *   key list
 *   key remove <keyId>
 */
async function cmdKey(ctx, args) {
  try {
    const sub = String(args[0] ?? "").trim();
    if (sub === "add") {
      const source = String(args[1] ?? "").trim();
      if (!source) throw new Error("用法: dshpkg key add <公钥文件|URL|base64行> [标签]");
      let text;
      if (/^https?:\/\//i.test(source)) {
        const fetcher = ctx.fetcher ?? globalThis.fetch;
        const res = await fetcher(source, { signal: AbortSignal.timeout(10_000) });
        if (!res?.ok) throw new Error(`HTTP ${res?.status ?? "unknown"}`);
        text = await res.text();
      } else {
        text = await readTextOrEmpty(source);
        if (!text.trim()) text = source; // bare base64 line passed directly
      }
      const parsed = parseMinisignPublicKey(text);
      if (!parsed.ok) throw new Error(parsed.error);
      const label = String(args[2] ?? "").trim();
      const base64Line = String(text)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("untrusted comment:"));
      await addTrustedKey(parsed.keyId, label, base64Line ?? "");
      ctx.log(`已信任公钥 ${parsed.keyId}${label ? `（${label}）` : ""}`);
      return 0;
    }
    if (sub === "list") {
      const { keys } = await readTrustedKeys();
      if (keys.length === 0) {
        ctx.log("（信任集中暂无公钥，使用 dshpkg key add 添加）");
        return 0;
      }
      ctx.log("信任的公钥:");
      for (const k of keys) {
        ctx.log(`  ${k.keyId}${k.label ? `  ${k.label}` : ""}（${k.addedAt ?? "?"}）`);
      }
      return 0;
    }
    if (sub === "remove") {
      const keyId = String(args[1] ?? "").trim();
      if (!keyId) throw new Error("用法: dshpkg key remove <keyId>");
      await removeTrustedKey(keyId);
      ctx.log(`已移除公钥 ${keyId}`);
      return 0;
    }
    throw new Error(
      "用法: dshpkg key add <公钥文件|URL|base64行> [标签] | key list | key remove <keyId>",
    );
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

/** Current dshpkg package identity from its own package.json (self-upgrade
 * must install the REAL package name — the scoped form after publishing). */
async function currentDshpkgInfo() {
  const pkg = await readJson(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    null,
  );
  return {
    name: typeof pkg?.name === "string" ? pkg.name : "dshpkg",
    version: typeof pkg?.version === "string" ? pkg.version : "0.0.0",
  };
}

/**
 * P4-2: transactional self-upgrade — snapshot the profile first, apply the
 * new dshpkg version, smoke-test the new binary, and roll back to the
 * previous version when the smoke test fails (the snapshot stays as an
 * extra restore point).
 */
async function cmdSelfUpgrade(ctx, args, opts) {
  try {
    const profile = opts.profile ?? (await readState()).profile ?? "web";
    const profileDir = await resolveProfileDir(profile);
    if (!profileDir) throw new Error(`未找到 profile "${profile}"`);
    const target = String(args[0] ?? "latest").trim() || "latest";
    const runner = ctx.runner ?? defaultRunner;
    const info = await currentDshpkgInfo();
    const pkgSpec = (name) => `${name}@${target}`;

    const snapshotTs = await saveSnapshot(profileDir);
    ctx.log(`已拍恢复快照 ${snapshotTs}`);
    ctx.log(`升级 ${info.name} ${info.version} -> ${target}...`);

    const apply = await runner(["add", "-g", pkgSpec(info.name)]);
    if (apply.status !== 0) {
      throw new Error(`升级失败: ${apply.stderr ?? apply.stdout ?? "未知错误"}`);
    }
    const smoke = await runner(["help"]);
    if (smoke.status !== 0) {
      const rollback = await runner(["add", "-g", `${info.name}@${info.version}`]);
      if (rollback.status !== 0) {
        ctx.error(`回退失败: 请手动执行 pnpm add -g ${info.name}@${info.version}`);
      }
      throw new Error(`新版本冒烟测试失败，已回退到 ${info.version}`);
    }
    ctx.log(`${info.name} 已升级到 ${target}（冒烟通过）`);
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

/**
 * NOTE: dshpkg deliberately does NOT register any OS-level auto-start
 * (no HKCU Run key, no Windows Task Scheduler). dshpkg is a dsh-ecosystem
 * plugin manager — touching system-global state is out of scope. To guard a
 * running dsh session, use the on-demand `dshpkg run` watchdog instead.
 */

/**
 * `dshpkg update --check` — read-only update detection. Builds the installed
 * set from state.packages (dshpkg's bookkeeping) merged with the profile's
 * real npm dependencies (via lib/bundle.js), then compares each against the
 * latest version declared by the recipe repos. Prints a Chinese table of
 * updateable plugins. Writes nothing; a missing profile degrades to the
 * state-only view.
 */
async function cmdUpdateCheck(ctx, opts) {
  const state = await readState();
  const profile = opts.profile ?? state.profile ?? "web";

  // Installed versions: state bookkeeping first, supplemented by the real
  // profile package.json dependencies (a plugin installed outside dshpkg
  // still shows up here). The profile dir is resolved through the standard
  // guard (never a guessed path); a missing profile just yields no extras.
  const profileDir = await resolveProfileDir(profile);
  let installed = { ...(state.packages ?? {}) };
  if (profileDir) {
    const { deps } = await readProfileBundles(profileDir);
    installed = mergeInstalledFromDeps(installed, deps);
  }

  // Latest versions: the recipe repos' source.spec (npm versions). A recipe
  // whose source.spec is a bare npm name (no @version) carries no concrete
  // version and is skipped (we cannot compare against "latest").
  const recipes = await loadAllRecipes();
  const latestByName = new Map();
  for (const { recipe } of recipes) {
    const spec = typeof recipe?.source?.spec === "string" ? recipe.source.spec : "";
    const m = spec.match(/@(\d[^/@]*)$/);
    if (m) latestByName.set(recipe.name, m[1]);
  }

  const rows = checkUpdates(installed, latestByName);
  const updateable = rows.filter((r) => r.updateable);

  if (updateable.length === 0) {
    ctx.log("所有已装插件均为最新（或配方库未提供可比较的版本）");
    return 0;
  }
  ctx.log(`发现 ${updateable.length} 个可更新插件:`);
  printTable(
    ctx,
    ["名称", "当前版本", "最新版本", "状态"],
    updateable.map((r) => [
      r.name,
      r.current ?? "未知",
      r.latest,
      r.held ? "held（upgrade 将跳过）" : "可更新",
    ]),
  );
  ctx.log("（运行 dshpkg upgrade [名称] 升级，本命令未做任何修改）");
  return 0;
}

async function cmdUpdate(ctx, _args, opts) {
  try {
    // `update --check` is strictly read-only: it compares what is installed
    // against the recipe repos' latest versions and prints which plugins are
    // out of date — it does NOT sync, does NOT refresh the index, and writes
    // nothing to disk.
    if (opts.check) {
      return await cmdUpdateCheck(ctx, opts);
    }
    ctx.log("同步配方仓库...");
    const outcomes = await syncRepos(ctx.fetcher ? { fetcher: ctx.fetcher } : {});
    if (outcomes.length === 0) {
      ctx.log("  （未配置配方仓库，运行 dshpkg repo init 添加默认社区仓库）");
    }
    for (const outcome of outcomes) {
      if (outcome.status === "ok") ctx.log(`  ✓ ${outcome.name}`);
      else ctx.error(`  ✗ ${outcome.name}: ${outcome.error}`);
    }
    ctx.log("刷新插件索引...");
    const index = await refreshIndex(ctx.fetcher ? { fetcher: ctx.fetcher } : {});
    if (index.skipped) {
      ctx.log(`  索引 24 小时内已刷新过，跳过（现有 ${index.count} 条）`);
      return 0;
    }
    if (index.ok) {
      ctx.log(`  索引已更新：${index.count} 条（${index.fetchedAt}）`);
      return 0;
    }
    ctx.error(`  索引刷新失败：${index.lastError}（沿用旧索引 ${index.count} 条）`);
    return 1;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdUpgrade(ctx, args, opts) {
  try {
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const single = String(args[0] ?? "").trim();
    const targets = single
      ? [single]
      : Object.keys(state.packages ?? {}).filter((n) => !state.packages[n].held);
    if (targets.length === 0) {
      ctx.log("没有可升级的插件（全部 held 或未安装任何插件）");
      return 0;
    }
    // R5: snapshot the known-good profile BEFORE touching anything. An
    // upgrade whose transaction rollback itself failed restores this exact
    // state; snapshotting is best-effort (a failure only degrades rollback).
    let snapshotTs = null;
    let profileDir = null;
    if (!opts.dryRun) {
      profileDir = await resolveProfileDir(profile);
      if (profileDir) {
        try {
          snapshotTs = await saveSnapshot(profileDir);
        } catch (err) {
          ctx.error(`警告: 升级前快照保存失败（${err?.message ?? err}），回滚能力降级`);
        }
      }
    }
    let failures = 0;
    for (const name of targets) {
      if (isOpen(state, name)) {
        ctx.error(`跳过 ${name}: 电路处于 circuit-open，请先运行 dshpkg fix-broken`);
        failures += 1;
        continue;
      }
      const spec = `${name}@latest`;
      const result = await install(spec, {
        profile,
        dryRun: Boolean(opts.dryRun),
        runner: ctx.runner,
        installRunner: ctx.installRunner ?? ctx.runner,
      });
      if (!result.ok) {
        ctx.error(`升级失败: ${name}（${result.error}）`);
        failures += 1;
        // Transaction rollback failed too: the profile is in an uncertain
        // state — restore the pre-upgrade snapshot and stop upgrading.
        if (result.rolledBack === false && snapshotTs && profileDir) {
          const restored = await restoreSnapshot(profileDir, snapshotTs);
          if (restored.ok) {
            ctx.log(`已回滚 profile 到升级前快照（${snapshotTs}）`);
          } else {
            ctx.error(`快照回滚失败: ${restored.error}（请手动运行 dshpkg doctor）`);
          }
          break;
        }
        continue;
      }
      if (opts.dryRun) ctx.log(`[dry-run] 将升级 ${name}: dsh plugin --profile ${profile} add ${spec}`);
      else {
        if (state.packages?.[name]) {
          state.packages[name].version = "latest";
          state.packages[name].installedAt = new Date().toISOString();
          await writeState(state);
        }
        ctx.log(`✓ ${name} 已升级到最新版本`);
      }
    }
    return failures === 0 ? 0 : 1;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

/**
 * R2 bootstrap: register dshpkg itself as a bundle in the profile and
 * re-layer dsh.profile.bundles (kernel -> guardians -> topology), so the
 * next dsh boot loads dshpkg right after the kernel. This is the ONE
 * intentional write to a real profile; every other path goes through an
 * install transaction.
 */
async function cmdBootstrap(ctx, _args, opts) {
  try {
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const profileDir = await resolveProfileDir(profile);
    if (!profileDir) {
      throw new Error(`找不到 profile "${profile}"（目录不存在或没有 dsh.profile 声明）`);
    }
    const result = await ensureDshpkgBundle(profileDir);
    if (!result.ok) throw new Error(result.error);
    ctx.log(
      result.added
        ? `已将 dshpkg 注册到 profile "${profile}" 的 bundles 并重排加载顺序`
        : `dshpkg 已在 profile "${profile}" 的 bundles 中，已重排加载顺序`,
    );
    ctx.log("加载顺序（内核 → 守护 → 依赖拓扑序）:");
    result.order.forEach((name, i) => ctx.log(`  ${i + 1}. ${name}`));
    ctx.log("重启 dsh 后生效（dshpkg 将是内核之后第一个加载的插件）");
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

/**
 * One-shot crash rescue: restore a known-good snapshot into the profile
 * without running the watchdog. No argument restores the NEWEST snapshot;
 * an explicit snapshot id (see `dshpkg audit` / the list this command
 * prints) restores that one. restoreSnapshot stays strict: an incomplete
 * snapshot refuses without touching the profile.
 */
async function cmdRestore(ctx, args, opts) {
  try {
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const profileDir = await resolveProfileDir(profile);
    if (!profileDir) {
      throw new Error(`找不到 profile "${profile}"（目录不存在或没有 dsh.profile 声明）`);
    }
    const snapshots = await listSnapshots(); // newest first
    if (snapshots.length === 0) {
      ctx.log("没有可恢复的快照（安装/升级成功后会自动保存快照）");
      return 0;
    }
    const target = String(args[0] ?? "").trim() || snapshots[0];
    if (!snapshots.includes(target)) {
      ctx.error(`快照 ${target} 不存在，可用快照（新→旧）:`);
      for (const ts of snapshots) ctx.error(`  - ${ts}`);
      return 1;
    }
    const restored = await restoreSnapshot(profileDir, target);
    if (!restored.ok) throw new Error(restored.error);
    ctx.log(`已恢复快照 ${target} 到 profile "${profile}"（重启 dsh 后生效）`);
    ctx.log("提示: 持续守护请运行 dshpkg run（看门狗自动熔断与快照恢复）");
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

/**
 * One-shot dependency/registration reconciliation for a broken environment
 * (crashed boots, plugins installed outside dshpkg, reconciler misses).
 * The installed face is scanned as the single source of truth and three
 * problem classes are reported: unregistered bundles, missing declared
 * deps, and order/registration drift. `--fix` actively fills the missing
 * deps through the transaction channel, then registers + re-layers.
 */
async function cmdReconcile(ctx, _args, opts) {
  try {
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const profileDir = await resolveProfileDir(profile);
    if (!profileDir) {
      throw new Error(`找不到 profile "${profile}"（目录不存在或没有 dsh.profile 声明）`);
    }
    // Scan the installed face: unregistered bundles + missing declared deps.
    const manifest = await readJson(join(profileDir, "package.json"), null);
    const depNames = Object.keys(manifest?.dependencies ?? {});
    const currentBundles = Array.isArray(manifest?.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles
      : [];
    const registeredSet = new Set(currentBundles);
    const unregistered = [];
    const missingDeps = [];
    for (const name of depNames) {
      const depManifest = await readJson(
        join(profileDir, "node_modules", ...name.split("/"), "package.json"),
        null,
      );
      if (!depManifest) continue; // not materialized on disk: cannot judge
      if (depManifest?.dsh?.bundle?.patch !== undefined && !registeredSet.has(name)) {
        unregistered.push(name);
      }
      for (const depName of Object.keys(depManifest?.dependencies ?? {})) {
        if (!existsSync(join(profileDir, "node_modules", ...depName.split("/")))) {
          missingDeps.push({ pkg: name, dep: depName });
        }
      }
    }
    // Order/registration drift (dry plan, no write).
    const plan = await planReorder(profileDir);
    // R20 name drift: dependency keys whose installed package carries a
    // different real name break dsh's runtime bundle resolution.
    const drift = await detectNameDrift(profileDir);

    const problems = unregistered.length + missingDeps.length + drift.length + (plan.changed ? 1 : 0);
    if (problems === 0) {
      ctx.log("✓ 依赖与注册对账一致，无需修复");
      return 0;
    }
    if (unregistered.length > 0) {
      ctx.log(`未注册的 bundle（已安装但未进加载列表）: ${unregistered.join(", ")}`);
    }
    if (missingDeps.length > 0) {
      ctx.log("缺失的依赖:");
      for (const { pkg, dep } of missingDeps) ctx.log(`  - ${pkg} 缺少 ${dep}`);
    }
    if (drift.length > 0) {
      ctx.log("安装键与包名错配（运行时导入会失败）:");
      for (const d of drift) ctx.log(`  - 安装键 ${d.key} 的包真实名称是 ${d.realName}`);
    }
    if (plan.changed) ctx.log("加载顺序/注册与安装面不一致，需要重排");
    if (!opts.fix) {
      ctx.log("运行 dshpkg reconcile --fix 自动修复（改写错配键 + 补装缺失依赖 + 注册 + 重排）");
      return 1;
    }
    // R20 --fix: rewrite drifted keys to the real package names FIRST (dsh
    // re-links the junctions under the correct names on its next boot).
    if (drift.length > 0) {
      const { repaired } = await withSyncLock(() => repairNameDrift(profileDir));
      for (const r of repaired) ctx.log(`✓ 已改写安装键 ${r}`);
      if (repaired.length > 0) {
        await appendIncident({ type: "drift-repaired", detail: repaired.join(", ") });
      }
    }
    // --fix: actively fill missing deps through the transaction channel
    // (one final re-layer runs afterwards, so per-install reorders skip).
    let failures = 0;
    const seen = new Set();
    for (const { dep } of missingDeps) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      ctx.log(`补装缺失依赖: ${dep}`);
      const result = await install(dep, {
        profile,
        runner: ctx.runner ?? defaultRunner,
        installRunner: ctx.installRunner ?? ctx.runner ?? defaultRunner,
        skipReorder: true,
      });
      if (!result.ok) {
        ctx.error(`补装失败: ${dep}（${result.error}）`);
        failures += 1;
      }
    }
    const reconciled = await reorderProfileBundles(profileDir);
    if (reconciled.registered.length > 0) {
      ctx.log(`已注册: ${reconciled.registered.join(", ")}`);
    }
    if (reconciled.changed) {
      ctx.log(`已重排 dsh.profile.bundles（${reconciled.order.length} 个插件）`);
    }
    ctx.log(
      failures === 0
        ? "修复完成（重启 dsh 后生效；持续守护请运行 dshpkg run）"
        : `修复完成，但 ${failures} 个依赖补装失败`,
    );
    return failures === 0 ? 0 : 1;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdHold(ctx, args, held) {
  try {
    const name = String(args[0] ?? "").trim();
    if (!name) throw new Error("用法: dshpkg hold|unhold <名称>");
    if (isDangerousKey(name)) throw new Error(`非法的插件名: ${name}`);
    const state = await readState();
    const pkg = state.packages?.[name];
    if (!pkg) throw new Error(`未找到已安装插件 "${name}"（先安装或检查状态）`);
    pkg.held = held;
    await writeState(state);
    ctx.log(
      held ? `已保持 ${name}（upgrade 将跳过它）` : `已取消保持 ${name}`,
    );
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

/** Shared enable/disable driver: host HTTP first, cordis.patch.yml fallback. */
async function setPluginDisabled(ctx, args, opts, disabled) {
  try {
    const name = String(args[0] ?? "").trim();
    if (!name) throw new Error("用法: dshpkg enable|disable <名称>");
    // Spec section 9: core entries must never be disabled. The protect list
    // only blocks the disable/circuit-open direction — enable (removing a
    // managed disable block) is a restore and stays unrestricted, matching
    // the fix-broken recovery path.
    if (disabled && isProtected(name)) {
      throw new Error(`核心条目受保护，禁止熔断/禁用（${name}）`);
    }
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const port = opts.port ?? HOST_PORT;

    const host = await probeHost(ctx, port);
    if (host && host.ok) {
      const res = await hostPost(ctx, port, `/dshpkg/managed/${disabled ? "disable" : "enable"}`, {
        name,
      });
      if (res.ok) {
        ctx.log(
          `已通过运行中的 dshpkg host 将插件 ${name} ${disabled ? "禁用" : "启用"}（本次运行内生效）`,
        );
        return 0;
      }
      ctx.error(`host 请求失败（${res.error ?? "?"}），退回文件模式`);
    }

    const profileDir = await resolveProfileDir(profile);
    if (!profileDir) {
      throw new Error(`找不到 profile "${profile}"（目录不存在或缺少 dsh.profile 声明）`);
    }
    const patchFile = join(profileDir, "cordis.patch.yml");
    // R19: the patch layer is shared with the watchdog and the in-process
    // guardian — serialize the read-modify-write under the sync lock.
    let changed = false;
    await withSyncLock(async () => {
      const text = await readTextOrEmpty(patchFile);
      const updated = disabled
        ? applyDisableToPatch(text, name)
        : removeManagedBlock(text, name);
      if (updated === text) return;
      await writeFile(patchFile, updated, "utf8");
      changed = true;
    });
    if (!changed) {
      ctx.log(`插件 ${name} 已处于${disabled ? "禁用" : "启用"}状态`);
      return 0;
    }
    ctx.log(
      `已在 profile "${profile}" 的 cordis.patch.yml 中${disabled ? "禁用" : "启用"} ${name}（重启 dsh 后生效）`,
    );
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdStatus(ctx, args, opts) {
  try {
    const name = String(args[0] ?? "").trim();
    if (!name) throw new Error("用法: dshpkg status <名称>");
    const state = await readState();
    if (isOpen(state, name)) {
      ctx.log(`${name}: circuit-open`);
      return 0;
    }
    const port = opts.port ?? HOST_PORT;
    const host = await probeHost(ctx, port);
    if (host && host.ok) {
      const managed = Array.isArray(host.managed) ? host.managed : [];
      const entry = managed.find((m) => m.name === name);
      if (entry) {
        ctx.log(`${name}: ${entry.enabled ? "running" : "disabled"}`);
        return 0;
      }
    }
    const profile = opts.profile ?? state.profile ?? "web";
    const profileDir = await resolveProfileDir(profile);
    const text = profileDir
      ? await readTextOrEmpty(join(profileDir, "cordis.patch.yml"))
      : "";
    ctx.log(`${name}: ${hasManagedBlock(text, name) ? "disabled" : "running"}`);
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdList(ctx, _args, opts) {
  try {
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const recipes = await loadAllRecipes();
    const recipeByName = new Map(
      recipes.map(({ recipe, origin }) => [recipe.name, { recipe, origin }]),
    );
    const profileDir = await resolveProfileDir(profile);
    const manifest = profileDir
      ? await readJson(join(profileDir, "package.json"), null)
      : null;
    const depNames = Object.keys(manifest?.dependencies ?? {});
    const names = [
      ...new Set([
        ...Object.keys(state.packages ?? {}),
        ...depNames,
        ...recipeByName.keys(),
      ]),
    ].sort();
    const rows = [];
    for (const name of names) {
      const pkg = state.packages?.[name] ?? null;
      const installed = Boolean(pkg) || depNames.includes(name);
      if (opts.installed && !installed) continue;
      const rec = recipeByName.get(name);
      const version =
        pkg?.version ??
        (typeof rec?.recipe?.source?.spec === "string" ? rec.recipe.source.spec : null) ??
        manifest?.dependencies?.[name] ??
        "-";
      const status = pkg?.held
        ? "held"
        : isOpen(state, name)
          ? "circuit-open"
          : installed
            ? "已安装"
            : "可用";
      rows.push([name, version, rec?.origin ?? pkg?.source ?? "-", status]);
    }
    if (rows.length === 0) {
      ctx.log(
        opts.installed
          ? "（未安装任何插件）"
          : "（配方库与本地均无插件，运行 dshpkg repo init + update 拉取社区仓库）",
      );
      return 0;
    }
    printTable(ctx, ["名称", "版本", "来源", "状态"], rows);
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdInfo(ctx, args) {
  try {
    const name = String(args[0] ?? "").trim();
    if (!name) throw new Error("用法: dshpkg info <名称>");
    const state = await readState();
    const recipes = await loadAllRecipes();
    const found = recipes.find(({ recipe }) => recipe.name === name);
    if (found) {
      const { recipe, origin } = found;
      const deps = (recipe.deps ?? [])
        .map((d) => (typeof d === "string" ? d : d?.name ?? "?"))
        .join(", ");
      ctx.log(`名称:         ${recipe.name}`);
      ctx.log(`类型:         ${recipe.kind}`);
      ctx.log(
        `来源:         ${recipe.source?.type ?? "?"} ${typeof recipe.source?.spec === "string" ? recipe.source.spec : ""}`,
      );
      ctx.log(`依赖:         ${deps || "（无）"}`);
      ctx.log(`harness 范围: ${recipe.harnessRange ?? "*"}`);
      if (recipe.description) ctx.log(`介绍:         ${recipe.description}`);
      if (recipe.maintainer) ctx.log(`维护者:       ${recipe.maintainer}`);
      if (recipe.homepage) ctx.log(`主页:         ${recipe.homepage}`);
      ctx.log(`许可:         ${recipe.license ?? "UNKNOWN"}`);
      if (Array.isArray(recipe.tags) && recipe.tags.length > 0) {
        ctx.log(`标签:         ${recipe.tags.join("、")}`);
      }
      ctx.log(`pin:          ${recipe.pin?.allow ? "允许" : "不允许"}`);
      ctx.log(
        `验证:         ${recipe.verify?.label ?? "?"}（level ${recipe.verify?.level ?? "?"}，风险 ${recipe.verify?.risk ?? "?"}）`,
      );
      ctx.log(`仓库:         ${origin}`);
    } else {
      ctx.log(`名称:         ${name}`);
      ctx.log("（配方库中未找到该插件，仅显示本地状态）");
    }
    const pkg = state.packages?.[name] ?? null;
    if (pkg) {
      ctx.log(`已安装:       ${pkg.installedAt ?? "是"}`);
      ctx.log(`版本:         ${pkg.version ?? "未知"}`);
      ctx.log(`来源记录:     ${pkg.source ?? "未知"}`);
      ctx.log(`held:         ${pkg.held ? "是" : "否"}`);
      ctx.log(`崩溃计数:     ${pkg.crashCount ?? 0}`);
      ctx.log(`电路状态:     ${isOpen(state, name) ? "circuit-open" : "closed"}`);
    } else {
      ctx.log("已安装:       否");
      ctx.log("崩溃计数:     0");
    }
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdWhy(ctx, args) {
  try {
    const name = String(args[0] ?? "").trim();
    if (!name) throw new Error("用法: dshpkg why <名称>");
    const recipes = await loadAllRecipes();
    const dependents = recipes.filter(({ recipe }) =>
      (recipe.deps ?? []).some((d) => (typeof d === "string" ? d : d?.name) === name),
    );
    if (dependents.length === 0) {
      ctx.log(`没有配方声明依赖 ${name}`);
      return 0;
    }
    ctx.log(`以下配方依赖 ${name}:`);
    for (const { recipe, origin } of dependents) {
      ctx.log(`  - ${recipe.name}（仓库 ${origin}）`);
    }
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdDoctor(ctx, _args, opts) {
  try {
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const result = ctx.dshRun(["--profile", profile, "--dump-config"]);
    if (result.error) throw new Error(`执行 dsh 失败: ${result.error.message}`);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status !== 0) {
      ctx.error(`✗ 组合树校验失败（dsh --profile ${profile} --dump-config 退出码 ${result.status}）:`);
      ctx.error(tailOf(output, 12) || "（无输出）");
      return 1;
    }
    ctx.log(`✓ 组合树校验通过（dsh --profile ${profile} --dump-config，退出码 0）`);

    // Dependency graph check over installed recipes.
    const recipes = await loadAllRecipes();
    const profileDir = await resolveProfileDir(profile);
    const manifest = profileDir
      ? await readJson(join(profileDir, "package.json"), null)
      : null;
    const installed = new Set([
      ...Object.keys(state.packages ?? {}),
      ...Object.keys(manifest?.dependencies ?? {}),
    ]);
    const problems = [];
    for (const { recipe } of recipes) {
      if (!installed.has(recipe.name)) continue;
      for (const dep of recipe.deps ?? []) {
        const depName = typeof dep === "string" ? dep : dep?.name;
        if (depName && !installed.has(depName)) {
          problems.push(`${recipe.name} 缺少依赖 ${depName}`);
        }
      }
    }
    ctx.log(`依赖图检查: ${recipes.length} 个配方, ${problems.length} 处缺失依赖`);
    for (const problem of problems.slice(0, 10)) ctx.error(`  - ${problem}`);

    // Bundle layering check (READ-ONLY): dshpkg must be a declared bundle
    // and the guardian layer must sit right after the kernel — otherwise
    // dsh boots dshpkg too late (or never). The fix is `dshpkg bootstrap`.
    const layerProblems = [];
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter((n) => typeof n === "string" && n)
      : [];
    if (profileDir && bundles.length > 0) {
      const selfName = DEFAULT_GUARDIANS[0];
      if (!bundles.includes(selfName)) {
        layerProblems.push(
          `${selfName} 未注册到 bundles（dsh 启动不会加载它），运行 dshpkg bootstrap 修复`,
        );
      }
      const guardianPos = DEFAULT_GUARDIANS
        .map((g) => bundles.indexOf(g))
        .filter((i) => i >= 0);
      const plainPos = bundles
        .map((n, i) =>
          n.startsWith(KERNEL_PREFIX) || DEFAULT_GUARDIANS.includes(n) ? -1 : i,
        )
        .filter((i) => i >= 0);
      if (
        guardianPos.length > 0 &&
        plainPos.length > 0 &&
        Math.min(...guardianPos) > Math.min(...plainPos)
      ) {
        layerProblems.push(
          "守护层未紧跟内核（有普通插件先于守护加载），运行 dshpkg bootstrap 重排",
        );
      }
    }
    ctx.log(
      layerProblems.length === 0
        ? "bundles 顺序检查: ✓ 守护层位置正确"
        : `bundles 顺序检查: ${layerProblems.length} 处问题`,
    );
    for (const problem of layerProblems) ctx.error(`  - ${problem}`);
    ctx.log("依赖与注册对账: dshpkg reconcile [--fix]（扫描未注册 bundle 与缺失依赖）");
    // Boot guardian status (R16): a persistent marker means the previous
    // boot died before confirmation; the attribution names the culprit the
    // guardian disabled (fix-broken re-enables it once repaired).
    const bootMarker = state.boot?.startedAt ?? null;
    const bootFailures = Number(state.bootFailures) || 0;
    const lastCulprit = state.boot?.lastCulprit ?? null;
    ctx.log(
      `启动守卫: ${bootMarker ? `启动标记存在（${bootMarker}，持续存在说明上次启动异常退出）` : "无启动标记"}，` +
        `累计启动失败 ${bootFailures} 次` +
        (lastCulprit ? `，最近归因: ${lastCulprit}（修复后 dshpkg fix-broken 可恢复）` : ""),
    );

    // R19 state integrity check: state.json must parse as an object, every
    // incidents.jsonl line must be JSON, and each snapshot dir must carry
    // the three manifest files. --fix quarantines the damaged items and
    // records a doctor-repair event; the checks above (readState) already
    // self-heal a corrupt state.json on read.
    const healthProblems = [];
    let stateJsonOk = true;
    try {
      const rawState = JSON.parse(await readFile(statePath("state.json"), "utf8"));
      if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
        stateJsonOk = false;
        healthProblems.push("state.json 不是 JSON 对象");
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        stateJsonOk = false;
        healthProblems.push(`state.json 不可解析: ${err.message}`);
      }
    }
    let badIncidentLines = 0;
    try {
      const incidentText = await readFile(statePath("incidents.jsonl"), "utf8");
      for (const line of incidentText.split("\n")) {
        if (!line.trim()) continue;
        try {
          JSON.parse(line);
        } catch {
          badIncidentLines += 1;
        }
      }
    } catch {
      // no incidents file = nothing to check
    }
    if (badIncidentLines > 0) {
      healthProblems.push(`incidents.jsonl 有 ${badIncidentLines} 行不可解析（读取时已容忍，仅提示）`);
    }
    const snapshotNames = await listSnapshots();
    const brokenSnapshots = [];
    for (const ts of snapshotNames) {
      const complete = SNAPSHOT_FILES.every((file) =>
        existsSync(statePath("snapshots", ts, file)),
      );
      if (!complete) brokenSnapshots.push(ts);
    }
    for (const ts of brokenSnapshots) {
      healthProblems.push(`快照 ${ts} 缺少文件，无法用于恢复`);
    }
    ctx.log(
      healthProblems.length === 0
        ? "状态体检: ✓ state / incidents / snapshots 完整"
        : `状态体检: ${healthProblems.length} 处问题`,
    );
    for (const problem of healthProblems) ctx.error(`  - ${problem}`);
    if (opts.fix && healthProblems.length > 0) {
      let repaired = 0;
      let healthUnresolved = healthProblems.length;
      if (!stateJsonOk) {
        // readState quarantines the corrupt file and rebuilds defaults.
        await readState();
        repaired += 1;
        healthUnresolved -= 1;
      }
      for (const ts of brokenSnapshots) {
        const src = statePath("snapshots", ts);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          await rename(src, `${src}.corrupt-${stamp}`);
          repaired += 1;
          healthUnresolved -= 1;
        } catch {
          // a failed quarantine is reported but never fatal
          ctx.error(`  - 隔离快照 ${ts} 失败，请手动处理`);
        }
      }
      await appendIncident({
        type: "doctor-repair",
        detail: healthProblems.join("; "),
      });
      ctx.log(`状态体检修复: 已隔离/重建 ${repaired} 项，事件已记录`);
      // Re-evaluate the exit condition: repaired items no longer count.
      healthProblems.length = healthUnresolved;
    }

    // R20 name-drift check: a dependency key different from the installed
    // package's real name breaks dsh's runtime bundle resolution (the
    // loader imports the REAL name). --fix rewrites the manifest keys.
    const drift = profileDir ? await detectNameDrift(profileDir) : [];
    ctx.log(
      drift.length === 0
        ? "包名校验: ✓ 无错配"
        : `包名校验: ${drift.length} 处错配`,
    );
    for (const d of drift) {
      ctx.error(`  - 安装键 ${d.key} 的包真实名称是 ${d.realName}（dshpkg doctor --fix 可修复）`);
    }
    let driftLeft = drift.length;
    if (opts.fix && drift.length > 0) {
      ctx.log("自动修复: 改写错配的安装键为真实包名...");
      const { repaired } = await withSyncLock(() => repairNameDrift(profileDir));
      for (const r of repaired) ctx.log(`✓ 已改写 ${r}（重启 dsh 后按正确包名重装）`);
      if (repaired.length > 0) {
        await appendIncident({ type: "drift-repaired", detail: repaired.join(", ") });
      }
      driftLeft = drift.length - repaired.length;
    }

    // Installed-face integrity: every installed package's declared deps
    // must exist in node_modules — a missing one is a crash waiting to
    // happen (load-order errors, missing services).
    const installedMissing = [];
    if (profileDir) {
      for (const name of Object.keys(manifest?.dependencies ?? {})) {
        const depManifest = await readJson(
          join(profileDir, "node_modules", ...name.split("/"), "package.json"),
          null,
        );
        if (!depManifest) continue; // not materialized: cannot judge
        for (const depName of Object.keys(depManifest?.dependencies ?? {})) {
          if (!existsSync(join(profileDir, "node_modules", ...depName.split("/")))) {
            installedMissing.push({ pkg: name, dep: depName });
          }
        }
      }
    }
    ctx.log(`装机完整性检查: ${installedMissing.length} 处缺失依赖`);
    for (const { pkg, dep } of installedMissing.slice(0, 10)) {
      ctx.error(`  - ${pkg} 缺少依赖 ${dep}（运行 dshpkg reconcile --fix 修复）`);
    }

    // --fix: install every missing dependency automatically (no waiting for
    // a human to run install by hand).
    if (opts.fix && (problems.length > 0 || installedMissing.length > 0)) {
      let failures = 0;
      if (problems.length > 0) {
        ctx.log("自动修复: 安装缺失依赖...");
        const recipeByName = new Map(recipes.map(({ recipe: r }) => [r.name, r]));
        for (const problem of problems) {
          const depName = problem.split(" 缺少依赖 ")[1]?.trim();
          if (!depName) continue;
          const depRecipe = recipeByName.get(depName);
          const specOrRecipe = depRecipe
            ? await expandRecipeClosure(depRecipe)
            : depName;
          const result = await install(specOrRecipe, {
            profile,
            runner: ctx.runner ?? defaultRunner,
            installRunner: ctx.installRunner ?? ctx.runner ?? defaultRunner,
            gitRunner: ctx.gitRunner ?? undefined,
          });
          if (!result.ok) {
            ctx.error(`修复失败: ${depName}（${result.error}）`);
            failures += 1;
          } else {
            ctx.log(`✓ 已安装缺失依赖 ${depName}`);
          }
        }
      }
      if (installedMissing.length > 0) {
        ctx.log("自动修复: 补装装机缺失依赖...");
        const seen = new Set();
        for (const { dep } of installedMissing) {
          if (seen.has(dep)) continue;
          seen.add(dep);
          const result = await install(dep, {
            profile,
            runner: ctx.runner ?? defaultRunner,
            installRunner: ctx.installRunner ?? ctx.runner ?? defaultRunner,
            skipReorder: true,
          });
          if (!result.ok) {
            ctx.error(`补装失败: ${dep}（${result.error}）`);
            failures += 1;
          } else {
            ctx.log(`✓ 已补装 ${dep}`);
          }
        }
        await reorderProfileBundles(profileDir);
      }
      if (failures > 0) {
        ctx.error(`仍有 ${failures} 处依赖修复失败`);
        return 1;
      }
      ctx.log("缺失依赖已全部自动修复");
      return driftLeft === 0 ? 0 : 1;
    }
    return problems.length === 0 && layerProblems.length === 0 && installedMissing.length === 0 && healthProblems.length === 0 && driftLeft === 0
      ? 0
      : 1;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

/**
 * `dshpkg autoremove` — remove orphan packages (installed, non-bundle, and
 * referenced by nothing else installed). Never touches bundles or referenced
 * packages; `--dry-run` only lists them.
 */
async function cmdAutoremove(ctx, _args, opts) {
  try {
    const profile = opts.profile ?? (await readState()).profile ?? "web";
    const result = await autoremove({
      profile,
      dryRun: Boolean(opts.dryRun),
      runner: ctx.runner ?? defaultRunner,
    });
    if (!result.ok) throw new Error(result.error);
    if (result.removed.length === 0) {
      ctx.log("没有可清理的孤儿包");
      return 0;
    }
    ctx.log(
      opts.dryRun
        ? `将清理 ${result.removed.length} 个孤儿包: ${result.removed.join(", ")}`
        : `已清理 ${result.removed.length} 个孤儿包: ${result.removed.join(", ")}`,
    );
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdAudit(ctx, _args) {
  try {
    const state = await readState();
    const openNames = Object.keys(state.packages ?? {}).filter((n) =>
      isOpen(state, n),
    );
    ctx.log(`电路状态: ${openNames.length} 个插件处于 circuit-open`);
    for (const n of openNames) {
      ctx.log(`  ⚠ ${n}（崩溃 ${state.packages[n].crashCount ?? 0} 次，可运行 dshpkg fix-broken）`);
    }
    const incidents = await readIncidents(20);
    ctx.log(`最近 ${incidents.length} 条崩溃记录:`);
    for (const inc of incidents) {
      ctx.log(
        `  ${inc.t ?? ""} ${inc.entryId ?? "-"} ${inc.detail ?? inc.reason ?? ""}`.trim(),
      );
    }
    if (incidents.length === 0) ctx.log("  （暂无）");
    const snapshots = await listSnapshots();
    if (snapshots.length > 0) {
      ctx.log(`崩溃救援: dshpkg restore [快照id]（最新: ${snapshots[0]}）；持续守护请运行 dshpkg run`);
    }
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdFixBroken(ctx, args, opts) {
  try {
    const state = await readState();
    const openNames = Object.keys(state.packages ?? {}).filter((n) =>
      isOpen(state, n),
    );
    if (openNames.length === 0) {
      ctx.log("没有处于 circuit-open 的插件");
      return 0;
    }
    ctx.log("以下插件电路已熔断（circuit-open）:");
    openNames.forEach((n, i) =>
      ctx.log(`  [${i + 1}] ${n}（崩溃 ${state.packages[n].crashCount ?? 0} 次）`),
    );
    const answer = await ctx.ask("输入要修复的编号（回车取消）: ");
    const text = String(answer ?? "").trim();
    if (!text) {
      ctx.log("已取消");
      return 0;
    }
    const index = Number.parseInt(text, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= openNames.length) {
      throw new Error("编号无效");
    }
    const name = openNames[index];
    closeCircuit(state, name);
    await writeState(state);
    ctx.log(`已闭合 ${name} 的电路并清零崩溃计数`);

    const profile = opts.profile ?? state.profile ?? "web";
    const profileDir = await resolveProfileDir(profile);
    if (profileDir) {
      const patchFile = join(profileDir, "cordis.patch.yml");
      // R19: shared surface — serialize under the sync lock.
      let removedBlock = false;
      await withSyncLock(async () => {
        const patchText = await readTextOrEmpty(patchFile);
        const updated = removeManagedBlock(patchText, name);
        if (updated === patchText) return;
        await writeFile(patchFile, updated, "utf8");
        removedBlock = true;
      });
      if (removedBlock) {
        ctx.log(`已移除 cordis.patch.yml 中 ${name} 的禁用块（重启 dsh 后生效）`);
      } else {
        ctx.log(`cordis.patch.yml 中没有 ${name} 的禁用块，无需清理`);
      }
    }
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdLog(ctx, _args) {
  try {
    const incidents = await readIncidents(100);
    if (incidents.length === 0) {
      ctx.log("（暂无崩溃记录）");
      return 0;
    }
    for (const inc of incidents) ctx.log(JSON.stringify(inc));
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdRun(ctx, _args, opts) {
  try {
    const supervisorJs = join(dirname(fileURLToPath(import.meta.url)), "supervisor.js");
    const childArgs = [supervisorJs];
    if (opts.profile) childArgs.push("--profile", opts.profile);
    if (opts.port) childArgs.push("--port", String(opts.port));
    const doSpawn = ctx.spawnImpl ?? ((cmd, args, options) => spawn(cmd, args, options));
    ctx.log(`启动看门狗: node ${childArgs.join(" ")}（Ctrl+C 停止）`);
    const child = doSpawn(process.execPath, childArgs, {
      stdio: "inherit",
      env: process.env,
      windowsHide: false,
    });
    const forward = () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    await new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        process.removeListener("SIGINT", forward);
        process.removeListener("SIGTERM", forward);
        resolve({ code, signal });
      });
      child.once("error", (err) => {
        process.removeListener("SIGINT", forward);
        process.removeListener("SIGTERM", forward);
        resolve({ error: err });
      });
    });
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdRepo(ctx, args) {
  try {
    const sub = String(args[0] ?? "").trim();
    if (sub === "init") {
      const noDefault = args.includes("--no-default");
      const result = await repoInit({ noDefault });
      if (result.skipped) {
        ctx.log(
          noDefault
            ? "已跳过默认仓库（--no-default）"
            : "已有配方仓库，跳过默认添加",
        );
      } else {
        ctx.log(`已添加 ${result.added} 个默认仓库（运行 dshpkg update 拉取）`);
      }
      return 0;
    }
    if (sub === "add") {
      // Flags may appear anywhere: url [name] [--format git|index].
      let format = "git";
      const rest = [];
      for (let i = 1; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--format" && args[i + 1] !== undefined) {
          format = args[++i];
        } else if (arg.startsWith("--format=")) {
          format = arg.slice("--format=".length);
        } else {
          rest.push(arg);
        }
      }
      const entry = await repoAdd(rest[0], rest[1], format);
      ctx.log(
        `已添加仓库 ${entry.name}（${entry.url}${entry.format === "index" ? "，静态索引源" : ""}）`,
      );
      return 0;
    }
    if (sub === "remove") {
      await repoRemove(args[1]);
      ctx.log(`已移除仓库 ${args[1]}`);
      return 0;
    }
    if (sub === "list") {
      const repos = await repoList();
      if (repos.length === 0) {
        ctx.log("（未配置任何配方仓库，运行 dshpkg repo init 添加默认社区仓库）");
        return 0;
      }
      ctx.log("仓库列表（优先级从上到下）:");
      for (const repo of repos) {
        ctx.log(
          `  ${repo.enabled === false ? "✗" : "✓"} ${repo.name}  ${repo.url}${repo.format === "index" ? "  [index]" : ""}`,
        );
      }
      return 0;
    }
    throw new Error(
      "用法: dshpkg repo init [--no-default] | repo add <url> [名称] [--format git|index] | repo remove <名称> | repo list",
    );
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

// --- dispatch ---------------------------------------------------------------

/** Command table: name -> handler(ctx, args, opts) returning an exit code. */
export const COMMANDS = new Map([
  ["search", cmdSearch],
  ["install", cmdInstall],
  ["remove", cmdRemove],
  ["update", cmdUpdate],
  ["sync", cmdUpdate],
  ["upgrade", cmdUpgrade],
  ["hold", (ctx, args, opts) => cmdHold(ctx, args, true)],
  ["unhold", (ctx, args, opts) => cmdHold(ctx, args, false)],
  ["enable", (ctx, args, opts) => setPluginDisabled(ctx, args, opts, false)],
  ["disable", (ctx, args, opts) => setPluginDisabled(ctx, args, opts, true)],
  ["status", cmdStatus],
  ["list", cmdList],
  ["info", cmdInfo],
  ["why", cmdWhy],
  ["doctor", cmdDoctor],
  ["autoremove", cmdAutoremove],
  ["bootstrap", cmdBootstrap],
  ["restore", cmdRestore],
  ["reconcile", cmdReconcile],
  ["audit", cmdAudit],
  ["fix-broken", cmdFixBroken],
  ["log", cmdLog],
  ["run", cmdRun],
  ["repo", cmdRepo],
  ["key", cmdKey],
  ["self-upgrade", cmdSelfUpgrade],
  ["help", async (ctx) => { ctx.log(helpText()); return 0; }],
]);

/** Full Chinese help text (apt-style: command + one-line description). */
export function helpText() {
  return [
    "用法: dshpkg <命令> [选项]",
    "",
    "命令:",
    "  search <关键词>           搜索插件（本地索引；--online 联网 GitHub/npm，--ecosystem 仅 dsh 生态）",
    "  install <名称|npm名|git地址|本地路径>[@版本]",
    "                            安装插件（名称支持模糊匹配；--dry-run 演练，",
    "                            --yes 多候选时自动选第 1 名，--profile <名>）",
    "  remove <名称>             卸载插件（--dry-run 演练，--profile <名>）",
    "  update                    同步配方仓库并刷新插件索引（apt update 语义）",
    "  sync                      同 update",
    "  upgrade [名称]            升级全部或指定插件到最新版本",
    "  hold <名称>               保持当前版本（upgrade 跳过它）",
    "  unhold <名称>             取消保持",
    "  enable <名称>             启用插件（移除 cordis.patch.yml 禁用块）",
    "  disable <名称>            禁用插件（追加 cordis.patch.yml 禁用块）",
    "  status <名称>             插件状态：running / disabled / circuit-open",
    "  list                      列出插件（--installed 仅看已安装）",
    "  info <名称>               配方详情、依赖与崩溃计数",
    "  why <名称>                依赖反查：哪些配方依赖它",
    "  doctor [--fix]             校验组合树、依赖图与状态台账完整性（--fix 自动安装缺失依赖并隔离损坏项）",
    "  bootstrap                 注册 dshpkg 到 profile bundles 并重排加载顺序",
    "                            （内核 → 守护 → 依赖拓扑序；重启 dsh 后生效）",
    "  restore [快照id]           崩溃一键救援: 恢复快照到 profile（缺省恢复最新）",
    "  reconcile [--fix]         依赖/注册对账: 扫描未注册 bundle 与缺失依赖",
    "                            （--fix 主动补装 + 注册 + 重排）",
    "  autoremove                 清理孤儿包（被卸载插件的残留依赖；--dry-run 演练）",
    "  audit                     最近 20 条崩溃记录 + 电路状态汇总",
    "  fix-broken                交互式修复 circuit-open 的插件",
    "  log                       输出崩溃事件流（incidents.jsonl）",
    "  run                       启动看门狗守护 dsh（--port N / --profile 名）",
    "  repo init [--no-default]   首次使用：一键添加默认社区仓库",
    "  repo add <url> [名称] [--format git|index]",
    "                            添加配方仓库（--format index = 发布者静态索引源）",
    "  repo remove <名称>        移除配方仓库",
    "  repo list                 列出配方仓库",
    "  key add <公钥文件|URL|base64行> [标签]  信任一个 minisign 公钥",
    "  key list                  列出已信任的公钥",
    "  key remove <keyId>        移除已信任的公钥",
    "  self-upgrade [版本]       事务化升级 dshpkg 自身（快照+冒烟，失败自动回退）",
    "  help                      显示本帮助",
    "",
    "选项:",
    "  --online       search 时联网查询 GitHub/npm",
    "  --ecosystem    search 时仅显示 dsh 生态插件（dsh* 包名或 dsh-plugin/deepseek 主题）",
    "  --installed    list 时仅显示已安装插件",
    "  --dry-run      只打印将执行的命令，不做任何修改",
    "  --yes          install 多候选时跳过交互，自动选择第 1 名",
    "  --profile <名> 指定 profile（默认 state.json 记录的 profile，再默认 web）",
    "  --port <N>     run 与 host 探测端口（默认 3080）",
    "  -h, --help     显示本帮助",
  ].join("\n");
}

const KNOWN_FLAGS = new Set([
  "--online",
  "--ecosystem",
  "--installed",
  "--dry-run",
  "--yes",
  "--profile",
  "--port",
  "--help",
  "-h",
  "--",
  "--no-default",
  "--format",
  "--fix",
  "--now",
  "--check",
  "--force",
]);

/**
 * Parse argv into {command, positionals, flags}. Flags may appear before or
 * after the command (apt-style global options). Unknown flags throw with a
 * Chinese message.
 */
export function parseArgs(argv) {
  const opts = {
    command: null,
    positionals: [],
    online: false,
    ecosystem: false,
    installed: false,
    dryRun: false,
    profile: null,
    port: null,
    help: false,
    yes: false,
    fix: false,
    now: false,
    check: false,
    force: false,
  };
  let passthrough = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passthrough) {
      opts.positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--online") {
      opts.online = true;
      continue;
    }
    if (arg === "--ecosystem") {
      opts.ecosystem = true;
      continue;
    }
    if (arg === "--installed") {
      opts.installed = true;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--yes") {
      opts.yes = true;
      continue;
    }
    if (arg === "--fix") {
      opts.fix = true;
      continue;
    }
    if (arg === "--now") {
      opts.now = true;
      continue;
    }
    if (arg === "--check") {
      opts.check = true;
      continue;
    }
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    if (arg === "--profile" && argv[i + 1] !== undefined) {
      opts.profile = argv[++i];
      continue;
    }
    if (arg.startsWith("--profile=")) {
      opts.profile = arg.slice("--profile=".length);
      continue;
    }
    if (arg === "--port" && argv[i + 1] !== undefined) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--port 必须是正整数");
      opts.port = value;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const value = Number(arg.slice("--port=".length));
      if (!Number.isInteger(value) || value <= 0) throw new Error("--port 必须是正整数");
      opts.port = value;
      continue;
    }
    // repo-only flags pass through to the command as positionals (cmdRepo
    // scans them itself: --format index / --format=index / --no-default).
    if (arg.startsWith("--format=")) {
      opts.positionals.push(arg);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-" && !KNOWN_FLAGS.has(arg)) {
      throw new Error(`未知选项: ${arg}`);
    }
    if (!opts.command) opts.command = arg;
    else opts.positionals.push(arg);
  }
  return opts;
}

// --- runtime wiring ---------------------------------------------------------

/** Default interactive prompt via readline on stdin/stdout. */
async function defaultAsk(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * Default dsh run for doctor: shared launcher resolution (DSH_BIN .exe
 * direct, else `node <bin.js>`), spawnSync, never through a shell, output
 * captured for the doctor report. Dependencies are injectable for tests.
 *
 * @param {string[]} args dsh arguments (without the binary itself)
 * @param {object} [deps] {spawnImpl, resolveImpl, execPath}
 */
export function defaultDshRun(args, deps = {}) {
  return runDshSync(args, { options: { encoding: "utf8" }, ...deps });
}

/**
 * Build the injectable context from user overrides (tests inject fakes).
 * When tests inject a dsh `runner`, the add steps reuse it (so the fakes see
 * every call); in production the add steps use the capturing install runner
 * so pnpm output (allowBuilds hints, network errors) can be inspected.
 */
function makeCtx({ log, error, ask, runner, installRunner, dshRun, fetcher, spawnImpl, search, gitRunner, harnessVersionImpl } = {}) {
  const resolvedRunner = runner ?? defaultRunner;
  const askInjected = typeof ask === "function";
  return {
    log: log ?? ((...a) => console.log(...a)),
    error: error ?? ((...a) => console.error(...a)),
    ask: ask ?? defaultAsk,
    // Interactive prompts only make sense on a TTY; an explicitly injected
    // ask (tests / embedding hosts) always counts as interactive.
    canPrompt: askInjected || process.stdin.isTTY === true,
    runner: resolvedRunner,
    installRunner: installRunner ?? (runner ? resolvedRunner : defaultInstallRunner),
    dshRun: dshRun ?? defaultDshRun,
    fetcher: fetcher ?? null,
    spawnImpl: spawnImpl ?? null,
    search: search ?? null, // injectable search (smart install; tests)
    gitRunner: gitRunner ?? null, // injectable git runner (search-derived github: specs)
    harnessVersionImpl: harnessVersionImpl ?? null, // injectable harness version probe (harnessRange gate)
  };
}

/**
 * Run one CLI invocation. Returns an exit code (0 ok, 1 command error,
 * 2 usage error). Handlers already catch their own errors; the dispatch
 * try/catch is the final safety net.
 *
 * @param {string[]} argv args after "node bin/dshpkg.js"
 * @param {object} [io] injectable {log, error, ask, runner, dshRun, fetcher,
 *   spawnImpl, search, gitRunner}
 * @returns {Promise<number>} exit code
 */
export async function runCli(argv, io = {}) {
  const ctx = makeCtx(io);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    ctx.error(helpText());
    return 2;
  }
  if (opts.help || !opts.command) {
    ctx.log(helpText());
    return 0;
  }
  const handler = COMMANDS.get(opts.command);
  if (!handler) {
    ctx.error(`错误: 未知命令 "${opts.command}"`);
    ctx.error(helpText());
    return 2;
  }
  try {
    return await handler(ctx, opts.positionals, opts);
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (typeof code === "number" && code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      console.error(`dshpkg 异常: ${err?.message ?? err}`);
      process.exitCode = 1;
    });
}
