// Tests for lib/order-bundles.js — profile bundle re-layering.
// Every IO test uses a synthetic temp profile dir; the real ~/.dsh/profiles
// is never touched. Pure-function tests carry no IO at all.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkgRoot } from "../lib/state.js";
import {
  KERNEL_PREFIX,
  DEFAULT_GUARDIANS,
  topoStable,
  orderBundles,
  buildDepGraph,
  collectDeclaredBundles,
  planReorder,
  reorderProfileBundles,
  ensureDshpkgBundle,
  detectNameDrift,
  repairNameDrift,
} from "../lib/order-bundles.js";

// R19: reorderProfileBundles takes the sync lock — give the whole file a
// temp state root so the real ~/.dsh/dshpkg is never touched.
let fileStateRoot = null;
before(async () => {
  fileStateRoot = await mkdtemp(join(tmpdir(), "dshpkg-ob-filestate-"));
  if (!process.env.DSH_PKG_HOME) process.env.DSH_PKG_HOME = fileStateRoot;
});
after(() => {
  if (process.env.DSH_PKG_HOME === fileStateRoot) delete process.env.DSH_PKG_HOME;
});

/** Shorthand graph builder: entries are [name, ...deps]. */
function graph(...entries) {
  return new Map(entries.map(([name, ...deps]) => [name, new Set(deps)]));
}

// --- topoStable ----------------------------------------------------------------

test("topoStable: empty graph keeps the original order", () => {
  const { order, guard } = topoStable(["a", "b", "c"], new Map());
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(guard, []);
});

test("topoStable: deps come before dependents", () => {
  // c depends on b, b depends on a -> a, b, c regardless of input order
  const g = graph(["c", "b"], ["b", "a"], ["a"]);
  const { order } = topoStable(["c", "b", "a"], g);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("topoStable: independent nodes keep their relative order (stable)", () => {
  const g = graph(["x"], ["y"], ["z"]);
  const { order } = topoStable(["z", "y", "x"], g);
  assert.deepEqual(order, ["z", "y", "x"]);
});

test("topoStable: deps outside the node set are ignored", () => {
  const g = graph(["a", "external-pkg"], ["b", "a"]);
  const { order, guard } = topoStable(["b", "a"], g);
  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(guard, []);
});

test("topoStable: cycle members are reported and appended in original order", () => {
  const g = graph(["p", "q"], ["q", "p"], ["r", "p"]);
  const { order, guard } = topoStable(["r", "p", "q"], g);
  // every node hangs off the p<->q cycle -> all land in the guard
  assert.deepEqual(guard, ["r", "p", "q"]);
  assert.deepEqual(order, ["r", "p", "q"]); // original relative order kept
});

test("topoStable: self-dependency is ignored", () => {
  const g = graph(["a", "a"], ["b", "a"]);
  const { order, guard } = topoStable(["b", "a"], g);
  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(guard, []);
});

// --- orderBundles ---------------------------------------------------------------

const KERNEL_BASE = "@deepseek-ai/dsh-base";
const KERNEL_WEB = "@deepseek-ai/dsh-web-app";
const DSHPKG = "@sentencemang/dshpkg";
const BOOT_GUARD = "dsh-boot-guard";

test("orderBundles: kernel first, guardians next, rest after", () => {
  const bundles = [
    KERNEL_BASE,
    KERNEL_WEB,
    "dsh-pocket",
    BOOT_GUARD,
    "dsh-context",
    DSHPKG,
    "dsh-at-file",
  ];
  const deps = bundles.filter((n) => !n.startsWith(KERNEL_PREFIX));
  const order = orderBundles(bundles, deps, new Map());
  assert.deepEqual(order, [
    KERNEL_BASE,
    KERNEL_WEB,
    DSHPKG,
    BOOT_GUARD,
    "dsh-pocket",
    "dsh-context",
    "dsh-at-file",
  ]);
});

test("orderBundles: kernel bundles survive the dependency filter", () => {
  // in-box template bundles are never profile dependencies (kernel design)
  const bundles = [KERNEL_BASE, KERNEL_WEB, "dsh-a"];
  const order = orderBundles(bundles, ["dsh-a"], new Map());
  assert.deepEqual(order, [KERNEL_BASE, KERNEL_WEB, "dsh-a"]);
});

test("orderBundles: stale bundles (not in deps) are dropped", () => {
  const bundles = [KERNEL_BASE, "dsh-gone", "dsh-a"];
  const order = orderBundles(bundles, ["dsh-a"], new Map());
  assert.deepEqual(order, [KERNEL_BASE, "dsh-a"]);
});

test("orderBundles: deps null keeps every entry", () => {
  const bundles = [KERNEL_BASE, "dsh-gone", "dsh-a"];
  const order = orderBundles(bundles, null, new Map());
  assert.deepEqual(order, [KERNEL_BASE, "dsh-gone", "dsh-a"]);
});

test("orderBundles: rest layer follows the dependency topology", () => {
  // dsh-child depends on dsh-parent; input lists the child first. Stable
  // Kahn: among ready nodes the ORIGINAL order wins, so dsh-lonely (ready
  // before the child is unblocked) stays ahead of dsh-child.
  const bundles = [KERNEL_BASE, "dsh-child", "dsh-parent", "dsh-lonely"];
  const deps = ["dsh-child", "dsh-parent", "dsh-lonely"];
  const g = graph(["dsh-child", "dsh-parent"], ["dsh-parent"], ["dsh-lonely"]);
  const order = orderBundles(bundles, deps, g);
  assert.deepEqual(order, [KERNEL_BASE, "dsh-parent", "dsh-lonely", "dsh-child"]);
});

test("orderBundles: guardians not present in the list are ignored", () => {
  const bundles = [KERNEL_BASE, "dsh-a"];
  const order = orderBundles(bundles, ["dsh-a"], new Map());
  assert.deepEqual(order, [KERNEL_BASE, "dsh-a"]);
});

test("orderBundles: custom guardian layer overrides the default", () => {
  const bundles = [KERNEL_BASE, "dsh-a", BOOT_GUARD, DSHPKG];
  const deps = ["dsh-a", BOOT_GUARD, DSHPKG];
  const order = orderBundles(bundles, deps, new Map(), {
    guardians: ["dsh-a"],
  });
  assert.deepEqual(order, [KERNEL_BASE, "dsh-a", BOOT_GUARD, DSHPKG]);
});

test("orderBundles: duplicates collapse to the first occurrence", () => {
  const bundles = [KERNEL_BASE, "dsh-a", "dsh-a", BOOT_GUARD];
  const order = orderBundles(bundles, [BOOT_GUARD, "dsh-a"], new Map());
  assert.equal(order.filter((n) => n === "dsh-a").length, 1);
});

test("orderBundles: malformed inputs degrade to best-effort output", () => {
  assert.deepEqual(orderBundles(null, null, null), []);
  assert.deepEqual(orderBundles([null, 42, "", "dsh-a"], null, null), ["dsh-a"]);
  assert.doesNotThrow(() => orderBundles(["dsh-a"], "not-a-list", null));
});

test("orderBundles: default guardians constant names dshpkg first", () => {
  assert.equal(DEFAULT_GUARDIANS[0], DSHPKG);
  assert.ok(DEFAULT_GUARDIANS.includes(BOOT_GUARD));
  assert.equal(KERNEL_PREFIX, "@deepseek-ai/");
});

// --- IO helpers (temp profile dirs only) ----------------------------------------

async function makeTempProfile() {
  return await mkdtemp(join(tmpdir(), "dshpkg-order-"));
}

async function writeProfileManifest(dir, manifest) {
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest, null, 2), "utf8");
}

/** Drop a fake installed bundle manifest under the profile node_modules. */
async function fakeBundle(dir, name, dependencies = {}, extra = {}) {
  const pkgDir = join(dir, "node_modules", ...name.split("/"));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", dependencies, ...extra }, null, 2),
    "utf8",
  );
}

/** Fake installed bundle: manifest declares dsh.bundle.patch. */
const BUNDLE_DECL = { dsh: { bundle: { patch: "./cordis.patch.yml" } } };

test("reorderProfileBundles: rewrites the manifest with the layered order", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    name: "dsh-profile-web",
    dependencies: { "dsh-child": "^1", "dsh-parent": "^1", [BOOT_GUARD]: "^1", [DSHPKG]: "link:x" },
    dsh: {
      profile: {
        bundles: [KERNEL_BASE, KERNEL_WEB, "dsh-child", BOOT_GUARD, "dsh-parent", DSHPKG],
      },
    },
  });
  await fakeBundle(dir, "dsh-child", { "dsh-parent": "^1" });
  await fakeBundle(dir, "dsh-parent");
  await fakeBundle(dir, BOOT_GUARD);
  await fakeBundle(dir, DSHPKG);

  const res = await reorderProfileBundles(dir);
  assert.equal(res.changed, true);
  assert.deepEqual(res.order, [
    KERNEL_BASE,
    KERNEL_WEB,
    DSHPKG,
    BOOT_GUARD,
    "dsh-parent",
    "dsh-child",
  ]);
  // topological invariant: every bundle loads after its bundle dependencies
  const pos = new Map(res.order.map((n, i) => [n, i]));
  assert.ok(pos.get("dsh-parent") < pos.get("dsh-child"));
  const written = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.deepEqual(written.dsh.profile.bundles, res.order);
  // unrelated manifest fields survive the rewrite
  assert.equal(written.name, "dsh-profile-web");
  assert.ok(written.dependencies["dsh-child"]);
  await rm(dir, { recursive: true, force: true });
});

test("reorderProfileBundles: idempotent — the second run is a no-op", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: { [DSHPKG]: "link:x", "dsh-a": "^1" },
    dsh: { profile: { bundles: [KERNEL_BASE, "dsh-a", DSHPKG] } },
  });
  await fakeBundle(dir, DSHPKG);
  await fakeBundle(dir, "dsh-a");
  const first = await reorderProfileBundles(dir);
  assert.equal(first.changed, true);
  const text = await readFile(join(dir, "package.json"), "utf8");
  const second = await reorderProfileBundles(dir);
  assert.equal(second.changed, false);
  assert.deepEqual(second.order, first.order);
  assert.equal(await readFile(join(dir, "package.json"), "utf8"), text);
  await rm(dir, { recursive: true, force: true });
});

test("reorderProfileBundles: disabled/invalid inputs return unchanged", async () => {
  assert.deepEqual(await reorderProfileBundles(undefined), { changed: false, order: [], registered: [] });
  assert.deepEqual(await reorderProfileBundles(""), { changed: false, order: [], registered: [] });
  const dir = await makeTempProfile();
  await writeFile(join(dir, "package.json"), "not json{{", "utf8");
  assert.deepEqual(await reorderProfileBundles(dir), { changed: false, order: [], registered: [] });
  await rm(dir, { recursive: true, force: true });
});

test("reorderProfileBundles: completes an entirely missing kernel layer (web template)", async () => {
  // basename "web" selects the shipped web kernel template
  const home = await mkdtemp(join(tmpdir(), "dshpkg-order-kernel-"));
  const dir = join(home, "profiles", "web");
  await mkdir(dir, { recursive: true });
  await writeProfileManifest(dir, {
    dependencies: { "dsh-a": "^1" },
    dsh: { profile: { bundles: ["dsh-a"] } },
  });
  await fakeBundle(dir, "dsh-a");
  const res = await reorderProfileBundles(dir);
  assert.equal(res.changed, true);
  assert.deepEqual(res.order, [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-a",
  ]);
  await rm(home, { recursive: true, force: true });
});

test("reorderProfileBundles: non-template profile with no kernel gains dsh-base only", async () => {
  const dir = await makeTempProfile(); // random basename -> KERNEL_FALLBACK
  await writeProfileManifest(dir, {
    dependencies: { "dsh-a": "^1" },
    dsh: { profile: { bundles: ["dsh-a"] } },
  });
  await fakeBundle(dir, "dsh-a");
  const res = await reorderProfileBundles(dir);
  assert.deepEqual(res.order, ["@deepseek-ai/dsh-base", "dsh-a"]);
  await rm(dir, { recursive: true, force: true });
});

test("reorderProfileBundles: a partial kernel layer is never completed", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: { "dsh-a": "^1" },
    // only dsh-base present: dsh-web-app must NOT be added
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-a"] } },
  });
  await fakeBundle(dir, "dsh-a");
  const res = await reorderProfileBundles(dir);
  assert.deepEqual(res.order, ["@deepseek-ai/dsh-base", "dsh-a"]);
  await rm(dir, { recursive: true, force: true });
});

test("reorderProfileBundles: drops bundles that left the dependency set", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: { "dsh-a": "^1" },
    dsh: { profile: { bundles: [KERNEL_BASE, "dsh-gone", "dsh-a"] } },
  });
  const res = await reorderProfileBundles(dir);
  assert.deepEqual(res.order, [KERNEL_BASE, "dsh-a"]);
  await rm(dir, { recursive: true, force: true });
});

test("buildDepGraph: edges only between installed bundles", async () => {
  const dir = await makeTempProfile();
  await fakeBundle(dir, "dsh-a", { "dsh-b": "^1", zod: "^3" });
  await fakeBundle(dir, "dsh-b");
  const g = await buildDepGraph(dir, ["dsh-a", "dsh-b", "dsh-missing"]);
  assert.deepEqual([...g.get("dsh-a")], ["dsh-b"]); // zod is not a bundle
  assert.deepEqual([...g.get("dsh-b")], []);
  assert.deepEqual([...(g.get("dsh-missing") ?? [])], []); // manifest unreadable
  assert.deepEqual([...(await buildDepGraph(undefined, ["dsh-a"]))], []);
  await rm(dir, { recursive: true, force: true });
});

test("ensureDshpkgBundle: adds dshpkg by its own manifest name, then re-layers", async () => {
  const dir = await makeTempProfile();
  // dshpkg must be a dependency so the dep filter keeps it after re-layering
  await writeProfileManifest(dir, {
    dependencies: { "dsh-a": "^1", [DSHPKG]: "link:." },
    dsh: { profile: { bundles: [KERNEL_BASE, KERNEL_WEB, "dsh-a"] } },
  });
  await fakeBundle(dir, "dsh-a");
  const ownManifest = JSON.parse(
    await readFile(join(pkgRoot(), "package.json"), "utf8"),
  );
  assert.equal(ownManifest.name, DSHPKG); // guard: the test's assumption

  const res = await ensureDshpkgBundle(dir);
  assert.equal(res.ok, true);
  assert.equal(res.added, true);
  assert.deepEqual(res.order, [KERNEL_BASE, KERNEL_WEB, DSHPKG, "dsh-a"]);
  const written = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.deepEqual(written.dsh.profile.bundles, [KERNEL_BASE, KERNEL_WEB, DSHPKG, "dsh-a"]);
  // second call: already present, nothing added
  const again = await ensureDshpkgBundle(dir);
  assert.equal(again.ok, true);
  assert.equal(again.added, false);
  await rm(dir, { recursive: true, force: true });
});

test("ensureDshpkgBundle: unreadable profile manifest fails with a Chinese error", async () => {
  const dir = await makeTempProfile();
  const res = await ensureDshpkgBundle(dir);
  assert.equal(res.ok, false);
  assert.match(res.error, /profile 清单不可读/);
  assert.ok(!existsSync(join(dir, "package.json.bak"))); // no side effects
  await rm(dir, { recursive: true, force: true });
});

// --- installed-face scan + registration reconciliation (R15) ---------------

test("collectDeclaredBundles: finds scoped and plain bundles, skips the rest", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: {
      "dsh-a": "^1",
      "@scope/dsh-b": "^1",
      "plain-lib": "^1",
      "ghost-missing": "^1",
    },
    dsh: { profile: { bundles: [] } },
  });
  await fakeBundle(dir, "dsh-a", {}, BUNDLE_DECL);
  await fakeBundle(dir, "@scope/dsh-b", {}, BUNDLE_DECL);
  await fakeBundle(dir, "plain-lib"); // no dsh.bundle declaration
  // ghost-missing: no manifest on disk -> contributes nothing
  const found = await collectDeclaredBundles(dir);
  assert.deepEqual(found, ["dsh-a", "@scope/dsh-b"]);
  await rm(dir, { recursive: true, force: true });
});

test("collectDeclaredBundles: disabled/invalid inputs yield []", async () => {
  assert.deepEqual(await collectDeclaredBundles(undefined), []);
  assert.deepEqual(await collectDeclaredBundles(""), []);
  const dir = await makeTempProfile();
  await writeFile(join(dir, "package.json"), "not json{{", "utf8");
  assert.deepEqual(await collectDeclaredBundles(dir), []);
  await rm(dir, { recursive: true, force: true });
});

test("reorderProfileBundles: registers installed bundles the reconciler missed", async () => {
  const dir = await makeTempProfile();
  // dsh-a is installed and declares dsh.bundle, but the official reconciler
  // never added it to bundles (the reported dshpkg-itself failure mode).
  await writeProfileManifest(dir, {
    dependencies: { "dsh-a": "^1" },
    dsh: {
      profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
    },
  });
  await fakeBundle(dir, "dsh-a", {}, BUNDLE_DECL);
  const res = await reorderProfileBundles(dir);
  assert.equal(res.changed, true);
  assert.deepEqual(res.registered, ["dsh-a"]);
  assert.deepEqual(res.order, [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-a",
  ]);
  const written = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.deepEqual(written.dsh.profile.bundles, res.order);
  // second run: idempotent, nothing newly registered
  const again = await reorderProfileBundles(dir);
  assert.equal(again.changed, false);
  assert.deepEqual(again.registered, []);
  await rm(dir, { recursive: true, force: true });
});

test("reorderProfileBundles: a registered bundle-dependency loads before its dependent", async () => {
  const dir = await makeTempProfile();
  // dsh-child depends on dsh-parent; BOTH were missed by the reconciler.
  await writeProfileManifest(dir, {
    dependencies: { "dsh-child": "^1", "dsh-parent": "^1" },
    dsh: {
      profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-child"] },
    },
  });
  await fakeBundle(dir, "dsh-child", { "dsh-parent": "^1" }, BUNDLE_DECL);
  await fakeBundle(dir, "dsh-parent", {}, BUNDLE_DECL);
  const res = await reorderProfileBundles(dir);
  assert.deepEqual(res.registered, ["dsh-parent"]);
  const pos = new Map(res.order.map((n, i) => [n, i]));
  assert.ok(pos.get("dsh-parent") < pos.get("dsh-child"));
  await rm(dir, { recursive: true, force: true });
});

test("planReorder: computes the same plan without writing", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: { "dsh-a": "^1" },
    dsh: {
      profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
    },
  });
  await fakeBundle(dir, "dsh-a", {}, BUNDLE_DECL);
  const before = await readFile(join(dir, "package.json"), "utf8");
  const plan = await planReorder(dir);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.registered, ["dsh-a"]);
  // the manifest is untouched
  assert.equal(await readFile(join(dir, "package.json"), "utf8"), before);
  await rm(dir, { recursive: true, force: true });
});

// --- detectNameDrift / repairNameDrift (R20) -------------------------------

test("detectNameDrift: flags keys whose installed package carries a different name", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: { "@wrong-key/dsh-x": "link:./x", "dsh-ok": "^1" },
    dsh: { profile: { bundles: ["@wrong-key/dsh-x", "dsh-ok"] } },
  });
  await fakeBundle(dir, "@wrong-key/dsh-x");
  // the installed manifest declares a DIFFERENT real name
  await writeFile(
    join(dir, "node_modules", "@wrong-key", "dsh-x", "package.json"),
    JSON.stringify({ name: "@real-name/dsh-x", version: "1.0.0" }, null, 2),
    "utf8",
  );
  await fakeBundle(dir, "dsh-ok");
  const drift = await detectNameDrift(dir);
  assert.deepEqual(drift, [{ key: "@wrong-key/dsh-x", realName: "@real-name/dsh-x" }]);
  await rm(dir, { recursive: true, force: true });
});

test("detectNameDrift: healthy profile reports no drift", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: { "dsh-a": "^1", "dsh-missing": "^1" },
    dsh: { profile: { bundles: ["dsh-a"] } },
  });
  await fakeBundle(dir, "dsh-a"); // dsh-missing is not materialized: not drift
  assert.deepEqual(await detectNameDrift(dir), []);
  await rm(dir, { recursive: true, force: true });
});

test("repairNameDrift: rewrites the key and the bundles entry to the real name", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: { "@wrong-key/dsh-x": "link:./x" },
    dsh: { profile: { bundles: [KERNEL_BASE, "@wrong-key/dsh-x"] } },
  });
  await fakeBundle(dir, "@wrong-key/dsh-x");
  await writeFile(
    join(dir, "node_modules", "@wrong-key", "dsh-x", "package.json"),
    JSON.stringify({ name: "@real-name/dsh-x", version: "1.0.0" }, null, 2),
    "utf8",
  );
  const { repaired } = await repairNameDrift(dir);
  assert.deepEqual(repaired, ["@wrong-key/dsh-x -> @real-name/dsh-x"]);
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@real-name/dsh-x"], "link:./x"); // spec kept
  assert.equal(manifest.dependencies["@wrong-key/dsh-x"], undefined);
  assert.ok(manifest.dsh.profile.bundles.includes("@real-name/dsh-x"));
  assert.ok(!manifest.dsh.profile.bundles.includes("@wrong-key/dsh-x"));
  await rm(dir, { recursive: true, force: true });
});

test("repairNameDrift: refuses to clobber an existing dependency with the real name", async () => {
  const dir = await makeTempProfile();
  await writeProfileManifest(dir, {
    dependencies: { "@wrong-key/dsh-x": "link:./x", "@real-name/dsh-x": "^2" },
    dsh: { profile: { bundles: ["@wrong-key/dsh-x"] } },
  });
  await fakeBundle(dir, "@wrong-key/dsh-x");
  await writeFile(
    join(dir, "node_modules", "@wrong-key", "dsh-x", "package.json"),
    JSON.stringify({ name: "@real-name/dsh-x", version: "1.0.0" }, null, 2),
    "utf8",
  );
  const { repaired } = await repairNameDrift(dir);
  assert.deepEqual(repaired, [], "the existing real-name dependency wins");
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@real-name/dsh-x"], "^2");
  await rm(dir, { recursive: true, force: true });
});
