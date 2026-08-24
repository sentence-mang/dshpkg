// dshpkg — crash log parsing + attribution (triage).
// Parses the kernel's fail-loud boot messages ("failed to apply loader entry
// ...") out of an stderr tail and decides which plugin entry caused the boot
// failure. Pure functions: no IO, no state mutation; persistence is left to
// the supervisor / host service.

// Full format, verified against dsh 0.1.1-rc.2:
//   failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure
// The outer include wrapper adds one nesting level:
//   failed to apply loader entry include (cordis:include): <inner>
// Capture groups: stage, entry id, entry name, detail. The lookahead stops
// each detail right before the next nested error so nested wrappers match
// too — the INNERMOST culprit therefore ends up LAST in the result.
const LOADER_ERROR_RE =
  /failed to (import|apply|dispose|rollback) loader entry (\S+) \(([^)]*)\): (.*?)(?=failed to (?:import|apply|dispose|rollback) loader entry|$)/gm;

/**
 * Extract every loader-error record from a log tail.
 * Nested wrappers (e.g. `include (cordis:include)`) match as well, and the
 * INNERMOST culprit is the LAST element of the returned array.
 *
 * @param {string} text stderr tail or any text; null-safe
 * @returns {{stage: string, entryId: string, entryName: string, detail: string}[]}
 */
export function parseLoaderErrors(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return [...text.matchAll(LOADER_ERROR_RE)].map((m) => ({
    stage: m[1],
    entryId: m[2],
    entryName: m[3],
    detail: m[4],
  }));
}

/**
 * Attribute a crash to one plugin entry.
 * Order of evidence:
 *   1. innermost loader error parsed from stderrTail;
 *   2. package with the highest crashCount in state.packages;
 *   3. newest incident record that carries an entryId (newest last);
 *   4. null — cannot attribute.
 *
 * @param {{stderrTail?: string, incidents?: object[], state?: object}} input
 * @returns {{entryId: string|null, reason: string}} reason is a Chinese,
 *   user-facing explanation of the chosen evidence.
 */
export function attributeCrash({ stderrTail, incidents, state } = {}) {
  // 1) loader error in the stderr tail — innermost match is the culprit
  const errors = parseLoaderErrors(stderrTail);
  if (errors.length > 0) {
    const last = errors[errors.length - 1];
    const detail = last.detail ? `：${last.detail}` : "";
    return {
      entryId: last.entryId,
      reason: `启动日志定位到崩溃条目 ${last.entryId}（${last.stage}）${detail}`,
    };
  }

  // 2) highest crashCount among recorded packages
  const packages = state?.packages;
  if (packages && typeof packages === "object") {
    let bestId = null;
    let bestCount = 0;
    for (const [id, pkg] of Object.entries(packages)) {
      const n = pkg && typeof pkg.crashCount === "number" ? pkg.crashCount : 0;
      if (n > bestCount) {
        bestCount = n;
        bestId = id;
      }
    }
    if (bestId !== null) {
      return {
        entryId: bestId,
        reason: `状态中崩溃次数最高：${bestId}（${bestCount} 次）`,
      };
    }
  }

  // 3) newest incident record with an entryId (incidents are newest-last)
  if (Array.isArray(incidents)) {
    for (let i = incidents.length - 1; i >= 0; i--) {
      const id = incidents[i]?.entryId;
      if (typeof id === "string" && id.length > 0) {
        return { entryId: id, reason: `最近一次崩溃记录指向：${id}` };
      }
    }
  }

  // 4) give up
  return { entryId: null, reason: "未能定位崩溃来源" };
}
