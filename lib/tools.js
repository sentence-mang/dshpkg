// dshpkg — model tool handlers + install guard section (Spec section 8).
//
// Everything here is dependency-injected and host-agnostic so it can be
// unit-tested without a live cordis host:
//   - buildGuardSection() renders the Chinese install-guard rule text injected
//     into the system prompt;
//   - createToolHandlers({search, install, toggle}) returns the three
//     plugin_* handler functions the tool registry executes;
//   - buildToolDefinitions(handlers) shapes them into @deepseek-ai/dsh-tools
//     ToolDefinition-like objects ({name, description, parameters, execute,
//     output}) — the real registry contract is honored defensively: the host
//     wraps registration in try/catch and skips silently when the shape
//     differs.
//
// Zero third-party dependencies: parameter schemas are plain JSON Schema
// objects and the output renderer emits {type:"text"} content blocks.

/**
 * The install-guard rule section (Chinese, model-facing). Injected into the
 * system prompt via SystemPrompt.section() when the service exists.
 *
 * @returns {string}
 */
export function buildGuardSection() {
  return [
    "## dshpkg 插件管理规则（必须遵守）",
    "- 插件安装必须走 dshpkg CLI 或 plugin_* 工具（plugin_search / plugin_install / plugin_toggle）；",
    "- 禁止直接执行裸 dsh plugin / pnpm add 命令安装插件；",
    "- 安装前先用 plugin_search 搜索确认；卸载、禁用与故障恢复同样通过 dshpkg 进行。",
  ].join("\n");
}

/** Format one search hit into a one-line Chinese summary. */
function summarizeHit(item, index) {
  const name = String(item?.name ?? item?.packageName ?? item?.key ?? "?");
  const pkg = item?.packageName && item.packageName !== name ? `（${item.packageName}）` : "";
  const desc = item?.description ? ` — ${String(item.description).slice(0, 80)}` : "";
  const marker = item?.installed ? "【已安装】" : "";
  return `${index + 1}. ${name}${pkg}${desc} ${marker}`.trim();
}

/**
 * Build the three plugin_* handlers. Every dependency is injected so tests
 * can drive them with fakes:
 *   - search(query) -> Promise<Array<item>>  (lib/search.js search)
 *   - install(name)  -> Promise<result>      (lib/transaction.js install)
 *   - toggle(name)   -> Promise<result>      (host enable/disable flip)
 * All handlers are total: missing/invalid arguments return {ok:false} and a
 * throwing dependency is caught and normalized — never throw outward.
 *
 * @param {{search?: Function, install?: Function, toggle?: Function}} deps
 * @returns {{plugin_search: Function, plugin_install: Function, plugin_toggle: Function}}
 */
export function createToolHandlers({ search, install, toggle } = {}) {
  const plugin_search = async (args) => {
    const query = String(args?.query ?? "").trim();
    if (!query) return { ok: false, error: "缺少 query 参数" };
    try {
      const raw = typeof search === "function" ? await search(query) : [];
      const items = Array.isArray(raw) ? raw : [];
      const top = items.slice(0, 10).map(summarizeHit);
      if (top.length === 0) return { ok: true, query, count: 0, list: [], hint: "本地索引中没有匹配项，可用 dshpkg sync 刷新索引或换关键词" };
      return { ok: true, query, count: top.length, list: top };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  };

  const plugin_install = async (args) => {
    const name = String(args?.name ?? "").trim();
    if (!name) return { ok: false, error: "缺少 name 参数" };
    if (typeof install !== "function") return { ok: false, error: "安装通道不可用（无 transaction 实现）" };
    try {
      return await install(name);
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  };

  const plugin_toggle = async (args) => {
    const name = String(args?.name ?? "").trim();
    if (!name) return { ok: false, error: "缺少 name 参数" };
    if (typeof toggle !== "function") return { ok: false, error: "启停通道不可用（无 loader）" };
    try {
      return await toggle(name);
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  };

  return { plugin_search, plugin_install, plugin_toggle };
}

/**
 * A permissive canonical-output contract: accepts any JSON value and renders
 * it as plain text content blocks for the model. The schema declares a
 * single "object" type because the current dsh-tools registry rejects type
 * ARRAYS ("schema.type must be a single type string"); the render function
 * still stringifies every value shape.
 */
function textOutput() {
  return {
    schema: { type: "object" },
    render: (_args, value) => [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? null) },
    ],
  };
}

/**
 * Shape the handlers into ToolDefinition-like objects for the dsh-tools
 * registry (name / description / parameters / execute / output). The host
 * registers each one defensively — a mismatched registry shape skips
 * registration instead of throwing.
 *
 * @param {{plugin_search: Function, plugin_install: Function, plugin_toggle: Function}} handlers
 * @returns {Array<object>}
 */
export function buildToolDefinitions(handlers) {
  return [
    {
      name: "plugin_search",
      description:
        "搜索 dsh 插件（离线本地索引）。返回前 10 条中文摘要：名称、描述与是否已安装。安装前先搜索确认来源。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词（插件名或主题）" },
        },
        required: ["query"],
      },
      execute: (args) => handlers.plugin_search(args),
      output: textOutput(),
    },
    {
      name: "plugin_install",
      description:
        "通过 dshpkg 事务安装 dsh 插件：依赖闭包 → 预检 → 安装 → 冒烟，任一步失败自动回滚。禁止用裸 dsh plugin / pnpm add 代替。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "插件名或安装规格（如 dsh-plugin-x@1.0.0）" },
        },
        required: ["name"],
      },
      execute: (args) => handlers.plugin_install(args),
      output: textOutput(),
    },
    {
      name: "plugin_toggle",
      description:
        "启用或禁用 dsh loader 条目（按当前状态翻转）。核心条目（loader / include 等）受保护，调用会被拒绝。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "loader 条目 id（如 dsh-web-plugin-manager）" },
        },
        required: ["name"],
      },
      execute: (args) => handlers.plugin_toggle(args),
      output: textOutput(),
    },
  ];
}

/**
 * CommandDefinition-shaped registration for the /dshpkg slash command
 * (dsh-commands registry). The handler renders a Chinese help card with the
 * core plugin_* workflow and points at `dshpkg --help` for the full CLI.
 */
export function buildCommandDefinition(handlers) {
  return {
    name: "dshpkg",
    description: "dshpkg 插件管理器：搜索 / 安装 / 启停 dsh 插件（apt 风格）",
    input: { description: "子命令或插件名（可选）" },
    recordInput: true,
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? "").trim();
      const [verb, ...rest] = raw.split(/\s+/).filter(Boolean);
      const arg = rest.join(" ").trim();
      try {
        if (verb === "search" || verb === "s") {
          if (!arg) return { kind: "success", text: "用法: /dshpkg search <关键词>（离线本地索引）" };
          const result = await handlers.plugin_search({ query: arg });
          if (!result.ok) return { kind: "success", text: `搜索失败：${result.error}` };
          if (result.count === 0) return { kind: "success", text: result.hint ?? "没有匹配项" };
          return { kind: "success", text: `找到 ${result.count} 个插件：\n${result.list.join("\n")}` };
        }
        if (verb === "install" || verb === "i") {
          if (!arg) return { kind: "success", text: "用法: /dshpkg install <插件名>" };
          const result = await handlers.plugin_install({ name: arg });
          return result.ok
            ? { kind: "success", text: `已安装: ${(result.installed ?? []).join(", ")}` }
            : { kind: "success", text: `安装失败：${result.error ?? "?"}` };
        }
        if (verb === "toggle" || verb === "t") {
          if (!arg) return { kind: "success", text: "用法: /dshpkg toggle <条目 id>" };
          const result = await handlers.plugin_toggle({ name: arg });
          if (result.protected) return { kind: "success", text: result.reason };
          return result.ok
            ? { kind: "success", text: `已${result.disabled ? "禁用" : "启用"}条目 ${result.name}` }
            : { kind: "success", text: `操作失败：${result.error ?? "?"}` };
        }
        return {
          kind: "success",
          text: "/dshpkg 子命令：\n  search <关键词>  搜索插件（离线索引）\n  install <名称>   事务安装（失败自动回滚）\n  toggle <条目id>  启用/禁用 loader 条目\n完整 CLI 见终端 dshpkg --help",
        };
      } catch (err) {
        return { kind: "success", text: `dshpkg 命令执行失败：${String(err?.message ?? err)}` };
      }
    },
  };
}

export default { buildGuardSection, createToolHandlers, buildToolDefinitions, buildCommandDefinition };
