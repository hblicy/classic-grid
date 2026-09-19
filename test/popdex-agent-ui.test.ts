import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const html = fs.readFileSync(path.resolve("public/index.html"), "utf8");
const scriptPath = path.resolve("public/popdex-agent.js");

test("Dashboard includes local ethers and the complete Agent controls", () => {
  assert.match(html, /\/vendor\/ethers\.js\?v=6\.13\.5-umd/);
  assert.match(html, /\/popdex-agent\.js/);
  assert.match(html, /授权、替换、保存、撤销或清理前请先暂停 PopDEX/);
  for (const id of [
    "popdex-agent-generate",
    "popdex-agent-copy",
    "popdex-agent-authorize",
    "popdex-agent-save",
    "popdex-agent-refresh",
    "popdex-agent-revoke",
    "popdex-agent-clear",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test("Agent browser code keeps secrets in memory and protects mutations", () => {
  assert.equal(fs.existsSync(scriptPath), true);
  const script = fs.readFileSync(scriptPath, "utf8");
  assert.match(script, /ethers\.Wallet\.createRandom\(\)/);
  assert.match(script, /window\.ethereum/);
  assert.match(script, /X-Grid-Request/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(script, /URLSearchParams.*private|location\.(?:search|hash).*private/i);
  assert.match(script, /async function clearLocalAgent/);
  assert.match(script, /status\.exists\s*===\s*false/);
  assert.match(script, /configuredStatus\.exists/);
});

test("Agent authorization order validates before confirmation and sending", () => {
  const script = fs.readFileSync(scriptPath, "utf8");
  const authorizeStart = script.indexOf("async function authorizeAgent()");
  const authorizeEnd = script.indexOf("async function persistAgent()", authorizeStart);
  const authorize = script.slice(authorizeStart, authorizeEnd);
  const readIntentAt = authorize.indexOf("readAgentAuthorizationIntent");
  const checkAt = authorize.indexOf("checkedAgentTransaction");
  const confirmAt = authorize.indexOf("window.confirm");
  const sendAt = authorize.indexOf("sendAndConfirm(checked.transaction)");
  assert.ok(readIntentAt >= 0);
  assert.ok(readIntentAt < checkAt);
  assert.ok(checkAt < confirmAt);
  assert.ok(confirmAt < sendAt);
  assert.doesNotMatch(authorize, /prepared\.action/);
  assert.match(authorize, /checked\.action\s*===\s*["']replace["']/);
  assert.match(authorize, /checked\.oldAgent/);
  assert.match(authorize, /checked\.newAgent/);
});
