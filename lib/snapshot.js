// dshpkg — known-good snapshots (module G).
//
// A snapshot is an immutable copy of the three profile manifest files
// (package.json, cordis.patch.yml, pnpm-lock.yaml) stored under
// <stateRoot>/snapshots/<dir-timestamp>/.
//
// Windows forbids ":" in directory names, so the ISO timestamp is sanitized
// for the on-disk name (":" and "." become "-"). saveSnapshot returns that
// sanitized timestamp; restoreSnapshot accepts both the sanitized name and a
// raw ISO string. Writes are atomic: stage in a tmp dir next to the target,
// then rename into place. Only the latest 5 snapshots are kept.
//
// All state lands under stateRoot() which honors DSH_PKG_HOME, so tests can
// point it at a temp dir and never touch a real profile.

import { mkdir, readdir, copyFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { statePath, listSnapshots } from "./state.js";

export { listSnapshots };

/** The three manifest files that fully describe a profile's plugin set. */
const SNAPSHOT_FILES = ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"];

/** How many snapshots to keep (prune on every save). */
const MAX_SNAPSHOTS = 5;

/** Sanitize a raw ISO timestamp into a directory-safe name. */
function dirNameOf(ts) {
  return String(ts).replace(/[:.]/g, "-");
}

/** Random-ish suffix for staging dirs/files. */
function tmpSuffix() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * Save a snapshot of the profile's three manifest files.
 *
 * package.json is required (a profile is not a profile without it);
 * cordis.patch.yml and pnpm-lock.yaml are copied when present — a fresh
 * profile may not have them yet. Files are staged in a tmp dir next to the
 * snapshot root and renamed into place (atomic on same-volume). After the
 * save, older snapshots beyond MAX_SNAPSHOTS are pruned.
 *
 * @param {string} profileDir absolute path to the profile directory
 * @returns {Promise<string>} the snapshot timestamp (sanitized ISO, usable
 *   directly as the `ts` argument of restoreSnapshot / listSnapshots output)
 */
export async function saveSnapshot(profileDir) {
  const iso = new Date().toISOString();
  const dirName = dirNameOf(iso);
  const snapRoot = statePath("snapshots");
  const target = join(snapRoot, dirName);

  if (existsSync(target)) {
    throw new Error(`快照已存在: ${dirName}`);
  }
  if (!existsSync(join(profileDir, "package.json"))) {
    throw new Error(`保存快照失败: ${profileDir} 缺少 package.json`);
  }

  await mkdir(snapRoot, { recursive: true });
  const tmp = join(snapRoot, `.snap-${tmpSuffix()}.tmp`);
  await mkdir(tmp, { recursive: true });
  try {
    for (const file of SNAPSHOT_FILES) {
      const src = join(profileDir, file);
      if (existsSync(src)) {
        await copyFile(src, join(tmp, file));
      }
    }
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new Error(`保存快照失败: ${err.message}`);
  }

  await pruneSnapshots();
  return dirName;
}

/**
 * Restore a snapshot back into the profile.
 *
 * All three files must exist in the snapshot, otherwise nothing is written.
 * The three files are copied to tmp files inside the profile dir first, then
 * renamed into place one by one (per-file tmp+rename; the pre-check above
 * guarantees no partial restore from a broken snapshot).
 *
 * @param {string} profileDir absolute path to the profile directory
 * @param {string} ts snapshot timestamp (sanitized dir name or raw ISO)
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function restoreSnapshot(profileDir, ts) {
  const snapDir = join(statePath("snapshots"), dirNameOf(ts));

  // Refuse early when the snapshot is incomplete: never touch the profile.
  for (const file of SNAPSHOT_FILES) {
    if (!existsSync(join(snapDir, file))) {
      return { ok: false, error: `快照 ${dirNameOf(ts)} 缺少 ${file}, 未做任何修改` };
    }
  }

  const staged = [];
  try {
    await mkdir(profileDir, { recursive: true });
    for (const file of SNAPSHOT_FILES) {
      const tmp = join(profileDir, `.restore-${tmpSuffix()}-${file}.tmp`);
      await copyFile(join(snapDir, file), tmp);
      staged.push([tmp, join(profileDir, file)]);
    }
    for (const [tmp, dst] of staged) {
      await rename(tmp, dst);
    }
    return { ok: true };
  } catch (err) {
    for (const [tmp] of staged) {
      await rm(tmp, { force: true }).catch(() => {});
    }
    return { ok: false, error: `恢复快照失败: ${err.message}` };
  }
}

/** Delete the oldest snapshots beyond MAX_SNAPSHOTS. Never throws. */
async function pruneSnapshots() {
  try {
    const snapRoot = statePath("snapshots");
    const entries = await readdir(snapRoot, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".tmp"))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const old of names.slice(MAX_SNAPSHOTS)) {
      await rm(join(snapRoot, old), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Pruning is best-effort; a failed prune must not fail the save.
  }
}
