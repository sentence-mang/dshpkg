// dshpkg — Web UI crash banner (Spec section 9: "Web UI settings.section + 崩溃横幅").
//
// Self-contained inline script (zero external dependencies, no framework
// hooks) injected into the host index.html via webServer.tapIndex(). The
// script polls GET /dshpkg/status every 30s; when the host reports
// bootFailures > 0, circuit-open packages, or managed entries with mount
// errors, it shows a dark Chinese banner at the top of the page for 5s and
// then fades it out.
//
// buildBannerScript() is a pure string constant so the test suite asserts on
// it without a browser or a live host.

/** @returns {string} inline script to inject into the host index.html */
export function buildBannerScript() {
  return `(function () {
  "use strict";
  var BAR_ID = "dshpkg-crash-banner";
  function dismiss() {
    var el = document.getElementById(BAR_ID);
    if (el) el.remove();
  }
  function show(count) {
    dismiss();
    var el = document.createElement("div");
    el.id = BAR_ID;
    el.setAttribute("role", "alert");
    el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483000;" +
      "background:#14161a;color:#e6e6e6;border-bottom:1px solid #c0392b;" +
      "padding:10px 16px;font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.55);text-align:center;";
    el.textContent = "dshpkg：检测到 " + count + " 个故障条目，已被自动熔断。详情见 dshpkg log 或设置页";
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity 1s";
      el.style.opacity = "0";
      setTimeout(dismiss, 1100);
    }, 5000);
  }
  function check() {
    fetch("/dshpkg/status", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || data.ok !== true) return;
        var st = data.state || {};
        var bootDown = typeof st.bootFailures === "number" && st.bootFailures > 0 ? 1 : 0;
        var circuitOpen = Array.isArray(st.circuitOpen) ? st.circuitOpen.length : 0;
        var failedManaged = (Array.isArray(data.managed) ? data.managed : [])
          .filter(function (m) { return m && Array.isArray(m.mountErrors) && m.mountErrors.length > 0; })
          .length;
        var count = bootDown + circuitOpen + failedManaged;
        if (count > 0) show(count);
        else dismiss();
      })
      .catch(function () { /* host unreachable: stay quiet */ });
  }
  function boot() {
    if (document.body) check();
    else document.addEventListener("DOMContentLoaded", check);
  }
  boot();
  setInterval(check, 30000);
})();`;
}

/**
 * Inject the banner script into an index.html body: append a <script> tag
 * before </body> when present, else at the very end of the string.
 *
 * @param {string} html host index.html body
 * @param {string} script inline script text
 * @returns {string}
 */
export function injectBannerScript(html, script = buildBannerScript()) {
  const text = String(html ?? "");
  const tag = `<script>${script}</script>`;
  const close = text.lastIndexOf("</body>");
  if (close >= 0) return text.slice(0, close) + tag + text.slice(close);
  return text + tag;
}

export default { buildBannerScript, injectBannerScript };
