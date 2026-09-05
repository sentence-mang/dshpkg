// dshpkg — unit tests for the performance optimization module (lib/perf.js).
// Uses node:test + node:assert and an isolated temp dir (fs.mkdtemp) for any
// filesystem work — it never touches a real profile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  measureCompose,
  scorePlugins,
  dirSize,
  cacheStats,
  mb,
} from "../lib/perf.js";

// --- measureCompose ----------------------------------------------------------

test("measureCompose: success returns ok, ms, status", async () => {
  let t = 0;
  const clock = () => {
    t += 10;
    return t;
  };
  const dshRun = (args) => {
    assert.deepEqual(args, ["--profile", "web", "--dump-config"]);
    return { status: 0, stdout: "{}", stderr: "" };
  };
  const r = await measureCompose("web", { dshRun, clock });
  assert.equal(r.ok, true);
  assert.equal(r.ms, 10);
  assert.equal(r.status, 0);
  assert.equal(r.error, null);
});

test("measureCompose: non-zero status sets ok=false and error", async () => {
  const dshRun = () => ({ status: 1, stdout: "", stderr: "boom" });
  const r = await measureCompose("web", { dshRun });
  assert.equal(r.ok, false);
  assert.equal(r.status, 1);
  assert.ok(r.error.includes("boom"));
});

test("measureCompose: thrown error becomes a failed result", async () => {
  const dshRun = () => {
    throw new Error("kaboom");
  };
  const r = await measureCompose("web", { dshRun });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.ok(r.error.includes("kaboom"));
});

test("measureCompose: error string truncated to 200 chars", async () => {
  const long = "x".repeat(500);
  const dshRun = () => ({ status: 2, stdout: "", stderr: long });
  const r = await measureCompose("web", { dshRun });
  assert.equal(r.ok, false);
  assert.equal(r.error.length, 200);
});

// --- scorePlugins ------------------------------------------------------------

function baseState(packages = {}) {
  return { packages };
}

test("scorePlugins: circuit-open +60", () => {
  const state = baseState({
    a: { circuitOpenAt: "2026-01-01T00:00:00Z" },
  });
  const [e] = scorePlugins(state);
  assert.equal(e.circuitOpen, true);
  assert.equal(e.score, 60);
  assert.ok(e.reasons.includes("电路熔断(circuit-open)"));
});

test("scorePlugins: crashCount 3 adds +15", () => {
  const state = baseState({ a: { crashCount: 3 } });
  const [e] = scorePlugins(state);
  assert.equal(e.crashCount, 3);
  assert.equal(e.score, 15);
  assert.ok(e.reasons.includes("崩溃 3 次"));
});

test("scorePlugins: crashCount capped at 10", () => {
  const state = baseState({ a: { crashCount: 99 } });
  const [e] = scorePlugins(state);
  assert.equal(e.score, 50);
});

test("scorePlugins: held flag is marked but adds no score", () => {
  const state = baseState({ a: { held: true } });
  const [e] = scorePlugins(state);
  assert.equal(e.held, true);
  assert.equal(e.score, 0);
});

test("scorePlugins: bytes >= 20MB adds +20, 5-20MB adds +5", () => {
  const state = baseState({ big: {}, mid: {} });
  const entries = scorePlugins(state, {
    sizes: { big: 21 * 1024 * 1024, mid: 6 * 1024 * 1024 },
  });
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName.big.score, 20);
  assert.ok(byName.big.reasons.includes("体积大(≥20MB)"));
  assert.equal(byName.mid.score, 5);
  assert.ok(byName.mid.reasons.includes("体积偏大(≥5MB)"));
});

test("scorePlugins: sizes absent -> bytes null, no score", () => {
  const state = baseState({ a: {} });
  const [e] = scorePlugins(state);
  assert.equal(e.bytes, null);
  assert.equal(e.score, 0);
});

test("scorePlugins: union includes sizes-only names with safe defaults", () => {
  const state = baseState({ a: { crashCount: 2 } });
  const entries = scorePlugins(state, { sizes: { b: 30 * 1024 * 1024 } });
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.ok(byName.a);
  assert.ok(byName.b);
  // b not in packages: no crash, no circuit, not held
  assert.equal(byName.b.crashCount, 0);
  assert.equal(byName.b.circuitOpen, false);
  assert.equal(byName.b.held, false);
  assert.equal(byName.b.bytes, 30 * 1024 * 1024);
});

test("scorePlugins: sorts by score desc, name asc on tie", () => {
  const state = baseState({
    x: { crashCount: 3 },
    y: { circuitOpenAt: "2026-01-01T00:00:00Z" },
    z: { crashCount: 3 },
  });
  const entries = scorePlugins(state);
  assert.equal(entries[0].name, "y"); // 60
  assert.equal(entries[1].name, "x"); // 15
  assert.equal(entries[2].name, "z"); // 15 (tie -> name asc)
  assert.equal(entries[1].score, entries[2].score);
  assert.ok(entries[1].name < entries[2].name);
});

// --- dirSize -----------------------------------------------------------------

test("dirSize: two plain files sum", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-perf-"));
  try {
    await writeFile(join(dir, "a.bin"), Buffer.alloc(10));
    await writeFile(join(dir, "b.bin"), Buffer.alloc(20));
    assert.equal(await dirSize(dir), 30);
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(dir, { recursive: true, force: true }),
    );
  }
});

test("dirSize: recurses into subdirectories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-perf-"));
  try {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "top.bin"), Buffer.alloc(5));
    await writeFile(join(dir, "sub", "inner.bin"), Buffer.alloc(25));
    assert.equal(await dirSize(dir), 30);
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(dir, { recursive: true, force: true }),
    );
  }
});

test("dirSize: does not follow symlinks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-perf-"));
  try {
    await writeFile(join(dir, "real.bin"), Buffer.alloc(40));
    await mkdir(join(dir, "linkdir"));
    await writeFile(join(dir, "linkdir", "target.bin"), Buffer.alloc(100));
    try {
      // Windows symlink creation may require privileges; skip on failure.
      await symlink(join(dir, "linkdir"), join(dir, "link"), "dir");
    } catch {
      t.skip("symlink not permitted on this platform");
      return;
    }
    // real.bin (40) counted; the link dir and its 100-byte file are NOT.
    assert.equal(await dirSize(dir), 40);
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(dir, { recursive: true, force: true }),
    );
  }
});

test("dirSize: missing path returns 0", async () => {
  assert.equal(await dirSize(join(tmpdir(), "no-such-dshpkg-dir-xyz")), 0);
});

// --- cacheStats --------------------------------------------------------------

test("cacheStats: sums all areas and excludes .tmp snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-perf-"));
  try {
    await mkdir(join(root, "snapshots", "snap-1"), { recursive: true });
    await writeFile(join(root, "snapshots", "snap-1", "a.json"), Buffer.alloc(10));
    await mkdir(join(root, "snapshots", "snap-2"), { recursive: true });
    await writeFile(join(root, "snapshots", "snap-2", "b.json"), Buffer.alloc(20));
    await mkdir(join(root, "snapshots", "tmp-abc.tmp"), { recursive: true });
    await writeFile(join(root, "snapshots", "tmp-abc.tmp", "c.json"), Buffer.alloc(999));

    await mkdir(join(root, "cache", "git"), { recursive: true });
    await writeFile(join(root, "cache", "git", "repo.bin"), Buffer.alloc(100));

    await mkdir(join(root, "managed"), { recursive: true });
    await writeFile(join(root, "managed", "pkg.bin"), Buffer.alloc(200));

    await mkdir(join(root, "index"), { recursive: true });
    await writeFile(join(root, "index", "idx.bin"), Buffer.alloc(300));

    const s = await cacheStats({ root });
    assert.equal(s.snapshotCount, 2); // .tmp dir excluded from the count
    // dirSize recurses into every directory (incl. .tmp), so its bytes count:
    // snapshotsBytes = 10 + 20 + 999 = 1029; only snapshotCount filters .tmp.
    assert.equal(s.snapshotsBytes, 1029);
    assert.equal(s.gitBytes, 100);
    assert.equal(s.managedBytes, 200);
    assert.equal(s.indexBytes, 300);
    assert.equal(s.totalBytes, 1029 + 100 + 200 + 300);
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    );
  }
});

// --- mb ----------------------------------------------------------------------

test("mb: formats bytes as MB with 1 decimal", () => {
  assert.equal(mb(0), 0);
  assert.equal(mb(1048576), 1.0);
  assert.equal(mb(1536), 0.0); // 0.00146 -> rounds to 0.0
  assert.equal(mb(2 * 1048576), 2.0);
  assert.equal(mb(1572864), 1.5);
});

test("mb: invalid input returns 0", () => {
  assert.equal(mb(NaN), 0);
  assert.equal(mb(-5), 0);
  assert.equal(mb(Infinity), 0);
  assert.equal(mb("1048576"), 0);
  assert.equal(mb(undefined), 0);
});
