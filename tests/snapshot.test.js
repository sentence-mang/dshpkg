// Tests for lib/snapshot.js (module G).
// All snapshot state lands in temp dirs via DSH_PKG_HOME; profile dirs are
// temp dirs too. Real profiles and the real ~/.dsh/dshpkg state are never
// touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSnapshot, restoreSnapshot, listSnapshots } from "../lib/snapshot.js";

const PKG = JSON.stringify({ name: "web-profile", version: "1.0.0", dsh: { profile: true }, dependencies: { "dsh-plugin-x": "1.0.0" } });
const PATCH = "- id: dsh-plugin-x\n  disabled: false\n";
const LOCK = "lockfileVersion: '9.0'\n";

/** Fresh temp profile dir with the given files. */
async function makeProfile(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-snap-profile-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Point DSH_PKG_HOME at a fresh temp state root; restore it after the test. */
async function useStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "dshpkg-snap-state-"));
  process.env.DSH_PKG_HOME = root;
  t.after(() => {
    delete process.env.DSH_PKG_HOME;
  });
  return root;
}

test("saveSnapshot copies the three manifest files and returns a timestamp", async (t) => {
  const root = await useStateRoot(t);
  const profile = await makeProfile({ "package.json": PKG, "cordis.patch.yml": PATCH, "pnpm-lock.yaml": LOCK });

  const ts = await saveSnapshot(profile);
  // sanitized ISO: colons and dots become dashes (windows-safe dir name)
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);

  const snapDir = join(root, "snapshots", ts);
  assert.equal(await readFile(join(snapDir, "package.json"), "utf8"), PKG);
  assert.equal(await readFile(join(snapDir, "cordis.patch.yml"), "utf8"), PATCH);
  assert.equal(await readFile(join(snapDir, "pnpm-lock.yaml"), "utf8"), LOCK);

  // no staging tmp dir left behind
  const entries = await readdir(join(root, "snapshots"));
  assert.ok(entries.every((name) => !name.endsWith(".tmp")));
});

test("saveSnapshot keeps only the latest 5 and listSnapshots is newest-first", async (t) => {
  await useStateRoot(t);
  const profile = await makeProfile({ "package.json": PKG });

  const times = [];
  for (let i = 0; i < 7; i++) {
    times.push(await saveSnapshot(profile));
    await new Promise((resolve) => setTimeout(resolve, 5)); // ms-resolution timestamps must differ
  }

  const listed = await listSnapshots();
  assert.equal(listed.length, 5);
  assert.deepEqual(listed, [...times].reverse().slice(0, 5));
});

test("saveSnapshot tolerates missing optional files", async (t) => {
  const root = await useStateRoot(t);
  const profile = await makeProfile({ "package.json": PKG, "pnpm-lock.yaml": LOCK });

  const ts = await saveSnapshot(profile);
  const entries = await readdir(join(root, "snapshots", ts));
  assert.deepEqual(entries.sort(), ["package.json", "pnpm-lock.yaml"]);
});

test("saveSnapshot throws when package.json is missing", async (t) => {
  await useStateRoot(t);
  const profile = await makeProfile({}); // no package.json
  await assert.rejects(() => saveSnapshot(profile), /package\.json/);
});

test("restoreSnapshot copies all three files back into the profile", async (t) => {
  await useStateRoot(t);
  const profile = await makeProfile({ "package.json": PKG, "cordis.patch.yml": PATCH, "pnpm-lock.yaml": LOCK });
  const ts = await saveSnapshot(profile);

  // corrupt the profile afterwards
  await writeFile(join(profile, "package.json"), '{"name":"broken"}');
  await writeFile(join(profile, "cordis.patch.yml"), "broken\n");
  await writeFile(join(profile, "pnpm-lock.yaml"), "broken\n");

  const res = await restoreSnapshot(profile, ts);
  assert.deepEqual(res, { ok: true });
  assert.equal(await readFile(join(profile, "package.json"), "utf8"), PKG);
  assert.equal(await readFile(join(profile, "cordis.patch.yml"), "utf8"), PATCH);
  assert.equal(await readFile(join(profile, "pnpm-lock.yaml"), "utf8"), LOCK);
  // no staging tmp files left behind
  const entries = await readdir(profile);
  assert.ok(entries.every((name) => !name.includes(".restore-") || !name.endsWith(".tmp")));
});

test("restoreSnapshot accepts a raw ISO timestamp (colons/dots)", async (t) => {
  await useStateRoot(t);
  const profile = await makeProfile({ "package.json": PKG, "cordis.patch.yml": PATCH, "pnpm-lock.yaml": LOCK });
  const ts = await saveSnapshot(profile);

  // rebuild the raw ISO form from the sanitized dir name: T<HH>-<MM>-<ss>-<mmm> -> T<HH>:<MM>:<ss>.<mmm>
  const rawIso = ts.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
  assert.notEqual(rawIso, ts);
  const res = await restoreSnapshot(profile, rawIso);
  assert.deepEqual(res, { ok: true });
});

test("restoreSnapshot refuses an incomplete snapshot and leaves the profile untouched", async (t) => {
  const root = await useStateRoot(t);
  const profile = await makeProfile({ "package.json": PKG, "cordis.patch.yml": PATCH, "pnpm-lock.yaml": LOCK });
  const ts = await saveSnapshot(profile);

  await rm(join(root, "snapshots", ts, "pnpm-lock.yaml"));
  await writeFile(join(profile, "package.json"), "untouched");

  const res = await restoreSnapshot(profile, ts);
  assert.equal(res.ok, false);
  assert.match(res.error, /pnpm-lock\.yaml/);
  assert.equal(await readFile(join(profile, "package.json"), "utf8"), "untouched");
  assert.equal(await readFile(join(profile, "cordis.patch.yml"), "utf8"), PATCH);
});

test("restoreSnapshot fails cleanly for an unknown timestamp", async (t) => {
  await useStateRoot(t);
  const profile = await makeProfile({ "package.json": PKG });
  const res = await restoreSnapshot(profile, "1999-01-01T00-00-00-000Z");
  assert.equal(res.ok, false);
  assert.match(res.error, /缺少 package\.json/);
});

test("restoreSnapshot fails without writing when the profile is untouched by other means", async (t) => {
  // profile dir does not exist yet: a failed restore must not create it
  await useStateRoot(t);
  const missing = join(await mkdtemp(join(tmpdir(), "dshpkg-snap-nodir-")), "does-not-exist");
  const res = await restoreSnapshot(missing, "1999-01-01T00-00-00-000Z");
  assert.equal(res.ok, false);
  await assert.rejects(() => readdir(missing), /ENOENT/);
});

test("restoreSnapshot recreates a deleted profile directory", async (t) => {
  const root = await useStateRoot(t);
  const profile = await makeProfile({ "package.json": PKG, "cordis.patch.yml": PATCH, "pnpm-lock.yaml": LOCK });
  const ts = await saveSnapshot(profile);

  const rebuilt = join(profile, "rebuilt");
  const res = await restoreSnapshot(rebuilt, ts);
  assert.deepEqual(res, { ok: true });
  assert.equal(await readFile(join(rebuilt, "package.json"), "utf8"), PKG);
});
