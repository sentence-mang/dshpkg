// dshpkg — host service entry (L2 managed layer) in cordis plugin shape.
//
// Defensive by design: `ctx.get("webServer")` and `ctx.get("loader")` may be
// undefined (headless-safe) and every route handler is wrapped so apply() and
// the handlers never throw outward. The interesting logic lives in
// managed.js / rescue.js which are unit-tested without cordis; this module is
// kept thin (syntax/loadability only: `node --check lib/index.js`).

import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ManagedLayer } from "./managed.js";
import {
  readState,
  writeState,
  readIncidents,
  readApiToken,
  resolveProfileDir,
  recordManagedInstall,
  appendIncident,
  statePath,
  dshHome,
  listSnapshots,
} from "./state.js";
import { isDangerousKey } from "./circuit.js";
import {
  rescueHtml,
  buildDisableBlock,
  applyDisableToPatch,
  removeManagedBlock,
} from "./rescue.js";
import { isProtected } from "./protect.js";
import { search } from "./search.js";
import { install } from "./transaction.js";
import { saveSnapshot, restoreSnapshot } from "./snapshot.js";
import { reorderProfileBundles } from "./order-bundles.js";
import {
  BOOT_CONFIRM_MS,
  SAFE_MODE_FAILURES,
  decideBootDisables,
  hasStaleBootMarker,
  newestInstalled,
  readStateSync,
  writeStateSync,
  appendIncidentSync,
  writeManagedDisableSync,
  createCrashCapture,
  handleExitSync,
  confirmBootSync,
  cleanShutdownSync,
  handleUncaughtLoaderSync,
  degradeBootSync,
} from "./bootguard.js";
import {
  buildGuardSection,
  createToolHandlers,
  buildToolDefinitions,
  buildCommandDefinition,
} from "./tools.js";
import { buildBannerScript, injectBannerScript } from "./banner.js";

export const name = "dshpkg";

// Cross-fiber service access in the current cordis REQUIRES inject: ctx.get
// on a service provided by another fiber throws "cannot get property without
// inject" (verified against dsh-boot-guard's working pattern). The ctx.get
// fallbacks in apply() keep headless/test contexts (no loader entries)
// degrading to null instead of failing.
export const inject = ["webServer", "loader"];

/**
 * Host-side install channel with CLI-quality bookkeeping (the AI tool and
 * /dshpkg command go through this, never through bare transaction.install):
 * a successful install records state.packages + the managed ledger (so
 * status/list/upgrade see it) and snapshots the known-good profile. Both
 * side effects are best-effort — an install that already succeeded is never
 * reported failed because bookkeeping broke. No interactive trust gate is
 * possible inside the host (no terminal); the channel behaves like an
 * explicit user install of a bare spec, and the install-guard system-prompt
 * section keeps the model pointed at dshpkg.
 *
 * @param {string} name plugin name or install spec
 * @param {{installImpl?: Function}} [deps] injectable for tests
 * @returns {Promise<object>} the install result, verbatim
 */
export async function hostInstall(name, { installImpl = install } = {}) {
  const result = await installImpl(name);
  if (!result || !result.ok) return result;
  let state = null;
  try {
    state = await readState();
    for (const installedName of result.installed ?? []) {
      // __proto__/constructor/prototype would resolve to the shared
      // prototype and pollute Object.prototype on assignment.
      if (isDangerousKey(installedName)) continue;
      const existing = state.packages?.[installedName] ?? {};
      state.packages[installedName] = {
        ...existing,
        source: existing.source ?? installedName,
        version: existing.version ?? null,
        kind: existing.kind ?? "unknown",
        installedAt: new Date().toISOString(),
        held: existing.held ?? false,
        crashCount: 0,
        crashTimes: [],
        circuitOpenAt: null,
      };
      recordManagedInstall(state, installedName, {});
    }
    await writeState(state);
  } catch {
    // best-effort bookkeeping
  }
  try {
    const profileDir = await resolveProfileDir(state?.profile ?? "web");
    if (profileDir) await saveSnapshot(profileDir);
  } catch {
    // best-effort snapshot
  }
  return result;
}

/**
 * Boot-time registration reconcile (fire-and-forget self-healing): register
 * installed-but-unregistered bundles and re-layer for the NEXT boot. Deps
 * are never filled here (no pnpm at boot time); a change is recorded as a
 * "reconcile" incident. Every failure degrades silently — the harness boot
 * must never be disturbed by its own guardian.
 */
export async function bootReconcile() {
  try {
    const state = await readState();
    const profile = state.profile ?? "web";
    const profileDir = await resolveProfileDir(profile);
    if (!profileDir) return;
    const result = await reorderProfileBundles(profileDir);
    if (result.changed) {
      await appendIncident({
        type: "reconcile",
        profile,
        registered: result.registered,
        at: new Date().toISOString(),
      });
    }
  } catch {
    // silent degradation: boot above all
  }
}

// --- R16: in-process boot guardian -------------------------------------------

/** Profile dir resolver, sync variant (the guardian's core must not await). */
function resolveProfileDirSync(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  const dir = join(dshHome(), "profiles", name);
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (!manifest?.dsh?.profile) return null;
    return dir;
  } catch {
    return null;
  }
}

// One installation per process (dshpkg applies once); tests reset via
// resetBootGuardForTests().
let bootGuardArmed = false;

// R20 service-readiness flag: the confirmation window must not certify a
// zombie (alive process, dead plugin tree). Set when the /dshpkg routes are
// actually registered; the confirm timer reads it.
let dshpkgRoutesReady = false;

/** Test-only: allow re-arming the guardian in isolated environments. */
export function resetBootGuardForTests() {
  bootGuardArmed = false;
  dshpkgRoutesReady = false;
}

/**
 * Arm the in-process boot guardian (R16). The SYNC core runs before any
 * await so preemptive disables land before later loader entries apply:
 * stale-marker detection -> escalation decision -> persistent disable
 * blocks -> fresh marker -> exit/uncaught hooks. The async tail (incident
 * records, safe-mode snapshot restore, the confirmation timer with its
 * known-good snapshot) is fire-and-forget. Every failure degrades silently.
 *
 * @param {object|null} loader cordis loader (may be null headless)
 * @param {{confirmDelayMs?: number, setTimeoutImpl?: Function, isReadyImpl?: Function}} [deps] test injection
 */
export function armBootGuard(loader, { confirmDelayMs = BOOT_CONFIRM_MS, setTimeoutImpl = setTimeout, isReadyImpl } = {}) {
  if (bootGuardArmed) return;
  bootGuardArmed = true;
  const stateFile = statePath("state.json");
  const incidentsFile = statePath("incidents.jsonl");
  let profileDir = null;
  let bootFailures = 0;
  let safeMode = false;
  try {
    const state = readStateSync(stateFile) ?? {
      version: 1,
      profile: "web",
      packages: {},
      managed: {},
      bootFailures: 0,
    };
    profileDir = resolveProfileDirSync(state.profile ?? "web");
    const stale = hasStaleBootMarker(state);
    bootFailures = (Number(state.bootFailures) || 0) + (stale ? 1 : 0);
    safeMode = bootFailures >= SAFE_MODE_FAILURES;
    const at = new Date().toISOString();

    // Preemptive disables: evidence-based, persistent file blocks first
    // (guaranteed for the next boot), then best-effort live entry.update
    // (may still stop a later entry in THIS boot).
    const entryIds = (collectOfficialEntries(loader) ?? []).map((e) => e.id);
    const disables = decideBootDisables({
      bootFailures,
      lastCulprit: state.boot?.lastCulprit ?? null,
      latestInstalled: newestInstalled(state),
      entryIds,
      isProtected,
    });
    for (const id of disables) {
      if (profileDir) writeManagedDisableSync(join(profileDir, "cordis.patch.yml"), id);
      try {
        const entry = findEntry(loader, id);
        if (entry && typeof entry.update === "function") {
          Promise.resolve(entry.update({ disabled: true })).catch(() => {});
        }
      } catch {
        // live disable is best-effort; the file block persists anyway
      }
    }

    // Fresh marker + escalated counter (sync: must exist before any later
    // entry can crash the process).
    state.boot = { startedAt: at, pid: process.pid };
    state.bootFailures = bootFailures;
    writeStateSync(stateFile, state);

    // Exit attribution: capture the kernel's fail-loud stderr lines; the
    // sync exit hook writes the culprit's disable block before death.
    const capture = createCrashCapture();
    const patchFile = profileDir ? join(profileDir, "cordis.patch.yml") : null;
    process.once("uncaughtException", (err) => {
      const detail = String(err?.message ?? err);
      appendIncidentSync(incidentsFile, {
        type: "uncaught-exception",
        detail,
        at: new Date().toISOString(),
      });
      // R20: a plugin-tree crash that surfaces as an exception (dsh wraps
      // and re-throws) leaves a ZOMBIE — the exit hook never runs. While the
      // boot window is still pending (marker set), attribute and disable the
      // culprit right now; post-confirmation runtime errors are only logged.
      try {
        if (readStateSync(stateFile)?.boot) {
          handleUncaughtLoaderSync({ stateFile, incidentsFile, patchFile }, detail);
        }
      } catch {
        // attribution must never disturb the exception path
      }
    });
    process.once("exit", (code) =>
      handleExitSync({ stateFile, incidentsFile, patchFile, captured: capture.captured }, code),
    );
    // R19 clean-shutdown signals: the 'exit' hook never runs when SIGINT /
    // SIGTERM kills the process directly, so the boot marker would leak and
    // the NEXT boot would escalate disables for a stop that was not a crash.
    // Registering a listener suppresses Node's default termination, so the
    // handler must flush and exit itself. Kernel handlers registered earlier
    // run first (registration order). DSHPKG_NO_SIGNAL_GUARD=off disables the
    // registration for test runners that emit synthetic signals.
    if (process.env.DSHPKG_NO_SIGNAL_GUARD !== "off") {
      const onCleanSignal = () => {
        try {
          cleanShutdownSync({ stateFile, incidentsFile });
        } catch {
          // never disturb the host's own shutdown
        }
        process.exit(0);
      };
      process.once("SIGINT", onCleanSignal);
      process.once("SIGTERM", onCleanSignal);
    }
  } catch {
    // the guardian must never disturb boot itself
  }

  // Async tail (fire-and-forget): incidents, safe-mode restore, confirm.
  if (bootFailures >= 1) {
    appendIncident({
      type: "boot-crash-detected",
      bootFailures,
      safeMode,
      at: new Date().toISOString(),
    }).catch(() => {});
  }
  if (safeMode && profileDir) {
    (async () => {
      try {
        const snaps = await listSnapshots();
        if (snaps.length > 0) await restoreSnapshot(profileDir, snaps[0]);
      } catch {
        // best-effort: the live disables already protect this boot
      }
    })();
  }
  try {
    const readyCheck = isReadyImpl ?? (() => dshpkgRoutesReady);
    const timer = setTimeoutImpl(() => {
      // R20 service-aware confirmation: survival alone is not proof of a
      // healthy boot. Alive but never registered the /dshpkg routes -> the
      // plugin tree is dead (zombie): degrade instead of certify, keeping
      // the marker so the next boot escalates with the stored culprit.
      let ready = true;
      try {
        ready = Boolean(readyCheck());
      } catch {
        ready = true; // a broken probe must not block confirmation
      }
      if (!ready) {
        degradeBootSync({ stateFile, incidentsFile });
        return;
      }
      if (confirmBootSync({ stateFile, incidentsFile }) && profileDir) {
        saveSnapshot(profileDir).catch(() => {});
      }
    }, confirmDelayMs);
    timer?.unref?.();
  } catch {
    // no confirmation window: the fingerprint still converges on next boot
  }
}

/** Request body cap (256 KiB) enforced for every POST route. */
const BODY_LIMIT = 256 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function apply(ctx) {
  let webServer = null;
  let loader = null;
  // Inject-declared services arrive as ctx properties; ctx.get stays as the
  // fallback for contexts where the declaration was skipped (headless/tests).
  try {
    webServer = ctx?.webServer ?? ctx?.get?.("webServer") ?? null;
  } catch {
    webServer = null;
  }
  try {
    loader = ctx?.loader ?? ctx?.get?.("loader") ?? null;
  } catch {
    loader = null;
  }

  // R16 boot guardian FIRST: its sync core (stale-marker detection,
  // evidence-based preemptive disables, fresh marker, exit hooks) must
  // land before any later loader entry can crash this boot.
  try {
    armBootGuard(loader);
  } catch {
    // the guardian must never disturb boot itself
  }

  // Real mount implementation: dynamic import with cache-buster + cordis
  // ctx.plugin. Falls back to a bare import result when ctx.plugin is missing
  // (headless contexts), so mounting source never hard-depends on cordis.
  const mountImpl = async (importUrl) => {
    const mod = await import(importUrl);
    if (typeof ctx?.plugin !== "function") {
      return { dispose: async () => {}, module: mod };
    }
    return await ctx.plugin(mod, {});
  };

  const layer = new ManagedLayer({ mountImpl });

  // The loader may only become available after this bundle's apply runs
  // (composition timing), so entry access resolves lazily.
  const getLoader = () => {
    try {
      return ctx?.loader ?? loader;
    } catch {
      return loader;
    }
  };

  const api = {
    layer,
    setEntryDisabled: (entryId, disabled) => setEntryDisabled(getLoader(), entryId, disabled),
    enableEntry: (entryId) => setEntryDisabled(getLoader(), entryId, false),
    disableEntry: (entryId) => setEntryDisabled(getLoader(), entryId, true),
    toggleEntry: (entryId) => toggleEntry(getLoader(), entryId),
    collectOfficialEntries: () => collectOfficialEntries(getLoader()),
    rescue: { rescueHtml, buildDisableBlock, applyDisableToPatch, removeManagedBlock },
  };
  try {
    ctx.dshpkg = api;
  } catch {
    // ctx may be frozen; the API stays usable via apply()'s return value.
  }

  // Boot-time restore of previously mounted entries (fire-and-forget so the
  // harness boot is never blocked; failures land in manifest.mountErrors).
  layer.autoRestore().catch(() => {});

  // Reactive service registration (current-kernel pattern, verified against
  // dsh-boot-guard): webServer/tools may be provided AFTER this bundle's
  // apply runs — ctx.effect waits for the dependency and then executes,
  // whereas a synchronous probe at apply time saw null and skipped forever.
  // Contexts without effect (older hosts / tests) run inline instead.
  const effectImpl = (fn, label) => {
    if (typeof ctx?.effect === "function") {
      try {
        ctx.effect(fn, label);
        return;
      } catch (err) {
        // A reactive-registration failure (e.g. fiber inactive mid-boot) is
        // recorded and followed by the inline attempt so boot stays functional.
        try {
          appendIncidentSync(statePath("incidents.jsonl"), {
            type: "effect-error",
            label,
            error: String(err?.message ?? err),
            at: new Date().toISOString(),
          });
        } catch {}
      }
    }
    try {
      fn();
    } catch {
      // registration must never break the harness boot
    }
  };

  effectImpl(() => {
    const ws = ctx?.webServer ?? webServer;
    if (!ws || typeof ws.register !== "function") return;
    ws.register({
      kind: "prefix",
      path: "/dshpkg",
      handler: (req, res) => handleRequest(req, res, api),
    });
    // R20: service-readiness proof for the confirmation window.
    dshpkgRoutesReady = true;
  }, "dshpkg: routes");

  // Spec section 8: model tools + install guard + /dshpkg slash command.
  // Every probe below is defensive — a missing service (or an unexpected
  // interface shape) skips silently and never throws out of apply(). The
  // registered flag guards against an effect re-run double-registering.
  const toolHandlers = createToolHandlers({
    search: (query) => search(query),
    install: (pkgName) => hostInstall(pkgName),
    toggle: (pkgName) => api.toggleEntry(pkgName),
  });
  let toolsRegistered = false;
  effectImpl(() => {
    if (toolsRegistered) return;
    registerModelTools(ctx, toolHandlers);
    registerGuardSection(ctx);
    registerSlashCommand(ctx, toolHandlers);
    toolsRegistered = true;
  }, "dshpkg: tools");

  // Spec section 9: Web UI crash banner via webServer.tapIndex().
  effectImpl(() => {
    registerCrashBanner(ctx?.webServer ?? webServer);
  }, "dshpkg: banner");

  // Boot-time self-healing: reconcile bundle registrations for the next
  // boot (fire-and-forget; never blocks or throws).
  bootReconcile().catch(() => {});

  return api;
}

/** (req, res) style handler; every branch is internally try/catch-safe. */
async function handleRequest(req, res, api) {
  try {
    const auth = await authorizeRequest(req);
    if (!auth.ok) {
      return json(res, auth.code, { ok: false, error: auth.error });
    }
    const method = String(req?.method ?? "GET").toUpperCase();
    const sub = subPath(req);
    if (method === "GET" && (sub === "/" || sub === "" || sub === "/status")) {
      return await routeStatus(res, api);
    }
    if (method === "GET" && sub === "/incidents") {
      return await routeIncidents(res);
    }
    if (method === "GET" && sub === "/metrics") {
      return await routeMetrics(res);
    }
    if (method === "GET" && sub === "/selfcheck") {
      return await routeSelfcheck(res, api);
    }
    if (method === "POST" && sub === "/managed/mount") {
      return await routeMount(req, res, api);
    }
    if (method === "POST" && sub === "/managed/unmount") {
      return await routeUnmount(req, res, api);
    }
    if (method === "POST" && sub === "/managed/enable") {
      return await routeEntryDisabled(req, res, api, false);
    }
    if (method === "POST" && sub === "/managed/disable") {
      return await routeEntryDisabled(req, res, api, true);
    }
    if (method === "POST" && sub === "/circuit/close") {
      return await routeCircuitClose(req, res);
    }
    return json(res, 404, { ok: false, error: `未找到路由: ${method} ${sub}` });
  } catch (err) {
    const code = typeof err?.statusCode === "number" ? err.statusCode : 500;
    return json(res, code, { ok: false, error: String(err?.message ?? err) });
  }
}

/**
 * Authorize an incoming /dshpkg request. Returns { ok: true } when allowed,
 * otherwise { ok: false, code, error }.
 *
 * Rules (tightened in the Phase 0 security review):
 *   - the client must be loopback, OR (when no socket info is available) hold
 *     a valid x-dshpkg-token — the old "no addr => trust" default is gone;
 *   - the request must be same-origin, OR (when it sends no Origin header, as
 *     curl/CLI do) hold a valid x-dshpkg-token;
 *   - every write route (POST) always requires a valid token, so a local
 *     process cannot mount/unmount toggles without the secret. The read
 *     routes (GET /status, /incidents) stay token-free for the Web banner.
 */
export async function authorizeRequest(req) {
  const method = String(req?.method ?? "GET").toUpperCase();
  const tokenOk = await verifyToken(req);
  const loopbackOk = hasLoopbackAddr(req) ? isLoopback(req) : tokenOk;
  const originOk = hasOriginHeader(req) ? isSameOrigin(req) : tokenOk;
  if (!loopbackOk || !originOk) {
    return {
      ok: false,
      code: 403,
      error: "仅允许本机访问（回环地址 + 同源，或携带合法 token）",
    };
  }
  if (method === "POST" && !tokenOk) {
    return { ok: false, code: 401, error: "缺少或错误的 x-dshpkg-token" };
  }
  return { ok: true };
}

async function routeStatus(res, api) {
  const state = await readState();
  const circuitOpen = Object.keys(state.packages ?? {})
    .filter((name) => state.packages[name]?.circuitOpenAt)
    .sort();
  const summary = {
    version: state.version,
    profile: state.profile,
    lastBootOkAt: state.lastBootOkAt,
    bootFailures: state.bootFailures,
    circuitOpen,
    packageCount: Object.keys(state.packages ?? {}).length,
  };
  const managed = await api.layer.list();
  const incidents = await readIncidents(10);
  // Official loader first (CONTRACTS.md R10): live entries merged with the
  // state bookkeeping. null when there is no loader (or entries() throws) —
  // the state/managed fields above keep the fallback path intact.
  const officialEntries = mergeOfficialEntries(
    api.collectOfficialEntries(),
    state.packages,
  );
  return json(res, 200, { ok: true, state: summary, managed, incidents, officialEntries });
}

async function routeIncidents(res) {
  const incidents = await readIncidents(100);
  return json(res, 200, { ok: true, incidents });
}

/**
 * Zero-dependency observability (R19): aggregate counters from state +
 * incidents. Read-only, same auth class as /status. A Prometheus client is
 * deliberately NOT used — it would violate the zero third-party dependency
 * contract (CONTRACTS.md R19).
 */
export async function routeMetrics(res) {
  const state = await readState();
  const incidents = await readIncidents(2000);
  const count = (type) => incidents.filter((e) => e?.type === type).length;
  const lastOf = (type) => {
    for (let i = incidents.length - 1; i >= 0; i -= 1) {
      if (incidents[i]?.type === type) return incidents[i]?.t ?? incidents[i]?.at ?? null;
    }
    return null;
  };
  const circuitOpen = Object.keys(state.packages ?? {})
    .filter((name) => state.packages[name]?.circuitOpenAt)
    .sort();
  return json(res, 200, {
    ok: true,
    metrics: {
      bootFailures: Number(state.bootFailures) || 0,
      lastBootOkAt: state.lastBootOkAt ?? null,
      bootMarkerActive: Boolean(state.boot?.startedAt),
      circuitOpen,
      counts: {
        bootCrash: count("boot-crash"),
        bootConfirmed: count("boot-confirmed"),
        cleanShutdown: count("clean-shutdown"),
        portBusy: count("port-busy"),
        portEvicted: count("port-evicted"),
        stateCorrupt: count("state-corrupt"),
        lockBusy: count("lock-busy"),
      },
      lastEvents: {
        bootCrash: lastOf("boot-crash"),
        bootConfirmed: lastOf("boot-confirmed"),
        portBusy: lastOf("port-busy"),
        portEvicted: lastOf("port-evicted"),
      },
    },
  });
}

/**
 * P3-3 host self-check: state readable, loader enumerable, profile patch
 * parseable. Every check degrades to its own ok:false; the endpoint reports
 * 200 only when all checks pass (503 otherwise) and never throws.
 */
async function routeSelfcheck(res, api) {
  const checks = {};
  let state = null;
  try {
    state = await readState();
    checks.state = {
      ok: true,
      packages: Object.keys(state.packages ?? {}).length,
      profile: state.profile ?? null,
    };
  } catch (err) {
    checks.state = { ok: false, error: String(err?.message ?? err) };
  }
  try {
    const entries = api.collectOfficialEntries() ?? [];
    checks.loader = { ok: true, entries: entries.length };
  } catch (err) {
    checks.loader = { ok: false, error: String(err?.message ?? err) };
  }
  try {
    const profileDir = await resolveProfileDir(state?.profile ?? "web");
    const patchText = profileDir
      ? await readFileSafe(join(profileDir, "cordis.patch.yml"))
      : "";
    const top = patchTopLevel(patchText);
    checks.patch = top.ok
      ? { ok: true, kind: top.kind }
      : { ok: false, kind: top.kind, first: top.first };
  } catch (err) {
    checks.patch = { ok: false, error: String(err?.message ?? err) };
  }
  const allOk = Object.values(checks).every((c) => c.ok === true);
  return json(res, allOk ? 200 : 503, { ok: allOk, checks });
}

/** Read a text file; missing file reads as "". */
async function readFileSafe(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** Minimal patch top-level classification (array / empty / invalid) — the
 * same contract as the supervisor's readPatchTopLevel, inlined here so the
 * self-check never depends on bin/. */
function patchTopLevel(patchText) {
  const meaningful = String(patchText ?? "")
    .split(/\r?\n/)
    .filter((line) => {
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

async function routeMount(req, res, api) {
  const body = await readBody(req);
  const { name, source } = body ?? {};
  if (typeof name !== "string" || !name) {
    return json(res, 400, { ok: false, error: "缺少 name" });
  }
  if (typeof source !== "string" || !source) {
    return json(res, 400, { ok: false, error: "缺少 source" });
  }
  const result = await api.layer.mount(name, source);
  return json(res, result.ok ? 200 : 500, result);
}

async function routeUnmount(req, res, api) {
  const body = await readBody(req);
  const { name } = body ?? {};
  if (typeof name !== "string" || !name) {
    return json(res, 400, { ok: false, error: "缺少 name" });
  }
  const result = await api.layer.unmount(name);
  return json(res, result.ok ? 200 : 404, result);
}

/**
 * Live enable/disable of an L1 loader entry over HTTP (added during the CLI
 * integration, see CONTRACTS.md rulings). Uses entry.update({ disabled }) on
 * the running host; the CLI falls back to cordis.patch.yml file mode when no
 * host answers.
 */
async function routeEntryDisabled(req, res, api, disabled) {
  const body = await readBody(req);
  const { name } = body ?? {};
  if (typeof name !== "string" || !name) {
    return json(res, 400, { ok: false, error: "缺少 name" });
  }
  const result = await api.setEntryDisabled(name, disabled);
  return json(res, result.ok ? 200 : 503, result);
}

async function routeCircuitClose(req, res) {
  const body = await readBody(req);
  const { name } = body ?? {};
  if (typeof name !== "string" || !name) {
    return json(res, 400, { ok: false, error: "缺少 name" });
  }
  // A __proto__/constructor/prototype name must never be used as a state
  // key: state.packages[name] would resolve to the shared prototype and a
  // later mutation (circuitOpenAt = null) would pollute Object.prototype.
  if (isDangerousKey(name)) {
    return json(res, 400, { ok: false, error: `非法的插件名: ${name}` });
  }
  const state = await readState();
  const pkg = state.packages?.[name];
  if (!pkg) return json(res, 404, { ok: false, error: `未找到插件: ${name}` });
  pkg.circuitOpenAt = null;
  if (pkg.circuit) pkg.circuit.closedAt = new Date().toISOString();
  await writeState(state);
  return json(res, 200, { ok: true, name, circuitClosed: true });
}

/**
 * Live enable/disable of an L1 loader entry (entry.update({ disabled })).
 * Returns { ok: false, error } when the loader is unavailable, the entry is
 * missing, or update rejects — never throws.
 */
async function setEntryDisabled(loader, entryId, disabled) {
  // Spec section 9: core entries must never be disabled by the self-healing
  // machinery — refuse before touching the loader.
  if (isProtected(entryId)) {
    return { ok: false, protected: true, reason: "核心条目受保护，禁止熔断" };
  }
  if (!loader) return { ok: false, error: "loader 不可用" };
  try {
    const entry = findEntry(loader, entryId);
    if (!entry || typeof entry.update !== "function") {
      return { ok: false, error: `未找到条目: ${entryId}` };
    }
    await entry.update({ disabled });
    return { ok: true, name: entryId, disabled };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Flip the disabled state of an L1 loader entry (plugin_toggle backend).
 * Reads the entry's current disabled flag to decide the target state; an
 * unknown current state defaults to "enabled" (toggle disables). Core
 * entries are refused the same way as setEntryDisabled.
 */
async function toggleEntry(loader, entryId) {
  if (isProtected(entryId)) {
    return { ok: false, protected: true, reason: "核心条目受保护，禁止熔断" };
  }
  if (!loader) return { ok: false, error: "loader 不可用" };
  try {
    const entry = findEntry(loader, entryId);
    if (!entry || typeof entry.update !== "function") {
      return { ok: false, error: `未找到条目: ${entryId}` };
    }
    const currentlyDisabled = entry.disabled === true;
    const next = !currentlyDisabled;
    await entry.update({ disabled: next });
    return { ok: true, name: entryId, disabled: next };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** Resolve a loader entry by id across the two known loader shapes. */
function findEntry(loader, entryId) {
  try {
    if (typeof loader?.entryById === "function") {
      return loader.entryById(entryId) ?? null;
    }
    if (Array.isArray(loader?.entries)) {
      return loader.entries.find((e) => e?.id === entryId) ?? null;
    }
  } catch {
    // fall through to null
  }
  return null;
}

/**
 * Collect live entries from the official loader (official API first, see
 * CONTRACTS.md R10). Each entry becomes { id, module, disabled, phase }:
 * module prefers entry.options.name (entry.name fallback), disabled is
 * normalized to a boolean, phase is best-effort from entry.fiber
 * (phase or state). Returns null when the loader is missing or entries()
 * throws — the caller falls back to its own state bookkeeping.
 */
export function collectOfficialEntries(loader) {
  if (!loader) return null;
  let list;
  try {
    if (typeof loader.entries === "function") list = loader.entries();
    else if (Array.isArray(loader.entries)) list = loader.entries;
    else return null;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const entry of list) {
    try {
      const id = entry?.id;
      if (typeof id !== "string" || !id) continue;
      out.push({
        id,
        module: entry?.options?.name ?? entry?.name ?? null,
        disabled: entry?.disabled === true,
        phase: phaseOf(entry),
      });
    } catch {
      // malformed entry: skip it, keep the rest
    }
  }
  return out;
}

/** Best-effort fiber phase: entry.fiber.phase, else entry.fiber.state. */
function phaseOf(entry) {
  try {
    const fiber = entry?.fiber;
    if (!fiber) return null;
    if (typeof fiber.phase === "string") return fiber.phase;
    if (typeof fiber.state === "string") return fiber.state;
  } catch {
    // fall through to null
  }
  return null;
}

/**
 * Merge official loader entries with state.packages into the status view.
 * Entries the official tree owns keep source "official-loader" (official
 * phase/disabled win); state supplements crashCount/circuitOpen. State-only
 * entries get source "dshpkg-state". Returns null when officialEntries is
 * null (no loader) so the caller can fall back to the plain state path.
 */
export function mergeOfficialEntries(officialEntries, packages) {
  if (officialEntries == null) return null;
  const merged = new Map();
  for (const entry of officialEntries) {
    merged.set(entry.id, {
      id: entry.id,
      module: entry.module ?? null,
      disabled: entry.disabled === true,
      phase: entry.phase ?? null,
      source: "official-loader",
    });
  }
  for (const [name, pkg] of Object.entries(packages ?? {})) {
    const crashCount = typeof pkg?.crashCount === "number" ? pkg.crashCount : null;
    const circuitOpen = pkg?.circuitOpenAt ? true : null;
    const existing = merged.get(name);
    if (existing) {
      if (crashCount != null) existing.crashCount = crashCount;
      if (circuitOpen) existing.circuitOpen = true;
    } else {
      merged.set(name, {
        id: name,
        module: null,
        disabled: false,
        phase: null,
        source: "dshpkg-state",
        ...(crashCount != null ? { crashCount } : {}),
        ...(circuitOpen ? { circuitOpen: true } : {}),
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// --- Spec section 8: model tools / install guard / slash command -------------

/**
 * Register plugin_search / plugin_install / plugin_toggle with the dsh-tools
 * registry. Probes ctx.get("tools"); a missing service, a mismatched shape,
 * or a rejected definition is logged (one line) and skipped — never throws.
 */
function registerModelTools(ctx, toolHandlers) {
  let tools = null;
  try {
    tools = ctx?.get?.("tools") ?? null;
  } catch {
    tools = null;
  }
  if (!tools || typeof tools.register !== "function") return;
  let definitions;
  try {
    definitions = buildToolDefinitions(toolHandlers);
  } catch {
    definitions = [];
  }
  let yielded = 0;
  for (const def of definitions) {
    try {
      tools.register(def);
    } catch (err) {
      // A same-name tool already provided by another plugin (e.g.
      // dsh-web-plugin-manager) is a normal yield, not a failure; a single
      // summary line is printed after the loop instead of one line per tool.
      if (/already registered/i.test(String(err?.message ?? err))) {
        yielded += 1;
      } else {
        console.log(
          `[dshpkg] 模型工具 ${def?.name ?? "?"} 注册失败，已跳过：${String(err?.message ?? err)}`,
        );
      }
    }
  }
  if (yielded > 0) {
    console.log(
      `[dshpkg] ${yielded} 个同名插件工具已由其他插件提供（如 dsh-web-plugin-manager），dshpkg 自动让位`,
    );
  }
}

/**
 * Inject the install-guard rule into the system prompt via
 * SystemPrompt.section(). Skips silently when the service or its section
 * method is absent (or rejects).
 */
function registerGuardSection(ctx) {
  let systemPrompt = null;
  try {
    systemPrompt = ctx?.get?.("systemPrompt") ?? null;
  } catch {
    systemPrompt = null;
  }
  if (!systemPrompt || typeof systemPrompt.section !== "function") return;
  try {
    systemPrompt.section({
      name: "dshpkg:install-guard",
      order: 60,
      text: buildGuardSection(),
    });
  } catch {
    // guard injection is best-effort
  }
}

/**
 * Register the /dshpkg slash command with the commands registry
 * (ctx.get("commands") with a ctx.command fallback). Skips silently when the
 * service shape cannot be determined.
 */
function registerSlashCommand(ctx, toolHandlers) {
  let commands = null;
  try {
    commands = ctx?.get?.("commands") ?? null;
    if (!commands) commands = ctx?.commands ?? null;
  } catch {
    commands = null;
  }
  if (!commands || typeof commands.register !== "function") return;
  try {
    commands.register(buildCommandDefinition(toolHandlers));
  } catch {
    // command registration is best-effort
  }
}

// --- Spec section 9: Web UI crash banner -------------------------------------

/**
 * Inject the crash-banner inline script into the host index.html via
 * webServer.tapIndex() (same channel as dsh-boot-guard). Best-effort: a
 * missing tapIndex or a throwing transform leaves the page untouched.
 */
function registerCrashBanner(webServer) {
  if (!webServer || typeof webServer.tapIndex !== "function") return;
  try {
    webServer.tapIndex((html) => injectBannerScript(html, buildBannerScript()));
  } catch {
    // banner injection is best-effort
  }
}

/** True when the request carries resolvable socket address info. */
export function hasLoopbackAddr(req) {
  return (
    typeof req?.socket?.remoteAddress === "string" &&
    req.socket.remoteAddress.length > 0
  );
}

/**
 * Loopback guard. Unlike the pre-fix version, a missing socket address is NOT
 * treated as loopback — it returns false, and the caller (authorizeRequest)
 * demands a valid token instead.
 */
export function isLoopback(req) {
  const addr = req?.socket?.remoteAddress;
  if (!addr) return false;
  return LOOPBACK.has(addr) || /^::ffff:127\./.test(addr);
}

/** True when the request carries an Origin header at all. */
export function hasOriginHeader(req) {
  return (
    typeof req?.headers?.origin === "string" && req.headers.origin.length > 0
  );
}

/**
 * Same-origin guard: a browser request carrying an Origin must match Host.
 * Requests with no Origin header are handled by authorizeRequest (they need a
 * valid token) — this predicate alone does not decide the no-Origin case.
 */
export function isSameOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Verify the x-dshpkg-token header against the on-disk api-token. Requests
 * carrying no header fail fast (they never cause the token file to be
 * created); the async compare only runs when a header is actually present.
 */
export async function verifyToken(req) {
  const header = req?.headers?.["x-dshpkg-token"];
  if (typeof header !== "string" || header.length === 0) return false;
  const token = await readApiToken();
  // Constant-time comparison to avoid a timing oracle on the token. Compare
  // lengths first (timingSafeEqual throws on unequal lengths), then the bytes.
  const a = Buffer.from(header.trim(), "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Normalize the sub-path under /dshpkg. Handles both styles: req.url keeps the
 * full path ("/dshpkg/status") or the web server already stripped the prefix
 * ("/status").
 */
function subPath(req) {
  let p = "";
  if (typeof req?.url === "string") {
    try {
      p = new URL(req.url, "http://localhost").pathname;
    } catch {
      p = String(req.url).split("?")[0] ?? "";
    }
  }
  const idx = p.indexOf("/dshpkg");
  if (idx >= 0) p = p.slice(idx + "/dshpkg".length) || "/";
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/** Read the request body as JSON with a 256 KiB cap. */
async function readBody(req) {
  if (!req || typeof req[Symbol.asyncIterator] !== "function") return {};
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      throw Object.assign(new Error("请求体超过 256KB 上限"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 });
  }
}

function json(res, code, obj) {
  try {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  } catch {
    // stream may already be closed; nothing sensible left to do
  }
}

// The loader's unwrapExports prefers module.default over named exports, so
// the default export MUST carry inject too — a default of { name, apply }
// alone silently lost the inject declaration ("cannot get property
// webServer without inject", R16).
export default { name, inject, apply };
