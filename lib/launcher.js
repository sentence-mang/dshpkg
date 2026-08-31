// dshpkg — shared dsh launcher resolution.
//
// npm's global "dsh" on Windows is a .cmd/.ps1 shim without a real .exe;
// CreateProcess (spawnSync with shell:false) cannot run it — the bare name
// resolves to ENOENT, the shim file itself to EINVAL (verified on Node 24,
// Windows). Every caller therefore resolves the real launcher entry
// <npm-global>/node_modules/@deepseek-ai/dsh/lib/bin.js and invokes it as
// `node <bin.js> ...` (process.execPath), unless DSH_BIN names a real .exe.
//
// Shared by lib/transaction.js (default runner), bin/dshpkg.js (doctor) and
// bin/supervisor.js (watchdog spawn). shell:true is never used.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Launcher entry point relative to a global npm prefix. */
export const LAUNCHER_SEGMENTS = [
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
];

/** User-facing message when no launcher can be resolved. */
export const LAUNCHER_NOT_FOUND =
  "未找到 dsh 全局入口（可设置 DSH_LAUNCHER 指向 @deepseek-ai/dsh/lib/bin.js）";

/** Well-known global npm prefixes probed without spawning any process. */
export function staticNpmPrefixes() {
  if (process.platform === "win32") {
    const prefixes = [];
    if (process.env.APPDATA) prefixes.push(join(process.env.APPDATA, "npm"));
    return prefixes;
  }
  return ["/usr/local", "/usr", join(homedir(), ".local")];
}

/**
 * Ask npm for its global prefix (`npm prefix -g`), fully offline.
 * On Windows npm is itself a .cmd shim, so it is invoked through
 * `cmd.exe /d /s /c` (still shell:false). Returns null when npm is
 * unavailable.
 *
 * @param {{spawnImpl?: Function}} [opts]
 * @returns {string|null}
 */
export function npmGlobalPrefix({ spawnImpl = spawnSync } = {}) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const cmd =
    process.platform === "win32"
      ? process.env.ComSpec || "cmd.exe"
      : command;
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", `${command} prefix -g`]
      : ["prefix", "-g"];
  try {
    const result = spawnImpl(cmd, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // npm not available — fall through to static prefixes.
  }
  return null;
}

/**
 * Resolve how to invoke the global dsh CLI:
 *   1. DSH_BIN ending in .exe (a real executable): spawned directly.
 *      .cmd/.ps1/bare shims are NOT directly executable with shell:false,
 *      so any other DSH_BIN value is ignored and resolution falls through.
 *   2. DSH_LAUNCHER: a path to @deepseek-ai/dsh/lib/bin.js.
 *   3. Auto-detect: <npm global prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js
 *      (`npm prefix -g` when npm is available, then well-known prefixes
 *      without invoking any process).
 *
 * @param {{spawnImpl?: Function, existsImpl?: Function, allowDirect?: boolean}} [opts]
 * @returns {{kind: "direct", command: string} | {kind: "node", script: string} | null}
 */
export function resolveDshLauncher({
  spawnImpl = spawnSync,
  existsImpl = existsSync,
  allowDirect = true,
} = {}) {
  const bin = process.env.DSH_BIN;
  if (allowDirect && bin && /\.exe$/i.test(bin)) {
    // A path is only trusted when it exists; a bare command name is looked
    // up on PATH by CreateProcess itself.
    if (!/[\\/]/.test(bin) || existsImpl(bin)) {
      return { kind: "direct", command: bin };
    }
  }
  if (process.env.DSH_LAUNCHER) {
    return { kind: "node", script: process.env.DSH_LAUNCHER };
  }
  const candidates = [];
  const prefix = npmGlobalPrefix({ spawnImpl });
  if (prefix) candidates.push(join(prefix, ...LAUNCHER_SEGMENTS));
  for (const p of staticNpmPrefixes()) {
    candidates.push(join(p, ...LAUNCHER_SEGMENTS));
  }
  for (const candidate of candidates) {
    if (existsImpl(candidate)) return { kind: "node", script: candidate };
  }
  return null;
}

/**
 * Run dsh synchronously through the resolved launcher (shared by the
 * transaction runner and the CLI doctor). spawnImpl / resolveImpl / execPath
 * are injectable so tests never execute a real process; the inherited
 * environment is always passed and shell:true is never set. Returns a
 * spawnSync-like result; a failed resolution yields
 * { status: null, error, stdout: "", stderr: "" } with a Chinese message.
 *
 * @param {string[]} args dsh arguments (without the binary itself)
 * @param {{resolveImpl?: Function, spawnImpl?: Function, execPath?: string, options?: object}} [opts]
 * @returns {{status: number|null, error?: Error, stdout: string, stderr: string}}
 */
export function runDshSync(
  args,
  {
    resolveImpl = resolveDshLauncher,
    spawnImpl = spawnSync,
    execPath = process.execPath,
    options = {},
  } = {},
) {
  const resolved = resolveImpl();
  if (!resolved) {
    return {
      status: null,
      error: new Error(LAUNCHER_NOT_FOUND),
      stdout: "",
      stderr: "",
    };
  }
  if (resolved.kind === "direct") {
    return spawnImpl(resolved.command, args, { env: process.env, ...options });
  }
  return spawnImpl(execPath, [resolved.script, ...args], {
    env: process.env,
    ...options,
  });
}
