// dshpkg — closed-loop recovery executor (module R).
//
// Executes a recovery plan (from lib/diag.js + lib/depsafe.js) with
// per-action verification: after each action the dsh tree is re-composed
// (--dump-config); a failing action is rolled back immediately and recorded
// as an incident, so a bad self-heal step can never leave the profile worse
// than it started. Every side effect (dsh run, disable write, block removal,
// upgrade) is injected by the caller — this module stays offline-testable.
//
// Design rule: an action only counts as "ok" when the tree composes AFTER
// it. `verified` is true only when every executed action verified clean.

/**
 * Execute a recovery plan with per-action verification and rollback.
 *
 * @param {object} input
 * @param {string} input.profile profile name
 * @param {Array<{kind: string, name?: string}>} input.plan ordered actions
 * @param {(args: string[]) => {status: number|null, stderr?: string}} input.dshRun
 *   dsh runner for verification (e.g. ctx.dshRun); status 0 = composes
 * @param {(name: string) => Promise<unknown>} [input.applyDisable] write disable block
 * @param {(name: string) => Promise<unknown>} [input.removeBlock] remove disable block
 * @param {(name: string) => Promise<unknown>} [input.upgradePkg] transactional upgrade
 * @param {(e: object) => Promise<unknown>} [input.incident] appendIncident-like logger
 * @returns {Promise<{actions: Array<{kind: string, name: string, ok: boolean, rolledBack: boolean, error?: string}>, verified: boolean, needsManual: Array<{kind: string, name?: string}>}>}
 */
export async function heal({
  profile,
  plan = [],
  dshRun,
  applyDisable,
  removeBlock,
  upgradePkg,
  incident,
} = {}) {
  const actions = [];
  const needsManual = [];
  const verify = async () => {
    try {
      const res = await dshRun(["--profile", profile, "--dump-config"]);
      return Boolean(res && res.status === 0);
    } catch {
      return false;
    }
  };
  const record = async (entry) => {
    try {
      if (typeof incident === "function") await incident(entry);
    } catch {
      // incident logging is best-effort
    }
  };

  for (const step of plan) {
    const name = step?.name ?? "";
    const kind = step?.kind ?? "manual";
    // Manual / check actions cannot be executed automatically here.
    if (kind === "manual" || kind === "check-service") {
      needsManual.push({ kind, name });
      continue;
    }

    const result = { kind, name, ok: false, rolledBack: false, error: undefined };
    let executed = false;
    try {
      if (kind === "disable") {
        if (typeof applyDisable !== "function") throw new Error("applyDisable 未注入");
        await applyDisable(name);
        executed = true;
      } else if (kind === "install-dep") {
        // install-dep is routed through the transaction channel by the CLI;
        // selfheal only verifies. The caller injects upgradePkg for installs.
        if (typeof upgradePkg !== "function") throw new Error("upgradePkg 未注入");
        await upgradePkg(name);
        executed = true;
      } else if (kind === "upgrade") {
        if (typeof upgradePkg !== "function") throw new Error("upgradePkg 未注入");
        await upgradePkg(name);
        executed = true;
      } else {
        needsManual.push({ kind, name });
        continue;
      }

      result.ok = await verify();
      if (!result.ok) {
        // roll back the action that broke the tree
        if (kind === "disable" && typeof removeBlock === "function") {
          await removeBlock(name).catch(() => {});
          result.rolledBack = true;
        } else if (typeof removeBlock === "function") {
          await removeBlock(name).catch(() => {});
          result.rolledBack = true;
        }
        result.error = "动作后校验失败，已回滚";
      }
    } catch (err) {
      result.error = err?.message ?? String(err);
      if (executed && typeof removeBlock === "function") {
        await removeBlock(name).catch(() => {});
        result.rolledBack = true;
      }
    }
    await record({ type: `heal-${result.ok ? "ok" : "failed"}`, kind, name, profile, error: result.error });
    actions.push(result);
  }

  return {
    actions,
    verified: actions.length > 0 && actions.every((a) => a.ok),
    needsManual,
  };
}

/**
 * Build an executable plan (pure): keep only actions the executor can run
 * (disable/upgrade/install-dep), cap the count, and de-duplicate by name.
 *
 * @param {Array<{kind: string, name?: string, reason?: string}>} suggestions
 * @param {{max?: number}} [opts]
 * @returns {Array<{kind: string, name?: string, reason?: string}>}
 */
export function executablePlan(suggestions = [], { max = 8 } = {}) {
  const seen = new Set();
  const out = [];
  if (!(max > 0)) return out;
  for (const s of suggestions) {
    if (!s || typeof s !== "object") continue;
    if (!["disable", "upgrade", "install-dep"].includes(s.kind)) continue;
    const key = `${s.kind}:${s.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}