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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readState,
  writeState,
  readIncidents,
  resolveProfileDir,
  readJson,
} from "../lib/state.js";
import { search } from "../lib/search.js";
import {
  repoAdd,
  repoRemove,
  repoList,
  syncRepos,
  loadAllRecipes,
} from "../lib/repo.js";
import { refreshIndex, readIndex } from "../lib/indexer.js";
import { install, remove, defaultRunner, defaultInstallRunner } from "../lib/transaction.js";
import { isOpen, closeCircuit } from "../lib/circuit.js";
import { isProtected } from "../lib/protect.js";
import { runDshSync } from "../lib/launcher.js";
import {
  hasManagedBlock,
  applyDisableToPatch,
  removeManagedBlock,
} from "../lib/rescue.js";
import { recipeFromPackageJson } from "../lib/recipe.js";

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

/** GET /dshpkg/status with a 2s timeout; null when no host answers. */
async function probeHost(ctx, port) {
  const fetcher = ctx.fetcher ?? globalThis.fetch;
  try {
    const res = await fetcher(`http://127.0.0.1:${port}/dshpkg/status`, {
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
  try {
    const res = await fetcher(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      recipe = resolved.recipe;
      recordSpec = resolved.recordSpec;
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
      const existing = state.packages?.[installedName] ?? {};
      state.packages[installedName] = {
        ...existing,
        source: existing.source ?? (installedName === name ? recordSpec : installedName),
        version:
          installedName === name
            ? versionOf(recordSpec) ?? recipe?.source?.spec?.match(/@([^@/]+)$/)?.[1] ?? null
            : existing.version ?? null,
        kind: installedName === name ? recipe?.kind ?? "unknown" : existing.kind ?? "unknown",
        installedAt: new Date().toISOString(),
        held: existing.held ?? false,
        crashCount: 0,
        crashTimes: [],
        circuitOpenAt: null,
      };
    }
    await writeState(state);
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
    if (state.packages?.[name]) {
      delete state.packages[name];
      await writeState(state);
    }
    ctx.log(`已移除 ${name}`);
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}

async function cmdUpdate(ctx, _args, _opts) {
  try {
    ctx.log("同步配方仓库...");
    const outcomes = await syncRepos();
    if (outcomes.length === 0) {
      ctx.log("  （未配置配方仓库，使用 dshpkg repo add <url> 添加）");
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
      ctx.log(opts.installed ? "（未安装任何插件）" : "（配方库与本地均无插件）");
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
    return problems.length === 0 ? 0 : 1;
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
    if (sub === "add") {
      const entry = await repoAdd(args[1], args[2]);
      ctx.log(`已添加仓库 ${entry.name}（${entry.url}）`);
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
        ctx.log("（未配置任何配方仓库，使用 dshpkg repo add <url> 添加）");
        return 0;
      }
      ctx.log("仓库列表（优先级从上到下）:");
      for (const repo of repos) {
        ctx.log(`  ${repo.enabled === false ? "✗" : "✓"} ${repo.name}  ${repo.url}`);
      }
      return 0;
    }
    throw new Error("用法: dshpkg repo add <url> [名称] | repo remove <名称> | repo list");
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
  ["audit", cmdAudit],
  ["fix-broken", cmdFixBroken],
  ["log", cmdLog],
  ["run", cmdRun],
  ["repo", cmdRepo],
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
    "  doctor                    校验组合树与依赖图（dsh --dump-config）",
    "  audit                     最近 20 条崩溃记录 + 电路状态汇总",
    "  fix-broken                交互式修复 circuit-open 的插件",
    "  log                       输出崩溃事件流（incidents.jsonl）",
    "  run                       启动看门狗守护 dsh（--port N / --profile 名）",
    "  repo add <url> [名称]     添加配方仓库",
    "  repo remove <名称>        移除配方仓库",
    "  repo list                 列出配方仓库",
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
