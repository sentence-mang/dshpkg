// dshpkg — shared state store.
// All state lives under ~/.dsh/dshpkg/. Writes are atomic (tmp + rename in
// the same directory); the store must work both inside the harness host and
// standalone from the CLI / supervisor, so it never touches cordis services.

import { readFile, writeFile, rename, mkdir, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Resolve a profile directory (~/.dsh/profiles/<name>).
 * Returns null when the directory does not exist or its package.json
 * declares no `dsh.profile` manifest (avoids guessing the current directory,
 * the same stance as dsh-boot-guard).
 */
export async function resolveProfileDir(name) {
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

/** Read JSON; returns the fallback when missing or unparsable. */
export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/** Read state.json, creating the default shape on first use. */
export async function readState() {
  const defaults = {
    version: 1,
    profile: "web",
    packages: {}, // name -> {source, version, kind, layer, installedAt, crashCount, held, circuit}
    managed: {}, // L2 entries: name -> {rev, enabled, mountErrors}
    lastBootOkAt: null,
    bootFailures: 0,
  };
  const value = await readJson(statePath("state.json"), null);
  if (value && typeof value === "object") {
    return { ...defaults, ...value };
  }
  return defaults;
}

export async function writeState(state) {
  await writeJsonAtomic(statePath("state.json"), state);
}

/** Append one line to incidents.jsonl (crash event stream). */
export async function appendIncident(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  const file = statePath("incidents.jsonl");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, line + "\n", { encoding: "utf8", flag: "a" });
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
