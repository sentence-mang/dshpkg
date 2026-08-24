// Tests for the official-loader-first status merge (lib/index.js, R10).
// The loader is faked and all state lives in temp dirs (DSH_HOME /
// DSH_PKG_HOME); nothing touches a real profile and nothing reaches the
// network. apply() is exercised through a captured fake webServer handler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, collectOfficialEntries, mergeOfficialEntries } from "../lib/index.js";
import { readState, writeState } from "../lib/state.js";

// ------------------------------------------------------------- test plumbing

/** Fresh DSH_HOME + DSH_PKG_HOME per test (never a real profile). */
async function makeEnv(t) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-status-home-"));
  const root = await mkdtemp(join(tmpdir(), "dshpkg-status-state-"));
  process.env.DSH_HOME = home;
  process.env.DSH_PKG_HOME = root;
  if (t && typeof t.after === "function") {
    t.after(() => {
      delete process.env.DSH_HOME;
      delete process.env.DSH_PKG_HOME;
    });
  }
  return { home, root };
}

/** The R10 fixture loader: two entries, one disabled, one without a fiber. */
function fakeLoader() {
  return {
    entries: () => [
      { id: "a", options: { name: "mod-a" }, disabled: false, fiber: { phase: "active" } },
      { id: "b", options: { name: "mod-b" }, disabled: true, fiber: null },
    ],
  };
}

/** Fake webServer capturing the /dshpkg handler; apply() returns the api. */
function bootHost({ loader } = {}) {
  let handler = null;
  const webServer = {
    register: (spec) => {
      handler = spec.handler;
    },
    tapIndex: () => {},
  };
  const ctx = {
    get: (key) =>
      key === "webServer" ? webServer : key === "loader" ? (loader ?? null) : null,
  };
  const api = apply(ctx);
  return { handler, api };
}

/** GET /dshpkg/status through the captured handler with a minimal res. */
async function getStatus({ loader } = {}) {
  const { handler, api } = bootHost({ loader });
  assert.ok(handler, "webServer.register must capture the /dshpkg handler");
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(text) {
      this.body += text;
    },
  };
  await handler({ socket: null, method: "GET", url: "/dshpkg/status", headers: {} }, res, api);
  return { statusCode: res.statusCode, payload: JSON.parse(res.body) };
}

// ------------------------------------------------- collectOfficialEntries

test("collectOfficialEntries maps live loader entries to the R10 shape", () => {
  const entries = collectOfficialEntries(fakeLoader());
  assert.deepEqual(entries, [
    { id: "a", module: "mod-a", disabled: false, phase: "active" },
    { id: "b", module: "mod-b", disabled: true, phase: null },
  ]);
});

test("collectOfficialEntries returns null when entries() throws", () => {
  const loader = {
    entries: () => {
      throw new Error("loader broken");
    },
  };
  assert.equal(collectOfficialEntries(loader), null);
});

test("collectOfficialEntries returns null without a usable loader", () => {
  assert.equal(collectOfficialEntries(null), null);
  assert.equal(collectOfficialEntries(undefined), null);
  assert.equal(collectOfficialEntries({}), null);
});

// ------------------------------------------------------- mergeOfficialEntries

test("mergeOfficialEntries keeps the official source and adds state crash data", () => {
  const official = collectOfficialEntries(fakeLoader());
  const packages = {
    b: { crashCount: 2, circuitOpenAt: "2026-08-24T00:00:00.000Z" },
    c: { crashCount: 0 },
  };
  const merged = mergeOfficialEntries(official, packages);

  const a = merged.find((e) => e.id === "a");
  assert.equal(a.source, "official-loader");
  assert.equal(a.module, "mod-a");
  assert.equal(a.disabled, false);
  assert.equal(a.phase, "active");
  assert.equal(a.crashCount, undefined);

  const b = merged.find((e) => e.id === "b");
  assert.equal(b.source, "official-loader");
  assert.equal(b.module, "mod-b");
  assert.equal(b.disabled, true);
  assert.equal(b.phase, null);
  assert.equal(b.crashCount, 2);
  assert.equal(b.circuitOpen, true);

  const c = merged.find((e) => e.id === "c");
  assert.equal(c.source, "dshpkg-state");
  assert.equal(c.crashCount, 0);
  assert.equal(c.circuitOpen, undefined);
});

test("mergeOfficialEntries returns null when officialEntries is null", () => {
  assert.equal(mergeOfficialEntries(null, { a: { crashCount: 1 } }), null);
});

// ------------------------------------------------------------ status endpoint

test("GET /dshpkg/status merges official entries with state packages", async (t) => {
  await makeEnv(t);
  await writeState({
    ...(await readState()),
    packages: {
      b: { source: "npm", crashCount: 2, circuitOpenAt: "2026-08-24T00:00:00.000Z" },
    },
  });
  const { statusCode, payload } = await getStatus({ loader: fakeLoader() });
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);

  const b = payload.officialEntries.find((e) => e.id === "b");
  assert.ok(b, "merged view must contain entry b");
  assert.equal(b.source, "official-loader");
  assert.equal(b.crashCount, 2);
  assert.equal(b.circuitOpen, true);
  assert.equal(b.disabled, true);
  assert.equal(b.module, "mod-b");

  const a = payload.officialEntries.find((e) => e.id === "a");
  assert.equal(a.source, "official-loader");
  assert.equal(a.phase, "active");

  // the existing state summary keeps working alongside the new field
  assert.equal(payload.state.packageCount, 1);
  assert.deepEqual(payload.state.circuitOpen, ["b"]);
});

test("GET /dshpkg/status falls back to state when entries() throws", async (t) => {
  await makeEnv(t);
  await writeState({
    ...(await readState()),
    packages: { x: { crashCount: 1 } },
  });
  const loader = {
    entries: () => {
      throw new Error("loader broken");
    },
  };
  const { statusCode, payload } = await getStatus({ loader });
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.officialEntries, null);
  assert.equal(payload.state.packageCount, 1);
  assert.ok(Array.isArray(payload.managed));
});

test("GET /dshpkg/status with no loader keeps the pure state path", async (t) => {
  await makeEnv(t);
  await writeState({
    ...(await readState()),
    packages: { x: { crashCount: 1 } },
  });
  const { statusCode, payload } = await getStatus({ loader: null });
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.officialEntries, null);
  assert.equal(payload.state.packageCount, 1);
  assert.ok(Array.isArray(payload.managed));
});
