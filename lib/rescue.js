// dshpkg — boot-failure rescue page and cordis.patch.yml managed-block
// helpers. Pure string generation / string patching: no IO, no cordis, fully
// unit-testable.
//
// Managed marker block convention (see CONTRACTS.md module I):
//
//   # dshpkg:managed:start
//   - id: <entryId>
//     disabled: true
//   # dshpkg:managed:end

const MANAGED_START = "# dshpkg:managed:start";
const MANAGED_END = "# dshpkg:managed:end";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** HTML-escape user-controlled text before embedding into the page. */
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the dshpkg-managed disable block for one loader entry.
 * Exact format from CONTRACTS.md; ends with a trailing newline.
 */
export function buildDisableBlock(entryId) {
  return [
    MANAGED_START,
    `- id: ${entryId}`,
    "  disabled: true",
    MANAGED_END,
    "",
  ].join("\n");
}

/** True when patchText already contains a managed block for entryId. */
export function hasManagedBlock(patchText, entryId) {
  const text = patchText ?? "";
  const blockRe = /# dshpkg:managed:start\n[\s\S]*?# dshpkg:managed:end/g;
  for (const match of text.matchAll(blockRe)) {
    if (match[0].includes(`- id: ${entryId}\n`)) return true;
  }
  return false;
}

/**
 * True when the patch has no array entries at all: blank/comment lines
 * only, or the bare `[]` placeholder (official profile initial state).
 */
export function isEntrylessPatch(patchText) {
  const text = patchText ?? "";
  const meaningful = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  if (meaningful.length === 0) return true;
  return meaningful.length === 1 && meaningful[0].trim() === "[]";
}

/**
 * Normalize a patch that lost all its entries back to the official `[]`
 * placeholder: user comments are kept and a bare `[]` line is appended
 * (an empty file would drift from the profile template).
 */
export function restoreEmptyArray(patchText) {
  const text = patchText ?? "";
  if (!isEntrylessPatch(text)) return text;
  const trimmed = text.trim();
  if (!trimmed) return "[]\n";
  return trimmed + "\n[]\n";
}

/**
 * Append the managed disable block for entryId to patchText.
 * Idempotent: when a block for the same id already exists the text is
 * returned unchanged (no duplicates).
 * A bare `[]` placeholder is replaced (not appended after): `[]` cannot
 * take sibling lines and would otherwise produce invalid YAML.
 */
export function applyDisableToPatch(patchText, entryId) {
  const text = patchText ?? "";
  if (hasManagedBlock(text, entryId)) return text;
  const block = buildDisableBlock(entryId);
  if (!text.trim()) return block;
  if (isEntrylessPatch(text)) {
    // Drop the `[]` placeholder line together with its comment header;
    // keep any trailing comments, then emit the block so the result
    // stays a valid top-level YAML array.
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((line) => line.trim() === "[]");
    if (idx !== -1) {
      const tail = lines.slice(idx + 1).join("\n").trim();
      if (!tail) return block;
      return tail + "\n\n" + block;
    }
  }
  return text.replace(/\s+$/, "") + "\n\n" + block;
}

/**
 * Remove the managed disable block that dshpkg wrote for entryId.
 * Only matches blocks in the exact format buildDisableBlock produces; other
 * content (including differently formatted blocks) is left untouched.
 */
export function removeManagedBlock(patchText, entryId) {
  const text = patchText ?? "";
  const re = new RegExp(
    "# dshpkg:managed:start\\n- id: " +
      escapeRegExp(entryId) +
      "\\n  disabled: true\\n# dshpkg:managed:end\\n?",
    "g"
  );
  const cleaned = text.replace(re, "");
  if (cleaned === text) return text; // no block removed: leave untouched
  // Collapse 3+ blank lines into 2 and drop leading blank lines
  // (cosmetic only: YAML treats blank lines as insignificant).
  const compact = cleaned
    .split(/\r?\n/)
    .filter((line, index, lines) => {
      if (line.trim() !== "") return true;
      if (index === 0) return false;
      return lines[index - 1].trim() !== "";
    })
    .join("\n");
  // Removing the only block must leave the official `[]` placeholder.
  return restoreEmptyArray(compact);
}

const RESCUE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1rem;
  background: #0f1115; color: #e6e6e6;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  line-height: 1.6;
}
main { max-width: 760px; margin: 0 auto; }
.card {
  background: #1a1d24; border: 1px solid #2a2f3a;
  border-radius: 12px; padding: 1.5rem 1.75rem;
}
h1 { margin: 0 0 .25rem; font-size: 1.5rem; color: #ff6b6b; }
.sub { margin: 0 0 1.25rem; color: #9aa3b2; font-size: .92rem; }
section { margin-top: 1.25rem; }
h2 { font-size: 1.05rem; color: #d7dbe4; margin: 0 0 .5rem; }
pre {
  background: #10131a; border: 1px solid #2a2f3a; border-radius: 8px;
  padding: .75rem .9rem; overflow-x: auto; white-space: pre-wrap;
  word-break: break-word; font-family: Consolas, "Courier New", monospace;
  font-size: .86rem; margin: 0;
}
pre.error { color: #ff8f8f; border-color: #5c2b2b; }
.culprit {
  display: inline-block; background: #2b1a1a; color: #ff8f8f;
  border: 1px solid #5c2b2b; border-radius: 6px;
  padding: .25rem .75rem; font-family: Consolas, monospace; font-size: .9rem;
}
button {
  background: #3d6df2; color: #fff; border: none; border-radius: 6px;
  padding: .45rem 1rem; font-size: .9rem; cursor: pointer;
}
button:hover { background: #4f7bf5; }
ol { margin: .5rem 0; padding-left: 1.4rem; }
li { margin: .35rem 0; }
code { font-family: Consolas, monospace; font-size: .86rem; color: #8ab4ff; }
footer { margin-top: 1.5rem; color: #6b7280; font-size: .82rem; }
.hidden { display: none; }
`;

/**
 * Full self-contained rescue page (Chinese UI, dark theme, inline CSS):
 * error summary, culprit entry, a 复制诊断 (copy diagnostic) button with JS,
 * and recovery instructions showing the exact managed disable block.
 */
export function rescueHtml({ profile = "web", errorText = "", culpritId = "" } = {}) {
  const errorEscaped = escapeHtml(errorText);
  const culpritEscaped = escapeHtml(culpritId);
  const profileEscaped = escapeHtml(profile);
  const blockEscaped = escapeHtml(buildDisableBlock(culpritId).trimEnd());
  // Embed raw texts as JSON so the inline script can rebuild the diagnostic.
  // "<" is escaped as \u003c inside the JSON to keep any "</script>" inside
  // user text from breaking out of the inline script element.
  const asJson = (value) => JSON.stringify(value ?? "").replace(/</g, "\\u003c");
  const errorJson = asJson(errorText);
  const culpritJson = asJson(culpritId);
  const profileJson = asJson(profile);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dshpkg 启动救援</title>
<style>${RESCUE_CSS}</style>
</head>
<body>
<main class="card">
  <h1>⚠️ dshpkg 启动救援</h1>
  <p class="sub">DeepSeek Harness 启动失败，已进入救援模式。请按下方步骤修复。</p>

  <section>
    <h2>错误摘要</h2>
    <pre class="error">${errorEscaped}</pre>
  </section>

  <section>
    <h2>肇事插件</h2>
    <div class="culprit">${culpritEscaped}</div>
  </section>

  <section>
    <h2>诊断信息</h2>
    <button id="copy-diag" type="button">复制诊断</button>
  </section>

  <section>
    <h2>恢复说明</h2>
    <ol>
      <li>打开 profile 的 <code>cordis.patch.yml</code>（位于 profile 目录下）。</li>
      <li>在文件末尾追加下面的禁用块（<code>id</code> 为肇事插件）。</li>
      <li>保存后重新启动 dsh，确认可以正常启动。</li>
      <li>启动成功后使用 <code>dshpkg doctor</code> / <code>dshpkg fix-broken</code> 修复或移除损坏插件。</li>
    </ol>
    <pre>${blockEscaped}</pre>
  </section>

  <footer>Profile: ${profileEscaped} · 本页面由 dshpkg 生成</footer>
</main>
<script>
(function () {
  var btn = document.getElementById("copy-diag");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var diag = [
      "dshpkg 启动救援诊断",
      "时间: " + new Date().toISOString(),
      "Profile: " + ${profileJson},
      "肇事插件: " + ${culpritJson},
      "错误详情:",
      ${errorJson}
    ].join("\\n");
    function done() {
      btn.textContent = "已复制";
      setTimeout(function () { btn.textContent = "复制诊断"; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(diag).then(done, fallback);
    } else {
      fallback();
    }
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = diag;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      } catch (e) {
        btn.textContent = "复制失败";
      }
    }
  });
})();
</script>
</body>
</html>
`;
}

export default {
  escapeHtml,
  buildDisableBlock,
  hasManagedBlock,
  isEntrylessPatch,
  restoreEmptyArray,
  applyDisableToPatch,
  removeManagedBlock,
  rescueHtml,
};
