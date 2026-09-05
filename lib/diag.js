// dshpkg — crash diagnostics (module Q).
//
// Turns the incident stream into actionable evidence: collect boot-failure
// evidence, classify the failure signature (rule-based, reverse-engineered
// from real 2026-08-31/09-03 incidents), and recommend a recovery action.
// Pure functions over injected data (incidents/state), so every export is
// unit-testable offline. Zero third-party dependencies.
//
// The classification is deliberately CONSERVATIVE: "unknown" and "manual"
// fall through instead of guessing, and a crash that looks like an API/version
// incompatibility is recommended for upgrade — never for blind disable.

/** Failure classes produced by classifyFailure. */
export const FAILURE_CLASSES = [
  "upgrade-incompat", // TypeError / Cannot read properties (API/version drift)
  "service-pending", // entries never activate: (waiting for service: X)
  "missing-package", // ERR_MODULE_NOT_FOUND / Cannot find package
  "session-format", // session artifact backend compression mismatch
  "fixture", // explicit test harness ("intentional boot failure")
  "unknown",
];

/** Rule order matters: the FIRST matching class wins. */
const RULES = [
  { clazz: "missing-package", test: /(ERR_MODULE_NOT_FOUND|Cannot find package)/i },
  { clazz: "service-pending", test: /(did not activate|waiting for service:)/i },
  { clazz: "session-format", test: /(uses \.jsonl, but this backend is configured for|compression "zstd")/i },
  { clazz: "upgrade-incompat", test: /(TypeError:|Cannot read properties of undefined|reading '[^']+')/i },
  { clazz: "fixture", test: /intentional boot failure/i },
];

/**
 * Classify a boot-crash detail string into a failure class + hint.
 *
 * @param {string|undefined} detailText incident detail (may be multiline)
 * @returns {{clazz: string, hint: string}}
 */
export function classifyFailure(detailText) {
  const text = String(detailText ?? "");
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { clazz: rule.clazz, hint: hintFor(rule.clazz, text) };
    }
  }
  return { clazz: "unknown", hint: "未能自动归因，需要人工查看错误原文" };
}

function hintFor(clazz, text) {
  switch (clazz) {
    case "upgrade-incompat": {
      const m = text.match(/reading '([^']+)'/);
      const entry = text.match(/loader entry (\S+)/);
      return `疑似 API/版本不兼容（读不到 ${m ? `\`${m[1]}\`` : "属性"}）${entry ? `，肇事条目 ${entry[1]}` : ""}；建议升级该插件或对齐依赖版本，而非禁用`;
    }
    case "service-pending": {
      const m = text.match(/waiting for service: ([^)\s]+)/);
      return `有条目因缺少服务 ${m ? `\`${m[1]}\`` : ""} 无法激活；应先检查该服务由谁提供、是否被禁用/未加载，而不是禁用依赖方`;
    }
    case "missing-package":
      return "缺少依赖包；建议 dshpkg doctor --fix 或重新安装该插件";
    case "session-format":
      return "会话文件压缩格式不匹配（jsonl vs zstd）；属 dsh 会话存储配置问题，需人工处理";
    case "fixture":
      return "测试夹具（fixture）故意触发的崩溃，非真实插件问题；可安全禁用该夹具条目";
    default:
      return "未能自动归因";
  }
}

/**
 * Extend culprit candidates from a detail string: ids named by the loader
 * error AND ids named in "did not activate (waiting for service:)" blocks.
 *
 * @param {string|undefined} detailText
 * @returns {string[]} deduped candidate ids, first-mentioned order
 */
export function culpritCandidates(detailText) {
  const text = String(detailText ?? "");
  const out = [];
  const push = (id) => {
    if (id && !out.includes(id)) out.push(id);
  };
  for (const m of text.matchAll(/loader entry (\S+?) \(/g)) push(m[1]);
  for (const m of text.matchAll(/^(@?[\w][\w./-]*): pending/gm)) push(m[1]);
  // innermost loader entry is the real culprit; move it to the front
  for (const m of text.matchAll(/loader entry (\S+?) \(/g)) push(m[1]);
  return out;
}

/**
 * Aggregate boot evidence from the incident stream.
 *
 * @param {{incidents?: Array<object>, state?: object|null}} input
 *   incidents: parsed incident objects (fields type, at/t, detail, entryId, …)
 * @returns {{total: number, crashes: Array<{at: string, clazz: string, culprits: string[], detailHead: string}>, topCulprits: string[], classCounts: object, lastBootOkAt: string|null, bootFailures: number}}
 */
export function collectBootEvidence({ incidents = [], state = null } = {}) {
  const crashTypes = new Set(["uncaught-exception", "boot-tree-crash", "boot-crash-detected", "boot-failed"]);
  const crashes = [];
  const classCounts = Object.fromEntries(FAILURE_CLASSES.map((c) => [c, 0]));
  const culpritFreq = new Map();
  const bump = (id) => culpritFreq.set(id, (culpritFreq.get(id) ?? 0) + 1);

  for (const inc of incidents) {
    if (!inc || typeof inc !== "object") continue;
    if (crashTypes.has(inc.type)) {
      const detail = typeof inc.detail === "string" ? inc.detail : "";
      const { clazz } = classifyFailure(detail);
      classCounts[clazz] += 1;
      const culprits = culpritCandidates(detail);
      for (const c of culprits) bump(c);
      crashes.push({
        at: inc.at ?? inc.t ?? "",
        clazz,
        culprits,
        detailHead: detail.replace(/\n/g, " ").slice(0, 120),
      });
    }
  }

  crashes.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const topCulprits = [...culpritFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([id]) => id);

  return {
    total: incidents.length,
    crashes,
    topCulprits,
    classCounts,
    lastBootOkAt: state?.lastBootOkAt ?? null,
    bootFailures: Number(state?.bootFailures) || 0,
  };
}

/**
 * Recommended recovery action for a failure class. Always reversible or
 * manual — never a blind disable for a class we cannot safely attribute.
 *
 * @param {string} clazz one of FAILURE_CLASSES
 * @param {{name?: string}} [opts]
 * @returns {{kind: "upgrade"|"check-service"|"install-dep"|"disable"|"manual", reason: string, reversible: boolean}}
 */
export function suggestAction(clazz, { name = "" } = {}) {
  const target = name ? `（${name}）` : "";
  switch (clazz) {
    case "upgrade-incompat":
      return { kind: "upgrade", reason: `API/版本不兼容：建议升级肇事插件${target}或对齐依赖版本`, reversible: true };
    case "service-pending":
      return { kind: "check-service", reason: `服务未就绪：先排查服务提供者${target}，勿禁用依赖方`, reversible: true };
    case "missing-package":
      return { kind: "install-dep", reason: `缺少依赖包${target}，建议 dshpkg doctor --fix`, reversible: true };
    case "fixture":
      return { kind: "disable", reason: `测试夹具${target}可安全禁用`, reversible: true };
    case "session-format":
      return { kind: "manual", reason: `会话存储格式问题${target}，需人工处理`, reversible: false };
    default:
      return { kind: "manual", reason: `无法自动归因${target}，需人工查看`, reversible: false };
  }
}