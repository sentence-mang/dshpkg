// dshpkg — in-process boot guardian (R16).
//
// The official kernel turns a boot failure into a controlled process.exit(1):
// nobody attributes the crash, nothing disables the culprit, and the next
// boot crashes on the same plugin again. The out-of-process watchdog
// (`dshpkg run`) only helps when someone started it. This module gives
// dshpkg ITSELF a boot-protection loop that needs no watchdog and touches
// no dsh code — it runs inside apply() because dshpkg is the first
// non-kernel bundle (bundles order is guaranteed by the re-layering):
//
//   1. boot fingerprint  — a stale marker in state.json means the previous
//                          boot crashed; bootFailures escalates;
//   2. preemptive disable— evidence-based entries (last culprit, newest
//                          install, or EVERYTHING in safe mode) are disabled
//                          before later entries apply (file block + live
//                          entry.update), protected entries exempt;
//   3. exit attribution  — a stderr capture collects the kernel's fail-loud
//                          loader message; a synchronous 'exit' hook parses
//                          it, writes the culprit's managed disable block
//                          and the incident BEFORE the process dies, so the
//                          next boot excludes the culprit automatically;
//   4. boot confirmation — ~45s after apply(), a live process means the
//                          boot succeeded: marker cleared, failures reset,
//                          known-good snapshot taken.
//
// Convergence: any boot crash reproduces at most ONCE — the second boot
// disables the attributed culprit. Three unattributed crashes escalate to
// safe mode (all non-core entries disabled + newest snapshot restored).
//
// Everything here is dependency-injected and testable offline; the sync IO
// helpers exist because process 'exit' handlers cannot await.

import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { applyDisableToPatch } from "./rescue.js";
import { parseLoaderErrors } from "./triage.js";
import { isProtected } from "./protect.js";

/** Delay before a still-alive process counts as a successful boot. */
export const BOOT_CONFIRM_MS = 45_000;

/** Unattributed boot failures that escalate to safe mode. */
export const SAFE_MODE_FAILURES = 3;

/**
 * Protected entries that must NEVER be disabled even as an attributed
 * culprit — disabling loader/include/… bricks the boot entirely. dshpkg
 * itself is NOT on this list: when dshpkg is the proven culprit it must be
 * sacrificially disabled so the rest of the harness can boot.
 */
export const NEVER_DISABLE = new Set([
  "loader",
  "include",
  "cordis-host-runner",
  "web-startup",
  "web-runtime",
  "api-gateway",
]);

/**
 * Pure escalation decision: which entry ids to disable at boot.
 *   failures >= SAFE_MODE_FAILURES -> safe mode: every non-protected entry;
 *   failures == 2                  -> last culprit + the newest install;
 *   failures >= 1                  -> the last attributed culprit.
 * Candidates unknown to the loader (absent from entryIds) and NEVER_DISABLE
 * entries are dropped. Deterministic order (input order preserved).
 *
 * @param {object} p { bootFailures, lastCulprit, latestInstalled, entryIds, isProtected }
 * @returns {string[]} entry ids to disable ([] when failures < 1)
 */
export function decideBootDisables({
  bootFailures = 0,
  lastCulprit = null,
  latestInstalled = [],
  entryIds = [],
  isProtected = () => false,
} = {}) {
  if (!(bootFailures >= 1)) return [];
  const known = new Set(
    Array.isArray(entryIds) ? entryIds.filter((id) => typeof id === "string" && id) : [],
  );
  const out = [];
  const add = (id) => {
    if (typeof id !== "string" || !id) return;
    if (NEVER_DISABLE.has(id)) return; // kernel-critical: never, even as culprit
    if (isProtected(id) && id !== lastCulprit) return; // protection yields to proven attribution
    if (known.size > 0 && !known.has(id)) return; // only entries the loader actually has
    if (!out.includes(id)) out.push(id);
  };
  if (bootFailures >= SAFE_MODE_FAILURES) {
    for (const id of known) {
      if (!NEVER_DISABLE.has(id)) out.push(id);
    }
    return out;
  }
  add(lastCulprit);
  if (bootFailures >= 2 && Array.isArray(latestInstalled)) {
    for (const id of latestInstalled) {
      add(id);
      break; // only the single newest candidate
    }
  }
  return out;
}

/** True when the state carries a stale (never-confirmed) boot marker. */
export function hasStaleBootMarker(state) {
  return Boolean(state && state.boot && state.boot.startedAt);
}

/**
 * Names of the most recently installed packages (installedAt descending),
 * excluding protected ones — the "most suspect" candidates at level 2.
 * Pure: state is an input.
 */
export function newestInstalled(state, limit = 5) {
  const packages = state && state.packages && typeof state.packages === "object" ? state.packages : {};
  return Object.entries(packages)
    .filter(([name]) => typeof name === "string" && name && name !== "__proto__")
    .sort((a, b) => String(b[1]?.installedAt ?? "").localeCompare(String(a[1]?.installedAt ?? "")))
    .slice(0, limit)
    .map(([name]) => name);
}

// --- sync IO helpers (process 'exit' handlers cannot await) ------------------

/** Read state.json synchronously; null when missing/unparsable. */
export function readStateSync(stateFile) {
  try {
    const value = JSON.parse(readFileSync(stateFile, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Sync atomic state write (tmp + rename in the same directory). */
export function writeStateSync(stateFile, state) {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(stateFile)}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, stateFile);
}

/** Sync incident append (one JSON line). Never throws. */
export function appendIncidentSync(incidentsFile, record) {
  try {
    mkdirSync(dirname(incidentsFile), { recursive: true });
    appendFileSync(incidentsFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // a failed record must never disturb the exit path
  }
}

/**
 * Sync managed-disable block write for the exit hook: reads the profile
 * patch layer, appends the block when absent (applyDisableToPatch is
 * idempotent), writes tmp+rename. Returns true when the file changed.
 * Never throws — a failure simply means the next boot keeps its current
 * patch layer.
 */
export function writeManagedDisableSync(patchFile, entryId) {
  try {
    let text = "";
    try {
      text = readFileSync(patchFile, "utf8");
    } catch {
      text = "";
    }
    const next = applyDisableToPatch(text, entryId);
    if (next === text) return false;
    const tmp = `${patchFile}.dshpkg-bootguard.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, patchFile);
    return true;
  } catch {
    return false;
  }
}

// --- stderr capture + exit attribution ----------------------------------------

const LOADER_ERROR_RE = /failed to (import|apply|dispose|rollback) loader entry/;

/** Max captured crash lines kept in memory. */
const CAPTURE_LIMIT = 20;

/**
 * Wrap process.stderr.write to collect the kernel's fail-loud loader-error
 * lines (a controlled boot failure prints them and then process.exit(1)s —
 * uncaughtException never fires). Returns { captured, restore }; restore()
 * puts the original write back. The wrapper is total: any internal error
 * falls through to the original writer.
 *
 * @param {{stderr?: object}} [deps] injectable for tests
 */
export function createCrashCapture({ stderr = process.stderr } = {}) {
  const captured = [];
  const original = stderr.write;
  if (typeof original !== "function") return { captured, restore: () => {} };
  stderr.write = function patchedWrite(chunk, ...rest) {
    try {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      if (LOADER_ERROR_RE.test(text) && captured.length < CAPTURE_LIMIT) {
        captured.push(text);
      }
    } catch {
      // capture must never break the write
    }
    return original.call(this ?? stderr, chunk, ...rest);
  };
  return {
    captured,
    restore: () => {
      try {
        stderr.write = original;
      } catch {
        // best-effort restore
      }
    },
  };
}

/** Innermost attributed entryId from captured crash text, else null. */
export function attributeCaptured(captured) {
  const text = Array.isArray(captured) ? captured.join("\n") : String(captured ?? "");
  const matches = parseLoaderErrors(text);
  if (matches.length === 0) return null;
  // innermost match is last (CONTRACTS.md verified format)
  const culprit = matches[matches.length - 1];
  return typeof culprit?.entryId === "string" && culprit.entryId ? culprit.entryId : null;
}

/**
 * The synchronous exit hook. Installed once via process.on('exit'):
 *   - marker absent            -> nothing to do (boot confirmed elsewhere);
 *   - clean exit (code 0)      -> clear the marker quietly (user stopped dsh
 *                                 before the confirmation window elapsed);
 *   - non-zero exit with the
 *     marker still set         -> the boot crashed: attribute the captured
 *                                 stderr, write the culprit's disable block,
 *                                 record the incident, and store the
 *                                 attribution in state for the next boot's
 *                                 preemptive decision.
 * Never throws.
 *
 * @param {object} p { stateFile, incidentsFile, patchFile, captured, at? }
 */
export function handleExitSync({ stateFile, incidentsFile, patchFile, captured }, code) {
  try {
    const state = readStateSync(stateFile);
    if (!state || !hasStaleBootMarker(state)) return;
    if (code === 0) {
      delete state.boot; // clean shutdown inside the window: not a crash
      writeStateSync(stateFile, state);
      return;
    }
    const culprit = attributeCaptured(captured);
    // Defense in depth (R18): a protected entry is recorded but NEVER
    // disabled from the exit path — disabling loader/include/webserver
    // would brick the harness harder than the original crash.
    if (culprit && patchFile && !isProtected(culprit)) {
      writeManagedDisableSync(patchFile, culprit);
    }
    const at = new Date().toISOString();
    appendIncidentSync(incidentsFile, {
      type: "boot-crash",
      code,
      entryId: culprit,
      at,
    });
    if (!state.boot || typeof state.boot !== "object") state.boot = {};
    state.boot.lastCulprit = culprit;
    state.boot.crashedAt = at;
    writeStateSync(stateFile, state);
  } catch {
    // the exit path must never throw
  }
}

/**
 * Clean shutdown on a user/harness signal (SIGINT/SIGTERM, R19): clear the
 * boot marker and record the event. A deliberate stop is NOT a crash — a
 * leftover marker would make the next boot escalate disables for nothing.
 * Sync + never throws (runs inside a signal handler).
 */
export function cleanShutdownSync({ stateFile, incidentsFile }) {
  try {
    const state = readStateSync(stateFile);
    if (state && state.boot) {
      delete state.boot;
      writeStateSync(stateFile, state);
    }
    appendIncidentSync(incidentsFile, {
      type: "clean-shutdown",
      at: new Date().toISOString(),
    });
  } catch {
    // the shutdown path must never throw
  }
}

/**
 * R20 attribution for a plugin-tree crash that surfaces as an UNCAUGHT
 * EXCEPTION instead of the fail-loud stderr+exit path: dsh wraps loader
 * failures and re-throws them, and with an uncaughtException listener
 * registered the process SURVIVES as a zombie — the exit hook never runs.
 * When the exception text names a loader entry: disable it RIGHT NOW (the
 * next boot stays clean even if the zombie is hard-killed), persist
 * lastCulprit for the preemptive decision, record boot-tree-crash.
 * Sync + never throws (runs inside an exception handler).
 */
export function handleUncaughtLoaderSync({ stateFile, incidentsFile, patchFile }, errText) {
  try {
    const culprit = attributeCaptured([String(errText ?? "")]);
    appendIncidentSync(incidentsFile, {
      type: "boot-tree-crash",
      entryId: culprit,
      at: new Date().toISOString(),
    });
    const state = readStateSync(stateFile);
    if (!state) return;
    if (culprit) {
      if (!state.boot || typeof state.boot !== "object") state.boot = {};
      state.boot.lastCulprit = culprit;
      if (patchFile && !isProtected(culprit)) {
        writeManagedDisableSync(patchFile, culprit);
      }
    }
    writeStateSync(stateFile, state);
  } catch {
    // never disturb the host on the exception path
  }
}

/**
 * R20 degraded confirmation: the process survived the window but the dshpkg
 * service never came up (dead plugin tree, no web server) — a zombie must
 * NOT be certified as a healthy boot. Keep the marker so the NEXT boot
 * treats it as a crash and escalates with the stored lastCulprit; bump the
 * failure counter; record boot-degraded. Sync + never throws.
 */
export function degradeBootSync({ stateFile, incidentsFile }) {
  try {
    const state = readStateSync(stateFile);
    if (!state || !hasStaleBootMarker(state)) return; // nothing pending
    state.bootFailures = (Number(state.bootFailures) || 0) + 1;
    writeStateSync(stateFile, state);
    appendIncidentSync(incidentsFile, {
      type: "boot-degraded",
      bootFailures: state.bootFailures,
      at: new Date().toISOString(),
    });
  } catch {
    // the degrade path must never throw
  }
}

/**
 * Boot confirmation: runs after the confirmation delay; a still-set marker
 * means the process survived the boot window -> success. Clears the marker,
 * resets bootFailures, stamps lastBootOkAt and records a boot-confirmed
 * incident. Injectable clock/IO for tests; never throws.
 */
export function confirmBootSync({ stateFile, incidentsFile, at = new Date().toISOString() } = {}) {
  try {
    const state = readStateSync(stateFile);
    if (!state || !hasStaleBootMarker(state)) return false;
    delete state.boot;
    state.bootFailures = 0;
    state.lastBootOkAt = at;
    writeStateSync(stateFile, state);
    appendIncidentSync(incidentsFile, { type: "boot-confirmed", at });
    return true;
  } catch {
    return false;
  }
}
