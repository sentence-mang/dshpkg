// dshpkg — recipe spec unit tests.
// Pure functions only: no IO, no profile access, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECIPE_SCHEMA,
  validateRecipe,
  recipeFromPackageJson,
  matchesHarnessRange,
} from "../lib/recipe.js";

// ---------- validateRecipe ----------

const validRecipe = {
  name: "boot-guard",
  kind: "bundle",
  source: { type: "npm", spec: "dshpkg-fixture-boot-guard" },
  deps: ["helper-a"],
  harnessRange: ">=0.1.0",
  pin: { allow: true },
  verify: { level: 2, label: "community", risk: "low" },
  patchLines: ["- id: boot-guard", "  disabled: false"],
};

test("validateRecipe accepts a fully valid recipe", () => {
  const result = validateRecipe(validRecipe);
  assert.equal(result.ok, true);
  assert.equal(result.value.name, "boot-guard");
  assert.equal(result.value.kind, "bundle");
  assert.deepEqual(result.value.source, { type: "npm", spec: "dshpkg-fixture-boot-guard" });
  assert.deepEqual(result.value.deps, ["helper-a"]);
  assert.equal(result.value.pin.allow, true);
  assert.equal(result.value.verify.level, 2);
  assert.equal(result.value.patchLines.length, 2);
});

test("validateRecipe rejects a missing name (Chinese error)", () => {
  const result = validateRecipe({ kind: "bundle" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("name")), JSON.stringify(result.errors));
});

test("validateRecipe rejects a non-string name", () => {
  const result = validateRecipe({ name: 42 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("name")));
});

test("validateRecipe rejects a blank name", () => {
  const result = validateRecipe({ name: "   " });
  assert.equal(result.ok, false);
});

test("validateRecipe rejects a non-object / null / array input", () => {
  for (const bad of [null, undefined, "x", 42, []]) {
    const result = validateRecipe(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("对象")), String(bad));
  }
});

test("validateRecipe rejects an unknown kind", () => {
  const result = validateRecipe({ name: "x", kind: "banana" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("kind")));
});

test("validateRecipe defaults kind to host-only", () => {
  const result = validateRecipe({ name: "x" });
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "host-only");
});

test("validateRecipe accepts every kind in the enum", () => {
  for (const kind of RECIPE_SCHEMA.kind.values) {
    const result = validateRecipe({ name: "x", kind });
    assert.equal(result.ok, true, `kind ${kind} should be valid`);
  }
});

test("validateRecipe rejects a bad source.type", () => {
  const result = validateRecipe({ name: "x", source: { type: "ftp", spec: "a" } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("source.type")));
});

test("validateRecipe rejects a missing/blank source.spec", () => {
  const result = validateRecipe({ name: "x", source: { type: "npm", spec: "" } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("source.spec")));
});

test("validateRecipe rejects a non-object source", () => {
  const result = validateRecipe({ name: "x", source: "npm" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("source")));
});

test("validateRecipe rejects non-array deps", () => {
  const result = validateRecipe({ name: "x", deps: "helper" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("deps")));
});

test("validateRecipe rejects deps with non-string items", () => {
  const result = validateRecipe({ name: "x", deps: ["ok", 7] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("deps")));
});

test("validateRecipe rejects a non-string harnessRange", () => {
  const result = validateRecipe({ name: "x", harnessRange: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("harnessRange")));
});

test("validateRecipe rejects pin with non-boolean allow", () => {
  const result = validateRecipe({ name: "x", pin: { allow: "yes" } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("pin.allow")));
});

test("validateRecipe rejects a non-object pin", () => {
  const result = validateRecipe({ name: "x", pin: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("pin")));
});

test("validateRecipe rejects a bad verify block", () => {
  const result = validateRecipe({
    name: "x",
    verify: { level: "high", label: 1, risk: true },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("verify.level")));
  assert.ok(result.errors.some((e) => e.includes("verify.label")));
  assert.ok(result.errors.some((e) => e.includes("verify.risk")));
});

test("validateRecipe rejects a missing verify.level", () => {
  const result = validateRecipe({ name: "x", verify: { label: "l", risk: "r" } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("verify.level")));
});

test("validateRecipe rejects patchLines with non-string items", () => {
  const result = validateRecipe({ name: "x", patchLines: ["ok", null] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("patchLines")));
});

test("validateRecipe accumulates multiple errors", () => {
  const result = validateRecipe({ name: 1, kind: "banana", deps: "x" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3, JSON.stringify(result.errors));
});

// ---------- build field (AUR-style build()/package() equivalent) ----------

test("validateRecipe accepts a build block with commands and cwd", () => {
  const result = validateRecipe({
    name: "x",
    build: { commands: ["npm run build", "node ./scripts/post.js"], cwd: "packages/core" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.build, {
    commands: ["npm run build", "node ./scripts/post.js"],
    cwd: "packages/core",
  });
});

test("validateRecipe accepts a build block without cwd", () => {
  const result = validateRecipe({ name: "x", build: { commands: ["make"] } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.build, { commands: ["make"] });
});

test("validateRecipe leaves the build field undefined when omitted (backwards compatible)", () => {
  const result = validateRecipe({ name: "x" });
  assert.equal(result.ok, true);
  assert.equal(result.value.build, undefined);
});

test("validateRecipe rejects a non-object build block", () => {
  for (const bad of ["make", 42, ["make"], true]) {
    const result = validateRecipe({ name: "x", build: bad });
    assert.equal(result.ok, false, String(bad));
    assert.ok(result.errors.some((e) => e.includes("build")), JSON.stringify(result.errors));
  }
});

test("validateRecipe rejects build.commands that is not a string array", () => {
  const noCommands = validateRecipe({ name: "x", build: {} });
  assert.equal(noCommands.ok, false);
  assert.ok(noCommands.errors.some((e) => e.includes("build.commands")));

  const badItems = validateRecipe({ name: "x", build: { commands: ["ok", 7] } });
  assert.equal(badItems.ok, false);
  assert.ok(badItems.errors.some((e) => e.includes("build.commands")));
});

test("validateRecipe rejects a non-string build.cwd", () => {
  const result = validateRecipe({ name: "x", build: { commands: ["make"], cwd: 3 } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("build.cwd")));
});

test("validateRecipe fills defaults for omitted optional fields", () => {
  const result = validateRecipe({ name: "x" });
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "host-only");
  assert.deepEqual(result.value.deps, []);
  assert.equal(result.value.harnessRange, "*");
  assert.deepEqual(result.value.pin, { allow: false });
  assert.deepEqual(result.value.patchLines, []);
});

test("validateRecipe keeps unknown extra fields (forward compatible)", () => {
  const result = validateRecipe({ name: "x", futureField: { anything: true } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.futureField, { anything: true });
});

// ---------- recipeFromPackageJson ----------

test("recipeFromPackageJson probes bundle kind when dsh.bundle.patch exists", () => {
  const manifest = {
    name: "boot-guard",
    version: "1.0.0",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  };
  const result = recipeFromPackageJson(manifest);
  assert.equal(result.ok, true);
  assert.equal(result.value.name, "boot-guard");
  assert.equal(result.value.kind, "bundle");
  assert.deepEqual(result.value.source, { type: "npm", spec: "boot-guard" });
});

test("recipeFromPackageJson probes host-only kind without dsh.bundle.patch", () => {
  const result = recipeFromPackageJson({ name: "plain-host" });
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "host-only");
  assert.equal(result.value.source.type, "npm");
  assert.equal(result.value.harnessRange, "*");
});

test("recipeFromPackageJson carries a manifest harnessRange when present", () => {
  const result = recipeFromPackageJson({ name: "x", dsh: { harnessRange: ">=0.1.0" } });
  assert.equal(result.ok, true);
  assert.equal(result.value.harnessRange, ">=0.1.0");
});

test("recipeFromPackageJson fails without a manifest name", () => {
  for (const bad of [{}, { version: "1.0.0" }, null, "not-an-object"]) {
    const result = recipeFromPackageJson(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});

// ---------- matchesHarnessRange ----------

test("matchesHarnessRange: empty range and wildcard match anything", () => {
  assert.equal(matchesHarnessRange("", "0.1.1-rc.2"), true);
  assert.equal(matchesHarnessRange("*", "9.9.9"), true);
  assert.equal(matchesHarnessRange(undefined, "1.0.0"), true);
  assert.equal(matchesHarnessRange(null, "1.0.0"), true);
});

test("matchesHarnessRange: exact version", () => {
  assert.equal(matchesHarnessRange("1.2.3", "1.2.3"), true);
  assert.equal(matchesHarnessRange("v1.2.3", "1.2.3"), true);
  assert.equal(matchesHarnessRange("1.2.3", "v1.2.3"), true);
  assert.equal(matchesHarnessRange("1.2.3", "1.2.4"), false);
  assert.equal(matchesHarnessRange("1.2.3", "1.3.3"), false);
  assert.equal(matchesHarnessRange("1.2.3", "2.2.3"), false);
});

test("matchesHarnessRange: caret ^x.y.z", () => {
  assert.equal(matchesHarnessRange("^1.2.3", "1.2.3"), true);
  assert.equal(matchesHarnessRange("^1.2.3", "1.9.0"), true);
  assert.equal(matchesHarnessRange("^1.2.3", "1.2.2"), false);
  assert.equal(matchesHarnessRange("^1.2.3", "2.0.0"), false);
  assert.equal(matchesHarnessRange("^0.1.0", "0.2.0"), true);
});

test("matchesHarnessRange: tilde ~x.y.z", () => {
  assert.equal(matchesHarnessRange("~1.2.3", "1.2.3"), true);
  assert.equal(matchesHarnessRange("~1.2.3", "1.2.9"), true);
  assert.equal(matchesHarnessRange("~1.2.3", "1.2.2"), false);
  assert.equal(matchesHarnessRange("~1.2.3", "1.3.0"), false);
  assert.equal(matchesHarnessRange("~1.2.3", "2.0.0"), false);
});

test("matchesHarnessRange: greater-or-equal >=x.y.z", () => {
  assert.equal(matchesHarnessRange(">=1.2.3", "1.2.3"), true);
  assert.equal(matchesHarnessRange(">=1.2.3", "2.0.0"), true);
  assert.equal(matchesHarnessRange(">=1.2.3", "1.2.2"), false);
  assert.equal(matchesHarnessRange(">=1.2.3", "1.1.9"), false);
});

test("matchesHarnessRange handles prerelease harness versions", () => {
  // rc ranks below the corresponding release
  assert.equal(matchesHarnessRange(">=0.1.0", "0.1.1-rc.2"), true);
  assert.equal(matchesHarnessRange(">=0.1.1", "0.1.1-rc.2"), false);
  assert.equal(matchesHarnessRange("0.1.1-rc.2", "0.1.1-rc.2"), true);
  assert.equal(matchesHarnessRange("0.1.1-rc.2", "0.1.1"), false);
  assert.equal(matchesHarnessRange("^0.1.0", "0.1.1-rc.2"), true);
});

test("matchesHarnessRange returns false for garbage", () => {
  assert.equal(matchesHarnessRange("banana", "1.2.3"), false);
  assert.equal(matchesHarnessRange("1.2.3", "not-a-version"), false);
  assert.equal(matchesHarnessRange("1.2", "1.2.3"), false);
  assert.equal(matchesHarnessRange("^^1.2.3", "1.2.3"), false);
});
