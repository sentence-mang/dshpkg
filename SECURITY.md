# Security（dshpkg 安全模型）

## 威胁模型

dshpkg 管理 DeepSeek Harness profile 的插件安装。核心防护目标是**供应链攻击**：
配方仓库/索引/插件包在传输或托管中被篡改时，安装流程必须能识别并拒绝。

## 信任模型（Phase 3，minisign）

- **签名**：配方发布者可对配方（去掉 `signatures` 字段的 canonical JSON）做 minisign（Ed25519）签名；
  验签完全在本地用 `node:crypto` 完成，用户机器无需安装 minisign。
- **公钥来源（两者取并集）**：
  1. 仓库内置：每个配方仓库根目录 `pubkeys/<keyId>.pub`，`dshpkg sync` 时缓存到
     `<stateRoot>/pubkeys/`；
  2. 用户信任集：`dshpkg key add` 显式信任（`trusted-keys.json`）。
- **无 TOFU**：首次遇到的 keyId **默认不信任**。必须"公钥来自用户主动添加的仓库"或
  "用户显式 `key add`"才可信。
- **安装决策**：
  - 签名有效 + 公钥可信 → 自动放行（展示 ✓）；
  - 签名无效 → **拒绝**（`--yes` 也不放行，fail-closed，绝不误放行）；
  - 未签名 → 交互确认或 `--yes`；`pin.allow: true` 的配方按**仓库级信任**提示后放行
    （来源信息始终展示，不静默）；
  - 公钥缺失 → 按未签名处理（需人工确认）。

## 其他安全机制

- **REST 鉴权**：/dshpkg 写路由全部要求 `x-dshpkg-token`（随机 32 字节，文件 mode 0600，
  timingSafeEqual 比对）；无 Origin 或无 socket 信息的请求不再默认信任。
- **原型污染防护**：`state.packages` 等对象键读写拒绝 `__proto__/constructor/prototype`。
- **注入防护**：配方/仓库名白名单、git 参数 `--` 分隔符、YAML 注入转义、`homepage` 仅 http(s)。
- **自愈兜底**：崩溃事件流落盘、3 连败熔断、快照恢复链（最新→前一份→出厂基线）、
  lockfile 哈希校验与 `--frozen-lockfile` 重建、state.json 损坏自愈（隔离 .corrupt + 事件告警）。

## 已知边界（诚实声明）

- **verify 等级是发布者自报**：无签名时 `verify.level/label` 仅作展示参考，不构成安全背书
  （R1 去中心化后的固有边界，签名是 R6 的补强）。
- **canonical 化**：验签基于发布原文的 canonical JSON（键序排序、无空白、无 BOM）；
  发布者签名工具必须与 `lib/recipe.js canonicalJson` 完全一致，否则签名必然失效。
- **golden-vector**：当前测试用 node:crypto 自生成向量 + 独立字节偏移二次实现交叉验证；
  与真实 `minisign` 工具的交叉验证待可联网环境补做（见 RELEASE-CHECKLIST.md）。
- **密钥管理**：`key add` 信任的公钥需人工核对指纹；误信任恶意公钥 = 信任其名下所有签名。

## 漏洞报告

发现安全问题请提交 issue 或联系维护者（发布后补联系方式）。修复按 fail-closed 原则：
宁可拒绝安装，绝不误放行。
