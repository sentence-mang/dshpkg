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

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { listSnapshots, resolveProfileDir, statePath } from "../lib/state.js";

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
  const base = text.length === 0 || text.endsWith("\n") ? text : text + "\n";
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
  await writeFile(patchFile, cleaned, "utf8");
  return matches.length;
}

// --- defaults (injectable in tests) -----------------------------------------

/**
 * Resolve the global dsh launcher entry:
 *   DSH_LAUNCHER env, else <npm-global>/node_modules/@deepseek-ai/dsh/lib/bin.js
 * (npm prefix -g when npm is available, then well-known prefixes without
 * invoking any process). Returns null when not found.
 */
function resolveLauncherBin() {
  if (process.env.DSH_LAUNCHER) return process.env.DSH_LAUNCHER;
  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npmCmd, ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && result.stdout) {
      const candidate = join(
        result.stdout.trim(),
        "node_modules",
        "@deepseek-ai",
        "dsh",
        "lib",
        "bin.js",
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // npm not available — fall through to static prefixes.
  }
  const prefixes = [];
  if (process.platform === "win32") {
    if (process.env.APPDATA) prefixes.push(join(process.env.APPDATA, "npm"));
  } else {
    prefixes.push("/usr/local", "/usr", join(homedir(), ".local"));
  }
  for (const prefix of prefixes) {
    const candidate = join(
      prefix,
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Default child spawn: node <launcherBin> --profile <profile> ...args. */
function defaultSpawn({ launcherBin, profile, args }) {
  if (!launcherBin) {
    throw new Error(
      "未找到 dsh 全局入口（可设置 DSH_LAUNCHER 指向 @deepseek-ai/dsh/lib/bin.js）",
    );
  }
  // Never shell:true — always spawn node with the launcher script path.
  return spawn("node", [launcherBin, "--profile", profile, ...args], {
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

/**
 * Restore the newest snapshot: copies package.json + cordis.patch.yml +
 * pnpm-lock.yaml back into profileDir, then removes our managed blocks.
 * Returns the snapshot timestamp (null when no snapshot exists).
 */
async function restoreLatestSnapshot(profileDir) {
  const snapshots = await listSnapshots(); // sorted ascending, newest last
  if (snapshots.length === 0) return null;
  const ts = snapshots[snapshots.length - 1];
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
    // Resolve the launcher lazily: injected spawnImpl never touches npm.
    const launcherBin = spawnImpl ? null : resolveLauncherBin();
    const doSpawn =
      spawnImpl ?? (() => defaultSpawn({ launcherBin, profile, args }));
    const doProbe = probeImpl ?? defaultProbe;
    const doSleep = sleepImpl ?? defaultSleep;

    const emit = (type, detail = {}) => {
      try {
        onEvent({ type, detail });
      } catch {
        // a broken reporter must never stop the watchdog
      }
    };

    let consecutiveBootFailures = 0;

    while (!stopped) {
      // 1) spawn the dsh child (stdio piped for triage).
      let stdoutText = "";
      let stderrText = "";
      let exitedPromise;
      try {
        child = await doSpawn({ launcherBin, profile, args });
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

      const probeOnce = async () => {
        try {
          const result = await doProbe({ port, healthPath });
          return result === true || result?.ok === true;
        } catch {
          return false;
        }
      };

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
        emit("healthy", { port, profile });
        // Stay quiet until the child exits or the user stops us.
        await Promise.race([exitedPromise, stopPromise]);
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

      const triaged = parseLoaderErrors(stdoutText + stderrText);
      const culprit = triaged.length > 0 ? triaged[triaged.length - 1] : null;
      consecutiveBootFailures += 1;
      emit("boot-failed", {
        code,
        signal,
        entryId: culprit?.entryId ?? null,
        detail: culprit?.detail ?? null,
      });

      if (culprit) {
        try {
          await writeManagedDisable(profileDir, culprit.entryId);
        } catch (err) {
          emit("boot-failed", {
            reason: "managed-write",
            message: String(err?.message ?? err),
          });
        }
      }

      if (consecutiveBootFailures >= BOOT_FAIL_LIMIT) {
        emit("circuit-open", { failures: consecutiveBootFailures });
        let restoredTs = null;
        try {
          restoredTs = await restoreLatestSnapshot(profileDir);
        } catch (err) {
          emit("boot-failed", {
            reason: "snapshot-restore",
            message: String(err?.message ?? err),
          });
        }
        emit("snapshot-restored", { ts: restoredTs });
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

function parseCliArgs(argv) {
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
    } else if (arg.startsWith("--profile=")) {
      opts.profile = arg.slice("--profile=".length);
    } else if (arg === "--port" && argv[i + 1] !== undefined) {
      opts.port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      opts.port = Number(arg.slice("--port=".length));
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
      case "boot-failed":
        if (detail.entryId) {
          console.error(
            `[dshpkg] 启动失败：loader 条目 "${detail.entryId}" 出错（${detail.detail ?? ""}），已写入禁用标记`,
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
        } else {
          console.error("[dshpkg] 熔断后未找到可用快照，无法自动恢复");
        }
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
  await supervise({
    profile: opts.profile,
    port: opts.port ?? undefined,
    args: opts.args,
    healthPath: opts.healthPath,
    onEvent: consoleReporter(opts.profile, port),
  });
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
