// dshpkg — performance optimization module.
//
// Pure diagnostic/mitigation helpers for dsh lag: measure compose cost,
// score managed plugins by performance/stability risk, and account for
// state-directory cache disk usage. Everything with an external side effect
// (running dsh, filesystem paths) is injected by the caller so each export is
// unit-testable in isolation. Zero third-party runtime dependencies.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stateRoot } from "./state.js";

// --- 1. compose measurement --------------------------------------------------

/**
 * Measure how long dsh takes to compose a profile (`--dump-config`, which
 * only composes and never boots, so it is safe to run for diagnostics).
 *
 * @param {string} profile profile name
 * @param {{dshRun?: Function, clock?: Function}} [opts]
 * @returns {Promise<{ok: boolean, ms: number|null, status: number|null, error: string|null}>}
 */
export async function measureCompose(profile, { dshRun, clock } = {}) {
  const run = dshRun ?? (await import("./launcher.js")).runDshSync;
  const now = clock ?? (() => Date.now());
  const start = now();
  let result;
  try {
    result = run(["--profile", profile, "--dump-config"]);
  } catch (err) {
    result = { status: null, error: err, stdout: "", stderr: "" };
  }
  const end = now();
  const ms = Math.max(0, end - start);
  const ok = result?.status === 0;
  const status = result?.status ?? null;
  let error = null;
  if (!ok) {
    error =
      result?.error?.message ||
      result?.stderr ||
      "compose check failed";
    error = String(error).slice(0, 200);
  }
  return { ok, ms, status, error };
}

// --- 2. plugin scoring -------------------------------------------------------

const MB = 1024 * 1024;

/**
 * Score managed plugins by performance/stability risk, sorted by score
 * descending (ties broken by name ascending for determinism).
 *
 * @param {object} state readState() result with a `.packages` map
 * @param {{sizes?: object, now?: number}} [opts]
 * @returns {Array<ScoreEntry>}
 */
export function scorePlugins(state, { sizes = {}, now = Date.now() } = {}) {
  void now; // reserved for future time-based signals; not used today
  const packages = state?.packages ?? {};
  const names = new Set([
    ...Object.keys(packages),
    ...Object.keys(sizes ?? {}),
  ]);
  const entries = [];
  for (const name of names) {
    const pkg = packages[name] ?? {};
    const reasons = [];
    let score = 0;
    const circuitOpen = Boolean(pkg.circuitOpenAt);
    if (circuitOpen) {
      score += 60;
      reasons.push("电路熔断(circuit-open)");
    }
    const crashCountRaw = pkg.crashCount;
    const crashCount =
      Number.isInteger(crashCountRaw) && crashCountRaw > 0 ? crashCountRaw : 0;
    if (crashCount > 0) {
      score += Math.min(crashCount, 10) * 5;
      reasons.push(`崩溃 ${crashCount} 次`);
    }
    const held = Boolean(pkg.held);
    const bytes =
      sizes && Object.prototype.hasOwnProperty.call(sizes, name) ? sizes[name] : null;
    if (Number.isFinite(bytes) && bytes >= 0) {
      if (bytes >= 20 * MB) {
        score += 20;
        reasons.push("体积大(≥20MB)");
      } else if (bytes >= 5 * MB) {
        score += 5;
        reasons.push("体积偏大(≥5MB)");
      }
    }
    entries.push({
      name,
      score,
      reasons,
      circuitOpen,
      crashCount,
      held,
      bytes,
    });
  }
  entries.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.name < b.name ? -1 : 1,
  );
  return entries;
}

// --- 3. recursive directory size ---------------------------------------------

/**
 * Recursively compute a directory's size in bytes. Symlinks are recorded as
 * 0 and never followed (cycle-safe). Returns 0 for a missing path or any
 * error — never throws.
 *
 * @param {string} path
 * @returns {Promise<number>}
 */
export async function dirSize(path) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
  } catch {
    return 0;
  }
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isSymbolicLink()) {
        total += 0; // never follow
      } else if (entry.isFile()) {
        total += (await lstat(full).catch(() => ({ size: 0 }))).size ?? 0;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// --- 4. cache statistics ------------------------------------------------------

/**
 * Break down disk usage of the state-directory cache areas.
 *
 * @param {{root?: string}} [opts] root defaults to stateRoot()
 * @returns {Promise<{snapshotsBytes: number, snapshotCount: number, gitBytes: number, managedBytes: number, indexBytes: number, totalBytes: number}>}
 */
export async function cacheStats({ root } = {}) {
  const base = root ?? stateRoot();
  const [snapshotsBytes, gitBytes, managedBytes, indexBytes] =
    await Promise.all([
      dirSize(join(base, "snapshots")),
      dirSize(join(base, "cache", "git")),
      dirSize(join(base, "managed")),
      dirSize(join(base, "index")),
    ]);
  let snapshotCount = 0;
  try {
    const entries = await readdir(join(base, "snapshots"), {
      withFileTypes: true,
    });
    snapshotCount = entries.filter(
      (e) => e.isDirectory() && !e.name.includes(".tmp"),
    ).length;
  } catch {
    snapshotCount = 0;
  }
  return {
    snapshotsBytes,
    snapshotCount,
    gitBytes,
    managedBytes,
    indexBytes,
    totalBytes: snapshotsBytes + gitBytes + managedBytes + indexBytes,
  };
}

// --- 5. bytes -> MB -----------------------------------------------------------

/**
 * Format a byte count as MB with 1 decimal place. Invalid input returns 0.
 *
 * @param {number} bytes
 * @returns {number}
 */
export function mb(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return 0;
  }
  return Number((bytes / (1024 * 1024)).toFixed(1));
}
