// dshpkg — recipe spec (AUR-like declarative package recipes).
// A recipe describes where a package comes from (npm/git/path), how it
// integrates with the harness (bundle patch layer vs host-only), its
// dependency names, the harness version range it supports, and optional
// pin / verify policy plus extra cordis patch lines. Recipes may carry a
// minisign signature (signing.md, phase one) verified with node:crypto.
//
// Pure functions, zero dependencies: recipeFromPackageJson probes recipes
// from npm package manifests, matchesHarnessRange implements a tiny
// semver-style matcher so we never pull in the semver package.

import { createPublicKey, verify, createHash } from "node:crypto";

export const RECIPE_SCHEMA = {
  name: { type: "string", required: true, label: "name" },
  kind: {
    type: "enum",
    values: ["bundle", "host-only", "client", "skill", "preset"],
    default: "host-only",
    label: "kind",
  },
  source: {
    type: "object",
    label: "source",
    shape: {
      type: { type: "enum", values: ["npm", "git", "path"], label: "source.type" },
      spec: { type: "string", label: "source.spec" },
    },
  },
  deps: { type: "array", itemType: "string", default: [], label: "deps" },
  harnessRange: { type: "string", default: "*", label: "harnessRange" },
  pin: {
    type: "object",
    default: { allow: false },
    label: "pin",
    shape: {
      allow: { type: "boolean", label: "pin.allow" },
    },
  },
  verify: {
    type: "object",
    label: "verify",
    shape: {
      level: { type: "number", required: true, label: "verify.level" },
      label: { type: "string", required: true, label: "verify.label" },
      risk: { type: "string", required: true, label: "verify.risk" },
    },
  },
  patchLines: { type: "array", itemType: "string", default: [], label: "patchLines" },
  // Metadata (R4, design §1.2): free-form display fields, all optional.
  // homepage is restricted to http(s):// so no dangerous URL reaches the
  // rendering layer; license defaults to "UNKNOWN".
  description: { type: "string", label: "description" },
  maintainer: { type: "string", label: "maintainer" },
  homepage: { type: "string", label: "homepage" },
  license: { type: "string", default: "UNKNOWN", label: "license" },
  tags: { type: "array", itemType: "string", default: [], label: "tags" },
  build: {
    type: "object",
    label: "build",
    shape: {
      commands: { type: "array", itemType: "string", required: true, label: "build.commands" },
      cwd: { type: "string", label: "build.cwd" },
    },
  },
};

const KINDS = RECIPE_SCHEMA.kind.values;
const SOURCE_TYPES = RECIPE_SCHEMA.source.shape.type.values;

/**
 * Validate a recipe object. Unknown extra fields are kept (forward
 * compatible); missing optional fields get their defaults. Errors are
 * user-facing Chinese strings.
 *
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateRecipe(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["配方必须是对象"] };
  }
  const errors = [];
  const value = { ...obj };

  // name: required non-empty string
  if (typeof value.name !== "string" || value.name.trim() === "") {
    errors.push(value.name === undefined ? "缺少必填字段 name" : "name 必须是非空字符串");
  }

  // kind: enum, default host-only
  if (value.kind !== undefined) {
    if (typeof value.kind !== "string" || !KINDS.includes(value.kind)) {
      errors.push(`kind 必须是以下之一：${KINDS.join("、")}`);
    }
  } else {
    value.kind = "host-only";
  }

  // source: { type: npm|git|path, spec: non-empty string }
  if (value.source !== undefined) {
    const s = value.source;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      errors.push("source 必须是对象");
    } else {
      if (typeof s.type !== "string" || !SOURCE_TYPES.includes(s.type)) {
        errors.push(`source.type 必须是以下之一：${SOURCE_TYPES.join("、")}`);
      }
      if (typeof s.spec !== "string" || s.spec.trim() === "") {
        errors.push("source.spec 必须是非空字符串");
      }
    }
  }

  // deps: array of strings, default []
  if (value.deps !== undefined) {
    if (!Array.isArray(value.deps)) {
      errors.push("deps 必须是字符串数组");
    } else if (value.deps.some((dep) => typeof dep !== "string")) {
      errors.push("deps 的每一项必须是字符串");
    }
  } else {
    value.deps = [];
  }

  // harnessRange: string, default "*" (any)
  if (value.harnessRange !== undefined && typeof value.harnessRange !== "string") {
    errors.push("harnessRange 必须是字符串");
  } else if (value.harnessRange === undefined) {
    value.harnessRange = "*";
  }

  // pin: { allow: boolean }, default { allow: false }
  if (value.pin !== undefined) {
    const p = value.pin;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      errors.push("pin 必须是对象");
    } else if (typeof p.allow !== "boolean") {
      errors.push("pin.allow 必须是布尔值");
    }
  } else {
    value.pin = { allow: false };
  }

  // verify: { level: number, label: string, risk: string }
  if (value.verify !== undefined) {
    const v = value.verify;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      errors.push("verify 必须是对象");
    } else {
      if (typeof v.level !== "number") errors.push("verify.level 必须是数字");
      if (typeof v.label !== "string") errors.push("verify.label 必须是字符串");
      if (typeof v.risk !== "string") errors.push("verify.risk 必须是字符串");
    }
  }

  // patchLines: array of strings, default []
  if (value.patchLines !== undefined) {
    if (!Array.isArray(value.patchLines)) {
      errors.push("patchLines 必须是字符串数组");
    } else if (value.patchLines.some((line) => typeof line !== "string")) {
      errors.push("patchLines 的每一项必须是字符串");
    }
  } else {
    value.patchLines = [];
  }

  // build: optional AUR-style build()/package() equivalent
  // { commands: string[], cwd?: string }. Absent = rely on the package's own
  // prepare script (backwards compatible).
  if (value.build !== undefined) {
    const b = value.build;
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      errors.push("build 必须是对象");
    } else {
      if (!Array.isArray(b.commands)) {
        errors.push("build.commands 必须是字符串数组");
      } else if (b.commands.some((cmd) => typeof cmd !== "string")) {
        errors.push("build.commands 的每一项必须是字符串");
      }
      if (b.cwd !== undefined && typeof b.cwd !== "string") {
        errors.push("build.cwd 必须是字符串");
      }
    }
  }

  // Metadata fields (R4): optional, display-only — wrong content degrades to
  // missing info, it never blocks an install. Only shape and the http(s)
  // homepage rule are enforced.
  if (value.description !== undefined && typeof value.description !== "string") {
    errors.push("description 必须是字符串");
  }
  if (value.maintainer !== undefined && typeof value.maintainer !== "string") {
    errors.push("maintainer 必须是字符串");
  }
  if (value.homepage !== undefined) {
    if (
      typeof value.homepage !== "string" ||
      !/^https?:\/\//i.test(value.homepage.trim())
    ) {
      errors.push("homepage 必须是 http(s):// 开头的网址");
    }
  }
  if (value.license !== undefined) {
    if (typeof value.license !== "string") errors.push("license 必须是字符串");
  } else {
    value.license = "UNKNOWN";
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) {
      errors.push("tags 必须是字符串数组");
    } else if (value.tags.some((tag) => typeof tag !== "string")) {
      errors.push("tags 的每一项必须是字符串");
    }
  } else {
    value.tags = [];
  }

  // signatures (P3-1, signing.md): minisign now; ssh slot schema-reserved for
  // phase two. The field is EXCLUDED from the signed payload (see
  // canonicalJson / verifyRecipeSig).
  if (value.signatures !== undefined) {
    const s = value.signatures;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      errors.push("signatures 必须是对象");
    } else {
      if (s.minisign !== undefined) {
        const m = s.minisign;
        if (!m || typeof m !== "object" || Array.isArray(m)) {
          errors.push("signatures.minisign 必须是对象");
        } else {
          if (typeof m.keyId !== "string" || m.keyId.length === 0) {
            errors.push("signatures.minisign.keyId 必须是非空字符串");
          }
          if (m.algo !== undefined && m.algo !== "ed25519" && m.algo !== "ed25519-raw") {
            errors.push("signatures.minisign.algo 必须是 ed25519");
          }
          if (typeof m.signature !== "string" || m.signature.length === 0) {
            errors.push("signatures.minisign.signature 必须是非空字符串");
          }
        }
      }
      if (s.ssh !== undefined && (!s.ssh || typeof s.ssh !== "object" || Array.isArray(s.ssh))) {
        errors.push("signatures.ssh 必须是对象（二期支持）");
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Probe a recipe from a npm package manifest (package.json).
 * name <- manifest.name; kind = bundle when dsh.bundle.patch exists else
 * host-only; source.type = npm. The result is validated like any recipe.
 *
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function recipeFromPackageJson(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["无法探测配方：package.json 内容无效"] };
  }
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    return { ok: false, errors: ["无法探测配方：package.json 缺少 name 字段"] };
  }
  const hasPatch = Boolean(manifest.dsh?.bundle?.patch);
  const candidate = {
    name: manifest.name,
    kind: hasPatch ? "bundle" : "host-only",
    source: { type: "npm", spec: manifest.name },
    harnessRange:
      typeof manifest.dsh?.harnessRange === "string" ? manifest.dsh.harnessRange : "*",
  };
  return validateRecipe(candidate);
}

/**
 * Parse "1.2.3" / "v1.2.3" / "0.1.1-rc.2" into numeric parts.
 * Returns null for anything unparsable.
 */
export function parseVersion(text) {
  const match = String(text).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

/**
 * Compare two version strings. Negative when a < b, 0 when equal, positive
 * when a > b. Unparsable input compares as 0 (callers pre-validate).
 * A release ("1.2.3") ranks above its prerelease ("1.2.3-rc.1").
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === "") return 1;
  if (pb.prerelease === "") return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

// Matches a (possibly "v"-prefixed, optionally prerelease) semver literal.
const VERSION_PATTERN = String.raw`v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

/**
 * Minimal semver-style range match (no dependency on the semver package).
 * Supported forms: >=x.y.z, ^x.y.z, ~x.y.z, exact x.y.z, "*", empty string
 * (or null/undefined) = any version. Unrecognized ranges and unparsable
 * harness versions return false.
 */
export function matchesHarnessRange(range, harnessVersion) {
  if (range === undefined || range === null) return true;
  const r = String(range).trim();
  if (r === "" || r === "*") return true;
  if (!parseVersion(harnessVersion)) return false;

  let m;
  if ((m = r.match(new RegExp(`^>=\\s*(${VERSION_PATTERN})$`)))) {
    return compareVersions(harnessVersion, m[1]) >= 0;
  }
  if ((m = r.match(new RegExp(`^\\^\\s*(${VERSION_PATTERN})$`)))) {
    const base = parseVersion(m[1]);
    if (!base) return false;
    return (
      parseVersion(harnessVersion).major === base.major &&
      compareVersions(harnessVersion, m[1]) >= 0
    );
  }
  if ((m = r.match(new RegExp(`^~\\s*(${VERSION_PATTERN})$`)))) {
    const base = parseVersion(m[1]);
    if (!base) return false;
    const target = parseVersion(harnessVersion);
    return (
      target.major === base.major &&
      target.minor === base.minor &&
      compareVersions(harnessVersion, m[1]) >= 0
    );
  }
  if ((m = r.match(new RegExp(`^(${VERSION_PATTERN})$`)))) {
    return compareVersions(harnessVersion, m[1]) === 0;
  }
  return false;
}

// --- recipe signing (P3-1, design signing.md) --------------------------------
//
// Minisign (Ed25519 via node:crypto). Blob layout per jedisct1/minisign,
// CROSS-VALIDATED against the real minisign 0.12 Windows binary (golden
// vectors in tests/recipe.test.js):
//   public key  = base64( 2 bytes algo + 8 bytes key id + 32 bytes key )
//                 42 bytes, well-known "RWR" base64 prefix
//   signature   = base64( 2 bytes algo + 8 bytes key id + 64 bytes sig )
//                 74 bytes
// Algorithm identifier bytes:
//   0x45 0x64 ("Ed") = legacy: the signature covers the RAW file bytes
//   0x45 0x44 ("ED") = prehash: the signature covers BLAKE2b-512(file)
//   (minisign 0.12 signs prehashed by default; -l selects the legacy format)
// A raw 64-byte signature (algo "ed25519-raw") is also accepted, with the
// key id coming from the recipe's signatures.minisign.keyId field.

/** Stable serialization: keys sorted recursively, no whitespace, UTF-8
 * without BOM. Signing and verification MUST use the exact same bytes —
 * this function is the single source of that canonical form. */
export function canonicalJson(value) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = sortKeys(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

/** The signed payload of a recipe: everything except the signatures field. */
export function excludeSignatures(recipe) {
  const { signatures, ...rest } = recipe ?? {};
  return rest;
}

const MINISIGN_ALGO = [0x45, 0x64]; // "Ed" — Ed25519, legacy (raw file bytes)
const MINISIGN_ALGO_PREHASH = [0x45, 0x44]; // "ED" — Ed25519, prehash (BLAKE2b-512)
const MINISIGN_PUBLIC_KEY_LEN = 42;
const MINISIGN_SIGNATURE_LEN = 74;
const KEY_ID_LEN = 8;
const ED25519_KEY_LEN = 32;
const ED25519_SIG_LEN = 64;

/** Decode the first non-comment base64 line of a minisign file/text. */
function decodeBase64Line(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(
      (l) =>
        l.length > 0 &&
        !l.startsWith("untrusted comment:") &&
        !l.startsWith("trusted comment:"),
    );
  if (!line) return null;
  const raw = Buffer.from(line, "base64");
  return raw.length > 0 ? raw : null;
}

/** Parse a minisign public key (file text or the bare base64 line). */
export function parseMinisignPublicKey(text) {
  const raw = decodeBase64Line(text);
  if (!raw) return { ok: false, error: "无法解析公钥（缺少 base64 行）" };
  if (raw.length !== MINISIGN_PUBLIC_KEY_LEN) {
    return {
      ok: false,
      error: `公钥长度错误（期望 ${MINISIGN_PUBLIC_KEY_LEN} 字节，实际 ${raw.length}）`,
    };
  }
  if (raw[0] !== MINISIGN_ALGO[0] || raw[1] !== MINISIGN_ALGO[1]) {
    return { ok: false, error: "公钥算法标识不是 Ed25519（minisign）" };
  }
  return {
    ok: true,
    keyId: raw.subarray(2, 2 + KEY_ID_LEN).toString("hex"),
    pubKey: raw.subarray(2 + KEY_ID_LEN),
    error: null,
  };
}

/** Parse a stored minisign signature value into
 * { keyId, signature, prehashed } (prehashed = "ED" BLAKE2b-512 mode). */
export function parseMinisignSignature(value) {
  const raw = decodeBase64Line(value);
  if (!raw) return { ok: false, error: "无法解析签名（缺少 base64 行）" };
  if (raw.length === MINISIGN_SIGNATURE_LEN) {
    let prehashed = null;
    if (raw[0] === MINISIGN_ALGO[0] && raw[1] === MINISIGN_ALGO[1]) {
      prehashed = false; // "Ed": legacy, raw file bytes
    } else if (raw[0] === MINISIGN_ALGO_PREHASH[0] && raw[1] === MINISIGN_ALGO_PREHASH[1]) {
      prehashed = true; // "ED": BLAKE2b-512 prehash
    }
    if (prehashed === null) {
      return { ok: false, error: "签名算法标识不是 Ed25519（minisign）" };
    }
    return {
      ok: true,
      prehashed,
      keyId: raw.subarray(2, 2 + KEY_ID_LEN).toString("hex"),
      signature: raw.subarray(2 + KEY_ID_LEN),
    };
  }
  if (raw.length === ED25519_SIG_LEN) {
    // Raw 64-byte signature ("ed25519-raw"): keyId comes from the recipe.
    return { ok: true, prehashed: false, keyId: null, signature: raw };
  }
  return {
    ok: false,
    error: `签名长度错误（期望 74 或 64 字节，实际 ${raw.length}）`,
  };
}

/**
 * Verify a recipe's minisign signature (P3-1). The signed payload is the
 * canonical JSON of the recipe WITHOUT the signatures field.
 *
 * @param {object} recipe validated recipe value
 * @param {object} opts
 * @param {(keyId: string) => Promise<Buffer|null>} opts.publicKeyOf resolves
 *   a keyId to its raw 32-byte Ed25519 public key (trusted-keys store or the
 *   per-source pubkeys cache), or null when unknown.
 * @returns {Promise<{status: "valid"|"invalid"|"unsigned"|"key-missing",
 *   keyId: string|null, error: string|null}>}
 */
export async function verifyRecipeSig(recipe, { publicKeyOf }) {
  const ms = recipe?.signatures?.minisign;
  if (!ms || typeof ms !== "object") {
    return { status: "unsigned", keyId: null, error: null };
  }
  const parsed = parseMinisignSignature(ms.signature);
  if (!parsed.ok) return { status: "invalid", keyId: null, error: parsed.error };
  const keyId = parsed.keyId ?? (typeof ms.keyId === "string" ? ms.keyId : null);
  if (!keyId) return { status: "invalid", keyId: null, error: "签名缺少 keyId" };
  const pubKey = await publicKeyOf(keyId);
  if (!pubKey) return { status: "key-missing", keyId, error: null };
  const data = Buffer.from(canonicalJson(excludeSignatures(recipe)), "utf8");
  // "ED" (prehash) signatures cover BLAKE2b-512 of the canonical bytes;
  // "Ed" (legacy) signatures cover the canonical bytes themselves.
  const message = parsed.prehashed
    ? createHash("blake2b512").update(data).digest()
    : data;
  let keyObj;
  try {
    keyObj = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: pubKey.toString("base64url") },
      format: "jwk",
    });
  } catch (err) {
    return { status: "invalid", keyId, error: `公钥格式无效: ${err?.message ?? err}` };
  }
  try {
    const ok = verify(null, message, keyObj, parsed.signature);
    return ok
      ? { status: "valid", keyId, error: null }
      : { status: "invalid", keyId, error: "签名与配方内容不匹配" };
  } catch (err) {
    return { status: "invalid", keyId, error: `验签失败: ${err?.message ?? err}` };
  }
}
