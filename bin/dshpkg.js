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
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readState,
  writeState,
  readIncidents,
  appendIncident,
  resolveProfileDir,
  readJson,
  readApiToken,
  readTrustedKeys,
  addTrustedKey,
  removeTrustedKey,
  resolvePublicKey,
  recordManagedInstall,
  removeManagedEntry,
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
import { recipeFromPackageJson, verifyRecipeSig, parseMinisignPublicKey } from "../lib/recipe.js";
import { saveSnapshot } from "../lib/snapshot.js";
import { measureCompose, scorePlugins, dirSize, cacheStats, mb, sampleMemory, memoryBudget } from "../lib/perf.js";
import { budgetLevel, evictionPlan } from "../lib/governor.js";
import { collectBootEvidence, suggestAction } from "../lib/diag.js";
import { heal, executablePlan } from "../lib/selfheal.js";
import { reverseDeps, activeBaseline, guardDisable } from "../lib/depsafe.js";

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

/** schtasks runner for daemon management: spawnSync, never a shell (and
 * never through the dsh launcher — that is what this dedicated runner is
 * for: the daemon commands talk to the OS task scheduler directly). */
function schtasksRunner(args) {
  const result = spawnSync("schtasks", args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/** The two task names the daemon registers (logon-start + keep-alive). */
export const DAEMON_TASKS = {
  logon: "dshpkg-supervisor",
  keepalive: "dshpkg-supervisor-keepalive",
};

/**
 * Build the /TR command string that launches supervisor.ps1 (which resolves
 * node and DSH_LAUNCHER itself, so no PATH assumptions leak into the task).
 * Returned as ONE string — schtasks /TR takes a single command line and
 * re-runs it through cmd.exe, so the script path must be double-quoted.
 */
function daemonCommand(profile) {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "supervisor.ps1",
  );
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Profile ${profile}`;
}

/**
 * P4-1: Windows Task Scheduler integration. Registers TWO tasks because
 * schtasks /RI (repetition) is only valid with time-based schedules
 * (MINUTE/HOURLY/...), never with /SC ONLOGON:
 *   1. "dshpkg-supervisor"           /SC ONLOGON  — starts the watchdog at
 *      logon (the primary requirement).
 *   2. "dshpkg-supervisor-keepalive" /SC MINUTE /MO 5 — re-launches every 5
 *      minutes so a crashed watchdog is back within 5 min (the supervisor's
 *      own single-instance lock makes the re-launch idempotent).
 * /RL LIMITED keeps both user-scoped (no elevation). schtasks runs as a
 * plain arg array, never a shell.
 */
async function cmdDaemon(ctx, args, opts) {
  try {
    const sub = String(args[0] ?? "").trim();
    const runner = ctx.runner ?? schtasksRunner;
    const profile = opts.profile ?? (await readState()).profile ?? "web";
    const cmd = daemonCommand(profile);
    const all = [DAEMON_TASKS.logon, DAEMON_TASKS.keepalive];
    if (sub === "install") {
      const logon = await runner([
        "schtasks", "/Create", "/TN", DAEMON_TASKS.logon, "/TR", cmd,
        "/SC", "ONLOGON", "/RL", "LIMITED", "/F",
      ]);
      if (logon.status !== 0) {
        throw new Error(
          `注册登录任务失败: ${logon.stderr ?? logon.stdout ?? "未知错误"}`,
        );
      }
      const keepalive = await runner([
        "schtasks", "/Create", "/TN", DAEMON_TASKS.keepalive, "/TR", cmd,
        "/SC", "MINUTE", "/MO", "5", "/RL", "LIMITED", "/F",
      ]);
      if (keepalive.status !== 0) {
        throw new Error(
          `注册自愈任务失败: ${keepalive.stderr ?? keepalive.stdout ?? "未知错误"}`,
        );
      }
      ctx.log(
        `已注册计划任务 ${DAEMON_TASKS.logon}（登录时启动）与 ${DAEMON_TASKS.keepalive}（每 5 分钟自愈拉起）`,
      );
      // --now: start the watchdog immediately instead of waiting for the next
      // logon / keep-alive tick, so a fresh install guards dsh right away.
      if (opts.now) {
        const run = await runner(["schtasks", "/Run", "/TN", DAEMON_TASKS.logon]);
        if (run.status !== 0) {
          ctx.error(`立即启动失败: ${run.stderr ?? run.stdout ?? "未知错误"}`);
        } else {
          ctx.log("已立即启动看门狗");
        }
      }
      return 0;
    }
    if (sub === "uninstall") {
      let failed = false;
      for (const tn of all) {
        const result = await runner(["schtasks", "/Delete", "/TN", tn, "/F"]);
        if (result.status !== 0) failed = true;
      }
      if (failed) ctx.error("注销时部分任务删除失败（可能本就不存在）");
      else ctx.log(`已注销计划任务 ${all.join(" / ")}`);
      return 0;
    }
    if (sub === "status") {
      const registered = [];
      for (const tn of all) {
        const result = await runner(["schtasks", "/Query", "/TN", tn]);
        if (result.status === 0) registered.push(tn);
      }
      if (registered.length === all.length) {
        ctx.log("看门狗计划任务已注册（登录启动 + 5 分钟自愈）");
        return 0;
      }
      if (registered.length === 0) {
        ctx.log("看门狗计划任务未注册（运行 dshpkg daemon install 注册）");
      } else {
        ctx.log(
          `看门狗计划任务不完整：已注册 ${registered.join("、")}，缺失 ${
            all.filter((tn) => !registered.includes(tn)).join("、")
          }（运行 dshpkg daemon install 补齐）`,
        );
      }
      return 1;
    }
    throw new Error("用法: dshpkg daemon install [--now]|uninstall|status");
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

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
    const text = await readTextOrEmpty(patchFile);
    const updated = disabled
      ? applyDisableToPatch(text, name)
      : removeManagedBlock(text, name);
    if (updated === text) {
      ctx.log(`插件 ${name} 已处于${disabled ? "禁用" : "启用"}状态`);
      return 0;
    }
    await writeFile(patchFile, updated, "utf8");
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

    // --fix: install every missing dependency automatically (no waiting for
    // a human to run install by hand).
    if (opts.fix && problems.length > 0) {
      ctx.log("自动修复: 安装缺失依赖...");
      const recipeByName = new Map(recipes.map(({ recipe: r }) => [r.name, r]));
      let failures = 0;
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
      if (failures > 0) {
        ctx.error(`仍有 ${failures} 处依赖修复失败`);
        return 1;
      }
      ctx.log("缺失依赖已全部自动修复");
      return 0;
    }
    return problems.length === 0 ? 0 : 1;
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
      const patchText = await readTextOrEmpty(patchFile);
      const updated = removeManagedBlock(patchText, name);
      if (updated !== patchText) {
        await writeFile(patchFile, updated, "utf8");
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

async function cmdOptimize(ctx, args, opts) {
  try {
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const profileDir = await resolveProfileDir(profile);

    ctx.log(`[性能诊断] profile: ${profile}`);

    // 1) compose cost
    const comp = await measureCompose(profile, { dshRun: ctx.dshRun });
    ctx.log(`组合耗时(--dump-config): ${comp.ok ? `${comp.ms}ms` : "失败"}${comp.ok ? "" : `（${comp.error ?? "?"}）`}`);

    // 2) cache usage
    const cache = await cacheStats();
    ctx.log(`缓存占用: 快照 ${cache.snapshotCount} 份 ${mb(cache.snapshotsBytes)}MB · git ${mb(cache.gitBytes)}MB · managed ${mb(cache.managedBytes)}MB · index ${mb(cache.indexBytes)}MB（共 ${mb(cache.totalBytes)}MB）`);

    // 3) plugin sizes + scoring
    const sizes = {};
    if (profileDir) {
      for (const name of Object.keys(state.packages ?? {})) {
        const s = await dirSize(join(profileDir, "node_modules", name));
        if (s > 0) sizes[name] = s;
      }
    }
    const scores = scorePlugins(state, { sizes });

    // 4) memory budget governance
    const budgetMb = opts.budget && opts.budget > 0 ? opts.budget * 1024 * 1024 : undefined;
    const mem = await sampleMemory();
    const b = memoryBudget({ memory: mem, budget: budgetMb });
    const level = budgetLevel({ rss: b.rss, budget: b.budget });
    ctx.log(`内存: RSS ${mb(b.rss)}MB / 预算 ${mb(b.budget)}MB（${b.pct}%）档位 ${level}${b.over ? "（超预算）" : ""}`);
    const plan = evictionPlan({ rss: b.rss, budget: b.budget, scores });
    if (plan.actions.length > 0) {
      ctx.log(`建议禁用以释放内存（${plan.actions.length} 个）: ${plan.actions.map((a) => a.name).join("、")}`);
      if (!opts.apply) ctx.log("提示: 加 --apply 自动禁用（写 cordis.patch.yml 禁用块，重启后生效，可逆）。");
    }

    // 5) unstable plugin report
    const unstable = scores.filter(
      (e) => (e.circuitOpen || e.crashCount >= 3) && !e.held && !isProtected(e.name),
    );
    const top = scores.filter((e) => e.score > 0).slice(0, 8);
    if (top.length === 0) ctx.log("未发现高负载/不稳定插件，当前配置较健康。");
    else {
      ctx.log(`高负载/不稳定插件 Top ${top.length}:`);
      for (const e of top) ctx.log(`  ${e.name}（评分 ${e.score}）: ${e.reasons.join("、") || "—"}`);
    }
    if (unstable.length > 0) {
      ctx.log(`建议禁用的不稳定插件（${unstable.length} 个）: ${unstable.map((e) => e.name).join("、")}`);
      if (!opts.apply) ctx.log("提示: 加 --apply 自动禁用（写 cordis.patch.yml 禁用块，重启后生效，可逆）。");
    }

    // 6) --apply: disable unstable + red-zone memory relief (file mode, reversible)
    if (opts.apply) {
      const targets = [...unstable.map((e) => e.name), ...plan.actions.map((a) => a.name)];
      const uniq = [...new Set(targets)];
      if (uniq.length > 0) {
        if (!profileDir) throw new Error(`找不到 profile "${profile}"（目录不存在或缺少 dsh.profile 声明）`);
        const patchFile = join(profileDir, "cordis.patch.yml");
        let text = await readTextOrEmpty(patchFile);
        let changed = 0;
        for (const name of uniq) {
          const updated = applyDisableToPatch(text, name);
          if (updated !== text) { text = updated; changed += 1; }
        }
        if (changed > 0) {
          await writeFile(patchFile, text, "utf8");
          ctx.log(`已禁用 ${changed} 个插件（写入 ${profile} 的 cordis.patch.yml，重启 dsh 后生效；dshpkg enable <名称> 可恢复）`);
        } else {
          ctx.log("这些插件已在禁用状态，无需改动。");
        }
      }
    }
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdHeal(ctx, _args, opts) {
  try {
    const state = await readState();
    const incidents = await readIncidents(2000);
    const profile = opts.profile ?? state.profile ?? "web";
    const ev = collectBootEvidence({ incidents, state });

    ctx.log(`[崩溃自愈诊断] 共 ${ev.total} 条事件，其中 ${ev.crashes.length} 条崩溃相关`);
    ctx.log(`上次成功启动: ${ev.lastBootOkAt ?? "未知"} · bootFailures=${ev.bootFailures}`);
    if (ev.topCulprits.length > 0) ctx.log(`高频嫌疑条目: ${ev.topCulprits.join("、")}`);
    const clazzLines = Object.entries(ev.classCounts).filter(([, n]) => n > 0);
    if (clazzLines.length > 0) {
      ctx.log(`崩溃分类: ${clazzLines.map(([c, n]) => `${c}(${n})`).join("、")}`);
    }

    // suggestions from the most recent crashes, deduped by kind+name
    const suggestions = [];
    const seen = new Set();
    for (const crash of ev.crashes.slice(-12).reverse()) {
      const culprit = crash.culprits[0] ?? "";
      const act = suggestAction(crash.clazz, { name: culprit });
      const key = `${act.kind}:${culprit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ ...act, name: culprit, clazz: crash.clazz });
    }

    if (suggestions.length === 0) {
      ctx.log("最近未发现可归因的崩溃，配置健康。");
      return 0;
    }

    ctx.log(`建议动作（${suggestions.length} 项）:`);
    for (const s of suggestions) {
      const target = s.name ? ` ${s.name}` : "";
      ctx.log(`  [${s.kind}]${target}: ${s.reason}`);
    }

    if (opts.yes) {
      let plan = executablePlan(suggestions);
      if (plan.length === 0) {
        ctx.log("没有可自动执行的动作（其余需人工或 --upgrade）。");
        return 0;
      }
      const profileDir = await resolveProfileDir(profile);
      if (!profileDir) throw new Error(`找不到 profile "${profile}"（目录不存在或缺少 dsh.profile 声明）`);
      const patchFile = join(profileDir, "cordis.patch.yml");

      // Dependency-aware guard (Phase 2): refuse auto-disable that would
      // cascade into baseline dependents; the refused ones go to manual.
      const reverse = await reverseDeps(profileDir);
      const knownEntries = Object.keys(state.packages ?? {});
      const baseline = activeBaseline({ incidents, knownEntries });
      const guardedPlan = [];
      const guardedOut = [];
      for (const action of plan) {
        if (action.kind === "disable") {
          const g = guardDisable(action.name, { reverse, baseline, isProtected });
          if (!g.allowed) {
            guardedOut.push({ kind: "manual", name: action.name, reason: g.risk.join("；") });
            for (const r of g.risk) ctx.log(`  ⛔ [secure] ${action.name}: ${r}（跳过自动禁用）`);
            continue;
          }
        }
        guardedPlan.push(action);
      }
      plan = guardedPlan;
      const applyDisable = async (name) => {
        const text = await readTextOrEmpty(patchFile);
        const updated = applyDisableToPatch(text, name);
        if (updated !== text) await writeFile(patchFile, updated, "utf8");
      };
      const removeBlock = async (name) => {
        const text = await readTextOrEmpty(patchFile);
        const updated = removeManagedBlock(text, name);
        if (updated !== text) await writeFile(patchFile, updated, "utf8");
      };
      const upgradePkg = async (name) => {
        if (opts.upgrade && name) {
          const res = await install(name, { profile });
          if (!res.ok) throw new Error(res.error ?? "升级失败");
        } else {
          throw new Error("--upgrade 未开启，跳过升级型动作");
        }
      };
      const out = await heal({
        profile,
        plan,
        dshRun: ctx.dshRun,
        applyDisable,
        removeBlock,
        upgradePkg,
        incident: appendIncident,
      });
      for (const a of out.actions) {
        const status = a.ok ? "✓" : "✗";
        ctx.log(`  ${status} [${a.kind}] ${a.name}${a.rolledBack ? "（已回滚）" : ""}${a.error ? `: ${a.error}` : ""}`);
      }
      const allManual = [...out.needsManual, ...guardedOut];
      if (allManual.length > 0) {
        ctx.log(`需人工处理: ${allManual.map((m) => m.name || m.kind).join("、")}`);
      }
      ctx.log(out.verified ? "自愈动作全部通过校验。" : "部分动作未通过校验，已回滚，请人工介入。");
    } else {
      ctx.log("提示: 加 --yes 可自动执行 [disable] 类安全动作（逐一校验、失败回滚）；--upgrade 让 [upgrade] 类动作走事务升级。");
    }
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
  ["audit", cmdAudit],
  ["fix-broken", cmdFixBroken],
  ["log", cmdLog],
  ["optimize", cmdOptimize],
  ["heal", cmdHeal],
  ["run", cmdRun],
  ["repo", cmdRepo],
  ["key", cmdKey],
  ["self-upgrade", cmdSelfUpgrade],
  ["daemon", cmdDaemon],
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
    "  doctor [--fix]             校验组合树与依赖图（--fix 自动安装缺失依赖）",
    "  autoremove                 清理孤儿包（被卸载插件的残留依赖；--dry-run 演练）",
    "  audit                     最近 20 条崩溃记录 + 电路状态汇总",
    "  optimize [--apply] [--budget <MB>]",
    "                            性能诊断与优化：组合耗时、内存预算(默认500MB)、高负载/不稳定插件、缓存占用；--apply 自动禁用",
    "  heal [--yes] [--upgrade]   崩溃自愈诊断：归因分类+建议动作（--yes 执行安全可逆动作并逐一校验，--upgrade 走事务升级）",
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
    "  daemon install [--now]|uninstall|status",
    "                            注册/注销/查询看门狗计划任务（Windows 计划任务；",
    "                            install --now 注册后立即启动一次）",
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
  "--apply",
  "--budget",
  "--upgrade",
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
    apply: false,
    budget: null,
    upgrade: false,
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
    if (arg === "--apply") {
      opts.apply = true;
      continue;
    }
    if (arg === "--upgrade") {
      opts.upgrade = true;
      continue;
    }
    if (arg === "--budget" && argv[i + 1] !== undefined) {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--budget 必须是正数（MB）");
      opts.budget = value;
      continue;
    }
    if (arg.startsWith("--budget=")) {
      const value = Number(arg.slice("--budget=".length));
      if (!Number.isFinite(value) || value <= 0) throw new Error("--budget 必须是正数（MB）");
      opts.budget = value;
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
function makeCtx({ log, error, ask, runner, installRunner, dshRun, fetcher, spawnImpl, search, gitRunner } = {}) {
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
