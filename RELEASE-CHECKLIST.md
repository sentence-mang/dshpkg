# dshpkg 发布检查清单（RELEASE-CHECKLIST）

> 无人值守开发期间**不执行任何发布动作**（npm publish / 建仓库 / 注册系统任务）。
> 本清单供用户在有意发布时逐项核对；每一项都有明确证据要求。

## 补验结果（2026-08-27，总监记录）

- [x] **supervisor 取消用例真实环境复跑（完成）**：权限放开后以**默认隔离**（真实进程环境）复跑——
      `node --test tests/supervisor.test.js` **56/56 通过、0 取消**；`tests/protect.test.js` **11/11 通过、0 取消**。
      **13 个取消用例在真实进程环境全部通过**，SIGINT 中止机制行为符合预期；取消仅存在于沙箱
      `--test-isolation=none` 同进程模式（runner 事件循环排空检查），与代码无关（HEAD 基线对照证实）。
- [x] **minisign 真实工具交叉验证（完成）**：下载 minisign **0.12**（win64）真实二进制，
      生成真实密钥对并对 canonical 配方签名，双向验证全部通过：
      - **legacy 格式（`-l`，算法 "Ed" 0x45 0x64）**：`verifyRecipeSig` 端到端 valid ✓；
      - **prehash 格式（0.12 默认，算法 "ED" 0x45 0x44）**：黑盒确定签名消息 = **BLAKE2b-512(canonical 字节)**，
        已实现 "ED" 分支并验证 valid ✓（0.12 默认签名现可直接验签）；
      - 篡改载荷 → invalid（fail-closed）✓。
      真实向量已固化进 `tests/recipe.test.js`（GOLDEN_* 常量，48 用例全绿）。
- [x] **README 命令表核对**：helpText 实际输出 29 个命令入口，README 表格已对齐（标题 26→29）。

## 发布前必须由用户决策的项（资产风险）

- [ ] **npm 发布**：package.json 目前 `"private": true`（防误发）。
      - 需要：把 `private` 改为 `false`（或移除），确认包名 `dshpkg` 未被占用；
      - 执行 `npm publish`（或 pnpm publish）——这是**发布动作**，由用户执行；
      - 发布后核对：`npm view dshpkg` 版本号、`dshpkg --version`/`help` 可用。
- [ ] **社区配方仓库 URL**：`lib/defaults.js` 的占位 URL（github.com/OWNER/dsh-community）
      需替换为真实仓库（批准决议：发布前由用户定最终 URL）。
      **当前状态：保持占位 + TODO**；`dshpkg repo init` 支持 `DSH_DEFAULT_REPOS` 环境变量注入
      （JSON 数组），构建/部署脚本可借此注入真实 URL，无需改代码。上线前必须替换。
- [ ] **看门狗计划任务注册**：`dshpkg daemon install` 会写 Windows 计划任务——
      属于系统级改动，由用户决定是否注册（默认不注册）。

## 系统级安装验收（新增，daemon 注册后执行）

- [ ] 以**管理员权限**运行 `dshpkg daemon install`，核对：
      - 任务名 `dshpkg-supervisor` 创建成功（`schtasks /Query /TN dshpkg-supervisor`）；
      - 触发器：每 5 分钟（/SC MINUTE /MO 5）；执行命令含 supervisor.ps1 绝对路径与目标 profile；
      - 手动运行任务一次：dsh 被拉起、探活通过、日志出现 healthy；
      - 杀掉看门狗进程后 5 分钟内自动重新拉起（单实例锁防重复）；
      - 回滚路径：`dshpkg daemon uninstall`（或 `schtasks /Delete /TN dshpkg-supervisor /F`）后
        确认任务消失、系统无残留进程。

## 发布前自动检查项（可直接跑）

- [ ] `node --check` 全部 lib/bin 文件通过（`npm run check`）
- [ ] 全量测试通过：沙箱下逐文件 `node --test --test-isolation=none tests/*.test.js`
      （通过口径 pass；supervisor/protect 的 13 个取消用例为沙箱 runner 环境性行为，
      需在真实环境以默认隔离复跑确认）
- [ ] 真实环境补验（有 minisign 工具的环境）：
      - minisign 真实工具生成的 golden-vector 与 `verifyRecipeSig` 交叉验证（signing.md §7）
- [ ] README.md / CHANGELOG.md 与本版本一致
- [ ] git 工作树改动清单核对：无未授权文件（`git status` + `git diff --stat`）

## 版本流程（用户执行）

1. 改 package.json version → CHANGELOG 补版本条目 → commit
2. 打 tag（如 v0.1.0）
3. 发布 npm + 建立/更新社区配方仓库（含签名公钥 `pubkeys/<keyId>.pub`）
4. 安装冒烟：`pnpm add -g dshpkg` → `dshpkg repo init` → `dshpkg update` → `dshpkg list`
5. 可选：`dshpkg daemon install` 注册看门狗
