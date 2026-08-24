// dshpkg — core protection list (Spec section 9).
//
// The cordis core entries and dshpkg itself must never be disabled by the
// self-healing machinery: a circuit-open on `loader` or `include` would make
// the harness unbootable and the watchdog would fight itself. This module is
// the single source of truth shared by the host service (lib/index.js) and
// the L3 watchdog (bin/supervisor.js).
//
// Matching is exact OR prefix: an entry id that starts with "loader" or
// "cordis-host-runner" is protected too (e.g. "loader-extra", "cordis-host-runner-beta"),
// so derivative core entries cannot slip through the exact-name list.

/** Exact entry ids that must never be disabled. */
export const CORE_PROTECT_LIST = [
  "loader",
  "include",
  "cordis-host-runner",
  "web-startup",
  "web-runtime",
  "api-gateway",
  "dshpkg",
];

/** Entry ids that also protect every prefixed variant (prefix match). */
const PREFIX_PROTECTED = ["loader", "cordis-host-runner"];

/**
 * Is this entry id protected from being disabled?
 *
 * @param {unknown} entryId candidate entry id (non-strings are never protected)
 * @returns {boolean}
 */
export function isProtected(entryId) {
  if (typeof entryId !== "string") return false;
  const id = entryId.trim();
  if (!id) return false;
  if (CORE_PROTECT_LIST.includes(id)) return true;
  return PREFIX_PROTECTED.some((prefix) => id.startsWith(prefix));
}

export default { CORE_PROTECT_LIST, isProtected };
