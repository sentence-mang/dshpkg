// dshpkg — shared state store.
// All state lives under ~/.dsh/dshpkg/. Writes are atomic (tmp + rename in
// the same directory); the store must work both inside the harness host and
// standalone from the CLI / supervisor, so it never touches cordis services.

import { readFile, writeFile, rename, mkdir, stat, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMinisignPublicKey } from "./recipe.js";

/** Absolute path of this package root (works from lib/ and bin/). */
export function pkgRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** DSH home directory (~/.dsh). */
export function dshHome() {
  const env = process.env.DSH_HOME;
  return env ? env : join(homedir(), ".dsh");
}

/** dshpkg state root (~/.dsh/dshpkg). */
export function stateRoot() {
  const env = process.env.DSH_PKG_HOME;
  return env ? env : join(dshHome(), "dshpkg");
}

/** One state path under the state root. */
export function statePath(...parts) {
  return join(stateRoot(), ...parts);
}

// A profile name must look like a plain package name: an alphanumeric first
// character, then alphanumerics / dot / underscore / dash. This rejects path
// separators, `..` traversal and leading-dash flag injection when a caller
// builds a filesystem path from a user-supplied profile name.
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve a profile directory (~/.dsh/profiles/<name>).
 * Returns null when the name is not a safe package-like name, the directory
 * does not exist or its package.json declares no `dsh.profile` manifest
 * (avoids guessing the current directory, the same stance as
 * dsh-boot-guard).
 */
export async function resolveProfileDir(name) {
  if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) return null;
  const dir = join(dshHome(), "profiles", name);
  try {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    if (!manifest?.dsh?.profile) return null;
    return dir;
  } catch {
    return null;
  }
}

/**
 * Atomic JSON write: tmp file in the same directory, then rename.
 * The tmp name derives from the basename only — embedding the full path put
 * the Windows drive-letter colon (C:) into the file name, which rename()
 * rejects with EINVAL (see CONTRACTS.md rulings).
 */
export async function writeJsonAtomic(filePath, value, space = 2) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(tmp, JSON.stringify(value, null, space), "utf8");
  await rename(tmp, filePath);
}

/**
 * Atomic raw-text write: tmp file in the same directory, then rename.
 * The tmp name derives from the basename only (see writeJsonAtomic for the
 * Windows drive-letter colon caveat in CONTRACTS.md).
 *
 * Sensitive content (the API token) is written mode 0600 — owner read/write
 * only. On POSIX that restricts the file to its owner; on Windows the mode
 * bit is a no-op (proven by POSIX-mode semantics being unsupported), so the
 * file's protection is the ACL on the state root directory, which must be
 * private to the user (the same requirement as ~/.dsh/dshpkg itself).
 */
export async function writeTextAtomic(filePath, text) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, filePath);
}

/**
 * Read (or lazily create) the local API token used to authenticate the
 * /dshpkg write routes. The token is a random 32-byte hex string stored at
 * <stateRoot>/api-token and is only meaningful on this machine. The file is
 * created atomically on first use; a concurrent first-time writer may win the
 * race, so the value read back (whatever is on disk) is authoritative.
 */
export async function readApiToken() {
  const file = statePath("api-token");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch {
    // missing or unreadable: generate below
  }
  await writeTextAtomic(file, randomBytes(32).toString("hex"));
  return (await readFile(file, "utf8")).trim();
}

/** Read JSON; returns the fallback when missing or unparsable. */
export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Read state.json, creating the default shape on first use. A CORRUPT file
 * (unparsable JSON) is quarantined as state.json.corrupt-<ts> and rebuilt
 * from the defaults, with the event recorded in incidents.jsonl (P4-3: the
 * supervisor then heals by rebuilding from snapshots instead of crashing on
 * every read).
 */
export async function readState() {
  const defaults = {
    version: 1,
    profile: "web",
    packages: {}, // name -> {source, version, kind, layer, installedAt, crashCount, held, circuit}
    managed: {}, // name -> {installedAt, via, version} — packages dshpkg installed itself
    lastBootOkAt: null,
    bootFailures: 0,
  };
  let text;
  try {
    text = await readFile(statePath("state.json"), "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      await quarantineStateFile(err);
    }
    return defaults; // missing file = first use
  }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") return { ...defaults, ...value };
    return defaults; // valid JSON but not an object ([] / "x" / 42)
  } catch (err) {
    await quarantineStateFile(err);
    return defaults;
  }
}

/** Move a corrupt state.json aside (state.json.corrupt-<ts>) and record the
 * event. Best-effort — a failed quarantine must not break the read. */
async function quarantineStateFile(err) {
  try {
    const file = statePath("state.json");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(file, statePath(`state.json.corrupt-${stamp}`));
    await appendIncident({
      type: "state-corrupt",
      detail: String(err?.message ?? err),
    });
  } catch {
    // quarantine is best-effort
  }
}

export async function writeState(state) {
  await writeJsonAtomic(statePath("state.json"), state);
}

// --- managed-ledger helpers (pure; caller owns readState/writeState) ---------
//
// state.managed records which packages dshpkg installed ITSELF (as opposed to
// plugins the official `dsh plugin add` channel installed directly but dshpkg
// never saw). Keeping this ledger populated is what lets crash attribution,
// update detection and snapshots tell "dshpkg-managed" apart from "foreign".
// These are pure in-place mutators mirroring circuit.js — no IO, so they are
// trivially unit-testable and the CLI only glues them to readState/writeState.

/** Keys that must never be used as a per-package ledger key (see circuit.js). */
const MANAGED_DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Record (or refresh) a package in state.managed.
 * `via` defaults to "dshpkg"; `version` records the installed version when
 * known (null when the spec carried no concrete version). Dangerous names are
 * refused so a hostile package name can never pollute Object.prototype.
 *
 * @param {object} state state object (mutated in place)
 * @param {string} name package name
 * @param {{version?: string|null, via?: string, installedAt?: string}} [rec]
 * @returns {object} the state object
 */
export function recordManagedInstall(state, name, rec = {}) {
  if (state === null || typeof state !== "object") return state;
  if (typeof name !== "string" || name.length === 0) return state;
  if (MANAGED_DANGEROUS_KEYS.has(String(name).toLowerCase())) return state;
  if (state.managed === null || typeof state.managed !== "object") {
    state.managed = {};
  }
  state.managed[name] = {
    installedAt: rec.installedAt ?? new Date().toISOString(),
    via: rec.via ?? "dshpkg",
    version: rec.version ?? null,
  };
  return state;
}

/**
 * Remove a package from state.managed (a no-op when absent). Dangerous names
 * are refused so the delete can never reach through the prototype.
 *
 * @param {object} state state object (mutated in place)
 * @param {string} name package name
 * @returns {object} the state object
 */
export function removeManagedEntry(state, name) {
  if (state === null || typeof state !== "object") return state;
  if (typeof name !== "string" || name.length === 0) return state;
  if (MANAGED_DANGEROUS_KEYS.has(String(name).toLowerCase())) return state;
  if (state.managed === null || typeof state.managed !== "object") return state;
  delete state.managed[name];
  return state;
}

/** How many incidents incidents.jsonl may keep; older lines are rotated out. */
export const INCIDENTS_MAX = 2000;

/**
 * Append one line to incidents.jsonl (crash event stream). Once the file
 * plausibly holds more than INCIDENTS_MAX lines (a size gate avoids reading
 * a small file on every append) the oldest lines are rotated away in a
 * rewritten file (atomic tmp+rename in the same directory), so the stream
 * can never grow without bound.
 */
export async function appendIncident(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  const file = statePath("incidents.jsonl");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, line + "\n", { encoding: "utf8", flag: "a" });
  await rotateIncidents(file);
}

/** Keep only the newest INCIDENTS_MAX lines. Best-effort: any failure
 * (concurrent write, missing file, unreadable) leaves the file untouched. */
async function rotateIncidents(file) {
  try {
    const size = (await stat(file)).size;
    // A JSON line is at least ~34 bytes, so INCIDENTS_MAX lines occupy at
    // least ~68 KiB; below the gate the file cannot be over capacity.
    if (size < INCIDENTS_MAX * 24) return;
    const kept = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    if (kept.length <= INCIDENTS_MAX) return;
    const dir = dirname(file);
    const tmp = join(
      dir,
      `.${basename(file)}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(tmp, kept.slice(-INCIDENTS_MAX).join("\n") + "\n", "utf8");
    await rename(tmp, file);
  } catch {
    // rotation is best-effort
  }
}

/** Last N incidents, newest last. */
export async function readIncidents(limit = 100) {
  try {
    const text = await readFile(statePath("incidents.jsonl"), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { t: "", raw: line };
        }
      })
      .slice(-limit);
  } catch {
    return [];
  }
}

/** Repos config: ordered list of recipe repositories (priority = order). */
export async function readRepos() {
  const defaults = {
    repos: [], // [{url, enabled, name}]
    lastSyncAt: null,
  };
  const value = await readJson(statePath("repos.json"), null);
  if (value && typeof value === "object") return { ...defaults, ...value };
  return defaults;
}

export async function writeRepos(repos) {
  await writeJsonAtomic(statePath("repos.json"), repos);
}

/**
 * List snapshot dirs, newest first (dshpkg-wide convention; snapshot.js
 * re-exports this single implementation). Staging `.tmp` dirs are skipped.
 */
export async function listSnapshots() {
  try {
    const entries = await readdir(statePath("snapshots"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".tmp"))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch {
    return [];
  }
}

export async function fileExists(path) {
  return existsSync(path);
}

export async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

// --- trusted keys (P3-1, design signing.md §3) -------------------------------
//
// Two key sources: the user's explicit trust set (trusted-keys.json, managed
// by `dshpkg key add|list|remove`) and the per-source pubkeys cache
// (<stateRoot>/pubkeys/<keyId>.pub, populated by repo syncs). Both store the
// full minisign public key line; resolvePublicKey returns the raw 32-byte
// Ed25519 key for verifyRecipeSig.

/** Read the user's explicit trust set (trusted-keys.json). */
export async function readTrustedKeys() {
  const defaults = { keys: [] }; // [{ keyId, label, addedAt, pubKeyB64 }]
  const value = await readJson(statePath("trusted-keys.json"), null);
  if (value && typeof value === "object" && Array.isArray(value.keys)) {
    return value;
  }
  return defaults;
}

async function writeTrustedKeys(config) {
  await writeJsonAtomic(statePath("trusted-keys.json"), config);
}

/** True when keyId is in the explicit trust set. */
export async function isKeyTrusted(keyId) {
  if (typeof keyId !== "string" || keyId.length === 0) return false;
  const { keys } = await readTrustedKeys();
  return keys.some((k) => k?.keyId === keyId);
}

/** Add a key to the trust set (idempotent). Returns the updated config. */
export async function addTrustedKey(keyId, label = "", pubKeyB64 = "") {
  const config = await readTrustedKeys();
  if (!config.keys.some((k) => k?.keyId === keyId)) {
    config.keys.push({
      keyId,
      label: String(label ?? ""),
      addedAt: new Date().toISOString(),
      pubKeyB64: String(pubKeyB64 ?? "").trim(),
    });
    await writeTrustedKeys(config);
  }
  return config;
}

/** Remove a key from the trust set. Returns the updated config. */
export async function removeTrustedKey(keyId) {
  const config = await readTrustedKeys();
  const before = config.keys.length;
  config.keys = config.keys.filter((k) => k?.keyId !== keyId);
  if (config.keys.length !== before) await writeTrustedKeys(config);
  return config;
}

/**
 * Resolve a keyId to its raw 32-byte Ed25519 public key: explicit trust set
 * first (stored blob), then the per-source pubkeys cache file. Returns null
 * when the key is unknown.
 */
export async function resolvePublicKey(keyId) {
  if (typeof keyId !== "string" || keyId.length === 0) return null;
  const { keys } = await readTrustedKeys();
  const trusted = keys.find((k) => k?.keyId === keyId);
  const blob = trusted?.pubKeyB64 || null;
  if (!blob) {
    try {
      const text = await readFile(statePath("pubkeys", `${keyId}.pub`), "utf8");
      const parsed = parseMinisignPublicKey(text);
      if (!parsed.ok) return null;
      return parsed.pubKey;
    } catch {
      return null;
    }
  }
  const raw = Buffer.from(String(blob).trim(), "base64");
  if (raw.length === 42 && raw[0] === 0x45 && raw[1] === 0x64) {
    return raw.subarray(10); // full minisign blob: skip algo + key id
  }
  return raw.length === 32 ? raw : null;
}

// --- exclusive lock files (P2-4 sync lock + P4-3 supervisor lock) -----------

/** How old a lock file may be before it is treated as a dead lock. */
export const SYNC_LOCK_STALE_MS = 10 * 60 * 1000;

/** Acquire one exclusive lock file (created with flag "wx"; a lock older than
 * staleMs is presumed dead and reclaimed). Returns { ok: true } or
 * { ok: false, reason }. */
async function acquireLockFile(
  file,
  { now = Date.now(), staleMs = SYNC_LOCK_STALE_MS } = {},
) {
  const payload = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() });
  const create = () =>
    writeFile(file, payload, { encoding: "utf8", flag: "wx" }).then(
      () => ({ ok: true }),
      (err) => ({ ok: false, reason: String(err?.message ?? err) }),
    );
  const first = await create();
  if (first.ok) return first;
  // EEXIST: someone holds the lock. Reclaim only when it is provably stale.
  let info;
  try {
    info = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { ok: false, reason: "locked" }; // unreadable lock: treat as live
  }
  const at = Date.parse(info?.at ?? "");
  if (!Number.isFinite(at) || now - at <= staleMs) {
    return { ok: false, reason: "locked" };
  }
  await rm(file, { force: true });
  return create();
}

/** Release one lock file; a missing lock is a no-op. Never throws. */
async function releaseLockFile(file) {
  await rm(file, { force: true }).catch(() => {});
}

/**
 * Acquire the exclusive sync lock (<stateRoot>/sync.lock) — only one caller
 * may sync at a time.
 */
export async function acquireSyncLock(opts) {
  return acquireLockFile(statePath("sync.lock"), opts ?? {});
}

/** Release the sync lock. */
export async function releaseSyncLock() {
  await releaseLockFile(statePath("sync.lock"));
}

/**
 * Acquire the supervisor single-instance lock (<stateRoot>/supervisor.lock,
 * P4-3): only one watchdog may guard this state root. A stale lock (crashed
 * holder) is reclaimed like the sync lock.
 */
export async function acquireSupervisorLock(opts) {
  return acquireLockFile(statePath("supervisor.lock"), opts ?? {});
}

/**
 * Heartbeat: rewrite the supervisor lock payload with a fresh timestamp so a
 * live watchdog is never reclaimed as "stale" by the keep-alive re-launch.
 * Without this, a supervisor running longer than SYNC_LOCK_STALE_MS (10 min)
 * would have its lock reclaimed by the 5-minute keep-alive task, double-
 * spawning a second watchdog. The write is atomic (tmp + rename).
 */
export async function refreshSupervisorLock(opts) {
  const payload = {
    pid: process.pid,
    at: new Date((opts?.now ?? Date.now())).toISOString(),
  };
  await writeJsonAtomic(statePath("supervisor.lock"), payload);
}

/** Release the supervisor lock. */
export async function releaseSupervisorLock() {
  await releaseLockFile(statePath("supervisor.lock"));
}
