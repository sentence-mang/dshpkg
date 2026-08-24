// dshpkg — Web UI crash banner tests (Spec section 9). Pure string-level
// assertions on the inline script and its index.html injection helper — no
// browser, no host, no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBannerScript,
  injectBannerScript,
} from "../lib/banner.js";

test("buildBannerScript polls /dshpkg/status on load and every 30s", () => {
  const script = buildBannerScript();
  assert.ok(script.includes('fetch("/dshpkg/status"'));
  assert.ok(script.includes("setInterval(check, 30000)"));
  assert.ok(script.includes("DOMContentLoaded"));
});

test("buildBannerScript shows the exact Chinese banner wording", () => {
  const script = buildBannerScript();
  assert.ok(script.includes("dshpkg：检测到"));
  assert.ok(script.includes("个故障条目，已被自动熔断"));
  assert.ok(script.includes("详情见 dshpkg log 或设置页"));
});

test("buildBannerScript counts bootFailures, circuitOpen and failed managed entries", () => {
  const script = buildBannerScript();
  assert.ok(script.includes("bootFailures"));
  assert.ok(script.includes("circuitOpen"));
  assert.ok(script.includes("mountErrors"));
  assert.ok(script.includes("dshpkg-crash-banner"));
});

test("buildBannerScript fades the banner out after 5s (zero dependencies)", () => {
  const script = buildBannerScript();
  assert.ok(script.includes("5000"), "5s display window");
  assert.ok(script.includes("transition"));
  assert.ok(script.includes("role\", \"alert\""));
  // Self-contained: no imports, no module syntax, no window globals beyond DOM.
  assert.ok(!script.includes("import "));
  assert.ok(!script.includes("require("));
  const lines = script.split("\n").length;
  assert.ok(lines <= 60, `script stays compact (${lines} lines)`);
});

test("injectBannerScript appends before </body> and keeps the page intact", () => {
  const html = "<!doctype html><html><head></head><body><div id=\"app\"></div></body></html>";
  const out = injectBannerScript(html, "<script>x</script>");
  assert.ok(out.includes('<div id="app"></div>'));
  assert.ok(out.includes("<script>x</script>"));
  const close = out.lastIndexOf("</body>");
  assert.ok(out.indexOf("<script>x</script>") < close, "script lands inside <body>");
  assert.ok(out.endsWith("</body></html>"));
});

test("injectBannerScript appends at the end when no </body> exists", () => {
  const out = injectBannerScript("<html></html>", "S");
  assert.equal(out, "<html></html><script>S</script>");
});

test("injectBannerScript tolerates null/undefined html", () => {
  const out = injectBannerScript(null, "S");
  assert.equal(out, "<script>S</script>");
  const out2 = injectBannerScript(undefined);
  assert.ok(out2.startsWith("<script>"));
  assert.ok(out2.includes("dshpkg-crash-banner"));
});
