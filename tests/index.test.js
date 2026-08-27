// Tests for lib/index.js /dshpkg request authorization (Phase 0 security).
// No real request is made — authorizeRequest and the guard predicates are
// pure functions; the token store is isolated to a temp DSH_PKG_HOME so a
// real ~/.dsh/dshpkg api-token is never created or read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeRequest,
  isLoopback,
  hasLoopbackAddr,
  isSameOrigin,
  hasOriginHeader,
  verifyToken,
} from "../lib/index.js";
import { readApiToken } from "../lib/state.js";

/** Point DSH_PKG_HOME at a fresh temp state root for one test; restore it. */
async function usePkgHome(t) {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-idx-state-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });
  return root;
}

function req({ method = "GET", origin, host, addr, token } = {}) {
  return {
    method,
    headers: {
      host,
      ...(origin !== undefined ? { origin } : {}),
      ...(token !== undefined ? { "x-dshpkg-token": token } : {}),
    },
    socket: addr !== undefined ? { remoteAddress: addr } : {},
  };
}

const HOST = "127.0.0.1:3080";

test("GET /status from a same-origin loopback browser is allowed (no token)", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "GET", host: HOST, origin: `http://${HOST}`, addr: "127.0.0.1" });
  assert.deepEqual(await authorizeRequest(r), { ok: true });
});

test("POST without a token is rejected with 401 even when same-origin/loopback", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "POST", host: HOST, origin: `http://${HOST}`, addr: "127.0.0.1" });
  assert.deepEqual(await authorizeRequest(r), {
    ok: false,
    code: 401,
    error: "缺少或错误的 x-dshpkg-token",
  });
});

test("POST with a valid token is allowed (loopback, no origin — CLI path)", async (t) => {
  await usePkgHome(t);
  const token = await readApiToken();
  const r = req({ method: "POST", host: HOST, addr: "127.0.0.1", token });
  assert.deepEqual(await authorizeRequest(r), { ok: true });
});

test("no-Origin request without a token is rejected (no default trust)", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "GET", host: HOST, addr: "127.0.0.1" }); // no origin, no token
  const auth = await authorizeRequest(r);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 403);
});

test("no socket addr without a token is rejected (no 'no addr => trust')", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "GET", host: HOST, origin: `http://${HOST}` }); // no addr, no token
  const auth = await authorizeRequest(r);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 403);
});

test("no socket addr WITH a valid token is allowed", async (t) => {
  await usePkgHome(t);
  const token = await readApiToken();
  const r = req({ method: "GET", host: HOST, origin: `http://${HOST}`, token });
  assert.deepEqual(await authorizeRequest(r), { ok: true });
});

test("cross-origin request is rejected even with a valid token", async (t) => {
  await usePkgHome(t);
  const token = await readApiToken();
  const r = req({ method: "POST", host: HOST, origin: "http://evil.example", addr: "127.0.0.1", token });
  const auth = await authorizeRequest(r);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 403);
});

test("a wrong token is rejected with 401 on a POST route", async (t) => {
  await usePkgHome(t);
  const r = req({ method: "POST", host: HOST, origin: `http://${HOST}`, addr: "127.0.0.1", token: "wrong" });
  assert.deepEqual(await authorizeRequest(r), {
    ok: false,
    code: 401,
    error: "缺少或错误的 x-dshpkg-token",
  });
});

test("a same-length wrong token is rejected (timingSafeEqual byte path)", async (t) => {
  await usePkgHome(t);
  const token = await readApiToken(); // 64 hex chars
  // Flip one hex digit: same length, different bytes — the length shortcut
  // cannot decide this, so the timingSafeEqual branch must reject it.
  const wrong = (token[0] === "0" ? "1" : "0") + token.slice(1);
  assert.equal(wrong.length, token.length);
  const r = req({ method: "POST", host: HOST, origin: `http://${HOST}`, addr: "127.0.0.1", token: wrong });
  const auth = await authorizeRequest(r);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, 401);
});

test("verifyToken returns false when no (or an empty) token header is sent", async (t) => {
  await usePkgHome(t);
  assert.equal(await verifyToken(req({ token: undefined })), false);
  assert.equal(await verifyToken(req({ token: "" })), false);
});

test("isLoopback no longer trusts a missing address", () => {
  assert.equal(hasLoopbackAddr({ socket: {} }), false);
  assert.equal(isLoopback({ socket: {} }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "10.0.0.1" } }), false);
});

test("hasOriginHeader / isSameOrigin behave per the tightened contract", () => {
  assert.equal(hasOriginHeader({ headers: {} }), false);
  assert.equal(hasOriginHeader({ headers: { origin: "" } }), false);
  assert.equal(hasOriginHeader({ headers: { origin: "http://x" } }), true);
  assert.equal(
    isSameOrigin({ headers: { origin: `http://${HOST}`, host: HOST } }),
    true,
  );
  assert.equal(
    isSameOrigin({ headers: { origin: "http://evil.example", host: HOST } }),
    false,
  );
  // no origin: isSameOrigin is false (authorizeRequest decides the no-origin case)
  assert.equal(isSameOrigin({ headers: { host: HOST } }), false);
});
