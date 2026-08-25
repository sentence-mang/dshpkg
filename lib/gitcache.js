// dshpkg — git source cache (AUR-style source installs).
//
// Git-backed package specs (github:/git+/git+https:/.git-ending urls) are
// cloned ONCE into <stateRoot>/cache/git/<sanitized-url>/ and installed from
// there via `link:`, so pnpm never clones the same repository again. A
// monorepo subdirectory is selected with a `#path:subdir` fragment. All git
// runs go through an injected runner (default: spawnSync with shell:false,
// never a shell); tests inject a fake runner that materializes temp dirs and
// stay network-free.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "./state.js";

/** SSH switching hint attached to GitHub connection failures (Chinese). */
export const SSH_HINT =
  '网络无法直连 GitHub 时可执行 git config --global url."git@github.com:".insteadOf "https://github.com/" 切换 SSH';

/**
 * Default runner: spawn git synchronously, never through a shell. The
 * injectable alternative is used by tests (a real git is never executed).
 *
 * @param {string[]} args git arguments (without "git" itself)
 * @param {object} [opts] spawnSync options (cwd etc.)
 * @returns {{status: number|null, stdout: string, stderr: string, error?: Error}}
 */
export function defaultGitRunner(args, opts = {}) {
  return spawnSync("git", args, {
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    windowsHide: true,
    ...opts,
  });
}

function runFailed(result) {
  return Boolean(result?.error) || result?.status !== 0;
}

/**
 * True for git-backed specs: `github:owner/repo`, `git+https://…`,
 * `git@…` (ssh form) or any url ending in `.git` (optional `#…` suffix).
 */
export function isGitSpec(spec) {
  const s = String(spec ?? "").trim();
  if (!s) return false;
  return /^(github:|git\+|git@)/i.test(s) || /\.git(?:#.*)?$/.test(s);
}

/**
 * Parse a git spec into { repoUrl, subdir, unsupportedRef }.
 *
 * - "github:owner/repo"           -> https://github.com/owner/repo.git
 * - "git+https://…" / "git+ssh://…" -> the git+ prefix is stripped
 * - a "#path:subdir" fragment selects a monorepo subdirectory
 * - any other fragment (branch/tag/commit/semver) is reported as
 *   `unsupportedRef` — the caller falls back to the official pnpm channel,
 *   which resolves such refs natively.
 */
export function parseGitSpec(spec) {
  const s = String(spec).trim();
  const hashIndex = s.indexOf("#");
  const base = hashIndex === -1 ? s : s.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : s.slice(hashIndex + 1);

  let repoUrl = base;
  if (/^github:/i.test(repoUrl)) {
    const rest = repoUrl.slice("github:".length).replace(/\.git$/i, "");
    repoUrl = `https://github.com/${rest}.git`;
  } else if (/^git\+/i.test(repoUrl)) {
    repoUrl = repoUrl.slice(4);
  }

  if (fragment === null || fragment === "") {
    return { repoUrl, subdir: null, unsupportedRef: null };
  }
  if (fragment.startsWith("path:")) {
    const subdir = fragment.slice(5).trim();
    return { repoUrl, subdir: subdir || null, unsupportedRef: null };
  }
  return { repoUrl, subdir: null, unsupportedRef: fragment };
}

/**
 * Sanitized cache dir name for a repo url:
 * "https://github.com/owner/repo.git" -> "github.com-owner-repo".
 * Uniquely identifies the repository without unsafe characters.
 */
export function gitCacheName(repoUrl) {
  const cleaned = String(repoUrl)
    .replace(/\.git$/i, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") // strip scheme://
    .replace(/[@:\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "repo";
}

/** Cache directory for a repo url: <stateRoot>/cache/git/<sanitized-name>/. */
export function resolveGitCache(repoUrl) {
  return statePath("cache", "git", gitCacheName(repoUrl));
}

/**
 * Ensure the cache checkout exists and is current: `clone --depth 1` on
 * first use, `fetch --depth 1` + `reset --hard origin/HEAD` afterwards
 * (fast path — no full clone). Returns the cache directory. Failures throw
 * with the git stderr so callers can detect network problems.
 *
 * @param {string} repoUrl clone-able git url
 * @param {Function} [runner] (args, opts) -> {status, stderr, error?}
 * @returns {Promise<string>} cache directory
 */
export async function ensureGitCache(repoUrl, runner = defaultGitRunner) {
  const dir = resolveGitCache(repoUrl);
  if (existsSync(join(dir, ".git"))) {
    const fetch = await runner(["fetch", "--depth", "1", "origin"], { cwd: dir });
    if (runFailed(fetch)) {
      throw new Error(String(fetch?.stderr || "git fetch 失败").trim());
    }
    const reset = await runner(["reset", "--hard", "origin/HEAD"], { cwd: dir });
    if (runFailed(reset)) {
      throw new Error(String(reset?.stderr || "git reset 失败").trim());
    }
    return dir;
  }
  const clone = await runner(["clone", "--depth", "1", repoUrl, dir], {});
  if (runFailed(clone)) {
    throw new Error(String(clone?.stderr || "git clone 失败").trim());
  }
  return dir;
}

/**
 * True when git/pnpm output describes a failed GitHub/network connection —
 * the trigger for the SSH switching hint.
 */
export function isGitNetworkError(text) {
  const t = String(text ?? "").toLowerCase();
  return (
    t.includes("failed to connect to github.com") ||
    t.includes("could not connect") ||
    t.includes("could not resolve host") ||
    t.includes("connection refused") ||
    t.includes("connection reset") ||
    t.includes("connection timed out") ||
    t.includes("unable to access") ||
    t.includes("network is unreachable")
  );
}
