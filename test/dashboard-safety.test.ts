import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const safetyPath = path.resolve("public/dashboard-safety.js");
const html = fs.readFileSync(path.resolve("public/index.html"), "utf8");

function loadDashboardSafety(): any {
  assert.equal(fs.existsSync(safetyPath), true, "public/dashboard-safety.js must exist");
  const context = { window: {} as Record<string, unknown> };
  vm.runInNewContext(fs.readFileSync(safetyPath, "utf8"), context, {
    filename: safetyPath,
  });
  return context.window.DashboardSafety;
}

test("escapeHtml renders venue errors as text", () => {
  const safety = loadDashboardSafety();
  assert.equal(
    safety.escapeHtml(`<img src=x onerror="steal()">&'`),
    "&lt;img src=x onerror=&quot;steal()&quot;&gt;&amp;&#39;"
  );
});

test("Dashboard loads the safety helper and applies it to lastError", () => {
  assert.match(html, /<script src=["']\/dashboard-safety\.js["']><\/script>/);
  assert.ok(html.indexOf("/dashboard-safety.js") < html.indexOf("/popdex-agent.js"));
  assert.match(html, /DashboardSafety\.escapeHtml\(v\.lastError\)/);
  assert.doesNotMatch(html, /\$\{v\.lastError\s*\|\|/);
});
