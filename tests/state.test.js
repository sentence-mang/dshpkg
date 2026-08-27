// Tests for lib/state.js — profile path resolution hardening.
// Every test points DSH_HOME at a fresh temp dir so the real ~/.dsh/profiles
// is never touched; profile dirs are synthetic (a package.json that may or
// may not declare dsh.profile).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProfileDir,
  appendIncident,
  readIncidents,
  INCIDENTS_MAX,
  acquireSyncLock,
  releaseSyncLock,
  statePath,
  addTrustedKey,
  removeTrustedKey,
  readTrustedKeys,
  isKeyTrusted,
  resolvePublicKey,
  readState,
  acquireSupervisorLock,
  releaseSupervisorLock,
} from "../lib/state.js";
import { generateKeyPairSync } from "node:crypto";
import { readdir } from "node:fs/promises";

/** Point DSH_HOME at a fresh temp dir for one test; restore it afterwards. */
async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-state-home-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  });
  return home;
}

/** Materialise a profile dir under <home>/profiles/<name> with a manifest. */
async function seedProfile(home, name, manifest) {
  const dir = join(home, "profiles", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  return dir;
}

test("resolveProfileDir returns the dir for valid profile names (web / dshpkg-poc)", async (t) => {
  const home = await withHome(t);
  const web = await seedProfile(home, "web", { name: "web", dsh: { profile: true } });
  const poc = await seedProfile(home, "dshpkg-poc", { name: "dshpkg-poc", dsh: { profile: true } });
  assert.equal(await resolveProfileDir("web"), web);
  assert.equal(await resolveProfileDir("dshpkg-poc"), poc);
});

test("resolveProfileDir returns null for unsafe profile names", async (t) => {
  const home = await withHome(t);
  for (const bad of [
    "../etc",
    "a/b",
    "a\\b",
    ".hidden",
    "-flag",
    "a:b",
    "..",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(await resolveProfileDir(bad), null, String(bad));
  }
});

test("resolveProfileDir returns null for a non-profile dir or a missing/unparsable manifest", async (t) => {
  const home = await withHome(t);
  // valid name but no dsh.profile manifest
  await seedProfile(home, "plain", { name: "plain" });
  assert.equal(await resolveProfileDir("plain"), null);
  // missing directory
  assert.equal(await resolveProfileDir("ghost"), null);
  // unparsable manifest
  const broken = join(home, "profiles", "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "package.json"), "not json");
  assert.equal(await resolveProfileDir("broken"), null);
});

test("appendIncident rotates incidents.jsonl keeping the newest INCIDENTS_MAX", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-state-incidents-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });
  const total = INCIDENTS_MAX + 5;
  for (let i = 0; i < total; i += 1) {
    await appendIncident({ type: "test", i });
  }
  const incidents = await readIncidents(total);
  assert.equal(incidents.length, INCIDENTS_MAX);
  assert.equal(incidents[0].i, 5); // oldest five rotated away
  assert.equal(incidents[incidents.length - 1].i, total - 1);
});

test("sync lock is exclusive, releasable, and reclaims stale locks (P2-4)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-state-lock-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });

  assert.deepEqual(await acquireSyncLock(), { ok: true });
  // second acquisition is refused while the lock is held
  assert.deepEqual(await acquireSyncLock(), { ok: false, reason: "locked" });
  await releaseSyncLock();
  assert.deepEqual(await acquireSyncLock(), { ok: true });
  await releaseSyncLock();

  // a lock older than staleMs is presumed dead and reclaimed
  const now = Date.now();
  await writeFile(
    statePath("sync.lock"),
    JSON.stringify({ pid: 1, at: new Date(now - 60_000).toISOString() }),
    "utf8",
  );
  assert.deepEqual(await acquireSyncLock({ now, staleMs: 30_000 }), { ok: true });
  await releaseSyncLock();
});

test("trusted keys add/list/remove and resolve to raw keys (P3-1)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-state-keys-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });

  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = "0a0b0c0d0e0f1011";
  const b64 = Buffer.concat([
    Buffer.from([0x45, 0x64]),
    Buffer.from(keyId, "hex"),
    raw,
  ]).toString("base64");

  assert.equal(await isKeyTrusted(keyId), false);
  await addTrustedKey(keyId, "test key", b64);
  assert.equal(await isKeyTrusted(keyId), true);
  // idempotent add
  await addTrustedKey(keyId, "test key", b64);
  assert.equal((await readTrustedKeys()).keys.length, 1);
  // resolves back to the raw 32-byte key
  const resolved = await resolvePublicKey(keyId);
  assert.ok(resolved && resolved.equals(raw), "resolvePublicKey returns the raw key");
  // unknown keyId -> null
  assert.equal(await resolvePublicKey("ffffffffffffffff"), null);

  await removeTrustedKey(keyId);
  assert.equal(await isKeyTrusted(keyId), false);
  assert.equal((await readTrustedKeys()).keys.length, 0);
});

test("readState quarantines a corrupt state.json and records an incident (P4-3)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-state-corrupt-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });

  // missing file = first use -> defaults
  assert.deepEqual((await readState()).packages, {});

  // corrupt JSON -> quarantined + defaults rebuilt + incident recorded
  await writeFile(statePath("state.json"), "{not json", "utf8");
  const healed = await readState();
  assert.deepEqual(healed.packages, {});
  assert.equal(
    (await readIncidents()).some((i) => i.type === "state-corrupt"),
    true,
  );
  const dir = await readdir(root);
  assert.ok(
    dir.some((f) => f.startsWith("state.json.corrupt-")),
    `quarantine file expected, got: ${dir.join(",")}`,
  );

  // valid JSON but not an object -> defaults, no quarantine
  await writeFile(statePath("state.json"), "[1,2,3]", "utf8");
  assert.deepEqual((await readState()).packages, {});
});

test("supervisor lock is exclusive per state root (P4-3)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-state-sup-lock-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });

  assert.deepEqual(await acquireSupervisorLock(), { ok: true });
  assert.deepEqual(await acquireSupervisorLock(), { ok: false, reason: "locked" });
  await releaseSupervisorLock();
  assert.deepEqual(await acquireSupervisorLock(), { ok: true });
  await releaseSupervisorLock();
});
