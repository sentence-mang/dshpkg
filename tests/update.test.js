// Tests for lib/update.js — pure update detection (no IO, no network).
// bareVersion / isUpdateAvailable / checkUpdates are all pure functions, so
// these are plain table-driven assertions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bareVersion, isUpdateAvailable, checkUpdates, mergeInstalledFromDeps } from "../lib/update.js";

test("bareVersion: extracts a bare semver from common spec forms", () => {
  assert.equal(bareVersion("1.2.3"), "1.2.3");
  assert.equal(bareVersion("v1.2.3"), "1.2.3");
  assert.equal(bareVersion("0.1.1-rc.2"), "0.1.1-rc.2");
  assert.equal(bareVersion("npm:other-pkg@1.2.3"), "1.2.3");
});

test("bareVersion: ranges / git / workspace / link are uncomparable (null)", () => {
  assert.equal(bareVersion("^1.2.3"), null);
  assert.equal(bareVersion("~1.2.3"), null);
  assert.equal(bareVersion(">=1.2.3"), null);
  assert.equal(bareVersion("workspace:*"), null);
  assert.equal(bareVersion("link:C:/x/y"), null);
  assert.equal(bareVersion("github:user/repo"), null);
  assert.equal(bareVersion(""), null);
  assert.equal(bareVersion(null), null);
  assert.equal(bareVersion(undefined), null);
});

test("isUpdateAvailable: strictly behind only", () => {
  assert.equal(isUpdateAvailable("1.0.0", "1.0.1"), true);
  assert.equal(isUpdateAvailable("1.0.0", "1.0.0"), false);
  assert.equal(isUpdateAvailable("1.0.1", "1.0.0"), false);
  assert.equal(isUpdateAvailable("0.1.0-rc.1", "0.1.0"), true); // release > prerelease
  assert.equal(isUpdateAvailable(null, "1.0.0"), false); // unknown current → not flagged
  assert.equal(isUpdateAvailable("1.0.0", null), false);
  assert.equal(isUpdateAvailable("^1.0.0", "1.2.0"), false); // range uncomparable
});

test("checkUpdates: flags only known, strictly-behind packages", () => {
  const installed = {
    a: { version: "1.0.0" },
    b: { version: "2.0.0" },
    c: { version: null }, // installed but unknown version
    d: { version: "1.0.0", held: true },
    e: { version: "1.0.0" }, // not in latest table → skipped
  };
  const latestByName = { a: "1.1.0", b: "2.0.0", c: "1.0.0", d: "1.5.0" };
  const rows = checkUpdates(installed, latestByName);
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ["a", "b", "c", "d"]); // e skipped
  const a = rows.find((r) => r.name === "a");
  assert.equal(a.updateable, true);
  assert.equal(a.current, "1.0.0");
  assert.equal(a.latest, "1.1.0");
  const b = rows.find((r) => r.name === "b");
  assert.equal(b.updateable, false);
  const d = rows.find((r) => r.name === "d");
  assert.equal(d.updateable, true);
  assert.equal(d.held, true);
});

test("checkUpdates: empty/absent inputs", () => {
  assert.deepEqual(checkUpdates(null, {}), []);
  assert.deepEqual(checkUpdates({}, { a: "1.0.0" }), []);
  assert.deepEqual(checkUpdates({ a: { version: "1.0.0" } }, null), []);
});

test("mergeInstalledFromDeps: backfills unknown deps without clobbering records", () => {
  const installed = { a: { version: "1.0.0" } };
  const merged = mergeInstalledFromDeps(installed, ["a", "b", "c"]);
  // existing record preserved verbatim
  assert.equal(merged.a.version, "1.0.0");
  // new deps gain {version: null}
  assert.deepEqual(merged.b, { version: null });
  assert.deepEqual(merged.c, { version: null });
  // input not mutated (pure)
  assert.deepEqual(installed, { a: { version: "1.0.0" } });
});

test("mergeInstalledFromDeps: tolerates missing/absent inputs", () => {
  assert.deepEqual(mergeInstalledFromDeps(null, ["a"]), { a: { version: null } });
  assert.deepEqual(mergeInstalledFromDeps({}, null), {});
  assert.deepEqual(mergeInstalledFromDeps({ a: { version: "1.0.0" } }, undefined), {
    a: { version: "1.0.0" },
  });
  // empty / non-string dep names are skipped
  assert.deepEqual(mergeInstalledFromDeps({}, ["a", "", 42, null]), {
    a: { version: null },
  });
});
