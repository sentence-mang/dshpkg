// dshpkg — host service entry (L2 managed layer) in cordis plugin shape.
//
// Defensive by design: `ctx.get("webServer")` and `ctx.get("loader")` may be
// undefined (headless-safe) and every route handler is wrapped so apply() and
// the handlers never throw outward. The interesting logic lives in
// managed.js / rescue.js which are unit-tested without cordis; this module is
// kept thin (syntax/loadability only: `node --check lib/index.js`).

import { ManagedLayer } from "./managed.js";
import {
  readState,
  writeState,
  readIncidents,
} from "./state.js";
import {
  rescueHtml,
  buildDisableBlock,
  applyDisableToPatch,
  removeManagedBlock,
} from "./rescue.js";

export const name = "dshpkg";

/** Request body cap (256 KiB) enforced for every POST route. */
const BODY_LIMIT = 256 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function apply(ctx) {
  let webServer = null;
  let loader = null;
  try {
    webServer = ctx?.get?.("webServer") ?? null;
  } catch {
    webServer = null;
  }
  try {
    loader = ctx?.get?.("loader") ?? null;
  } catch {
    loader = null;
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

  const api = {
    layer,
    setEntryDisabled: (entryId, disabled) => setEntryDisabled(loader, entryId, disabled),
    enableEntry: (entryId) => setEntryDisabled(loader, entryId, false),
    disableEntry: (entryId) => setEntryDisabled(loader, entryId, true),
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

  if (webServer && typeof webServer.register === "function") {
    try {
      webServer.register({
        kind: "prefix",
        path: "/dshpkg",
        handler: (req, res) => handleRequest(req, res, api),
      });
    } catch {
      // registration failure must not break the harness boot
    }
  }

  return api;
}

/** (req, res) style handler; every branch is internally try/catch-safe. */
async function handleRequest(req, res, api) {
  try {
    if (!isLoopback(req) || !sameOrigin(req)) {
      return json(res, 403, { ok: false, error: "仅允许本机访问（回环地址 + 同源）" });
    }
    const method = String(req?.method ?? "GET").toUpperCase();
    const sub = subPath(req);
    if (method === "GET" && (sub === "/" || sub === "" || sub === "/status")) {
      return await routeStatus(res, api);
    }
    if (method === "GET" && sub === "/incidents") {
      return await routeIncidents(res);
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

async function routeStatus(res, api) {
  const state = await readState();
  const summary = {
    version: state.version,
    profile: state.profile,
    lastBootOkAt: state.lastBootOkAt,
    bootFailures: state.bootFailures,
    packageCount: Object.keys(state.packages ?? {}).length,
  };
  const managed = await api.layer.list();
  const incidents = await readIncidents(10);
  return json(res, 200, { ok: true, state: summary, managed, incidents });
}

async function routeIncidents(res) {
  const incidents = await readIncidents(100);
  return json(res, 200, { ok: true, incidents });
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
  if (!loader) return { ok: false, error: "loader 不可用" };
  try {
    let entry = null;
    if (typeof loader.entryById === "function") entry = loader.entryById(entryId);
    else if (Array.isArray(loader.entries)) {
      entry = loader.entries.find((e) => e?.id === entryId) ?? null;
    }
    if (!entry || typeof entry.update !== "function") {
      return { ok: false, error: `未找到条目: ${entryId}` };
    }
    await entry.update({ disabled });
    return { ok: true, name: entryId, disabled };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** Loopback guard: no socket info is treated as loopback (test/CLI friendly). */
function isLoopback(req) {
  const addr = req?.socket?.remoteAddress;
  if (!addr) return true;
  return LOOPBACK.has(addr) || /^::ffff:127\./.test(addr);
}

/** Same-origin guard: browser requests must carry an Origin matching Host. */
function sameOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true; // non-browser clients (curl, node fetch) send none
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
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

export default { name, apply };
