// Unit tests for lib/rescue.js — pure string-level assertions, no IO.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDisableBlock,
  hasManagedBlock,
  applyDisableToPatch,
  removeManagedBlock,
  rescueHtml,
  escapeHtml,
} from "../lib/rescue.js";

test("buildDisableBlock produces the exact managed block format from CONTRACTS.md", () => {
  assert.equal(
    buildDisableBlock("boot-crash-fixture"),
    "# dshpkg:managed:start\n- id: boot-crash-fixture\n  disabled: true\n# dshpkg:managed:end\n"
  );
});

test("applyDisableToPatch appends the block to an empty patch", () => {
  assert.equal(
    applyDisableToPatch("", "alpha"),
    buildDisableBlock("alpha")
  );
  assert.equal(applyDisableToPatch(undefined, "alpha"), buildDisableBlock("alpha"));
});

test("applyDisableToPatch appends to existing content and keeps it intact", () => {
  const patch = "- id: stable\n  name: stable\n";
  const out = applyDisableToPatch(patch, "alpha");
  assert.ok(out.startsWith(patch.trimEnd()));
  assert.ok(out.includes(buildDisableBlock("alpha").trimEnd()));
});

test("applyDisableToPatch is idempotent: existing block for the same id is not duplicated", () => {
  const once = applyDisableToPatch("", "alpha");
  const twice = applyDisableToPatch(once, "alpha");
  assert.equal(twice, once);
  const matches = twice.match(/- id: alpha\n/g);
  assert.equal(matches.length, 1);
});

test("applyDisableToPatch merges blocks for different ids side by side", () => {
  let out = applyDisableToPatch("", "alpha");
  out = applyDisableToPatch(out, "beta");
  assert.ok(out.includes(buildDisableBlock("alpha").trimEnd()));
  assert.ok(out.includes(buildDisableBlock("beta").trimEnd()));
  assert.equal((out.match(/# dshpkg:managed:start/g) ?? []).length, 2);
});

test("applyDisableToPatch handles a patch without trailing newline", () => {
  const patch = "- id: stable";
  const out = applyDisableToPatch(patch, "alpha");
  assert.ok(out.startsWith("- id: stable\n\n"));
  assert.ok(out.endsWith("# dshpkg:managed:end\n"));
});

test("applyDisableToPatch replaces a bare [] placeholder with a valid array", () => {
  const out = applyDisableToPatch("[]", "alpha");
  assert.equal(out, buildDisableBlock("alpha"));
  assert.ok(!out.includes("[]"));
  const withNewline = applyDisableToPatch("[]\n", "alpha");
  assert.equal(withNewline, buildDisableBlock("alpha"));
  // idempotent on the placeholder path too
  assert.equal(applyDisableToPatch(out, "alpha"), out);
});

test("applyDisableToPatch drops a [] placeholder with its comment header", () => {
  const header = applyDisableToPatch("# user comment\n[]\n", "alpha");
  assert.ok(!header.includes("[]"));
  assert.ok(!header.includes("# user comment"));
  assert.equal(header, buildDisableBlock("alpha"));
  // trailing comments survive and stay ahead of the managed block
  const tail = applyDisableToPatch("[]\n# trailing note\n", "alpha");
  assert.ok(!tail.includes("[]"));
  assert.ok(tail.includes("# trailing note"));
  assert.ok(tail.endsWith("# dshpkg:managed:end\n"));
});

test("hasManagedBlock detects only blocks carrying the exact id line", () => {
  const patch = applyDisableToPatch("", "alpha");
  assert.equal(hasManagedBlock(patch, "alpha"), true);
  assert.equal(hasManagedBlock(patch, "beta"), false);
  // A plain (non-managed) entry with the same id must NOT count as managed.
  assert.equal(hasManagedBlock("- id: alpha\n  disabled: false\n", "alpha"), false);
});

test("removeManagedBlock removes only its own block and keeps the rest", () => {
  let patch = applyDisableToPatch("", "alpha");
  patch = applyDisableToPatch(patch, "beta");
  patch = "# user comment\n" + patch;
  const out = removeManagedBlock(patch, "alpha");
  assert.ok(!out.includes("- id: alpha\n"));
  assert.ok(out.includes(buildDisableBlock("beta").trimEnd()));
  assert.ok(out.includes("# user comment"));
});

test("removeManagedBlock leaves the text unchanged when no block exists", () => {
  const text = "# nothing here\n- id: other\n  disabled: true\n";
  assert.equal(removeManagedBlock(text, "ghost"), text);
  assert.equal(removeManagedBlock("", "ghost"), "");
});

test("removeManagedBlock only matches the exact dshpkg block shape", () => {
  // A hand-written block with different whitespace is not ours to remove.
  const foreign = "# dshpkg:managed:start\n- id: alpha\n   disabled: true\n# dshpkg:managed:end\n";
  const out = removeManagedBlock(foreign, "alpha");
  assert.ok(out.includes("- id: alpha"));
});

test("removeManagedBlock restores a bare [] after removing the only block", () => {
  const patch = applyDisableToPatch("[]", "alpha");
  assert.equal(removeManagedBlock(patch, "alpha"), "[]\n");
  // no block removed: text (including a bare []) stays untouched
  assert.equal(removeManagedBlock("[]\n", "ghost"), "[]\n");
});

test("removeManagedBlock keeps comments when restoring the [] placeholder", () => {
  const patch = "# user comment\n" + applyDisableToPatch("[]", "alpha");
  const out = removeManagedBlock(patch, "alpha");
  assert.equal(out, "# user comment\n[]\n");
});

test("rescueHtml renders a full Chinese dark-theme page with diagnostics and recovery", () => {
  const html = rescueHtml({
    profile: "web",
    errorText: "failed to apply loader entry boot-crash-fixture: boom",
    culpritId: "boot-crash-fixture",
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("<html lang=\"zh-CN\">"));
  assert.ok(html.includes("<title>dshpkg 启动救援</title>"));
  assert.ok(html.includes("错误摘要"));
  assert.ok(html.includes("肇事插件"));
  assert.ok(html.includes("boot-crash-fixture"));
  assert.ok(html.includes("复制诊断"));
  assert.ok(html.includes("恢复说明"));
  assert.ok(html.includes("cordis.patch.yml"));
  assert.ok(html.includes("dshpkg:managed:start"));
  assert.ok(html.includes("#0f1115"), "dark theme background color must be inline");
  assert.ok(html.includes("</html>"));
});

test("rescueHtml escapes user-controlled text (XSS-safe)", () => {
  const html = rescueHtml({
    profile: "web",
    errorText: "<script>alert('xss')</script>",
    culpritId: '"><img src=x onerror=alert(1)>',
  });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
});

test("rescueHtml embeds the raw diagnostic text for the copy button", () => {
  const html = rescueHtml({
    profile: "web",
    errorText: "boom \"quoted\"\nline2",
    culpritId: "alpha",
  });
  assert.ok(html.includes('"肇事插件: " + "alpha"'));
  assert.ok(html.includes('"boom \\"quoted\\"\\nline2"'));
  assert.ok(html.includes("navigator.clipboard"));
});

test("rescueHtml keeps a </script> inside the error text from breaking the inline script", () => {
  const html = rescueHtml({
    profile: "web",
    errorText: "evil </script><script>alert(1)</script>",
    culpritId: "alpha",
  });
  // The visible HTML may only contain the escaped form.
  assert.ok(!html.includes("</script><script>"));
  // The JSON inside the script uses the \\u003c escape.
  assert.ok(html.includes("\\u003c/script>"));
  // Exactly one inline script element survives.
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
});

test("escapeHtml escapes all five HTML metacharacters", () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});
