// dshpkg — recipe spec unit tests.
// Pure functions only: no IO, no profile access, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  RECIPE_SCHEMA,
  validateRecipe,
  recipeFromPackageJson,
  matchesHarnessRange,
  canonicalJson,
  parseMinisignPublicKey,
  verifyRecipeSig,
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

test("validateRecipe accepts optional metadata fields (R4)", () => {
  const result = validateRecipe({
    name: "meta-plugin",
    kind: "bundle",
    source: { type: "npm", spec: "meta-plugin" },
    description: "中文介绍",
    maintainer: "dev@example.com",
    homepage: "https://github.com/example/meta-plugin",
    license: "MIT",
    tags: ["markdown", "preview"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.description, "中文介绍");
  assert.equal(result.value.maintainer, "dev@example.com");
  assert.equal(result.value.homepage, "https://github.com/example/meta-plugin");
  assert.equal(result.value.license, "MIT");
  assert.deepEqual(result.value.tags, ["markdown", "preview"]);
});

test("validateRecipe defaults license/tags and rejects bad metadata", () => {
  // Old recipes without metadata still validate (backward compatible).
  const bare = validateRecipe({ name: "bare" });
  assert.equal(bare.ok, true);
  assert.equal(bare.value.license, "UNKNOWN");
  assert.deepEqual(bare.value.tags, []);

  // homepage must be http(s):// — no file:/javascript: into the render layer.
  const evil = validateRecipe({ name: "x", homepage: "javascript:alert(1)" });
  assert.equal(evil.ok, false);
  assert.ok(evil.errors.some((e) => e.includes("http")), JSON.stringify(evil.errors));
  const fileUrl = validateRecipe({ name: "x", homepage: "file:///etc/passwd" });
  assert.equal(fileUrl.ok, false);

  const badTags = validateRecipe({ name: "x", tags: ["ok", 3] });
  assert.equal(badTags.ok, false);
  assert.ok(badTags.errors.some((e) => e.includes("tags")));
  const badLicense = validateRecipe({ name: "x", license: 42 });
  assert.equal(badLicense.ok, false);
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

// ---------- signing (P3-1, signing.md) ----------

test("canonicalJson is deterministic: sorted keys, no whitespace, nested", () => {
  const a = { z: 1, a: { y: 2, b: [3, { d: 4, c: 5 }] }, m: null };
  const b = { a: { b: [3, { c: 5, d: 4 }], y: 2 }, m: null, z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"b":[3,{"c":5,"d":4}],"y":2},"m":null,"z":1}');
  // UTF-8 without BOM: the bytes start with the JSON itself ("{")
  assert.equal(Buffer.from(canonicalJson(a), "utf8")[0], 0x7b);
});

/** Build a minisign-format public key blob ("Ed" + keyId + raw key). */
function minisignPubKeyBlob(keyIdHex, rawPub) {
  return Buffer.concat([
    Buffer.from([0x45, 0x64]),
    Buffer.from(keyIdHex, "hex"),
    rawPub,
  ]).toString("base64");
}

test("parseMinisignPublicKey parses the 42-byte layout and rejects garbage", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  // First key-id byte 0x4a (0x40-0x7f) yields the well-known "RWR" prefix.
  const keyId = "4a1b2c3d4e5f6071";
  const b64 = minisignPubKeyBlob(keyId, raw);
  // the well-known "RWR" base64 prefix (algo bytes 0x45 0x64)
  assert.equal(b64.slice(0, 3), "RWR");
  const parsed = parseMinisignPublicKey(
    `untrusted comment: minisign public key ${keyId}\n${b64}`,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.keyId, keyId);
  assert.equal(parsed.pubKey.length, 32);

  // wrong length / wrong algo / no base64 line
  assert.equal(parseMinisignPublicKey("short").ok, false);
  assert.equal(parseMinisignPublicKey(Buffer.alloc(42).toString("base64")).ok, false);
  assert.equal(parseMinisignPublicKey("untrusted comment: only a comment").ok, false);
});

test("verifyRecipeSig accepts a valid minisign signature and rejects tampering", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = "0102030405060708";
  const recipe = {
    name: "signed-plugin",
    kind: "bundle",
    source: { type: "npm", spec: "signed-plugin" },
    verify: { level: 3, label: "已验证", risk: "low" },
  };
  const data = Buffer.from(canonicalJson(recipe), "utf8");
  const sig = sign(null, data, privateKey);
  const blob = Buffer.concat([
    Buffer.from([0x45, 0x64]),
    Buffer.from(keyId, "hex"),
    sig,
  ]).toString("base64");
  const signed = {
    ...recipe,
    signatures: { minisign: { keyId, algo: "ed25519", signature: blob } },
  };

  // key known -> valid
  assert.deepEqual(await verifyRecipeSig(signed, { publicKeyOf: async () => rawPub }), {
    status: "valid",
    keyId,
    error: null,
  });
  // key unknown -> key-missing (never auto-trusted)
  assert.equal((await verifyRecipeSig(signed, { publicKeyOf: async () => null })).status, "key-missing");
  // tampered payload -> invalid (fail-closed)
  const tampered = await verifyRecipeSig(
    { ...signed, name: "evil-plugin" },
    { publicKeyOf: async () => rawPub },
  );
  assert.equal(tampered.status, "invalid");
  // no signatures -> unsigned
  assert.equal((await verifyRecipeSig(recipe, { publicKeyOf: async () => rawPub })).status, "unsigned");
  // raw 64-byte signature form (ed25519-raw) with explicit keyId
  const rawForm = {
    ...signed,
    signatures: {
      minisign: { keyId, algo: "ed25519-raw", signature: sig.toString("base64") },
    },
  };
  assert.equal((await verifyRecipeSig(rawForm, { publicKeyOf: async () => rawPub })).status, "valid");
  // garbage signature value -> invalid
  assert.equal(
    (await verifyRecipeSig(
      { ...signed, signatures: { minisign: { keyId, signature: "garbage" } } },
      { publicKeyOf: async () => rawPub },
    )).status,
    "invalid",
  );
});

test("validateRecipe accepts signatures and rejects malformed ones", () => {
  const ok = validateRecipe({
    name: "signed",
    signatures: {
      minisign: { keyId: "0102", algo: "ed25519", signature: "RWT..." },
      ssh: { keyId: "sha256:xxx" }, // schema-reserved for phase two
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(validateRecipe({ name: "x", signatures: "nope" }).ok, false);
  assert.equal(validateRecipe({ name: "x", signatures: { minisign: {} } }).ok, false);
  assert.equal(validateRecipe({ name: "x", signatures: { minisign: { keyId: "k", algo: "pgp" } } }).ok, false);
});

// ---------- golden-vector cross-check (independent second implementation) ----

/**
 * Independent re-implementation of the minisign byte layout (per the public
 * spec: "Ed" algo bytes, 8-byte key id, 32-byte key / 64-byte signature),
 * written directly against raw offsets — deliberately NOT reusing the parse
 * functions under test. Both implementations must agree on every vector, so
 * a layout mistake in either one is caught.
 */
function independentLayout(b64) {
  const raw = Buffer.from(b64, "base64");
  return {
    length: raw.length,
    algo: [raw[0], raw[1]],
    keyId: raw.subarray(2, 10).toString("hex"),
    tail: raw.subarray(10),
  };
}

test("minisign layout cross-check: parse functions agree with an independent byte-offset implementation", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = "5e1d2c3b4a596877";
  const recipe = { name: "x", kind: "bundle", source: { type: "npm", spec: "x" } };
  const data = Buffer.from(canonicalJson(recipe), "utf8");
  const sig = sign(null, data, privateKey);

  // public key blob: 42 bytes, "Ed" + keyId + 32-byte key
  const pubB64 = Buffer.concat([
    Buffer.from([0x45, 0x64]),
    Buffer.from(keyId, "hex"),
    rawPub,
  ]).toString("base64");
  const pub = independentLayout(pubB64);
  assert.equal(pub.length, 42);
  assert.deepEqual(pub.algo, [0x45, 0x64]);
  assert.equal(pub.keyId, keyId);
  assert.equal(pub.tail.length, 32);
  assert.ok(pub.tail.equals(rawPub));

  // the parse function extracts the same fields
  const parsed = parseMinisignPublicKey(pubB64);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.keyId, pub.keyId);
  assert.ok(parsed.pubKey.equals(pub.tail));

  // signature blob: 74 bytes, "Ed" + keyId + 64-byte signature
  const sigB64 = Buffer.concat([
    Buffer.from([0x45, 0x64]),
    Buffer.from(keyId, "hex"),
    sig,
  ]).toString("base64");
  const sigLayout = independentLayout(sigB64);
  assert.equal(sigLayout.length, 74);
  assert.deepEqual(sigLayout.algo, [0x45, 0x64]);
  assert.equal(sigLayout.keyId, keyId);
  assert.equal(sigLayout.tail.length, 64);
  assert.ok(sigLayout.tail.equals(sig));

  // end-to-end: the verified keyId/signature pair from the independent layout
  // verifies through verifyRecipeSig with the independently parsed pubkey
  const signed = {
    ...recipe,
    signatures: {
      minisign: { keyId: sigLayout.keyId, algo: "ed25519", signature: sigB64 },
    },
  };
  const verdict = await verifyRecipeSig(signed, { publicKeyOf: async () => pub.tail });
  assert.equal(verdict.status, "valid");
  // a one-byte tamper in the signature tail must flip the verdict
  const flipped = Buffer.from(sigB64, "base64");
  flipped[10] ^= 0xff;
  const tampered = {
    ...signed,
    signatures: {
      minisign: { keyId: sigLayout.keyId, signature: flipped.toString("base64") },
    },
  };
  assert.equal(
    (await verifyRecipeSig(tampered, { publicKeyOf: async () => pub.tail })).status,
    "invalid",
  );
});

// ---------- real-minisign golden vectors (minisign 0.12, Windows) ------------

// Generated with the REAL minisign 0.12 tool (jedisct1/minisign win64):
//   minisign -G -s sec.key -p pub.key -W
//   minisign -S -s sec.key -m recipe.json            (default: prehash, "ED")
//   minisign -S -l -s sec.key -m recipe.json         (legacy format, "Ed")
// recipe.json bytes == canonicalJson(GOLDEN_RECIPE), UTF-8 without BOM.
const GOLDEN_RECIPE = {
  name: "golden-plugin",
  kind: "bundle",
  source: { type: "npm", spec: "golden-plugin" },
  description: "真实 minisign 工具生成的 golden vector 配方",
  verify: { level: 3, label: "已验证", risk: "low" },
  license: "MIT",
  tags: ["golden", "vector"],
};
const GOLDEN_PUBKEY = "RWTg2FLSfns237NE1zsjG/uCiS9raRHxHALJ7VpaA8aBKUQNkUjoqTmR";
const GOLDEN_KEY_ID = "e0d852d27e7b36df";
const GOLDEN_SIG_LEGACY =
  "RWTg2FLSfns237Xw1AFoUHxS0AcKht9G7gayi01AW8WugALZaHIF8awN5xlZx5YB1EWvuZr7bUMBnBEFG5jVjQvJCQL2rrmOgAE=";
const GOLDEN_SIG_PREHASH =
  "RUTg2FLSfns23+pNrfpWNOY5Jf3BESkL/yp1g+gZllWXO5ldR/RNSbgQtexMyOLQ/1qN5enCNYA6DiaIDkFQFy+PngEa+z7P3AE=";

test("golden vector: real minisign legacy signature verifies (Ed, raw bytes)", async () => {
  const pub = parseMinisignPublicKey(GOLDEN_PUBKEY);
  assert.equal(pub.ok, true);
  assert.equal(pub.keyId, GOLDEN_KEY_ID);
  const signed = {
    ...GOLDEN_RECIPE,
    signatures: { minisign: { keyId: pub.keyId, signature: GOLDEN_SIG_LEGACY } },
  };
  const verdict = await verifyRecipeSig(signed, { publicKeyOf: async () => pub.pubKey });
  assert.equal(verdict.status, "valid", verdict.error ?? "");
});

test("golden vector: real minisign prehash signature verifies (ED, BLAKE2b-512)", async () => {
  const pub = parseMinisignPublicKey(GOLDEN_PUBKEY);
  const signed = {
    ...GOLDEN_RECIPE,
    signatures: { minisign: { keyId: pub.keyId, signature: GOLDEN_SIG_PREHASH } },
  };
  const verdict = await verifyRecipeSig(signed, { publicKeyOf: async () => pub.pubKey });
  assert.equal(verdict.status, "valid", verdict.error ?? "");
  // tampering the payload flips both formats to invalid (fail-closed)
  const tampered = { ...signed, name: "evil" };
  assert.equal(
    (await verifyRecipeSig(tampered, { publicKeyOf: async () => pub.pubKey })).status,
    "invalid",
  );
});
