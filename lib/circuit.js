// dshpkg — circuit breaker state machine.
// Per-package crash history lives directly on the shared state object
// (lib/state.js): state.packages[entryId] gains crashCount, crashTimes and
// circuitOpenAt. Pure functions: they mutate the given state in place and
// never touch the filesystem; the caller owns reading/writing state.json.

/** Circuit defaults: open after `threshold` crashes inside `windowMs`. */
export const DEFAULTS = { threshold: 3, windowMs: 10 * 60 * 1000 };

/**
 * Record one crash for entryId at timestamp `at`.
 * Appends `at` to crashTimes, prunes timestamps older than windowMs, syncs
 * crashCount to the pruned length and opens the circuit (circuitOpenAt) once
 * the count reaches the threshold. Mutates and returns `state`; returns null
 * when state is missing.
 */
export function recordCrash(state, entryId, at = Date.now()) {
  if (state === null || typeof state !== "object") return null;
  if (typeof entryId !== "string" || entryId.length === 0) return state;
  if (state.packages === null || typeof state.packages !== "object") {
    state.packages = {};
  }
  const t = toTimestamp(at);
  const pkg = (state.packages[entryId] ??= {});
  const times = Array.isArray(pkg.crashTimes) ? pkg.crashTimes : [];
  times.push(t);
  const windowed = times.filter(
    (x) => typeof x === "number" && t - x < DEFAULTS.windowMs,
  );
  pkg.crashTimes = windowed;
  pkg.crashCount = windowed.length;
  // Keep the original open timestamp once opened; a later closeCircuit()
  // resets it so a fresh crash cycle can re-open the circuit.
  if (
    windowed.length >= DEFAULTS.threshold &&
    typeof pkg.circuitOpenAt !== "number"
  ) {
    pkg.circuitOpenAt = t;
  }
  return state;
}

/**
 * Is the circuit for entryId currently open?
 * Open = recordCrash() set circuitOpenAt and closeCircuit() has not run
 * since. As a fallback for state written by other writers, a full window of
 * crashTimes also counts as open (that is what `now` and `opts` are for).
 * The circuit does NOT auto-expire — close it explicitly with closeCircuit().
 */
export function isOpen(state, entryId, now = Date.now(), opts = DEFAULTS) {
  const pkg = state?.packages?.[entryId];
  if (!pkg || typeof pkg !== "object") return false;
  const openAt = pkg.circuitOpenAt;
  if (typeof openAt === "number" && Number.isFinite(openAt) && openAt > 0) {
    return true;
  }
  const windowMs =
    typeof opts?.windowMs === "number" && opts.windowMs > 0
      ? opts.windowMs
      : DEFAULTS.windowMs;
  const threshold =
    typeof opts?.threshold === "number" && opts.threshold > 0
      ? opts.threshold
      : DEFAULTS.threshold;
  const t = toTimestamp(now);
  const times = Array.isArray(pkg.crashTimes) ? pkg.crashTimes : [];
  return (
    times.filter((x) => typeof x === "number" && t - x < windowMs).length >=
    threshold
  );
}

/**
 * Close the circuit for entryId: clear crash history and the open marker.
 * Mutates and returns `state`; returns null when state is missing. Unknown
 * entries are a no-op (their record is left untouched).
 */
export function closeCircuit(state, entryId) {
  if (state === null || typeof state !== "object") return null;
  if (typeof entryId !== "string" || entryId.length === 0) return state;
  const pkg = state.packages?.[entryId];
  if (!pkg || typeof pkg !== "object") return state;
  pkg.crashCount = 0;
  pkg.crashTimes = [];
  pkg.circuitOpenAt = null;
  return state;
}

/** Coerce `at` to a finite ms timestamp; invalid input falls back to now. */
function toTimestamp(at) {
  const n = at instanceof Date ? at.getTime() : Number(at);
  return Number.isFinite(n) ? n : Date.now();
}
