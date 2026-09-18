import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const html = fs.readFileSync(path.resolve("public/index.html"), "utf8");
const scriptPath = path.resolve("public/popdex-agent.js");

test("Dashboard includes local ethers and the complete Agent controls", () => {
  assert.match(html, /\/vendor\/ethers\.js\?v=6\.13\.5-umd/);
  assert.match(html, /\/popdex-agent\.js/);
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
