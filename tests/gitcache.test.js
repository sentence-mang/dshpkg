// dshpkg — git source cache unit tests.
// Everything runs against a fresh fs.mkdtemp state root (DSH_PKG_HOME) with
// a fake git runner; no network, no real git, no real profile.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import {
  isGitSpec,
  parseGitSpec,
  gitCacheName,
  resolveGitCache,
  ensureGitCache,
  isGitNetworkError,
  SSH_HINT,
} from "../lib/gitcache.js";

let home;

beforeEach(async () => {
  // Relative state root keeps writeJsonAtomic tmp names free of drive-letter
  // colons (Windows; see CONTRACTS.md R1).
  home = await mkdtemp(join(tmpdir(), "dshpkg-gitcache-"));
  process.chdir(home);
  process.env.DSH_PKG_HOME = ".";
});

/**
 * Fake git runner: "clone" materializes the checkout (mkdir + .git marker)
 * so the fast path triggers on the next call; fetch/reset succeed silently.
 */
function fakeGitRunner({ failWith } = {}) {
  const calls = [];
  const run = async (args, opts = {}) => {
    calls.push({ args, opts });
    if (args[0] === "clone") {
      if (failWith && args.includes(failWith.url)) {
        return { status: 128, stdout: "", stderr: failWith.stderr, error: null };
      }
      const dest = args[args.length - 1];
      await mkdir(join(dest, ".git"), { recursive: true });
      await writeFile(join(dest, "package.json"), JSON.stringify({ name: basename(dest) }));
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    return { status: 0, stdout: "", stderr: "", error: null };
  };
  return { run, calls };
}

// ------------------------------------------------------------- isGitSpec

test("isGitSpec detects github:, git+, git@ and .git urls", () => {
  assert.equal(isGitSpec("github:owner/repo"), true);
  assert.equal(isGitSpec("github:owner/repo#path:packages/x"), true);
  assert.equal(isGitSpec("git+https://github.com/owner/repo.git"), true);
  assert.equal(isGitSpec("git+ssh://git@github.com/owner/repo.git"), true);
  assert.equal(isGitSpec("git@github.com:owner/repo.git"), true);
  assert.equal(isGitSpec("https://github.com/owner/repo.git"), true);
  assert.equal(isGitSpec("https://github.com/owner/repo.git#path:sub"), true);
});

test("isGitSpec rejects npm names, paths and non-git urls", () => {
  assert.equal(isGitSpec("dsh-plugin-x"), false);
  assert.equal(isGitSpec("dsh-plugin-x@1.0.0"), false);
  assert.equal(isGitSpec("npm:foo"), false);
  assert.equal(isGitSpec("link:C:\\abs\\plugin"), false);
  assert.equal(isGitSpec("https://example.com/tarball.tgz"), false);
  assert.equal(isGitSpec(""), false);
  assert.equal(isGitSpec(null), false);
});

// ------------------------------------------------------------ parseGitSpec

test("parseGitSpec converts github: specs to https clone urls", () => {
  assert.deepEqual(parseGitSpec("github:owner/repo"), {
    repoUrl: "https://github.com/owner/repo.git",
    subdir: null,
    unsupportedRef: null,
  });
  // a trailing .git on the github: form is normalized away before re-adding
  assert.deepEqual(parseGitSpec("github:owner/repo.git"), {
    repoUrl: "https://github.com/owner/repo.git",
    subdir: null,
    unsupportedRef: null,
  });
});

test("parseGitSpec strips the git+ prefix", () => {
  assert.deepEqual(parseGitSpec("git+https://github.com/owner/repo.git"), {
    repoUrl: "https://github.com/owner/repo.git",
    subdir: null,
    unsupportedRef: null,
  });
  assert.deepEqual(parseGitSpec("git+ssh://git@github.com/owner/repo.git"), {
    repoUrl: "ssh://git@github.com/owner/repo.git",
    subdir: null,
    unsupportedRef: null,
  });
});

test("parseGitSpec keeps plain https git urls unchanged", () => {
  assert.deepEqual(parseGitSpec("https://github.com/owner/repo.git"), {
    repoUrl: "https://github.com/owner/repo.git",
    subdir: null,
    unsupportedRef: null,
  });
});

test("parseGitSpec extracts a #path: subdirectory", () => {
  assert.deepEqual(parseGitSpec("github:owner/repo#path:packages/core"), {
    repoUrl: "https://github.com/owner/repo.git",
    subdir: "packages/core",
    unsupportedRef: null,
  });
  assert.deepEqual(parseGitSpec("git+https://example.com/mono.git#path:sub/dir"), {
    repoUrl: "https://example.com/mono.git",
    subdir: "sub/dir",
    unsupportedRef: null,
  });
});

test("parseGitSpec reports non-path fragments as unsupportedRef", () => {
  const branch = parseGitSpec("github:owner/repo#main");
  assert.equal(branch.unsupportedRef, "main");
  assert.equal(branch.subdir, null);
  assert.equal(branch.repoUrl, "https://github.com/owner/repo.git");

  assert.equal(parseGitSpec("https://example.com/x.git#v1.2.3").unsupportedRef, "v1.2.3");
});

// --------------------------------------------------- gitCacheName / resolve

test("gitCacheName sanitizes urls into stable directory names", () => {
  assert.equal(gitCacheName("https://github.com/owner/repo.git"), "github.com-owner-repo");
  assert.equal(gitCacheName("git+ssh://git@github.com/owner/repo.git"), "git-github.com-owner-repo");
  assert.equal(gitCacheName("https://example.com/a/b/c"), "example.com-a-b-c");
});

test("resolveGitCache points under <stateRoot>/cache/git/<name>", () => {
  const dir = resolveGitCache("https://github.com/owner/repo.git");
  // state root is "." here, so compare against the normalized absolute path
  assert.equal(resolve(dir), join(home, "cache", "git", "github.com-owner-repo"));
});

// ---------------------------------------------------------- ensureGitCache

test("ensureGitCache clones --depth 1 on first use", async () => {
  const git = fakeGitRunner();
  const dir = await ensureGitCache("https://github.com/owner/repo.git", git.run);
  assert.equal(resolve(dir), join(home, "cache", "git", "github.com-owner-repo"));
  assert.equal(git.calls.length, 1);
  assert.deepEqual(git.calls[0].args, [
    "clone",
    "--depth",
    "1",
    "https://github.com/owner/repo.git",
    dir,
  ]);
  // materialized by the fake runner: .git + package.json exist
  assert.ok(join(dir, ".git"));
});

test("ensureGitCache fetches + resets on the fast path", async () => {
  const first = fakeGitRunner();
  const dir = await ensureGitCache("https://github.com/owner/repo.git", first.run);

  const second = fakeGitRunner();
  const dir2 = await ensureGitCache("https://github.com/owner/repo.git", second.run);
  assert.equal(dir2, dir);
  assert.deepEqual(
    second.calls.map((c) => c.args[0]),
    ["fetch", "reset"],
  );
  assert.deepEqual(second.calls[0].args, ["fetch", "--depth", "1", "origin"]);
  assert.equal(resolve(second.calls[0].opts.cwd), resolve(dir));
  assert.deepEqual(second.calls[1].args, ["reset", "--hard", "origin/HEAD"]);
  assert.equal(resolve(second.calls[1].opts.cwd), resolve(dir));
});

test("ensureGitCache propagates clone failures with the git stderr", async () => {
  const git = fakeGitRunner({
    failWith: { url: "https://github.com/blocked/repo.git", stderr: "fatal: Failed to connect to github.com" },
  });
  await assert.rejects(
    () => ensureGitCache("https://github.com/blocked/repo.git", git.run),
    /Failed to connect to github.com/,
  );
});

// --------------------------------------------------------- isGitNetworkError

test("isGitNetworkError recognizes GitHub connection failures", () => {
  assert.equal(isGitNetworkError("fatal: Failed to connect to github.com port 443"), true);
  assert.equal(isGitNetworkError("ssh: Could not connect to github.com: Connection refused"), true);
  assert.equal(isGitNetworkError("Could not resolve host github.com"), true);
  assert.equal(isGitNetworkError("npm ERR! request to https://registry.npmjs.org failed, reason: unable to access"), true);
  assert.equal(isGitNetworkError("ERR_PNPM_FETCH_1 Connection reset by peer"), true);
  assert.equal(isGitNetworkError("install exited with code 1"), false);
  assert.equal(isGitNetworkError(""), false);
  assert.equal(isGitNetworkError(null), false);
});

test("isGitNetworkError recognizes pnpm's git resolution error code", () => {
  assert.equal(
    isGitNetworkError("ERR_PNPM_GIT_RESOLVE_FAILED Failed to resolve git head from repo"),
    true,
  );
  assert.equal(isGitNetworkError("err_pnpm_git_resolve_failed (lowercase output)"), true);
  assert.equal(isGitNetworkError("ERR_PNPM_BUILD_SCRIPTS_NOT_ALLOWED"), false);
});

test("SSH_HINT carries the git insteadOf switching command", () => {
  assert.ok(SSH_HINT.includes("git config --global"));
  assert.ok(SSH_HINT.includes("git@github.com:"));
  assert.ok(SSH_HINT.includes("insteadOf"));
});
