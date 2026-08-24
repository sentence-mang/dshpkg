// dshpkg — model tool handlers / guard section / command definition tests
// (Spec section 8). All handlers are driven with fake injected dependencies —
// zero network, zero cordis, zero real state.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGuardSection,
  createToolHandlers,
  buildToolDefinitions,
  buildCommandDefinition,
} from "../lib/tools.js";

// --- buildGuardSection ------------------------------------------------------

test("guard section carries the mandatory install-guard rules", () => {
  const text = buildGuardSection();
  assert.ok(text.includes("插件安装必须走 dshpkg CLI 或 plugin_* 工具"));
  assert.ok(text.includes("禁止直接执行裸 dsh plugin / pnpm add 命令"));
  assert.ok(text.includes("plugin_search"));
  assert.ok(text.includes("plugin_install"));
  assert.ok(text.includes("plugin_toggle"));
});

// --- createToolHandlers: plugin_search ---------------------------------------

test("plugin_search returns top-10 Chinese summaries from the injected search", async () => {
  const hits = Array.from({ length: 15 }, (_, i) => ({
    name: `plugin-${i}`,
    packageName: `dsh-plugin-${i}`,
    description: `第 ${i} 号测试插件`,
    installed: i % 2 === 0,
  }));
  const handlers = createToolHandlers({ search: async () => hits });

  const result = await handlers.plugin_search({ query: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.count, 10);
  assert.equal(result.list.length, 10);
  assert.ok(result.list[0].startsWith("1. plugin-0"));
  assert.ok(result.list[0].includes("第 0 号测试插件"));
  assert.ok(result.list[0].includes("【已安装】"));
  assert.ok(!result.list[1].includes("【已安装】"));
});

test("plugin_search reports empty indexes with a hint", async () => {
  const handlers = createToolHandlers({ search: async () => [] });
  const result = await handlers.plugin_search({ query: "ghost" });
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.ok(String(result.hint).includes("dshpkg sync"));
});

test("plugin_search rejects a missing query without calling search", async () => {
  let calls = 0;
  const handlers = createToolHandlers({
    search: async () => {
      calls += 1;
      return [];
    },
  });
  const result = await handlers.plugin_search({});
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("query"));
  assert.equal(calls, 0);
});

test("plugin_search normalizes a throwing search into {ok:false}", async () => {
  const handlers = createToolHandlers({
    search: async () => {
      throw new Error("index broken");
    },
  });
  const result = await handlers.plugin_search({ query: "x" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("index broken"));
});

// --- createToolHandlers: plugin_install --------------------------------------

test("plugin_install forwards to the injected install and passes the result through", async () => {
  const calls = [];
  const handlers = createToolHandlers({
    install: async (name) => {
      calls.push(name);
      return { ok: true, installed: [name] };
    },
  });
  const result = await handlers.plugin_install({ name: "dsh-plugin-x" });
  assert.deepEqual(result, { ok: true, installed: ["dsh-plugin-x"] });
  assert.deepEqual(calls, ["dsh-plugin-x"]);
});

test("plugin_install rejects missing names and tolerates a throwing install", async () => {
  const handlers = createToolHandlers({
    install: async () => {
      throw new Error("rollback failed");
    },
  });
  const missing = await handlers.plugin_install({});
  assert.equal(missing.ok, false);
  assert.ok(missing.error.includes("name"));

  const broken = await handlers.plugin_install({ name: "x" });
  assert.equal(broken.ok, false);
  assert.ok(broken.error.includes("rollback failed"));
});

test("plugin_install reports an unavailable channel when install is not injected", async () => {
  const handlers = createToolHandlers({});
  const result = await handlers.plugin_install({ name: "x" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("不可用"));
});

// --- createToolHandlers: plugin_toggle ---------------------------------------

test("plugin_toggle forwards to the injected toggle (protected refusals pass through)", async () => {
  const calls = [];
  const handlers = createToolHandlers({
    toggle: async (name) => {
      calls.push(name);
      return { ok: false, protected: true, reason: "核心条目受保护，禁止熔断" };
    },
  });
  const result = await handlers.plugin_toggle({ name: "loader" });
  assert.equal(result.protected, true);
  assert.equal(result.reason, "核心条目受保护，禁止熔断");
  assert.deepEqual(calls, ["loader"]);
});

test("plugin_toggle rejects missing names and unavailable channels", async () => {
  const handlers = createToolHandlers({});
  const missing = await handlers.plugin_toggle({});
  assert.equal(missing.ok, false);
  assert.ok(missing.error.includes("name"));

  const noChannel = await handlers.plugin_toggle({ name: "x" });
  assert.equal(noChannel.ok, false);
  assert.ok(noChannel.error.includes("不可用"));
});

// --- buildToolDefinitions ----------------------------------------------------

test("buildToolDefinitions produces three registerable tool definitions", () => {
  const handlers = createToolHandlers({});
  const defs = buildToolDefinitions(handlers);
  const names = defs.map((d) => d.name).sort();
  assert.deepEqual(names, ["plugin_install", "plugin_search", "plugin_toggle"]);

  for (const def of defs) {
    assert.equal(typeof def.description, "string");
    assert.equal(typeof def.execute, "function");
    assert.equal(def.parameters.type, "object");
    assert.ok(Array.isArray(def.parameters.required));
    assert.equal(def.output.schema.type.length > 0, true);
    const rendered = def.output.render({}, { ok: true });
    assert.deepEqual(rendered, [{ type: "text", text: '{"ok":true}' }]);
  }

  const search = defs.find((d) => d.name === "plugin_search");
  assert.deepEqual(search.parameters.required, ["query"]);
  const install = defs.find((d) => d.name === "plugin_install");
  assert.deepEqual(install.parameters.required, ["name"]);
});

test("buildToolDefinitions wires execute straight to the handler", async () => {
  const handlers = createToolHandlers({
    search: async () => [{ name: "x", packageName: "dsh-plugin-x", description: "演示" }],
  });
  const [searchDef] = buildToolDefinitions(handlers);
  const value = await searchDef.execute({ query: "x" });
  assert.equal(value.ok, true);
  assert.equal(value.count, 1);
  assert.ok(value.list[0].includes("x"));
});

// --- buildCommandDefinition --------------------------------------------------

test("slash command answers search/install/toggle and defaults to help", async () => {
  const handlers = createToolHandlers({
    search: async () => [{ name: "plugin-a", packageName: "dsh-plugin-a", description: "演示插件" }],
    install: async () => ({ ok: true, installed: ["plugin-a"] }),
    toggle: async () => ({ ok: true, name: "plugin-a", disabled: true }),
  });
  const def = buildCommandDefinition(handlers);
  assert.equal(def.name, "dshpkg");

  const searchResult = await def.handler({ rawInput: "search demo" });
  assert.equal(searchResult.kind, "success");
  assert.ok(searchResult.text.includes("plugin-a"));

  const installResult = await def.handler({ rawInput: "install plugin-a" });
  assert.ok(installResult.text.includes("已安装"));

  const toggleResult = await def.handler({ rawInput: "toggle plugin-a" });
  assert.ok(toggleResult.text.includes("禁用"));

  const help = await def.handler({ rawInput: "" });
  assert.ok(help.text.includes("dshpkg --help"));
  assert.ok(help.text.includes("search"));
});

test("slash command surfaces protected refusals verbatim", async () => {
  const handlers = createToolHandlers({
    toggle: async () => ({ ok: false, protected: true, reason: "核心条目受保护，禁止熔断" }),
  });
  const def = buildCommandDefinition(handlers);
  const result = await def.handler({ rawInput: "toggle loader" });
  assert.ok(result.text.includes("核心条目受保护"));
});

test("slash command stays total when a handler throws", async () => {
  const handlers = createToolHandlers({
    install: async () => {
      throw new Error("boom");
    },
  });
  const def = buildCommandDefinition(handlers);
  const result = await def.handler({ rawInput: "install x" });
  assert.equal(result.kind, "success");
  assert.ok(result.text.includes("boom"));
});
