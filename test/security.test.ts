import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { startDashboardServer } from "../src/dashboard.js";

assert.throws(
  () => startDashboardServer(8088, "0.0.0.0"),
  /拒绝监听非回环地址/
);

const html = fs.readFileSync(path.resolve("public/index.html"), "utf8");
assert.match(html, /function escapeHtml\(value\)/);
assert.match(
  html,
  /escapeHtml\(v\.lastError \|\| \(v\.seeded \? "运行中" : "待铺"\)\)/
);
assert.doesNotMatch(
  html,
  /\$\{v\.lastError \|\| \(v\.seeded \? "运行中" : "待铺"\)\}/
);
const escapeSource = html.match(/function escapeHtml\(value\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(escapeSource, "escapeHtml source missing");
const context: Record<string, unknown> = {
  input: `<img src=x onerror="globalThis.pwned=1">`,
};
vm.runInNewContext(`${escapeSource}; result = escapeHtml(input);`, context);
assert.equal(
  context.result,
  "&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt;"
);

const loopSource = fs.readFileSync(path.resolve("src/loop.ts"), "utf8");
assert.match(
  loopSource,
  /liquidationPrice:\s*snap\.liquidationPrice/,
  "主循环必须把交易所快照中的爆仓价传给看板"
);

const dashboardCliSource = fs.readFileSync(
  path.resolve("src/cli/dashboard.ts"),
  "utf8"
);
assert.match(
  dashboardCliSource,
  /liquidationPrice:\s*snap\.liquidationPrice/,
  "独立看板必须把交易所快照中的爆仓价传给看板"
);

console.log("security.test.ts OK");
