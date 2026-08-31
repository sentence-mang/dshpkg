// dshpkg — port availability check + arbitration (R18).
//
// A dsh boot fails with `listen EADDRINUSE` when another process holds the
// web port — typically a STALE dsh instance left over from a previous
// session. That crash happens in the dsh-web-app bundle layer, BEFORE
// dshpkg itself loads, so the in-process guardian is structurally blind to
// it: automatic resolution belongs to the watchdog (`dshpkg run`), which
// arbitrates the port BEFORE spawning its child:
//
//   1. checkPort(port)        probe availability; on EADDRINUSE identify
//                             the holder pid via netstat (best-effort) and
//                             its command line (platform-specific,
//                             best-effort);
//   2. evictPortHolder(port)  kill the holder ONLY when its command line
//                             looks like a stale dsh instance; an unknown
//                             or non-dsh holder is NEVER killed — the
//                             caller gets a Chinese reason to act on.
//
// Everything is injectable for tests (createServer / netstat / cmdline /
// kill / sleep impls). Zero third-party deps; spawnSync always shell:false.

import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Default backoff before the watchdog retries a busy port (exported). */
export const PORT_BUSY_BACKOFF_MS = 15_000;

/** Max evict attempts per arbitration call (anti-loop). */
export const MAX_EVICT_ATTEMPTS = 3;

/** Default sleep used between evict attempts (injectable). */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Command line of the process holding `port`, parsed from `netstat -ano`
 * (Windows) — returns { pid, commandLine } or null. The command line lookup
 * is platform-specific and best-effort: Windows uses a CIM query through
 * powershell.exe (wmic is gone on recent Windows); POSIX reads
 * /proc/<pid>/cmdline. Every spawner is injectable; shell is never used.
 */
export async function findPortHolder(port, { netstatImpl, cmdlineImpl } = {}) {
  let pid = null;
  try {
    const netstatFn =
      netstatImpl ??
      (() =>
        process.platform === "win32"
          ? spawnSync("netstat", ["-ano"], { encoding: "utf8", shell: false, timeout: 5_000 })
          : spawnSync("ss", ["-tlnp"], { encoding: "utf8", shell: false, timeout: 5_000 }));
    const netstat = await netstatFn();
    const out = String(netstat?.stdout ?? "");
    if (process.platform === "win32") {
      // `TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    11100`
      const re = new RegExp(`TCP\\s+[\\d.]+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");
      const m = out.match(re);
      if (m) pid = Number(m[1]);
    } else {
      const re = new RegExp(`:${port}\\s.*users:\\(\\("([^"]+)",pid=(\\d+)`, "i");
      const m = out.match(re);
      if (m) pid = Number(m[2]);
    }
  } catch {
    pid = null;
  }
  if (!pid) return null;
  let commandLine = null;
  try {
    const lookup =
      cmdlineImpl ??
      ((p) => {
        if (process.platform === "win32") {
          const r = spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `Get-CimInstance Win32_Process -Filter "ProcessId=${p}" | Select-Object -ExpandProperty CommandLine`,
            ],
            { encoding: "utf8", shell: false, timeout: 8_000 },
          );
          return String(r?.stdout ?? "").trim() || null;
        }
        try {
          return readFileSync(`/proc/${p}/cmdline`, "utf8").replaceAll("\0", " ").trim() || null;
        } catch {
          return null;
        }
      });
    commandLine = await lookup(pid);
  } catch {
    commandLine = null;
  }
  return { pid, commandLine };
}

/** True when a command line looks like a dsh harness instance. */
export function isDshCommandLine(commandLine) {
  const text = String(commandLine ?? "");
  return /[@\\/]deepseek-ai[\\/]+dsh[\\/].*bin\.js/i.test(text) || /dsh[\\/]lib[\\/]bin\.js/i.test(text);
}

/**
 * Probe a TCP port on loopback. Resolves { free: true } or
 * { free: false, pid?, holder?, error? }. `createServerImpl` is injectable
 * (tests fake the listen outcome); the default uses node:net. Never throws.
 */
export function checkPort(port, { createServerImpl = createServer, netstatImpl, cmdlineImpl } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let server;
    try {
      server = createServerImpl();
    } catch (err) {
      return done({ free: false, error: String(err?.message ?? err) });
    }
    try {
      server.once("error", async (err) => {
        try {
          server.close();
        } catch {
          // already closed
        }
        if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
          const holder = await findPortHolder(port, { netstatImpl, cmdlineImpl });
          done({
            free: false,
            pid: holder?.pid ?? null,
            holder: holder?.commandLine ?? null,
          });
        } else {
          done({ free: false, error: String(err?.code ?? err?.message ?? err) });
        }
      });
      server.listen({ port, host: "127.0.0.1" }, () => {
        try {
          server.close(() => done({ free: true }));
        } catch {
          done({ free: true });
        }
      });
    } catch (err) {
      done({ free: false, error: String(err?.message ?? err) });
    }
  });
}

/** Default kill: process.kill(pid, SIGKILL); true on success. */
function defaultKill(pid) {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * Arbitrate a busy port: kill the holder ONLY when its command line looks
 * like a stale dsh instance, re-probing after each kill. Unknown or non-dsh
 * holders are never killed — the caller receives a Chinese reason. Bounded
 * by MAX_EVICT_ATTEMPTS (anti-loop). Never throws.
 *
 * @returns {Promise<{ok: true, evicted: number} | {ok: false, reason: string}>}
 */
export async function evictPortHolder(
  port,
  {
    checkImpl = (p) => checkPort(p),
    killImpl = defaultKill,
    sleepImpl = defaultSleep,
    maxAttempts = MAX_EVICT_ATTEMPTS,
  } = {},
) {
  let evicted = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let check;
    try {
      check = await checkImpl(port);
    } catch {
      return { ok: false, reason: `端口 ${port} 探测失败，无法仲裁` };
    }
    if (check.free) return { ok: true, evicted };
    if (!check.pid || !isDshCommandLine(check.holder)) {
      return {
        ok: false,
        reason: `端口 ${port} 被非 dsh 进程占用（PID ${check.pid ?? "未知"}），不会自动结束该进程，请手动关闭它或改用其他端口`,
      };
    }
    const killed = killImpl(check.pid);
    if (!killed) {
      return { ok: false, reason: `无法结束占用端口 ${port} 的旧 dsh 实例（PID ${check.pid}），请手动结束它` };
    }
    evicted += 1;
    await sleepImpl(300); // let the OS release the port
  }
  let final;
  try {
    final = await checkImpl(port);
  } catch {
    return { ok: false, reason: `端口 ${port} 探测失败，无法确认仲裁结果` };
  }
  return final.free
    ? { ok: true, evicted }
    : { ok: false, reason: `端口 ${port} 在 ${evicted} 次清理后仍被占用，请手动排查` };
}
