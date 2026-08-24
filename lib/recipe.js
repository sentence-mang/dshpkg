// dshpkg — recipe spec (AUR-like declarative package recipes).
// A recipe describes where a package comes from (npm/git/path), how it
// integrates with the harness (bundle patch layer vs host-only), its
// dependency names, the harness version range it supports, and optional
// pin / verify policy plus extra cordis patch lines.
//
// Pure functions, zero dependencies: recipeFromPackageJson probes recipes
// from npm package manifests, matchesHarnessRange implements a tiny
// semver-style matcher so we never pull in the semver package.

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
function parseVersion(text) {
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
function compareVersions(a, b) {
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
