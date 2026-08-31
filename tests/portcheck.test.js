// Tests for lib/portcheck.js — port check + arbitration (R18).
// All IO is injected: no real sockets are bound, no process is killed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  checkPort,
  evictPortHolder,
  isDshCommandLine,
  findPortHolder,
  MAX_EVICT_ATTEMPTS,
} from "../lib/portcheck.js";

/** Fake server whose listen succeeds immediately. */
function freeServer() {
  const server = new EventEmitter();
  server.listen = (_opts, cb) => cb();
  server.close = (cb) => cb && cb();
  return server;
}

/** Fake server whose listen fails with the given error code. */
function busyServer(code = "EADDRINUSE") {
  const server = new EventEmitter();
  server.listen = () => {
    queueMicrotask(() => server.emit("error", Object.assign(new Error(code), { code })));
  };
  server.close = () => {};
  return server;
}

test("checkPort: a successful listen resolves free", async () => {
  const result = await checkPort(3999, { createServerImpl: () => freeServer() });
  assert.deepEqual(result, { free: true });
});

test("checkPort: EADDRINUSE resolves busy with holder info from injected lookups", async () => {
  const result = await checkPort(3080, {
    createServerImpl: () => busyServer("EADDRINUSE"),
    netstatImpl: () => ({
      status: 0,
      stdout: `  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       11100\n`,
    }),
    cmdlineImpl: async () => `node "C:/x/@deepseek-ai/dsh/lib/bin.js" web --port 3080`,
  });
  assert.equal(result.free, false);
  assert.equal(result.pid, 11100);
  assert.ok(result.holder.includes("@deepseek-ai/dsh"));
});

test("checkPort: netstat parse miss leaves pid null", async () => {
  const result = await checkPort(3080, {
    createServerImpl: () => busyServer("EADDRINUSE"),
    netstatImpl: () => ({ status: 0, stdout: "nothing matching here\n" }),
    cmdlineImpl: async () => null,
  });
  assert.equal(result.free, false);
  assert.equal(result.pid, null);
});

test("checkPort: unexpected error code surfaces as error, never throws", async () => {
  const result = await checkPort(3080, { createServerImpl: () => busyServer("EMFILE") });
  assert.equal(result.free, false);
  assert.ok(String(result.error).includes("EMFILE"));
});

test("isDshCommandLine matches dsh launcher lines only", () => {
  assert.equal(
    isDshCommandLine(`"C:\\Program Files\\nodejs\\node.exe" C:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web`),
    true,
  );
  assert.equal(isDshCommandLine(`node /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`), true);
  assert.equal(isDshCommandLine(`node app.js`), false);
  assert.equal(isDshCommandLine(`chrome.exe --flag`), false);
  assert.equal(isDshCommandLine(null), false);
});

test("evictPortHolder: port already free resolves ok without killing", async () => {
  let killed = 0;
  const result = await evictPortHolder(3080, {
    checkImpl: async () => ({ free: true }),
    killImpl: () => (killed += 1),
    sleepImpl: async () => {},
  });
  assert.deepEqual(result, { ok: true, evicted: 0 });
  assert.equal(killed, 0);
});

test("evictPortHolder: a non-dsh holder is never killed", async () => {
  let killed = 0;
  const result = await evictPortHolder(3080, {
    checkImpl: async () => ({ free: false, pid: 4242, holder: `chrome.exe --remote` }),
    killImpl: () => (killed += 1),
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("不会自动结束"));
  assert.equal(killed, 0);
});

test("evictPortHolder: unknown holder (no pid) is never killed", async () => {
  let killed = 0;
  const result = await evictPortHolder(3080, {
    checkImpl: async () => ({ free: false, pid: null, holder: null }),
    killImpl: () => (killed += 1),
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(killed, 0);
});

test("evictPortHolder: a stale dsh holder is killed once, then the port is free", async () => {
  let checks = 0;
  let killed = [];
  const result = await evictPortHolder(3080, {
    checkImpl: async () => {
      checks += 1;
      return checks === 1
        ? { free: false, pid: 11100, holder: `node C:/x/@deepseek-ai/dsh/lib/bin.js web` }
        : { free: true };
    },
    killImpl: (pid) => (killed.push(pid), true),
    sleepImpl: async () => {},
  });
  assert.deepEqual(result, { ok: true, evicted: 1 });
  assert.deepEqual(killed, [11100]);
});

test("evictPortHolder: a kill failure reports a Chinese reason", async () => {
  const result = await evictPortHolder(3080, {
    checkImpl: async () => ({ free: false, pid: 11100, holder: `node C:/x/@deepseek-ai/dsh/lib/bin.js web` }),
    killImpl: () => false,
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("无法结束"));
});

test("evictPortHolder: bounded by MAX_EVICT_ATTEMPTS when the port never frees", async () => {
  let kills = 0;
  const result = await evictPortHolder(3080, {
    checkImpl: async () => ({ free: false, pid: 11100, holder: `node C:/x/@deepseek-ai/dsh/lib/bin.js web` }),
    killImpl: () => (kills += 1),
    sleepImpl: async () => {},
    maxAttempts: MAX_EVICT_ATTEMPTS,
  });
  assert.equal(result.ok, false);
  assert.equal(kills, MAX_EVICT_ATTEMPTS);
});

test("findPortHolder: parses the windows netstat line via injected impls", async () => {
  const holder = await findPortHolder(3080, {
    netstatImpl: () => ({
      status: 0,
      stdout: "  TCP    0.0.0.0:135   0.0.0.0:0   LISTENING   999\n  TCP    127.0.0.1:3080   0.0.0.0:0   LISTENING   11100\n",
    }),
    cmdlineImpl: async (pid) => `cmdline-of-${pid}`,
  });
  if (process.platform === "win32") {
    assert.deepEqual(holder, { pid: 11100, commandLine: "cmdline-of-11100" });
  } else {
    // the win32 regex does not match ss output; holder stays null
    assert.equal(holder, null);
  }
});
