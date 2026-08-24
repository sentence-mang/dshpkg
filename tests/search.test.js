// Tests for lib/search.js.
// All network calls go through a fake fetcher; every case runs against temp
// dirs (DSH_PKG_HOME / DSH_HOME overrides). No real profile is ever touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { search, searchSemantic, scoreItem } from "../lib/search.js";

// ---- helpers --------------------------------------------------------------

function makeFetcher(routes) {
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const entry = Object.entries(routes).find(([pattern]) =>
      String(url).includes(pattern)
    );
    if (!entry) throw new Error(`unexpected fetch: ${url}`);
    const result =
      typeof entry[1] === "function" ? await entry[1](String(url)) : entry[1];
    if (result.error) throw result.error;
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.json,
      text: async () => result.text ?? "",
    };
  };
  fetcher.calls = calls;
  return fetcher;
}

/** Unified-shape item builder with safe defaults. */
function item(overrides) {
  return {
    key: "",
    name: "",
    ownerRepo: "",
    packageName: "",
    description: "",
    topics: [],
    stars: 0,
    url: "",
    latestVersion: null,
    verification: { level: "unknown", label: "未知" },
    security: { riskLevel: "unknown", status: "unreviewed" },
    ...overrides,
  };
}

/** Point DSH_PKG_HOME + DSH_HOME at a fresh temp dir; restore afterwards. */
async function withTempEnv(t) {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-src-"));
  const prevPkg = process.env.DSH_PKG_HOME;
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_PKG_HOME = dir;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (prevPkg === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prevPkg;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });
  return dir;
}

// ---- tests ----------------------------------------------------------------

test("offline ranking: exact > prefix > contains, topic/description bonuses, irrelevant filtered", async (t) => {
  await withTempEnv(t);
  const index = [
    item({ key: "g", name: "gamma", ownerRepo: "a/gamma", description: "unrelated" }),
    item({ key: "c", name: "x-dsh-foo-y", ownerRepo: "a/x-dsh-foo-y" }),
    item({ key: "t", name: "alpha", ownerRepo: "a/alpha", topics: ["dsh-foo"] }),
    item({ key: "p", name: "dsh-foobar", ownerRepo: "a/dsh-foobar" }),
    item({ key: "d", name: "beta", ownerRepo: "a/beta", description: "about dsh-foo here" }),
    item({ key: "e", name: "dsh-foo", ownerRepo: "a/dsh-foo" }),
  ];
  const results = await search("dsh-foo", { state: { packages: {} }, index });

  assert.equal(results.length, 5); // gamma filtered out (no keyword hit)
  assert.deepEqual(
    results.map((r) => r.key),
    ["e", "p", "c", "t", "d"] // descending score
  );
  assert.equal(results.find((r) => r.key === "e").score, 100); // exact
  assert.equal(results.find((r) => r.key === "p").score, 60); // prefix
  assert.equal(results.find((r) => r.key === "c").score, 30); // contains
  assert.equal(results.find((r) => r.key === "t").score, 20); // topic
  assert.equal(results.find((r) => r.key === "d").score, 10); // description
  for (const r of results) assert.equal(r.installed, false);
});

test("packageName participates in the exact/prefix/contains layers", async (t) => {
  await withTempEnv(t);
  const index = [
    item({ key: "n", name: "other-name", packageName: "dsh-exact" }),
  ];
  const results = await search("dsh-exact", { state: { packages: {} }, index });
  assert.equal(results.length, 1);
  assert.equal(results[0].score, 100); // exact via packageName
});

test("star bonus is stars/10000 capped at 10", () => {
  assert.equal(scoreItem(item({ name: "dsh-foo", stars: 0 }), "dsh-foo").total, 100);
  const s5 = scoreItem(item({ name: "dsh-foo", stars: 50000 }), "dsh-foo");
  assert.equal(s5.starBonus, 5);
  assert.equal(s5.total, 105);
  const sMax = scoreItem(item({ name: "dsh-foo", stars: 99999999 }), "dsh-foo");
  assert.equal(sMax.starBonus, 10);
  assert.equal(sMax.total, 110);
});

test("installed detection via state.packages and profile package.json dependencies", async (t) => {
  const dir = await withTempEnv(t);
  // a fake profile "web" under DSH_HOME with a dsh.profile manifest
  await mkdir(join(dir, "profiles", "web"), { recursive: true });
  await writeFile(
    join(dir, "profiles", "web", "package.json"),
    JSON.stringify({
      name: "web",
      version: "1.0.0",
      dsh: { profile: {} },
      dependencies: { "dsh-prof-installed": "^1.0.0" },
    }),
    "utf8"
  );
  const state = {
    packages: { "dsh-state-installed": { source: "npm", version: "1.0.0" } },
  };
  const index = [
    item({ key: "a", packageName: "dsh-state-installed", name: "dsh-state-installed" }),
    item({ key: "b", packageName: "dsh-prof-installed", name: "dsh-prof-installed" }),
    item({ key: "c", packageName: "dsh-free", name: "dsh-free" }),
  ];
  const results = await search("dsh", { state, index, profile: "web" });
  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.key === "a").installed, true);
  assert.equal(results.find((r) => r.key === "b").installed, true);
  assert.equal(results.find((r) => r.key === "c").installed, false);
});

test("online=true queries GitHub and npm live and merges with the index", async (t) => {
  await withTempEnv(t);
  const fetcher = makeFetcher({
    "api.github.com": {
      json: {
        items: [
          {
            full_name: "live/dsh-live",
            name: "dsh-live",
            description: "live gh",
            stargazers_count: 0,
            html_url: "https://github.com/live/dsh-live",
            topics: [],
          },
        ],
      },
    },
    "registry.npmjs.org": {
      json: {
        objects: [
          {
            package: {
              name: "dsh-live-npm",
              description: "live npm",
              version: "9.9.9",
              links: { npm: "https://www.npmjs.com/package/dsh-live-npm" },
            },
          },
        ],
      },
    },
  });
  const index = [item({ key: "off", name: "dsh-offline", ownerRepo: "a/dsh-offline" })];

  const results = await search("dsh-live", {
    online: true,
    state: { packages: {} },
    index,
    fetcher,
  });

  // both live endpoints hit, query embedded in the URLs
  assert.equal(fetcher.calls.length, 2);
  assert.ok(fetcher.calls[0].url.includes("api.github.com/search/repositories"));
  assert.ok(fetcher.calls[0].url.includes("dsh-live"));
  assert.ok(fetcher.calls[1].url.includes("registry.npmjs.org/-/v1/search"));
  assert.ok(fetcher.calls[1].url.includes("dsh-live"));

  // live GitHub entry ranks first (exact), live npm entry is a prefix hit
  const gh = results.find((r) => r.ownerRepo === "live/dsh-live");
  assert.ok(gh);
  assert.equal(gh.score, 100);
  const npm = results.find((r) => r.packageName === "dsh-live-npm");
  assert.ok(npm);
  assert.equal(npm.score, 60);

  // offline entry has no keyword hit for "dsh-live" -> filtered out
  assert.equal(results.some((r) => r.key === "off"), false);
});

test("online failures fall back to the local index silently", async (t) => {
  await withTempEnv(t);
  const fetcher = makeFetcher({
    "api.github.com": { error: new Error("gh down") },
    "registry.npmjs.org": { error: new Error("npm down") },
  });
  const index = [item({ key: "ok", name: "dsh-stable", ownerRepo: "a/dsh-stable" })];
  const results = await search("dsh-stable", {
    online: true,
    state: { packages: {} },
    index,
    fetcher,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].key, "ok");
});

test("name collisions keep the highest score and mark alternates", async (t) => {
  await withTempEnv(t);
  const index = [
    item({ key: "low", name: "dsh-twin", ownerRepo: "a/dsh-twin", stars: 0 }),
    item({ key: "high", name: "dsh-twin", ownerRepo: "b/dsh-twin", stars: 50000 }),
  ];
  const results = await search("dsh-twin", { state: { packages: {} }, index });
  assert.equal(results.length, 1);
  assert.equal(results[0].key, "high"); // 100 + 5 star bonus
  assert.equal(results[0].score, 105);
  assert.equal(results[0].alternates.length, 1);
  assert.equal(results[0].alternates[0].key, "low");
  assert.equal(results[0].alternates[0].score, 100);
  assert.equal(results[0].alternates[0].installed, false);
});

test("searchSemantic extracts lowercase keywords, drops stopwords, de-dupes", async () => {
  assert.deepEqual(await searchSemantic("Find  memory PLUGINS for me!"), ["memory"]);
  assert.deepEqual(await searchSemantic("想找 记忆 相关 插件 记忆 的"), ["记忆", "相关"]);
  assert.deepEqual(await searchSemantic("git worktree 工具"), ["git", "worktree", "工具"]);
  assert.deepEqual(await searchSemantic(""), []);
  assert.deepEqual(await searchSemantic("plugin dsh install"), []);
});

test("missing index, missing state and empty query degrade to []", async (t) => {
  await withTempEnv(t);
  // no index on disk, state missing -> readIndex() null -> []
  assert.deepEqual(await search("anything"), []);
  assert.deepEqual(await search("  ", { index: [item({ name: "x" })] }), []);
});
