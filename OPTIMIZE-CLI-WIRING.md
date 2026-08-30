# optimize 命令 CLI 接线规格（待集成阶段应用）

> 状态：`lib/perf.js` 模块与 `tests/perf.test.js` 单测已完成并通过（18 过 / 1 跳过）。
> 按多 AI 并行开发约定（禁止直接改共享核心文件 `bin/dshpkg.js`），CLI 接线**不在本分支执行**，
> 由集成阶段一次性并入。本文件是精确的接线手册 + 就绪测试。

## 一、lib/perf.js 契约（已实现）

```js
export async function measureCompose(profile, { dshRun, clock } = {})
// -> { ok, ms, status, error }；dshRun: (args)=> {status,stdout,stderr,error?}

export function scorePlugins(state, { sizes = {}, now = Date.now() } = {})
// -> Array<{ name, score, reasons: string[], circuitOpen, crashCount, held, bytes }> 已按 score 降序
// 打分：circuitOpen +60；crashCount>0 → min(n,10)*5；bytes≥20MB +20 / ≥5MB +5；held 仅标记

export async function dirSize(path)              // -> Promise<number> bytes，错误返回 0
export async function cacheStats({ root } = {})  // -> { snapshotsBytes, snapshotCount, gitBytes, managedBytes, indexBytes, totalBytes }
export function mb(bytes)                        // -> number，bytes/1048576 保留 1 位小数
```

## 二、bin/dshpkg.js 接线点（共 6 处，全部增量）

### 1. import（约 36-58 行 import 块之后）

```js
import { measureCompose, scorePlugins, dirSize, cacheStats, mb } from "../lib/perf.js";
```

### 2. 新增 cmdOptimize（放在 cmdLog 附近）

```js
async function cmdOptimize(ctx, args, opts) {
  try {
    const state = await readState();
    const profile = opts.profile ?? state.profile ?? "web";
    const profileDir = await resolveProfileDir(profile);

    ctx.log(`[性能诊断] profile: ${profile}`);
    const comp = await measureCompose(profile, { dshRun: ctx.dshRun });
    ctx.log(`组合耗时(--dump-config): ${comp.ok ? `${comp.ms}ms` : "失败"}${comp.ok ? "" : `（${comp.error ?? "?"}）`}`);

    const cache = await cacheStats();
    ctx.log(`缓存占用: 快照 ${cache.snapshotCount} 份 ${mb(cache.snapshotsBytes)}MB · git ${mb(cache.gitBytes)}MB · managed ${mb(cache.managedBytes)}MB · index ${mb(cache.indexBytes)}MB（共 ${mb(cache.totalBytes)}MB）`);

    const sizes = {};
    if (profileDir) {
      for (const name of Object.keys(state.packages ?? {})) {
        const s = await dirSize(join(profileDir, "node_modules", name));
        if (s > 0) sizes[name] = s;
      }
    }
    const scores = scorePlugins(state, { sizes });

    const unstable = scores.filter(
      (e) => (e.circuitOpen || e.crashCount >= 3) && !e.held && !isProtected(e.name),
    );

    const top = scores.filter((e) => e.score > 0).slice(0, 8);
    if (top.length === 0) ctx.log("未发现高负载/不稳定插件，当前配置较健康。");
    else {
      ctx.log(`高负载/不稳定插件 Top ${top.length}:`);
      for (const e of top) ctx.log(`  ${e.name}（评分 ${e.score}）: ${e.reasons.join("、") || "—"}`);
    }
    if (unstable.length > 0) {
      ctx.log(`建议禁用的不稳定插件（${unstable.length} 个）: ${unstable.map((e) => e.name).join("、")}`);
      if (!opts.apply) ctx.log("提示: 加 --apply 自动禁用上述插件（写 cordis.patch.yml 禁用块，重启 dsh 后生效，可逆）。");
    }

    if (opts.apply && unstable.length > 0) {
      if (!profileDir) throw new Error(`找不到 profile "${profile}"（目录不存在或缺少 dsh.profile 声明）`);
      const patchFile = join(profileDir, "cordis.patch.yml");
      let text = await readTextOrEmpty(patchFile);
      let changed = 0;
      for (const e of unstable) {
        const updated = applyDisableToPatch(text, e.name);
        if (updated !== text) { text = updated; changed += 1; }
      }
      if (changed > 0) {
        await writeFile(patchFile, text, "utf8");
        ctx.log(`已禁用 ${changed} 个不稳定插件（写入 ${profile} 的 cordis.patch.yml，重启 dsh 后生效；dshpkg enable <名称> 可恢复）`);
      } else {
        ctx.log("这些插件已在禁用状态，无需改动。");
      }
    }
    return 0;
  } catch (err) {
    ctx.error(`错误: ${err?.message ?? err}`);
    return 1;
  }
}
```

### 3. COMMANDS Map（["log", cmdLog] 之后）

```js
  ["optimize", cmdOptimize],
```

### 4. helpText() 命令列表加一行

```
  "  optimize [--apply]         性能诊断：测量组合耗时、标记高负载/不稳定插件、报告缓存占用（--apply 自动禁用不稳定插件）",
```

### 5. KNOWN_FLAGS 加 "--apply"

### 6. parseArgs：opts 初始对象加 `apply: false,`，循环里加

```js
    if (arg === "--apply") { opts.apply = true; continue; }
```

## 三、就绪测试 tests/optimize.test.js（接线后启用）

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, parseArgs } from "../bin/dshpkg.js";
import { readState, writeState } from "../lib/state.js";

function captureIo(overrides = {}) {
  const logs = [], errors = [];
  return { io: { log: (...a) => logs.push(a.join(" ")), error: (...a) => errors.push(a.join(" ")), ...overrides }, logs, errors };
}
async function makeEnv(t, { packages = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "dshpkg-opt-home-"));
  const root = await mkdtemp(join(tmpdir(), "dshpkg-opt-state-"));
  process.env.DSH_HOME = home; process.env.DSH_PKG_HOME = root;
  if (t && typeof t.after === "function") t.after(() => { delete process.env.DSH_HOME; delete process.env.DSH_PKG_HOME; });
  const profileDir = join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "package.json"), JSON.stringify({ name: "web-profile", version: "1.0.0", dsh: { profile: true } }));
  if (Object.keys(packages).length) await writeState({ ...(await readState()), packages });
  return { home, root, profileDir };
}
function fakeDshRun() { const calls = []; return { calls, dshRun: (a) => { calls.push([...a]); return { status: 0, stdout: "", stderr: "" }; } }; }

test("parseArgs recognizes --apply for optimize", () => {
  const o = parseArgs(["optimize", "--apply"]);
  assert.equal(o.command, "optimize"); assert.equal(o.apply, true);
});
test("optimize without --apply reports diagnostics and exits 0", async () => {
  await makeEnv(globalThis, { packages: { ok: { source: "npm", version: "1.0.0", crashCount: 0, crashTimes: [], held: false } } });
  const { io, logs } = captureIo(); const { dshRun } = fakeDshRun();
  assert.equal(await runCli(["optimize"], { ...io, dshRun }), 0);
  const text = logs.join("\n");
  assert.ok(text.includes("[性能诊断]")); assert.ok(text.includes("组合耗时")); assert.ok(text.includes("缓存占用"));
});
test("optimize --apply disables unstable and skips protected", async () => {
  const { profileDir } = await makeEnv(globalThis, { packages: {
    slow: { source: "npm", version: "1.0.0", crashCount: 5, crashTimes: [], held: false },
    loader: { source: "npm", version: "1.0.0", crashCount: 9, crashTimes: [], held: false },
  } });
  const { io, logs } = captureIo(); const { dshRun } = fakeDshRun();
  assert.equal(await runCli(["optimize", "--apply"], { ...io, dshRun }), 0);
  const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  assert.ok(patch.includes("dshpkg:managed:start")); assert.ok(patch.includes("slow"));
  assert.ok(!patch.includes("loader")); assert.ok(logs.join("\n").includes("已禁用"));
});
test("optimize with no packages reports healthy and exits 0", async () => {
  await makeEnv(globalThis, { packages: {} });
  const { io, logs } = captureIo(); const { dshRun } = fakeDshRun();
  assert.equal(await runCli(["optimize"], { ...io, dshRun }), 0);
  assert.ok(logs.join("\n").includes("未发现高负载/不稳定插件"));
});
```

## 四、接线后验证

```powershell
node --check bin/dshpkg.js
node --test --test-isolation=none tests/optimize.test.js tests/perf.test.js
```
