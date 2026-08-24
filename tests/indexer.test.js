// Tests for lib/indexer.js.
// All network calls go through a fake fetcher; every case runs against a
// temp dir via the DSH_PKG_HOME override. No real profile is ever touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  refreshIndex,
  readIndex,
  parseAwesomeMarkdown,
  SOURCES,
  USER_AGENT,
} from "../lib/indexer.js";

// ---- fake fetcher ---------------------------------------------------------

/**
 * Route fake responses by URL substring. A route value is either a static
 * response or an async function; `{ error }` makes the fetch reject.
 * Every call is recorded for assertions (URL + options).
 */
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

function githubPayload(items) {
  return { json: { items } };
}
function npmPayload(objects) {
  return { json: { objects } };
}
function awesomePayload(text) {
  return { text };
}
function dshsoPayload(payload) {
  return { json: payload };
}

// ---- fixtures -------------------------------------------------------------

const GITHUB_REPO = {
  full_name: "acme/dsh-foo",
  name: "dsh-foo",
  description: "A foo tool for DSH",
  stargazers_count: 1234,
  html_url: "https://github.com/acme/dsh-foo",
  topics: ["tools", "foo"],
  updated_at: "2026-01-01T00:00:00Z",
};

const NPM_PKG = {
  name: "dsh-bar",
  description: "bar plugin",
  version: "1.2.3",
  links: {
    repository: "git+https://github.com/other/dsh-bar.git",
    npm: "https://www.npmjs.com/package/dsh-bar",
  },
};

const AWESOME_README = [
  "# Awesome DSH Plugin",
  "",
  "## 目录",
  "- [插件](#插件)",
  "",
  "## 插件",
  "",
  "### 🎨 UI 增强",
  "- [zealot00/dsh-pet](https://github.com/zealot00/dsh-pet) - DSH Web UI 桌面宠物",
  "- [huiliyi37/dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui) — DeepSeek Harness 的终端 UI",
  "- [wsxwj123/dsh-plugins#turn-scrubber](https://github.com/wsxwj123/dsh-plugins/tree/main/packages/turn-scrubber) — 回合刻度条",
  "",
  "### 🛠️ 工具与能力",
  "- [omdsh-dev/dsh-toolkit](https://github.com/omdsh-dev/dsh-toolkit) — 零依赖工具包",
  "",
  "[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)",
].join("\n");

const DSH_SO_ITEMS = {
  items: [
    {
      packageName: "dsh-bar",
      ownerRepo: "other/dsh-bar",
      security: { riskLevel: "low", status: "reviewed" },
    },
  ],
};

/** Point DSH_PKG_HOME at a fresh temp dir; restore it after the test. */
async function withTempState(t) {
  const dir = await mkdtemp(join(tmpdir(), "dshpkg-idx-"));
  const prev = process.env.DSH_PKG_HOME;
  process.env.DSH_PKG_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_PKG_HOME;
    else process.env.DSH_PKG_HOME = prev;
  });
  return dir;
}

// ---- tests ----------------------------------------------------------------

test("refreshIndex aggregates four sources into the unified shape", async (t) => {
  await withTempState(t);
  const fetcher = makeFetcher({
    "api.github.com": githubPayload([GITHUB_REPO]),
    "registry.npmjs.org": npmPayload([{ package: NPM_PKG }]),
    "raw.githubusercontent.com": awesomePayload(AWESOME_README),
    "dsh.so": dshsoPayload(DSH_SO_ITEMS),
  });

  const res = await refreshIndex({ force: true, fetcher });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, false);
  // 1 github + 1 npm (merged with the dsh.so entry) + 4 awesome entries
  assert.equal(res.count, 6);
  assert.ok(res.fetchedAt);

  const items = await readIndex();
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 6);

  // GitHub entry: key falls back to ownerRepo, fields kept verbatim.
  const foo = items.find((i) => i.ownerRepo === "acme/dsh-foo");
  assert.equal(foo.key, "acme/dsh-foo");
  assert.equal(foo.name, "dsh-foo");
  assert.equal(foo.stars, 1234);
  assert.deepEqual(foo.topics, ["tools", "foo"]);
  assert.equal(foo.url, "https://github.com/acme/dsh-foo");
  assert.equal(foo.latestVersion, null);
  assert.deepEqual(foo.verification, { level: "unverified", label: "未验证" });
  assert.deepEqual(foo.security, { riskLevel: "unknown", status: "unreviewed" });

  // npm entry merged with the dsh.so verification entry.
  const bar = items.find((i) => i.packageName === "dsh-bar");
  assert.equal(bar.ownerRepo, "other/dsh-bar");
  assert.equal(bar.latestVersion, "1.2.3");
  assert.equal(bar.key, "dsh-bar"); // key prefers packageName
  assert.equal(bar.verification.level, "verified");
  assert.equal(bar.security.status, "reviewed");
  assert.equal(bar.security.riskLevel, "low");

  // awesome entry: verification level + category topic.
  const pet = items.find((i) => i.ownerRepo === "zealot00/dsh-pet");
  assert.equal(pet.verification.level, "awesome");
  assert.equal(pet.verification.label, "社区精选");
  assert.ok(pet.topics.includes("🎨 UI 增强"));

  // exactly the four source URLs, with UA + timeout signal, no auth header
  assert.equal(fetcher.calls.length, 4);
  assert.deepEqual(
    fetcher.calls.map((c) => c.url),
    [SOURCES.github, SOURCES.npm, SOURCES.awesome, SOURCES.dshso]
  );
  for (const call of fetcher.calls) {
    assert.equal(call.opts.headers["user-agent"], USER_AGENT);
    assert.ok(call.opts.signal);
    assert.equal(call.opts.headers.authorization, undefined);
  }

  // meta.json: fetchedAt / count / lastError
  const meta = JSON.parse(await readFile(join(process.env.DSH_PKG_HOME, "index", "meta.json"), "utf8"));
  assert.ok(meta.fetchedAt);
  assert.equal(meta.count, 6);
  assert.equal(meta.lastError, null);
});

test("dual-key de-dupe merges GitHub and npm entries sharing a repo", async (t) => {
  await withTempState(t);
  const fetcher = makeFetcher({
    "api.github.com": githubPayload([
      {
        full_name: "acme/dsh-dup",
        name: "dsh-dup",
        description: "dup from github",
        stargazers_count: 500,
        html_url: "https://github.com/acme/dsh-dup",
        topics: [],
      },
    ]),
    "registry.npmjs.org": npmPayload([
      {
        package: {
          name: "dsh-dup",
          description: "",
          version: "2.0.0",
          links: {
            repository: "https://github.com/acme/dsh-dup",
            npm: "https://www.npmjs.com/package/dsh-dup",
          },
        },
      },
    ]),
    "raw.githubusercontent.com": awesomePayload("# Awesome\n## 插件\n### 分类\n"),
    "dsh.so": { error: new Error("dsh.so down") }, // best-effort source
  });

  const res = await refreshIndex({ force: true, fetcher });
  assert.equal(res.ok, true);
  assert.equal(res.lastError, null); // dsh.so failure is ignored
  const items = await readIndex();
  assert.equal(items.length, 1);
  const merged = items[0];
  assert.equal(merged.ownerRepo, "acme/dsh-dup");
  assert.equal(merged.packageName, "dsh-dup");
  assert.equal(merged.key, "dsh-dup"); // key re-prefers packageName after merge
  assert.equal(merged.latestVersion, "2.0.0"); // filled by npm
  assert.equal(merged.stars, 500); // kept from GitHub
  assert.equal(merged.description, "dup from github"); // existing field wins
});

test("24h freshness gate skips a non-forced refresh", async (t) => {
  await withTempState(t);
  const fetcher = makeFetcher({
    "api.github.com": githubPayload([GITHUB_REPO]),
    "registry.npmjs.org": npmPayload([{ package: NPM_PKG }]),
    "raw.githubusercontent.com": awesomePayload(AWESOME_README),
    "dsh.so": dshsoPayload(DSH_SO_ITEMS),
  });

  const first = await refreshIndex({ force: true, fetcher });
  assert.equal(first.ok, true);
  assert.equal(first.skipped, false);
  const callsAfterFirst = fetcher.calls.length;

  const second = await refreshIndex({ fetcher }); // fresh -> skipped
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(second.count, first.count);
  assert.equal(fetcher.calls.length, callsAfterFirst); // no network calls

  const third = await refreshIndex({ force: true, fetcher }); // force bypasses
  assert.equal(third.ok, true);
  assert.equal(third.skipped, false);
  assert.ok(fetcher.calls.length > callsAfterFirst);
});

test("core-source failure is a negative cache: old index kept, lastError recorded", async (t) => {
  const dir = await withTempState(t);
  let githubBroken = false;
  const fetcher = makeFetcher({
    "api.github.com": () =>
      githubBroken ? { error: new Error("github boom") } : githubPayload([GITHUB_REPO]),
    "registry.npmjs.org": npmPayload([{ package: NPM_PKG }]),
    "raw.githubusercontent.com": awesomePayload(AWESOME_README),
    "dsh.so": dshsoPayload(DSH_SO_ITEMS),
  });

  const first = await refreshIndex({ force: true, fetcher });
  assert.equal(first.ok, true);
  const before = await readIndex();
  assert.equal(before.length, 6);

  githubBroken = true;
  const failed = await refreshIndex({ force: true, fetcher });
  assert.equal(failed.ok, false);
  assert.match(failed.lastError, /github boom/);

  // old items.json untouched
  assert.deepEqual(await readIndex(), before);

  // meta keeps old fetchedAt/count, records lastError
  const meta = JSON.parse(await readFile(join(dir, "index", "meta.json"), "utf8"));
  assert.equal(meta.fetchedAt, first.fetchedAt);
  assert.equal(meta.count, 6);
  assert.match(meta.lastError, /github boom/);
});

test("empty sources produce a valid empty index", async (t) => {
  await withTempState(t);
  const fetcher = makeFetcher({
    "api.github.com": githubPayload([]),
    "registry.npmjs.org": npmPayload([]),
    "raw.githubusercontent.com": awesomePayload("# none\n"),
    "dsh.so": dshsoPayload({ items: [] }),
  });
  const res = await refreshIndex({ force: true, fetcher });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.deepEqual(await readIndex(), []);
});

test("readIndex returns null when the index is missing or corrupt", async (t) => {
  const dir = await withTempState(t);
  assert.equal(await readIndex(), null);
  await mkdir(join(dir, "index"), { recursive: true });
  await writeFile(join(dir, "index", "items.json"), "{not json", "utf8");
  assert.equal(await readIndex(), null);
});

test("parseAwesomeMarkdown extracts entries with categories, skips TOC/badges", () => {
  const parsed = parseAwesomeMarkdown(AWESOME_README);
  assert.equal(parsed.length, 4);

  // " - " separator works like " — "
  assert.deepEqual(parsed[0], {
    ownerRepo: "zealot00/dsh-pet",
    url: "https://github.com/zealot00/dsh-pet",
    description: "DSH Web UI 桌面宠物",
    category: "🎨 UI 增强",
  });
  assert.deepEqual(parsed[1].ownerRepo, "huiliyi37/dsh-tianshu-tui");

  // "owner/repo#subpkg" keeps only the repo part
  const scrubber = parsed.find((p) => p.ownerRepo === "wsxwj123/dsh-plugins");
  assert.ok(scrubber);

  // category switches on the next section heading
  const toolkit = parsed.find((p) => p.ownerRepo === "omdsh-dev/dsh-toolkit");
  assert.equal(toolkit.category, "🛠️ 工具与能力");
  assert.equal(toolkit.description, "零依赖工具包");

  // TOC lines ("- [插件](#插件)") and badge images are skipped
  assert.equal(parsed.some((p) => p.url.includes("awesome-dsh-plugin.com")), false);
  assert.equal(parsed.some((p) => p.ownerRepo.includes("插件")), false);
});
