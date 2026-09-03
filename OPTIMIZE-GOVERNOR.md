# dshpkg 资源治理（Resource Governor）— 设计与接线规格

> 目标（用户 2026-08-31）：dshpkg 能对整个 dsh 做插件维度的优化——资源占用更小、响应更快、
> 插件再多也稳、内存占用可预期（默认预算 **500MB**）。
>
> 状态：决策层已实现并单测通过（`lib/governor.js` + `lib/perf.js` 内存部分）。
> 按多 AI 并行约定（禁止直接改共享核心文件 `bin/dshpkg.js`、`lib/transaction.js` 等），
> 本文件是**接线手册**，集成阶段一次性并入。当前分支只含纯函数模块 + 测试。

## 一、已实现模块（本分支交付）

### lib/perf.js 新增
- `DEFAULT_MEMORY_BUDGET = 500 * 1024 * 1024`（500 MiB，可配置）
- `sampleMemory({ memoryUsage })` → `{rss, heapUsed, heapTotal, external, arrayBuffers}`（DI 封装 process.memoryUsage）
- `memoryBudget({ memory, budget })` → `{rss, budget, ratio, remaining, over, pct}`

### lib/governor.js（新，纯决策，零依赖）
- `budgetLevel({ rss, budget })` → `"green" | "yellow" | "red"`（`<70%` / `<100%` / `≥100%`）
- `reliefCandidates({ scores, isProtected, heldNames, limit=3 })` → 最重、空闲、非保护、非 held 插件排序建议
- `evictionPlan({ rss, budget, scores, isProtected, heldNames, limit })` → 红区时给 `{kind:"disable", name, reason}` 可逆动作
- `composeBundleOrder({ bundles, deps, guardNames })` → `{ordered, missing, cycles}`：守护/基础层前置 + 依赖拓扑排序（Kahn），环与未知依赖只追加不丢弃

测试：`tests/governor.test.js`（+ perf 内存部分），**42 用例 41 过 1 跳过**（跳过项为沙箱 symlink 权限，非本模块）。

## 二、设计要点与边界

1. **边界（守住 dshpkg 插件管理器定位）**：只治理 dsh 自身进程内存与自身插件集合；不写系统注册、不常驻服务、不硬性截杀进程。500MB 是**治理预算**（触发分档与建议的阈值），不是进程强制上限——进程级硬限属于 dsh 核心/宿主职责。
2. **默认只测量、只建议**：红区卸载是**建议**，实际写 `cordis.patch.yml` 禁用块仅在：
   - CLI 显式 `--apply`，或
   - 宿主 governor 配置显式开启（如 `dshpkg.governor.autoRelief: true`）。
3. **永不动**：核心保护名单（`lib/protect.js` `isProtected`）、`held` 插件、字节未知的插件。一切可逆（`dshpkg enable <名称>`）。
4. **稳定性优先**：bundle 编排只**重排不丢包**；环（cycles）与缺失依赖（missing）作为诊断输出，由集成层决定告警。

## 三、接线规格（集成阶段应用，按需取舍）

### 1. CLI `dshpkg optimize` 增加内存治理输出
在既有 cmdOptimize（见 `OPTIMIZE-CLI-WIRING.md`）中补充：
- 采样：`const mem = await sampleMemory();` → `const b = memoryBudget({ memory: mem });`
- 输出：`内存: RSS ${mb(b.rss)}MB / 预算 ${mb(b.budget)}MB（${b.pct}%） 档位 ${budgetLevel({rss:b.rss,budget:b.budget})}`
- `--apply` 时：先走既有不稳定禁用，再 `evictionPlan({...})` 若 `level==="red"` 且 `opts.budget` 或配置允许，按 actions 写禁用块（复用 `applyDisableToPatch`）。
- 新增标志：`--budget <MB>`（覆盖默认 500MB）。

### 2. install 后 bundles 重排（解决加载顺序失控根因）
在 `lib/transaction.js` 安装成功冒烟后（集成阶段）：
1. `readProfileBundles(profileDir)` → 取 `{bundles, deps}`（deps 现读 package.json dependencies 或配方声明依赖）。
2. `composeBundleOrder({ bundles, deps })` → `ordered`。
3. 若 `ordered` 与当前顺序不同，写回 `dsh.profile.bundles`（先备份原值），再跑 `dsh --profile X --dump-config` 冒烟；失败回滚原顺序。

### 3. 宿主定时采样（lib/index.js，可选，默认关闭）
- `setInterval` 采样 `sampleMemory()`（间隔默认 60s），`budgetLevel` 进入 `red` 且 `config.governor.autoRelief` 为真时：执行 `evictionPlan` 并 `applyDisableToPatch` 写禁用块 + `appendIncident` 记录事件。
- 卸载钩子清理 interval；宿主不可用时（headless）静默跳过（防御式，同现有工具注册风格）。

## 四、验证

```powershell
node --check lib/perf.js lib/governor.js
node --test --test-isolation=none tests/governor.test.js tests/perf.test.js
# 期望：42 用例 41 过 1 跳过（跳过项 = 沙箱 symlink 权限）
```
