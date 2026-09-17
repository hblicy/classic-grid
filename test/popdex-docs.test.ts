import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const env = fs.readFileSync(".env.example", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const security = fs.readFileSync("SECURITY.md", "utf8");

test("environment template uses only PopDEX main-account and Agent credentials", () => {
  assert.match(env, /^DASHBOARD_TOKEN=$/m);
  assert.match(env, /^POPDEX_MAIN_ACCOUNT=$/m);
  assert.match(env, /^POPDEX_AGENT_PRIVATE_KEY=$/m);
  assert.doesNotMatch(env, /^POPDEX_PRIVATE_KEY=/m);
  assert.doesNotMatch(env, /^POPDEX_KEY_PATH=/m);
});

test("README documents the complete Agent lifecycle and restart boundary", () => {
  for (const phrase of ["生成 Agent", "主钱包授权", "链上回验", "保存", "重启", "撤销"]) {
    assert.match(readme, new RegExp(phrase));
  }
  assert.match(readme, /POPDEX_MAIN_ACCOUNT/);
  assert.match(readme, /POPDEX_AGENT_PRIVATE_KEY/);
  assert.match(readme, /主钱包私钥.*不得|不得.*主钱包私钥/);
});

test("security policy documents loopback and authenticated remote access", () => {
  assert.match(security, /127\.0\.0\.1/);
  assert.match(security, /DASHBOARD_TOKEN/);
  assert.match(security, /Basic Auth/);
  assert.match(security, /SSH|Tailscale|TLS/);
});
