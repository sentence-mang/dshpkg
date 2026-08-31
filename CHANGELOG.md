# CHANGELOG

dshpkg 版本记录。格式：[Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [Unreleased] - 测试开发阶段

> ⚠️ 当前处于**测试开发阶段**，尚未完成真实环境端到端验证，接口与行为可能调整。

### 新增

- **bundles 顺序编排**（`lib/order-bundles.js`）：安装后自动重排 `dsh.profile.bundles`——内核 → 守护层 → 依赖拓扑序，修复"新插件追加末尾导致加载时序错乱"的核心问题
- **bootguard**（`lib/bootguard.js`）：boot 守护层
- **portcheck**（`lib/portcheck.js`）：端口占用检测与清理
- **doctor reconcile**：`dshpkg doctor --fix` 校验并修复依赖缺失、注册与分层
- **install harnessRange 校验**：安装前校验配方与 harness 版本兼容性（`--force` 覆盖）
- **串行测试脚本**（`scripts/run-tests.js`）：规避 Node 并发 test runner 的偶发 deserialize 问题

### 变更

- `daemon` 命令已移除（dshpkg 不碰系统级注册，守护收敛为 bundle 内进程守护）

## [0.1.0-rc.1] - 2026-08-27（预发布候选）

### Breaking Changes（升级注意）

- **安装信任闸门（Phase 3）**：配方安装新增签名检查与确认流——非交互环境安装**未签名**且无 `pin.allow` 的配方必须显式 `--yes`，否则拒绝（此前直接安装）。脚本/CI 中 `dshpkg install <配方名>` 需补 `--yes` 或为配方配置 `pin.allow: true`。
- **默认同步不再请求 dsh.so（Phase 2）**：`dshpkg update` 只拉 GitHub/npm/awesome 三个公共源；需要 dsh.so 索引的用户用 `repo add <dshso-url> --format index` 显式添加。
- **repo 条目带 format 字段**：repos.json 每条新增 `format`（缺省 `"git"`），旧配置无需迁移（读取时缺省兼容）。

### Phase 0 — 安全止血（已完成）

- REST /dshpkg 全部写路由鉴权（x-dshpkg-token，随机 32 字节，api-token 文件 mode 0600，timingSafeEqual 比对）
- 原型污染拦截：`recordCrash`/`isOpen`/`closeCircuit` 与所有 state.packages 键读写拒绝 `__proto__/constructor/prototype`
- YAML 注入：`yamlSafeId` 统一（CLI 与 supervisor 同款转义），entryId 白名单
- 路径/参数加固：repo 名白名单、git clone/fetch 加 `--` 分隔符、sync 复校验 repos.json、profile 名白名单

### Phase 1 — 自愈接线（已完成）

- supervisor 事件流落盘 incidents.jsonl（六类事件全落盘，轮转保留 2000 条）
- 崩溃记账落盘：`recordCrash` 写入 state.packages，3 连败开闸持久化 circuitOpenAt
- 自动快照三触发点：安装冒烟通过后 / supervisor healthy 后 / 写禁用块前
- `dshpkg audit/log` 由此获得真实数据

### Phase 2 — 无服务器化（已完成）

- 默认同步不再请求 dsh.so（可 `repo add --format index` 显式启用）
- 配方元数据：description / maintainer / homepage（强制 http(s)）/ license / tags
- 发布者静态索引源（`dshpkg-index/v1`），与 git 配方仓库统一为 source
- 自动轮询：24h 间隔 + 指数退避（封顶 24h）+ 3 连败暂停 + sync.lock 互斥 + supervisor 空闲窗口集成
- 默认社区仓库：`dshpkg repo init`（DSH_DEFAULT_REPOS 可覆盖）

### Phase 3 — 信任与兜底（已完成）

- minisign 配方签名验签（node:crypto Ed25519；canonicalJson 对发布原文验签；SSH 槽位二期）
- 安装信任闸门：有效+可信自动放行 / 无效 fail-closed / 未签名需确认或 --yes
- `dshpkg key add/list/remove` 显式信任集 + 仓库 pubkeys 同步
- `GET /dshpkg/selfcheck` 宿主自检端点
- 无法归因兜底：快照恢复链（最新→前一份→出厂基线）+ lockfile 哈希校验与 `pnpm install --frozen-lockfile` 重建

### Phase 4 — 自举与发布（实现中）

- state.json 损坏自愈：隔离 .corrupt + 重建默认 + 事件告警
- supervisor 单实例互斥锁（supervisor.lock）
- `dshpkg self-upgrade` 事务化升级（快照 + 冒烟 + 失败回退）
- `dshpkg daemon install/uninstall/status`（Windows 计划任务，每 5 分钟拉起看门狗）

### 依赖管理自动化（2026-08-27 补强）

- **依赖闭包递归展开**：配方的字符串依赖经配方库递归解析——依赖的依赖自动安装，
  不再需要人工逐个补齐；无配方的依赖保持裸安装（pnpm 原生解析其声明依赖）
- **`doctor --fix`**：一键自动安装依赖图中所有缺失依赖（按配方版本）
- **`dshpkg autoremove`**：孤儿包（已装、非 bundle、无任何已装包引用）一键清理，
  `--dry-run` 演练；bundle 与仍被引用的包永不触碰
