// dshpkg — L2 managed layer.
//
// Hot-mountable plugin fibers stored as source files under
// <storeDir>/<name>/index.mjs plus a manifest.json per entry. The layer is
// fully dependency-injected (storeDir + mountImpl) so tests run without a
// live cordis host: mountImpl(importUrl) is what the host implements via
// `ctx.plugin(await import(importUrl))`, and tests provide a fake that only
// records calls and can be told to fail.

import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { statePath } from "./state.js";

/** Entry names must be filesystem-safe: no path separators, no ".." tricks. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Atomic text write: tmp file in the same directory, then rename. */
async function writeTextAtomic(filePath, text) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  await writeFile(tmp, text, "utf8");
  await rename(tmp, filePath);
}

async function writeJsonFile(filePath, value) {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readTextOrNull(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract a line number from a mount failure, preferring a frame that points
 * into the managed source file itself (managed/<name>/index.mjs), falling back
 * to the first `<file>:<line>:<col>` frame of the stack.
 */
function extractLine(err, name) {
  const stack = typeof err?.stack === "string" ? err.stack : String(err ?? "");
  const managedFile = new RegExp(
    `[/\\\\]${escapeRegExp(name)}[/\\\\]index\\.mjs:(\\d+)(?::\\d+)?`
  );
  const m = stack.match(managedFile);
  if (m) return Number(m[1]);
  const frame = stack.match(/(?:\(|at\s)(?:file:\/\/\/)?[^\s():]+:(\d+):(\d+)/);
  return frame ? Number(frame[1]) : null;
}

export class ManagedLayer {
  /**
   * @param {{ storeDir?: string, mountImpl: (importUrl: string) => any }} opts
   *   storeDir defaults to <stateRoot>/managed (DSH_PKG_HOME overrides the
   *   state root, see lib/state.js).
   */
  constructor({ storeDir, mountImpl } = {}) {
    this.storeDir = storeDir ?? statePath("managed");
    if (typeof mountImpl !== "function") {
      throw new TypeError("ManagedLayer requires an injected mountImpl function");
    }
    this.mountImpl = mountImpl;
    // name -> fiber currently mounted in THIS process (fiber may carry dispose())
    this.fibers = new Map();
  }

  /**
   * Mount a plugin from source.
   *
   * Flow: write source to managed/<name>/index.mjs (tmp+rename) -> bump the
   * monotonically increasing cache-buster seq -> mountImpl(importUrl with
   * ?v=<seq>) -> only on success persist manifest.json
   * { name, rev: prevRev+1, enabled: true, mountedAt }. A throwing mountImpl
   * leaves the manifest untouched and the rev unadvanced.
   */
  async mount(name, source) {
    try {
      if (!SAFE_NAME.test(name)) {
        return { ok: false, error: `非法插件名: ${name}` };
      }
      if (typeof source !== "string" || !source.trim()) {
        return { ok: false, error: "source 必须是非空字符串" };
      }
      const dir = join(this.storeDir, name);
      await mkdir(dir, { recursive: true });
      await writeTextAtomic(join(dir, "index.mjs"), source);

      const seq = await this.#nextSeq();
      const importUrl = pathToFileURL(join(dir, "index.mjs")).href + "?v=" + seq;

      let fiber;
      try {
        fiber = await this.mountImpl(importUrl);
      } catch (err) {
        // Contract: failed mount must not persist manifest / advance rev.
        return {
          ok: false,
          error: String(err?.message ?? err),
          line: extractLine(err, name),
        };
      }

      const prev = await readJsonFile(join(dir, "manifest.json"), null);
      const rev = (typeof prev?.rev === "number" ? prev.rev : 0) + 1;
      const manifest = {
        name,
        rev,
        enabled: true,
        mountedAt: new Date().toISOString(),
        seq,
      };
      await writeJsonFile(join(dir, "manifest.json"), manifest);
      this.fibers.set(name, fiber ?? null);
      return { ok: true, name, rev, seq };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err), line: extractLine(err, name) };
    }
  }

  /** Unmount: dispose the fiber (when it exposes dispose) and set enabled=false. */
  async unmount(name) {
    try {
      const dir = join(this.storeDir, name);
      const manifest = await readJsonFile(join(dir, "manifest.json"), null);
      if (!manifest) return { ok: false, error: `未找到受管条目: ${name}` };
      const fiber = this.fibers.get(name);
      if (fiber && typeof fiber.dispose === "function") {
        try {
          await fiber.dispose();
        } catch {
          // dispose failure must not block the state transition
        }
      }
      this.fibers.delete(name);
      manifest.enabled = false;
      await writeJsonFile(join(dir, "manifest.json"), manifest);
      return { ok: true, name, enabled: false };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /**
   * Replace: unmount the old fiber first, then mount the new source. On a
   * failed mount the old manifest stays as-is (contract); the old fiber has
   * already been disposed, and autoRestore will re-attempt it on next boot.
   */
  async replace(name, source) {
    try {
      const fiber = this.fibers.get(name);
      if (fiber && typeof fiber.dispose === "function") {
        try {
          await fiber.dispose();
        } catch {
          // ignore dispose errors during replace
        }
      }
      this.fibers.delete(name);
      return await this.mount(name, source);
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /**
   * Boot-time restore: re-mount every entry whose manifest says enabled.
   * Per-entry failures are recorded in the manifest (mountErrors) and never
   * block the remaining entries.
   */
  async autoRestore() {
    const results = [];
    let entries;
    try {
      entries = await readdir(this.storeDir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const dir = join(this.storeDir, name);
      const manifest = await readJsonFile(join(dir, "manifest.json"), null);
      if (!manifest?.enabled) continue;
      const source = await readTextOrNull(join(dir, "index.mjs"));
      if (source == null) {
        await this.#recordMountError(dir, manifest, "源码文件缺失");
        results.push({ name, ok: false, error: "源码文件缺失" });
        continue;
      }
      const seq = await this.#nextSeq();
      const importUrl = pathToFileURL(join(dir, "index.mjs")).href + "?v=" + seq;
      try {
        const fiber = await this.mountImpl(importUrl);
        this.fibers.set(name, fiber ?? null);
        manifest.mountErrors = [];
        await writeJsonFile(join(dir, "manifest.json"), manifest);
        results.push({ name, ok: true });
      } catch (err) {
        await this.#recordMountError(dir, manifest, String(err?.message ?? err));
        results.push({ name, ok: false, error: String(err?.message ?? err) });
      }
    }
    return results;
  }

  /** List managed entries from manifests: [{ name, rev, enabled, mountErrors }]. */
  async list() {
    const out = [];
    let entries;
    try {
      entries = await readdir(this.storeDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await readJsonFile(join(this.storeDir, entry.name, "manifest.json"), null);
      out.push({
        name: entry.name,
        rev: manifest?.rev ?? 0,
        enabled: manifest?.enabled ?? false,
        mountErrors: manifest?.mountErrors ?? [],
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Persist a mount failure on the manifest without disabling the entry. */
  async #recordMountError(dir, manifest, error) {
    try {
      manifest.mountErrors = [
        ...(Array.isArray(manifest.mountErrors) ? manifest.mountErrors : []),
        { error, at: new Date().toISOString() },
      ];
      await writeJsonFile(join(dir, "manifest.json"), manifest);
    } catch {
      // best effort: never let error bookkeeping break restore
    }
  }

  /** Monotonic cache-buster seq, persisted at <storeDir>/seq.json. */
  async #nextSeq() {
    const file = join(this.storeDir, "seq.json");
    const current = await readJsonFile(file, 0);
    const next = (typeof current === "number" && Number.isFinite(current) ? current : 0) + 1;
    await writeJsonFile(file, next);
    return next;
  }
}

export default ManagedLayer;
