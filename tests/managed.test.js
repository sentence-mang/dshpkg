// Unit tests for lib/managed.js — temp dirs + fake mountImpl only.
// Never boots a live dsh profile, never touches ~/.dsh/profiles/*.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedLayer } from "../lib/managed.js";

/**
 * Fake mountImpl: records every importUrl it receives; entries named in
 * `failFor` throw with a stack frame pointing at managed/<name>/index.mjs:42.
 */
function makeMountImpl({ calls = [], failFor = new Set() } = {}) {
  const impl = async (importUrl) => {
    calls.push(importUrl);
    const parts = new URL(importUrl).pathname.split("/").filter(Boolean);
    const name = parts[parts.length - 2];
    if (failFor.has(name)) {
      const err = new Error(`boot-crash fixture: intentional boot failure (${name})`);
      err.stack = `Error: boot-crash fixture\n    at file:///store/managed/${name}/index.mjs:42:7\n    at async ManagedLayer.mount`;
      throw err;
    }
    let disposed = 0;
    return {
      name,
      dispose: async () => {
        disposed += 1;
      },
      disposeCount: () => disposed,
    };
  };
  impl.calls = calls;
  return impl;
}

async function makeTmpStore() {
  return await mkdtemp(join(tmpdir(), "dshpkg-managed-"));
}

async function readManifest(storeDir, name) {
  return JSON.parse(await readFile(join(storeDir, name, "manifest.json"), "utf8"));
}

async function manifestExists(storeDir, name) {
  try {
    await readFile(join(storeDir, name, "manifest.json"));
    return true;
  } catch {
    return false;
  }
}

const SOURCE = "export const name = 'alpha';\nexport function apply() {}";

test("mount success: source written, seq cache-buster, manifest with rev 1", async () => {
  const storeDir = await makeTmpStore();
  const calls = [];
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl({ calls }) });
  try {
    const result = await layer.mount("alpha", SOURCE);
    assert.equal(result.ok, true);
    assert.equal(result.name, "alpha");
    assert.equal(result.rev, 1);
    assert.equal(result.seq, 1);

    const source = await readFile(join(storeDir, "alpha", "index.mjs"), "utf8");
    assert.equal(source, SOURCE);

    const manifest = await readManifest(storeDir, "alpha");
    assert.equal(manifest.name, "alpha");
    assert.equal(manifest.rev, 1);
    assert.equal(manifest.enabled, true);
    assert.equal(typeof manifest.mountedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(manifest.mountedAt)));

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("?v=1"), `importUrl should carry ?v=1, got: ${calls[0]}`);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("mount failure: no manifest persisted, rev not advanced, error line extracted", async () => {
  const storeDir = await makeTmpStore();
  const failFor = new Set(["bad"]);
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl({ failFor }) });
  try {
    const result = await layer.mount("bad", SOURCE);
    assert.equal(result.ok, false);
    assert.match(result.error, /intentional boot failure/);
    assert.equal(result.line, 42);
    assert.equal(await manifestExists(storeDir, "bad"), false);

    // Rev must not advance: a later successful mount of the same name starts at rev 1.
    failFor.clear();
    const retry = await layer.mount("bad", SOURCE);
    assert.equal(retry.ok, true);
    assert.equal(retry.rev, 1);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("second mount bumps rev and keeps seq monotonically increasing", async () => {
  const storeDir = await makeTmpStore();
  const calls = [];
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl({ calls }) });
  try {
    await layer.mount("alpha", SOURCE);
    const result = await layer.mount("alpha", SOURCE + "\n// v2");
    assert.equal(result.ok, true);
    assert.equal(result.rev, 2);
    assert.equal(result.seq, 2);
    assert.ok(calls[1].includes("?v=2"), `second importUrl should carry ?v=2, got: ${calls[1]}`);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("unmount disposes the fiber and sets enabled=false", async () => {
  const storeDir = await makeTmpStore();
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl() });
  try {
    await layer.mount("alpha", SOURCE);
    const fiber = layer.fibers.get("alpha");
    const result = await layer.unmount("alpha");
    assert.equal(result.ok, true);
    assert.equal(result.enabled, false);
    assert.equal(fiber.disposeCount(), 1);
    const manifest = await readManifest(storeDir, "alpha");
    assert.equal(manifest.enabled, false);
    assert.equal(manifest.rev, 1);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("unmount of unknown entry returns ok:false", async () => {
  const storeDir = await makeTmpStore();
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl() });
  try {
    const result = await layer.unmount("ghost");
    assert.equal(result.ok, false);
    assert.match(result.error, /未找到受管条目/);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("replace success: old fiber disposed, new fiber mounted, rev bumped", async () => {
  const storeDir = await makeTmpStore();
  const calls = [];
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl({ calls }) });
  try {
    await layer.mount("alpha", SOURCE);
    const oldFiber = layer.fibers.get("alpha");
    const result = await layer.replace("alpha", SOURCE + "\n// replaced");
    assert.equal(result.ok, true);
    assert.equal(result.rev, 2);
    assert.equal(oldFiber.disposeCount(), 1);
    assert.equal(calls.length, 2);
    const manifest = await readManifest(storeDir, "alpha");
    assert.equal(manifest.enabled, true);
    assert.equal(manifest.rev, 2);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("replace failure keeps the old manifest untouched", async () => {
  const storeDir = await makeTmpStore();
  let mountCount = 0;
  const impl = async (importUrl) => {
    mountCount += 1;
    if (mountCount > 1) {
      const err = new Error("boot-crash fixture: intentional boot failure");
      err.stack = "Error: boom\n    at file:///store/managed/alpha/index.mjs:9:5";
      throw err;
    }
    return { dispose: async () => {} };
  };
  const layer = new ManagedLayer({ storeDir, mountImpl: impl });
  try {
    await layer.mount("alpha", SOURCE);
    const result = await layer.replace("alpha", "export const boom = 1;");
    assert.equal(result.ok, false);
    assert.equal(result.line, 9);
    // Contract: old manifest is kept (enabled: true, rev 1).
    const manifest = await readManifest(storeDir, "alpha");
    assert.equal(manifest.enabled, true);
    assert.equal(manifest.rev, 1);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("autoRestore: remounts enabled entries, skips disabled, records mountErrors without blocking", async () => {
  const storeDir = await makeTmpStore();
  const failFor = new Set();
  const calls = [];
  const first = new ManagedLayer({ storeDir, mountImpl: makeMountImpl({ calls, failFor }) });
  try {
    await first.mount("good", SOURCE);
    await first.mount("broken", SOURCE);
    await first.mount("paused", SOURCE);
    await first.unmount("paused");

    // Corrupt the broken entry's source, then simulate a fresh process with a
    // new layer instance whose mountImpl rejects "broken".
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(storeDir, "broken", "index.mjs"), "export const oops = ;");

    const callsBefore = calls.length;
    failFor.add("broken");
    const second = new ManagedLayer({ storeDir, mountImpl: makeMountImpl({ calls, failFor }) });
    const results = await second.autoRestore();

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(byName.good.ok, true);
    assert.equal(byName.broken.ok, false);
    assert.match(byName.broken.error, /intentional boot failure/);
    // Disabled entry must not be remounted.
    assert.equal("paused" in byName, false);
    // Only two mount calls happened (good + broken), paused skipped.
    assert.equal(calls.length - callsBefore, 2);

    // Failure recorded on the manifest without disabling the entry.
    const brokenManifest = await readManifest(storeDir, "broken");
    assert.equal(brokenManifest.enabled, true);
    assert.equal(brokenManifest.mountErrors.length, 1);
    assert.match(brokenManifest.mountErrors[0].error, /intentional boot failure/);

    const list = await second.list();
    const brokenItem = list.find((item) => item.name === "broken");
    assert.equal(brokenItem.enabled, true);
    assert.equal(brokenItem.mountErrors.length, 1);
    const goodItem = list.find((item) => item.name === "good");
    assert.deepEqual(goodItem.mountErrors, []);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("autoRestore on an empty/nonexistent store returns []", async () => {
  const storeDir = await makeTmpStore();
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl() });
  try {
    const results = await layer.autoRestore();
    assert.deepEqual(results, []);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("list returns name/rev/enabled/mountErrors sorted by name", async () => {
  const storeDir = await makeTmpStore();
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl() });
  try {
    await layer.mount("zeta", SOURCE);
    await layer.mount("alpha", SOURCE);
    const list = await layer.list();
    assert.deepEqual(
      list.map((item) => item.name),
      ["alpha", "zeta"]
    );
    assert.equal(list[0].rev, 1);
    assert.equal(list[0].enabled, true);
    assert.deepEqual(list[0].mountErrors, []);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("mount rejects unsafe entry names", async () => {
  const storeDir = await makeTmpStore();
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl() });
  try {
    for (const bad of ["../evil", "a/b", "a\\b", ".", "..", "a b"]) {
      const result = await layer.mount(bad, SOURCE);
      assert.equal(result.ok, false, `name ${bad} should be rejected`);
    }
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("mount rejects empty source", async () => {
  const storeDir = await makeTmpStore();
  const layer = new ManagedLayer({ storeDir, mountImpl: makeMountImpl() });
  try {
    const result = await layer.mount("alpha", "   ");
    assert.equal(result.ok, false);
    assert.match(result.error, /source/);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("default storeDir is <stateRoot>/managed and DSH_PKG_HOME overrides it", async () => {
  const tmp = await makeTmpStore();
  const saved = process.env.DSH_PKG_HOME;
  try {
    process.env.DSH_PKG_HOME = tmp;
    const layer = new ManagedLayer({ mountImpl: makeMountImpl() });
    assert.equal(layer.storeDir, join(tmp, "managed"));
  } finally {
    if (saved === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = saved;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("constructor requires mountImpl", () => {
  assert.throws(() => new ManagedLayer({}), /mountImpl/);
});
