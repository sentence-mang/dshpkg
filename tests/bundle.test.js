// Tests for lib/bundle.js — read-only DSH profile bundle introspection.
// Every test uses a synthetic temp profile dir; the real ~/.dsh/profiles is
// never touched. The default (no dir) must stay disabled: empty results.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfileBundles, isBundle } from "../lib/bundle.js";

async function makeProfile(manifest) {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-bundle-"));
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

test("readProfileBundles: disabled when no profile dir given", async () => {
  const r = await readProfileBundles(undefined);
  assert.deepEqual(r, { bundles: [], deps: [] });
  const r2 = await readProfileBundles("");
  assert.deepEqual(r2, { bundles: [], deps: [] });
});

test("readProfileBundles: missing/invalid dir yields empty result", async () => {
  const r = await readProfileBundles(join(tmpdir(), "dshpkg-no-such-dir-xyz"));
  assert.deepEqual(r, { bundles: [], deps: [] });
  const bad = await mkdtemp(join(tmpdir(), "dshpkg-bundle-bad-"));
  await writeFile(join(bad, "package.json"), "not json{{", "utf8");
  const r2 = await readProfileBundles(bad);
  assert.deepEqual(r2, { bundles: [], deps: [] });
});

test("readProfileBundles: splits bundles and deps, dedupes, sorts", async () => {
  const dir = await makeProfile({
    name: "dsh-profile-x",
    dependencies: {
      "dsh-b": "^1.0.0",
      "dsh-a": "workspace:*",
      zod: "~3.24.3",
    },
    dsh: {
      profile: {
        bundles: ["dsh-b", "dsh-base", "dsh-a"],
      },
    },
  });
  const r = await readProfileBundles(dir);
  assert.deepEqual(r.bundles, ["dsh-a", "dsh-b", "dsh-base"]);
  assert.deepEqual(r.deps, ["dsh-a", "dsh-b", "zod"]);
});

test("readProfileBundles: manifest without dsh.profile.bundles", async () => {
  const dir = await makeProfile({ dependencies: { a: "^1" } });
  const r = await readProfileBundles(dir);
  assert.deepEqual(r.bundles, []);
  assert.deepEqual(r.deps, ["a"]);
});

test("readProfileBundles: null dependencies tolerated", async () => {
  const dir = await makeProfile({ name: "x" });
  const r = await readProfileBundles(dir);
  assert.deepEqual(r, { bundles: [], deps: [] });
});

test("isBundle: true for declared bundle, false otherwise/disabled", async () => {
  const dir = await makeProfile({
    dsh: { profile: { bundles: ["dsh-a", "dsh-b"] } },
  });
  assert.equal(await isBundle(dir, "dsh-a"), true);
  assert.equal(await isBundle(dir, "dsh-c"), false);
  assert.equal(await isBundle(dir, ""), false);
  assert.equal(await isBundle(undefined, "dsh-a"), false);
  await rm(dir, { recursive: true, force: true });
});
