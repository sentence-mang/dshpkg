#!/usr/bin/env node
// dshpkg — L3 process watchdog (supervisor).
//
// Keeps a dsh profile alive: spawns the harness, health-probes it over HTTP,
// and self-heals on boot failures:
//   1. non-zero child exit -> parse stderr with the loader-error triage regex,
//      disable the culprit entry via a managed marker block in
//      cordis.patch.yml, then restart;
//   2. three consecutive boot failures -> circuit open -> restore the newest
//      snapshot from <stateRoot>/snapshots/;
//   3. health probe success resets the failure counter.
//
// Hard constraints honoured here (see CONTRACTS.md):
//   - plain ESM, zero third-party dependencies (node:* builtins only);
//   - never shell:true — spawn "node" with the launcher script path;
//   - comments in English, user-facing console text in Chinese;
//   - all IO is injectable (spawnImpl / probeImpl / sleepImpl / onEvent) so
//     the test suite stays fully offline.

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  listSnapshots,
  resolveProfileDir,
  statePath,
  readJson,
  appendIncident,
  readState,
  writeState,
  acquireSupervisorLock,
  releaseSupervisorLock,
  refreshSupervisorLock,
} from "../lib/state.js";
import { isProtected } from "../lib/protect.js";
import { isEntrylessPatch, restoreEmptyArray } from "../lib/rescue.js";
import { resolveDshLauncher } from "../lib/launcher.js";
import { recordCrash, isDangerousKey } from "../lib/circuit.js";
import { saveSnapshot } from "../lib/snapshot.js";
import { autoPoll } from "../lib/repo.js";

// --- tuning constants (exported for tests / documentation) -----------------

/** Grace period after spawn before the first health probe. */
export const GRACE_MS = 30_000;
/** Interval between health probes. */
export const PROBE_INTERVAL_MS = 10_000;
/** Per-probe HTTP timeout. */
export const PROBE_TIMEOUT_MS = 5_000;
/** Consecutive failed probes that mark a child as hung (killed + restarted). */
export const PROBE_FAIL_LIMIT = 3;
/** Consecutive boot failures that open the circuit and restore a snapshot. */
export const BOOT_FAIL_LIMIT = 3;
/** How often the live supervisor refreshes its lock heartbeat. Must be well
 * under SYNC_LOCK_STALE_MS (10 min) so the 5-minute keep-alive re-launch never
 * mistakes a live watchdog for a dead one and double-spawns it. */
export const SUPERVISOR_HEARTBEAT_MS = 60_000;

// --- managed marker block convention ---------------------------------------

const MANAGED_START = "# dshpkg:managed:start";
const MANAGED_END = "# dshpkg:managed:end";

// Matches one complete managed block (start .. end), block body in group 1.
const MANAGED_BLOCK_RE =
  /^[ \t]*# dshpkg:managed:start[ \t]*\r?\n([\s\S]*?)^[ \t]*# dshpkg:managed:end[ \t]*\r?\n?/gm;

// Matches a managed start marker without its end marker (broken block).
const UNCLOSED_MANAGED_RE = /^[ \t]*# dshpkg:managed:start[ \t]*\r?\n[\s\S]*$/m;

// --- triage: loader error parsing (inlined per contract) --------------------

// Verified kernel message format (CONTRACTS.md):
//   failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure
// Wrappers add nesting (outermost names the include wrapper); the INNERMOST
// match is the culprit, so matches are returned in order and the last one wins.
export function parseLoaderErrors(text) {
  const re =
    /failed to (import|apply|dispose|rollback) loader entry (\S+) \(([^)]*)\): (.*)/g;
  const out = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push({
      stage: match[1],
      entryId: match[2],
      entryName: match[3],
      detail: match[4],
    });
    if (match[4].length === 0) break;
    // The greedy detail swallows nested loader errors on the first pass
    // (outer wrappers like cordis:include name the include). Move the
    // cursor back to the detail start so the next exec finds the innermost
    // match; the last element of the result is therefore the culprit.
    re.lastIndex -= match[4].length;
  }
  return out;
}

// --- triage: uncaughtException stack attribution ----------------------------

// Sync-crash class: the child dies from an uncaught exception without any
// "failed to apply loader entry" kernel message, so parseLoaderErrors misses
// and the watchdog would restore a snapshot instead of circuit-opening the
// culprit. The stack trace still names the file the throw happened in;
// extracting node_modules/<pkg>/ path segments recovers the package name.
const NODE_MODULES_SEGMENT_RE =
  /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)[\\/]/g;

/**
 * Extract candidate package names from an stderr tail by scanning stack
 * frames ("at ..." lines) for node_modules/<pkg>/ and node_modules/@scope/
 * <name>/ path segments. Candidates are deduped and sorted by occurrence
 * frequency (ties keep first-seen order); internal entries such as the
 * pnpm virtual store (.pnpm) are skipped.
 *
 * @param {string} stderrText stderr tail or any text; null-safe
 * @returns {string[]} candidate package names, most frequent first
 */
export function parseUncaughtModule(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) return [];
  const counts = new Map();
  for (const line of stderrText.split(/\r?\n/)) {
    if (!/^\s*at\s+/.test(line)) continue;
    for (const match of line.matchAll(NODE_MODULES_SEGMENT_RE)) {
      const name = match[1];
      if (!name || name.startsWith(".")) continue; // .pnpm virtual store etc.
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

// Quote handling for a YAML scalar read from a patch line.
function unquoteYamlScalar(value) {
  let v = String(value ?? "").trim();
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    v = v.slice(1, -1).replace(/''/g, "'");
  } else if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * Extract the first insert entry (id + name) from a package's own
 * cordis.patch.yml (the official bundle patch shape is
 * `- insert: [{ id, name }]`). The name is the `name:` line belonging to
 * the matched `- id:` entry. Returns null when no `- id:` line exists.
 */
function extractInsertEntry(patchText) {
  if (!patchText) return null;
  const lines = String(patchText).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^[ \t]*-[ \t]+id:[ \t]*(.+?)[ \t]*(?:#.*)?$/.exec(lines[i]);
    if (!match) continue;
    let name = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^[ \t]*-[ \t]+id:/.test(lines[j])) break; // next entry reached
      const nameMatch = /^[ \t]*name:[ \t]*(.+?)[ \t]*(?:#.*)?$/.exec(lines[j]);
      if (nameMatch) {
        name = unquoteYamlScalar(nameMatch[1]);
        break;
      }
    }
    return { id: unquoteYamlScalar(match[1]), name };
  }
  return null;
}

// First `- id: <value>` line inside a package's own cordis.patch.yml (the
// official bundle patch shape is `- insert: [{ id, name }]`).
function extractInsertEntryId(patchText) {
  return extractInsertEntry(patchText)?.id ?? null;
}

/** Read a text file; a missing file reads as "". */
async function readTextOrEmpty(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve a package name (from an uncaughtException stack frame) to the
 * loader entry id it inserts, fully offline:
 *   1. read <profileDir>/node_modules/<pkgName>/cordis.patch.yml and extract
 *      the insert entry id;
 *   2. fall back to <profileDir>/package.json dsh.profile.bundles: bundle
 *      entries matching the package name (exact or @version-suffixed) are
 *      scanned under node_modules; local-path bundle entries (file:/link:/
 *      absolute/relative paths, e.g. linked fixtures) are scanned directly;
 *   3. both fail -> null.
 *
 * @param {string} profileDir absolute profile directory
 * @param {string} pkgName package name from the stack trace
 * @returns {Promise<string|null>} loader entry id, or null
 */
export async function resolveEntryByPackage(profileDir, pkgName) {
  const looksLikePath = (value) =>
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\");
  const targets = [{ kind: "pkg", value: pkgName }];
  const manifest = await readJson(join(profileDir, "package.json"), null);
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles
    : [];
  for (const bundle of bundles) {
    const raw = String(bundle ?? "").trim();
    if (!raw) continue;
    const bare = raw.replace(/^(link:|file:)/, "");
    if (bare === pkgName || bare.startsWith(`${pkgName}@`)) {
      // Bundle entries may carry a version suffix (pkg@1.0.0): the
      // filesystem directory is always the bare package name.
      targets.push({ kind: "pkg", value: bare.replace(/@[^@/]+$/, "") });
    } else if (looksLikePath(bare)) {
      // Linked fixtures live outside node_modules: scan them directly.
      targets.push({ kind: "dir", value: bare });
    }
  }
  for (const target of targets) {
    const file =
      target.kind === "dir"
        ? join(target.value, "cordis.patch.yml")
        : join(profileDir, "node_modules", target.value, "cordis.patch.yml");
    const entryId = extractInsertEntryId(await readTextOrEmpty(file));
    if (entryId) return entryId;
  }
  return null;
}

// --- triage: installed bundles + real-path attribution ----------------------

// Normalise arbitrary text for path comparison: strip file:// URL prefixes,
// unify separators to forward slashes and fold case — junction targets,
// stack traces and dependency values may disagree in any of these.
function normalizePathForCompare(value) {
  return String(value ?? "")
    .replace(/file:\/+/gi, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

// Does a (raw) directory path appear in already-normalised text as a full
// path component? The character right after the match must not continue the
// directory name (sync-crash must not match sync-crash-v2).
function pathAppearsInText(pathValue, normalizedText) {
  const needle = normalizePathForCompare(pathValue);
  if (!needle) return false;
  const idx = normalizedText.indexOf(needle);
  if (idx === -1) return false;
  const next = normalizedText[idx + needle.length];
  return (
    next === undefined ||
    next === "/" ||
    next === ")" ||
    next === ":" ||
    next === "\n"
  );
}

// Does an entry/module name appear in normalised text as a standalone token?
// Letters/digits/`-`/`_` join words (pkg must not match pkg-v2); path
// separators, parentheses and other punctuation delimit.
function moduleNameAppearsInText(name, normalizedText) {
  const needle = String(name ?? "").toLowerCase();
  if (!needle) return false;
  const wordChar = (ch) => ch !== undefined && /[a-z0-9_-]/.test(ch);
  let from = 0;
  for (;;) {
    const idx = normalizedText.indexOf(needle, from);
    if (idx === -1) return false;
    const before = normalizedText[idx - 1];
    const after = normalizedText[idx + needle.length];
    if (!wordChar(before) && !wordChar(after)) return true;
    from = idx + 1;
  }
}

/**
 * Collect the real on-disk locations of one installed package:
 *   a) <profileDir>/node_modules/<pkgName> when present — fs.realpath
 *      resolves pnpm link: junctions / symlinks to the true source dir;
 *   b) a link:/file: dependency value carries the source path verbatim
 *      (e.g. "link:C:/…/fixtures/sync-crash"): extract + realpath it too.
 * Raw realpath strings are kept (fs-readable); comparison normalises.
 */
async function resolvePackageRealPaths(profileDir, pkgName, depValue) {
  const paths = new Set();
  const candidates = [];
  const nodeModulesDir = join(profileDir, "node_modules", pkgName);
  if (existsSync(nodeModulesDir)) candidates.push(nodeModulesDir);
  const bare = String(depValue ?? "")
    .trim()
    .replace(/^(link:|file:)/, "");
  if (bare && /^[a-zA-Z]:[\\/]|^[./]|^\//.test(bare)) candidates.push(bare);
  for (const candidate of candidates) {
    try {
      paths.add(await realpath(candidate));
    } catch {
      // broken junction / missing directory: skip
    }
  }
  return [...paths];
}

/**
 * Inventory the installed bundles of a profile for stack attribution:
 * package names from package.json dependencies + dsh.profile.bundles (merged,
 * deduped), each with its real disk paths and its insert entry ids + names
 * (read from the bundle's own cordis.patch.yml next to the real path).
 * Any failure (missing/broken profile) degrades to []: attribution must
 * never block the watchdog.
 *
 * @param {string} profileDir absolute profile directory
 * @returns {Promise<Array<{pkgName:string, realPaths:string[], entryIds:string[], moduleNames:string[]}>>}
 */
export async function listInstalledBundles(profileDir) {
  const out = [];
  try {
    const manifest = await readJson(join(profileDir, "package.json"), null);
    if (!manifest || typeof manifest !== "object") return out;
    const deps =
      manifest.dependencies && typeof manifest.dependencies === "object"
        ? manifest.dependencies
        : {};
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles
      : [];
    const names = [];
    const pushName = (name) => {
      if (name && !names.includes(name)) names.push(name);
    };
    for (const key of Object.keys(deps)) pushName(key);
    for (const raw of bundles) {
      // Bundle entries may carry a link:/file: prefix or a version suffix
      // (pkg@1.0.0); the identifier is always the bare package name.
      pushName(
        String(raw ?? "")
          .trim()
          .replace(/^(link:|file:)/, "")
          .replace(/@[^@/]+$/, ""),
      );
    }
    for (const pkgName of names) {
      const realPaths = await resolvePackageRealPaths(
        profileDir,
        pkgName,
        deps[pkgName],
      );
      const entryIds = [];
      const moduleNames = [];
      for (const realPath of realPaths) {
        const entry = extractInsertEntry(
          await readTextOrEmpty(join(realPath, "cordis.patch.yml")),
        );
        if (!entry) continue;
        if (entry.id && !entryIds.includes(entry.id)) entryIds.push(entry.id);
        if (entry.name && !moduleNames.includes(entry.name)) {
          moduleNames.push(entry.name);
        }
      }
      out.push({ pkgName, realPaths, entryIds, moduleNames });
    }
  } catch {
    // broken profile on disk: no attribution possible this round
  }
  return out;
}

/**
 * Attribute an uncaughtException stack (or any stderr text) to an installed
 * bundle by matching the bundle's real disk paths inside the text:
 *   - the text is normalised (file:// stripped, separators unified, case
 *     folded), so a link: junction stack naming the TRUE source path
 *     (no node_modules segment) still hits;
 *   - a hit takes the bundle's first insert entry id; when no real path
 *     matches, a verbatim entry-name mention is the weaker fallback signal.
 * Returns { entryId, pkgName } — both null when nothing matches.
 *
 * @param {string} stderrText stderr tail or any text; null-safe
 * @param {Array<object>} installed listInstalledBundles() output
 * @returns {{entryId:string|null, pkgName:string|null}}
 */
export function attributeFromStack(stderrText, installed) {
  const text = normalizePathForCompare(stderrText);
  const list = Array.isArray(installed) ? installed : [];
  for (const bundle of list) {
    const realPaths = Array.isArray(bundle?.realPaths) ? bundle.realPaths : [];
    if (realPaths.some((p) => pathAppearsInText(p, text))) {
      return {
        entryId: bundle.entryIds?.[0] ?? null,
        pkgName: bundle.pkgName ?? null,
      };
    }
  }
  // No real path found in the text: an entry-name mention is a weaker but
  // still package-specific signal (e.g. "dshpkg-fixture-sync-crash").
  for (const bundle of list) {
    const names = Array.isArray(bundle?.moduleNames) ? bundle.moduleNames : [];
    for (const name of names) {
      if (moduleNameAppearsInText(String(name), text)) {
        return {
          entryId: bundle.entryIds?.[0] ?? null,
          pkgName: bundle.pkgName ?? null,
        };
      }
    }
  }
  return { entryId: null, pkgName: null };
}

// --- cordis.patch.yml helpers (exported for tests) --------------------------

/**
 * Classify the top level of a patch file: a YAML array, an empty file
 * (comments/blank lines only), or something else (refuse to touch).
 * Heuristic, dependency-free: strips comment/blank lines, then inspects the
 * first meaningful line.
 *
 * @param {string} patchText
 * @returns {{ok:true,kind:"array"|"empty"}|{ok:false,kind:"invalid",first:string}}
 */
export function readPatchTopLevel(patchText) {
  const meaningful = patchText.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  if (meaningful.length === 0) return { ok: true, kind: "empty" };
  const first = meaningful[0].trim();
  if (first === "[]" || first.startsWith("- ") || first === "-") {
    return { ok: true, kind: "array" };
  }
  return { ok: false, kind: "invalid", first };
}

// Quote an entry id for YAML when it is not a plain scalar.
function yamlSafeId(id) {
  if (/^[A-Za-z0-9_.\-/@]+$/.test(id) && !/^[-?]/.test(id)) return id;
  return `'${id.replace(/'/g, "''")}'`;
}

// Does one managed block body already disable this entry id?
function managedBlockContainsId(blockText, entryId) {
  for (const line of blockText.split(/\r?\n/)) {
    const match = /^[ \t]*-[ \t]+id:[ \t]*(.+?)[ \t]*(?:#.*)?$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    if (value === entryId) return true;
  }
  return false;
}

/**
 * Append a managed disable block for entryId to <profileDir>/cordis.patch.yml.
 * Only appends (never rewrites existing lines); skips when a managed block for
 * the same id already exists; refuses non-array / non-empty top levels.
 * A bare `[]` placeholder (official profile initial state) is replaced, not
 * appended after: `[]` cannot take sibling lines in YAML.
 *
 * @returns {Promise<{written:boolean}>}
 */
export async function writeManagedDisable(profileDir, entryId) {
  const patchFile = join(profileDir, "cordis.patch.yml");
  let text = "";
  try {
    text = await readFile(patchFile, "utf8");
  } catch {
    // missing file = empty file
  }
  const top = readPatchTopLevel(text);
  if (!top.ok) {
    throw new Error(
      "cordis.patch.yml 顶层不是 YAML 数组或空文件，拒绝写入 managed 块",
    );
  }
  for (const match of text.matchAll(MANAGED_BLOCK_RE)) {
    if (managedBlockContainsId(match[1], entryId)) return { written: false };
  }
  const block = `${MANAGED_START}\n- id: ${yamlSafeId(entryId)}\n  disabled: true\n${MANAGED_END}\n`;
  let base = text;
  if (isEntrylessPatch(text)) {
    // Drop the `[]` placeholder line together with its comment header;
    // trailing comments (if any) stay in front of the managed block.
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((line) => line.trim() === "[]");
    if (idx !== -1) base = lines.slice(idx + 1).join("\n").trim();
  }
  base = base.length === 0 || base.endsWith("\n") ? base : base + "\n";
  await writeFile(patchFile, base + block, "utf8");
  return { written: true };
}

/**
 * Remove every dshpkg-managed marker block (and only those) from
 * <profileDir>/cordis.patch.yml. User content is left untouched.
 *
 * @returns {Promise<number>} number of removed blocks
 */
export async function removeManagedBlock(profileDir) {
  const patchFile = join(profileDir, "cordis.patch.yml");
  let text;
  try {
    text = await readFile(patchFile, "utf8");
  } catch {
    return 0;
  }
  const matches = [...text.matchAll(MANAGED_BLOCK_RE)];
  if (matches.length === 0) return 0;
  let cleaned = text;
  for (const match of matches) cleaned = cleaned.replace(match[0], "");
  // A start marker without its end marker: drop it through end of file.
  const unclosed = UNCLOSED_MANAGED_RE.exec(cleaned);
  if (unclosed) cleaned = cleaned.replace(unclosed[0], "");
  // Removing the last entries must leave the official `[]` placeholder,
  // not an empty file (matches the profile template).
  cleaned = restoreEmptyArray(cleaned);
  await writeFile(patchFile, cleaned, "utf8");
  return matches.length;
}

// --- defaults (injectable in tests) -----------------------------------------

/**
 * Resolve the global dsh launcher entry:
 *   DSH_LAUNCHER env, else <npm-global>/node_modules/@deepseek-ai/dsh/lib/bin.js
 * (npm prefix -g when npm is available, then well-known prefixes without
 * invoking any process). Returns null when not found.
 *
 * The watchdog always launches via `node <script>` — a DSH_BIN .exe is not a
 * JS entry point and is ignored here (allowDirect: false), matching the
 * original supervisor behavior.
 */
function resolveLauncherBin() {
  const resolved = resolveDshLauncher({ allowDirect: false });
  return resolved ? resolved.script : null;
}

/**
 * Default child spawn:
 *   node <launcherBin> --profile <profile> [--port <port>] <app args...>
 *
 * The dsh launcher stops parsing its own flags at the first unknown token,
 * so launcher flags (--profile) must precede app args (--port and the rest).
 * Any --profile / --port pair already present in `args` (preserved verbatim
 * by parseCliArgs) is moved to its canonical slot instead of duplicated.
 */
function defaultSpawn({ launcherBin, profile, args }) {
  if (!launcherBin) {
    throw new Error(
      "未找到 dsh 全局入口（可设置 DSH_LAUNCHER 指向 @deepseek-ai/dsh/lib/bin.js）",
    );
  }
  let portPair = [];
  const rest = [];
  let afterDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (afterDash) {
      // Everything after "--" belongs to the app, verbatim.
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDash = true;
      rest.push(arg);
    } else if (arg === "--port" && i + 1 < args.length) {
      portPair = ["--port", args[i + 1]];
      i += 1;
    } else if (arg.startsWith("--port=")) {
      portPair = [arg];
    } else if (arg === "--profile" && i + 1 < args.length) {
      i += 1; // canonical --profile pair added below instead
    } else if (arg.startsWith("--profile=")) {
      // canonical --profile pair added below instead
    } else {
      rest.push(arg);
    }
  }
  // Never shell:true — always spawn node with the launcher script path.
  return spawn("node", [launcherBin, "--profile", profile, ...portPair, ...rest], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Default health probe: HTTP GET with a hard timeout. */
async function defaultProbe({ port, healthPath }) {
  const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return res.ok;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Extract --port <n> / --port=<n> from the dsh launch args.
function parsePortFromArgs(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--port" && i + 1 < args.length) {
      const value = Number(args[i + 1]);
      if (Number.isInteger(value) && value > 0) return value;
    }
    const match = /^--port=(\d+)$/.exec(args[i]);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Copy one snapshot's three manifest files into the profile (missing files
 * inside the snapshot are tolerated) and drop every managed block. */
async function copySnapshotIntoProfile(profileDir, ts) {
  const dir = statePath("snapshots", ts);
  for (const name of ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"]) {
    try {
      await copyFile(join(dir, name), join(profileDir, name));
    } catch {
      // a missing file inside the snapshot is tolerated
    }
  }
  await removeManagedBlock(profileDir);
  return ts;
}

// --- P3-4: unattributable-failure fallbacks ---------------------------------
//
// When failures cannot be blamed on one entry (or the culprit is protected),
// the supervisor still has to recover: the snapshot chain walks newest ->
// previous -> ... -> factory baseline, and a drifted lockfile is rebuilt
// with `pnpm install --frozen-lockfile` before the next spawn. All of it is
// best-effort and injectable (tests stay offline).

/** Pick the next snapshot to restore: the newest one not yet attempted in
 * this failure episode, else null (chain exhausted -> factory baseline).
 * Pure, exported for tests. */
export function selectSnapshotToRestore(snapshots, attempted) {
  const tried = new Set(attempted ?? []);
  for (const ts of snapshots ?? []) {
    if (!tried.has(ts)) return ts;
  }
  return null;
}

/** P3-4 factory baseline: no managed blocks, patch restored to the official
 * `[]` placeholder. User content is left untouched. */
export async function resetToFactoryBaseline(profileDir) {
  await removeManagedBlock(profileDir);
  const patchFile = join(profileDir, "cordis.patch.yml");
  const text = await readTextOrEmpty(patchFile);
  const cleaned = restoreEmptyArray(text);
  if (cleaned !== text) await writeFile(patchFile, cleaned, "utf8");
}

/** sha256 hex of <profileDir>/pnpm-lock.yaml ("" when the file is missing). */
export async function lockfileHashOf(profileDir) {
  const text = await readTextOrEmpty(join(profileDir, "pnpm-lock.yaml"));
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Persist the profile's current lockfile hash as the known-good baseline. */
async function recordLockfileHash(profileDir) {
  try {
    const state = await readState();
    state.lockfileHash = await lockfileHashOf(profileDir);
    await writeState(state);
  } catch {
    // best-effort
  }
}

/** Default lockfile rebuild: pnpm install --frozen-lockfile, never shell. */
function defaultPnpmInstall(profileDir) {
  const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: profileDir,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr || "pnpm install --frozen-lockfile 失败");
  }
}

// --- Phase 1 wiring: the self-healing pillars reach production --------------
//
// P1-1: every supervise event is persisted to incidents.jsonl (via
// appendIncident). P1-2: attributed crashes are recorded into state.packages
// with recordCrash, and the open-circuit marker is persisted when the
// supervisor trips the circuit. P1-3: known-good snapshots are taken at the
// healthy point and right before a managed disable write. Every wiring call
// is best-effort: a broken state/incident store must never stop the watchdog.

/** Flatten a supervise event into the incident record appendIncident writes
 * (type + scalar detail fields + origin context; `t` is added by the writer).
 * Flat on purpose: cmdAudit/cmdLog read entryId/detail at the top level. */
export function eventToIncident(event, ctx = {}) {
  const { type, detail = {} } = event ?? {};
  return {
    type,
    ...(detail && typeof detail === "object" ? detail : { detail }),
    profile: ctx.profile ?? null,
    port: ctx.port ?? null,
  };
}

/** P1-2: record one crash for entryId in state.json (best-effort). */
export async function persistCrash(entryId) {
  if (typeof entryId !== "string" || entryId.length === 0) return;
  try {
    const state = await readState();
    recordCrash(state, entryId, Date.now());
    await writeState(state);
  } catch {
    // crash bookkeeping must never block the watchdog
  }
}

/** P1-2: persist an explicit open-circuit marker for entryId (best-effort).
 * The record is created when missing so the marker survives a supervisor
 * restart and fix-broken / the HTTP close route can clear it. */
export async function persistCircuitOpen(entryId) {
  if (typeof entryId !== "string" || entryId.length === 0) return;
  if (isDangerousKey(entryId)) return; // never write through the prototype
  try {
    const state = await readState();
    const pkg = ((state.packages ??= {})[entryId] ??= {});
    pkg.circuitOpenAt =
      typeof pkg.circuitOpenAt === "number" ? pkg.circuitOpenAt : Date.now();
    pkg.crashCount = Math.max(pkg.crashCount ?? 0, 3);
    await writeState(state);
  } catch {
    // best-effort
  }
}

/** Fire a best-effort async side effect; failures are swallowed. */
function fire(promiseFactory) {
  Promise.resolve()
    .then(promiseFactory)
    .catch(() => {});
}

// --- main watchdog loop -----------------------------------------------------

/**
 * Supervise a dsh profile until stopped by SIGINT/SIGTERM.
 *
 * @param {object} [opts]
 * @param {string} [opts.profile="web"] profile name under DSH_HOME/profiles/
 * @param {number} [opts.port] probe port (default: --port in args, else 3080)
 * @param {string[]} [opts.args=[]] extra dsh launcher args (forwarded as-is)
 * @param {string} [opts.healthPath="/"] health endpoint path
 * @param {(event:{type:string,detail:object})=>void} [opts.onEvent] reporter
 * @param {()=>Promise<object>} [opts.spawnImpl] child factory (injected in tests)
 * @param {({port:number,healthPath:string})=>Promise<boolean>} [opts.probeImpl]
 * @param {(ms:number)=>Promise<void>} [opts.sleepImpl] clock (injected in tests)
 * @param {boolean} [opts.adoptExisting=false] before the first spawn, probe the
 *   port once; if a dsh is already healthy there, adopt it (watch-only, then
 *   take over on failure) instead of spawning a competing child that would
 *   EADDRINUSE. The CLI enables this so the supervisor becomes the single
 *   entry even when a manual `dsh web` is already running.
 * @returns {Promise<void>}
 */
export async function supervise(
  {
    profile = "web",
    port: portOption,
    args = [],
    healthPath = "/",
    onEvent = () => {},
    spawnImpl,
    probeImpl,
    sleepImpl,
    incidentImpl = appendIncident,
    snapshotImpl = saveSnapshot,
    pollImpl = autoPoll,
    pnpmInstallImpl = defaultPnpmInstall,
    adoptExisting = false,
  } = {},
) {
  // Signal handling must be armed synchronously at entry: a SIGINT/SIGTERM
  // that arrives while the profile is still resolving has to stop us too.
  let child = null;
  let stopped = false;
  let resolveStop;
  const stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const onSignal = () => {
    if (stopped) return;
    stopped = true;
    resolveStop();
    if (child && typeof child.kill === "function") {
      try {
        child.kill();
      } catch {
        // ignore kill errors while stopping
      }
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const profileDir = await resolveProfileDir(profile);
    if (!profileDir) {
      throw new Error(
        `未找到 profile "${profile}"（目录不存在或缺少 dsh.profile 声明）`,
      );
    }
    if (stopped) return;

    const port = portOption ?? parsePortFromArgs(args) ?? 3080;
    // A --port pair inside args is forwarded as-is. When the probe port came
    // from an explicit option instead, append the pair to the spawn args so
    // the dsh child binds exactly the port we probe (E2E finding: probing
    // 3199 while dsh binds its 3080 default makes every probe fail).
    const spawnArgs =
      portOption != null && parsePortFromArgs(args) == null
        ? [...args, "--port", String(port)]
        : args;
    // Resolve the launcher lazily: injected spawnImpl never touches npm.
    const launcherBin = spawnImpl ? null : resolveLauncherBin();
    const doSpawn =
      spawnImpl ?? (() => defaultSpawn({ launcherBin, profile, args: spawnArgs }));
    const doProbe = probeImpl ?? defaultProbe;
    const doSleep = sleepImpl ?? defaultSleep;

    const emit = (type, detail = {}) => {
      try {
        onEvent({ type, detail });
      } catch {
        // a broken reporter must never stop the watchdog
      }
      // P1-1: every event also lands in incidents.jsonl (best-effort).
      fire(() => incidentImpl(eventToIncident({ type, detail }, { profile, port })));
    };

    let consecutiveBootFailures = 0;
    // P3-4: snapshots already restored in the current failure episode (reset
    // on healthy) — the restore chain walks newest -> previous -> baseline.
    let attemptedSnapshots = [];

    // One health probe, normalised to a boolean (never throws).
    const probeOnce = async () => {
      try {
        const result = await doProbe({ port, healthPath });
        return result === true || result?.ok === true;
      } catch {
        return false;
      }
    };

    // Pre-flight adopt (single-entry contract): before ever spawning, probe
    // the port once. If a dsh is already healthy there (e.g. a manual
    // `dsh web`), adopt it instead of spawning a competing child that would
    // EADDRINUSE and, worse, climb the boot-failure counter into a snapshot
    // restore that clobbers the profile. While adopted we only watch: the
    // moment the port stops answering we fall through and spawn our own child.
    let adopted = false;
    if (adoptExisting && (await probeOnce())) {
      adopted = true;
      emit("adopted", { port, profile });
      while (!stopped && (await probeOnce())) {
        await doSleep(PROBE_INTERVAL_MS);
      }
      if (stopped) return;
    }

    while (!stopped) {
      // P3-4: rebuild a drifted lockfile before spawning (best-effort; a
      // failed rebuild must not stop the watchdog).
      try {
        const st = await readState();
        if (st.lockfileHash && st.lockfileHash !== (await lockfileHashOf(profileDir))) {
          await pnpmInstallImpl(profileDir);
          const after = await readState();
          after.lockfileHash = await lockfileHashOf(profileDir);
          await writeState(after);
        }
      } catch {
        // a broken rebuild must not stop the watchdog
      }
      // 1) spawn the dsh child (stdio piped for triage).
      let stdoutText = "";
      let stderrText = "";
      let exitedPromise;
      try {
        child = await doSpawn({ launcherBin, profile, args: spawnArgs });
        if (!child) throw new Error("spawn 返回空子进程");
      } catch (err) {
        emit("boot-failed", {
          reason: "spawn",
          message: String(err?.message ?? err),
        });
        break; // nothing else we can do without a working spawn
      }
      child.stdout?.on?.("data", (chunk) => {
        stdoutText += chunk;
      });
      child.stderr?.on?.("data", (chunk) => {
        stderrText += chunk;
      });
      exitedPromise = new Promise((resolve) => {
        child.once?.("exit", (code, signal) => resolve({ code, signal }));
        child.once?.("error", (err) => resolve({ error: err }));
      });

      // 2) grace period, then periodic health probes.
      await doSleep(GRACE_MS);
      if (stopped) break;

      let probeFailures = 0;
      let healthy = false;
      let exitResult = null;
      while (!stopped) {
        const winner = await Promise.race([exitedPromise, probeOnce()]);
        if (
          winner &&
          typeof winner === "object" &&
          ("code" in winner || "signal" in winner || "error" in winner)
        ) {
          exitResult = winner;
          break;
        }
        if (winner === true) {
          healthy = true;
          break;
        }
        probeFailures += 1;
        if (probeFailures >= PROBE_FAIL_LIMIT) {
          // Child alive but unresponsive: treat as a boot failure.
          try {
            child.kill();
          } catch {
            // already gone
          }
          exitResult = { code: null, signal: "SIGKILL", probeFailures };
          break;
        }
        await doSleep(PROBE_INTERVAL_MS);
      }
      if (stopped) break;

      if (healthy) {
        // 4) boot success: reset the failure counter and report.
        consecutiveBootFailures = 0;
        attemptedSnapshots = [];
        emit("healthy", { port, profile });
        // P3-4: remember the known-good lockfile hash for drift detection.
        fire(() => recordLockfileHash(profileDir));
        // P1-3 trigger ②: snapshot the known-good profile right away — this
        // is the restore source the 3-failure circuit path needs. Fire-and-
        // forget is safe here: a crash right after healthy still finds the
        // previous known-good snapshot (graceful degradation).
        fire(() => snapshotImpl(profileDir));
        // P2-4: the idle window also hosts the automatic poll. Each wake-up
        // gives pollImpl one chance to run (it resolves "poll-done" only when
        // a poll actually ran); a non-due poll leaves a never-resolving
        // promise so the window keeps waiting on child exit / SIGINT. The
        // poll is best-effort and never disturbs probe/exit handling.
        const NEVER = new Promise(() => {});
        while (!stopped) {
          const winner = await Promise.race([
            exitedPromise,
            stopPromise,
            pollImpl()
              .then((r) => (r?.ran === true ? "poll-done" : NEVER))
              .catch(() => NEVER),
          ]);
          if (winner === "poll-done") continue; // a poll ran; check again
          break;
        }
        if (stopped) break;
        exitResult = await exitedPromise;
      }

      // 3) the child exited (or was killed as hung). A clean exit (code 0,
      // no signal) stops the watchdog as well; anything else is a boot
      // failure and goes through triage.
      const code = exitResult?.code ?? null;
      const signal = exitResult?.signal ?? null;
      if (code === 0 && signal == null) {
        stopped = true;
        break;
      }

      // Attribution order (E2E finding: sync-crash uncaughtException):
      // 1) loader errors, 2) installed-bundle stack attribution — fs.realpath
      // resolves link: junctions so a stack naming the TRUE source path
      // (no node_modules segment) still finds its package, 3) legacy
      // node_modules/<pkg>/ segment scan (packages present on disk without a
      // manifest declaration), 4) null (failure counter then climbs to the
      // snapshot path).
      const output = stdoutText + stderrText;
      const firstLine =
        String(stderrText)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? "";
      const triaged = parseLoaderErrors(output);
      let culprit = triaged.length > 0 ? triaged[triaged.length - 1] : null;
      if (!culprit) {
        // The installed-bundle inventory is refreshed on every attribution
        // (the profile may change between restarts); a failure degrades to
        // [] and must never block the watchdog.
        let installed = [];
        try {
          installed = await listInstalledBundles(profileDir);
        } catch {
          // no attribution possible this round
        }
        const attributed = attributeFromStack(output, installed);
        let entryId = attributed.entryId;
        const entryName = attributed.pkgName ?? null;
        if (!entryId && entryName) {
          // Real-path hit but no insert entry id on file: fall back to the
          // existing package -> entry resolver.
          entryId = await resolveEntryByPackage(profileDir, entryName);
        }
        if (entryId) {
          culprit = {
            stage: "uncaughtException",
            entryId,
            entryName,
            detail: firstLine,
          };
        } else {
          // Legacy fallback: packages installed without a dependencies /
          // bundles declaration still leave node_modules/<pkg>/ segments.
          for (const candidate of parseUncaughtModule(output)) {
            const id = await resolveEntryByPackage(profileDir, candidate);
            if (id) {
              culprit = {
                stage: "uncaughtException",
                entryId: id,
                entryName: candidate,
                detail: firstLine,
              };
              break;
            }
          }
        }
      }
      consecutiveBootFailures += 1;
      emit("boot-failed", {
        code,
        signal,
        entryId: culprit?.entryId ?? null,
        detail: culprit?.detail ?? null,
      });

      if (culprit) {
        // P1-2: attribute the crash to the culprit's per-package history;
        // the third crash inside the window opens and persists the circuit.
        await persistCrash(culprit.entryId);
        if (isProtected(culprit.entryId)) {
          // Spec section 9: core entries must never be disabled. The failure
          // counter and the restart/circuit loop proceed as usual — only the
          // managed disable block write is skipped for protected entries.
          emit("protected-blocked", { entryId: culprit.entryId });
        } else {
          // P1-3 trigger ③: snapshot BEFORE the disable write, so the
          // restore path can roll the managed block back. Awaited on
          // purpose: the snapshot must be complete before the patch
          // changes, or a restore could capture the disabled state.
          try {
            await snapshotImpl(profileDir);
          } catch {
            // a broken snapshot store must not block the disable write
          }
          try {
            await writeManagedDisable(profileDir, culprit.entryId);
          } catch (err) {
            emit("boot-failed", {
              reason: "managed-write",
              message: String(err?.message ?? err),
            });
          }
        }
      }

      if (consecutiveBootFailures >= BOOT_FAIL_LIMIT) {
        emit("circuit-open", { failures: consecutiveBootFailures });
        // P1-2: persist the open marker so the circuit survives a supervisor
        // restart (fix-broken / the HTTP close route clear it again).
        await persistCircuitOpen(culprit?.entryId ?? null);
        let restoredTs = null;
        let baseline = false;
        try {
          // P3-4: walk the snapshot chain (newest -> previous -> ...); when
          // every snapshot was already tried in this episode, fall back to
          // the factory baseline instead of re-restoring the same broken
          // state.
          const next = selectSnapshotToRestore(
            await listSnapshots(),
            attemptedSnapshots,
          );
          if (next) {
            attemptedSnapshots.push(next);
            restoredTs = await copySnapshotIntoProfile(profileDir, next);
          } else {
            await resetToFactoryBaseline(profileDir);
            baseline = true;
          }
        } catch (err) {
          emit("boot-failed", {
            reason: "snapshot-restore",
            message: String(err?.message ?? err),
          });
        }
        emit("snapshot-restored", { ts: restoredTs, baseline });
        consecutiveBootFailures = 0;
      }

      emit("restarting", { attempt: consecutiveBootFailures + 1 });
      // loop restarts the child
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    stopped = true;
    if (child && typeof child.kill === "function") {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  }
}

// --- CLI entry (invoked by supervisor.ps1) ----------------------------------

// --profile and --port are also legal dsh flags (the launcher needs
// --profile; the web app needs --port), so besides parsing them into opts
// they are preserved verbatim in opts.args for passthrough to the child.
// --health-path is supervisor-only and must NOT reach the dsh child.
export function parseCliArgs(argv) {
  const opts = { profile: "web", port: null, healthPath: "/", args: [] };
  let passthrough = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passthrough) {
      opts.args.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
    } else if (arg === "--profile" && argv[i + 1] !== undefined) {
      opts.profile = argv[++i];
      opts.args.push("--profile", opts.profile);
    } else if (arg.startsWith("--profile=")) {
      opts.profile = arg.slice("--profile=".length);
      opts.args.push(arg);
    } else if (arg === "--port" && argv[i + 1] !== undefined) {
      const value = argv[++i];
      opts.port = Number(value);
      opts.args.push("--port", value);
    } else if (arg.startsWith("--port=")) {
      opts.port = Number(arg.slice("--port=".length));
      opts.args.push(arg);
    } else if (arg === "--health-path" && argv[i + 1] !== undefined) {
      opts.healthPath = argv[++i];
    } else if (arg.startsWith("--health-path=")) {
      opts.healthPath = arg.slice("--health-path=".length);
    } else {
      opts.args.push(arg);
    }
  }
  return opts;
}

function consoleReporter(profile, port) {
  return (event) => {
    const { type, detail = {} } = event;
    switch (type) {
      case "healthy":
        console.log(
          `[dshpkg] profile "${profile}" 探活通过（端口 ${port}），看门狗就绪`,
        );
        break;
      case "adopted":
        console.log(
          `[dshpkg] 端口 ${port} 已有健康 dsh，已接管守护（不再重复启动）`,
        );
        break;
      case "boot-failed":
        if (detail.entryId) {
          console.error(
            `[dshpkg] 启动失败：条目 "${detail.entryId}" 出错（${detail.detail ?? ""}），已写入禁用标记`,
          );
        } else {
          console.error(
            `[dshpkg] 启动失败：退出码 ${detail.code ?? "?"}${detail.signal ? `（信号 ${detail.signal}）` : ""}`,
          );
        }
        break;
      case "restarting":
        console.log(
          `[dshpkg] 正在重启 dsh（第 ${detail.attempt ?? "?"} 次尝试）`,
        );
        break;
      case "circuit-open":
        console.error(
          `[dshpkg] 连续 ${detail.failures ?? "?"} 次启动失败，熔断触发`,
        );
        break;
      case "snapshot-restored":
        if (detail.ts) {
          console.log(`[dshpkg] 已从快照 ${detail.ts} 恢复 profile`);
        } else if (detail.baseline) {
          console.log("[dshpkg] 快照链已耗尽，回退到出厂基线（无禁用块状态）");
        } else {
          console.error("[dshpkg] 熔断后未找到可用快照，无法自动恢复");
        }
        break;
      case "protected-blocked":
        console.error(
          `[dshpkg] 肇事条目 "${detail.entryId ?? "?"}" 是核心条目，受保护，已跳过禁用标记（继续重启循环）`,
        );
        break;
      default:
        break;
    }
  };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const port =
    opts.port ?? parsePortFromArgs(opts.args) ?? 3080;
  // P4-3: single instance per state root — a second watchdog must not
  // double-spawn the profile. The lock is reclaimed when stale (crashed
  // holder), so a dead supervisor never blocks recovery.
  const lock = await acquireSupervisorLock();
  if (!lock.ok) {
    console.error("[dshpkg] 另一个 dshpkg 看门狗已在运行（supervisor.lock 被占用）");
    process.exitCode = 1;
    return;
  }
  // Heartbeat: keep the lock fresh so the 5-minute keep-alive re-launch never
  // mistakes this live watchdog for a dead one (whose lock would be reclaimed
  // after SYNC_LOCK_STALE_MS) and double-spawns a second supervisor.
  const heartbeat = setInterval(() => {
    refreshSupervisorLock().catch(() => {});
  }, SUPERVISOR_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    await supervise({
      profile: opts.profile,
      port: opts.port ?? undefined,
      args: opts.args,
      healthPath: opts.healthPath,
      onEvent: consoleReporter(opts.profile, port),
      adoptExisting: true,
    });
  } finally {
    clearInterval(heartbeat);
    await releaseSupervisorLock();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[dshpkg] 看门狗异常退出：${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
