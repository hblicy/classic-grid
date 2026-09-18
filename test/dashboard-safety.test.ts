import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import * as ethers from "ethers";
import { encodeFunctionData } from "viem";
import {
  agentNameBytes32,
  POPDEX_ACCOUNT_ABI,
  POPDEX_ACCOUNT_PRECOMPILE,
  prepareAgentAuthorization,
  prepareAgentRevocation,
} from "../src/popdex/agent.js";

const safetyPath = path.resolve("public/dashboard-safety.js");
const html = fs.readFileSync(path.resolve("public/index.html"), "utf8");
const NOW = 1_700_000_000_000;
const MAIN = "0x1000000000000000000000000000000000000001";
const AGENT = "0x3000000000000000000000000000000000000003";
const OTHER = "0x2000000000000000000000000000000000000002";

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

test("checkedAgentTransaction accepts exact approve and replace intents", () => {
  const safety = loadDashboardSafety();
  const intent = {
    kind: "authorize",
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: "grid.example",
  };
  const approve = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: intent.hostname,
    existingAgents: [],
    nowMs: NOW,
  });
  const checkedApprove = safety.checkedAgentTransaction(
    ethers,
    { from: MAIN, ...approve },
    MAIN,
    intent,
    NOW
  );
  assert.equal(checkedApprove.to, POPDEX_ACCOUNT_PRECOMPILE);
  assert.equal(checkedApprove.from, MAIN);

  const replace = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: intent.hostname,
    existingAgents: [{ agent: OTHER, name: agentNameBytes32(intent.hostname) }],
    nowMs: NOW,
  });
  assert.doesNotThrow(() =>
    safety.checkedAgentTransaction(
      ethers,
      { from: MAIN, ...replace },
      MAIN,
      intent,
      NOW
    )
  );
});

test("checkedAgentTransaction rejects changed envelope and authorization calldata", () => {
  const safety = loadDashboardSafety();
  const intent = {
    kind: "authorize",
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: "grid.example",
  };
  const prepared = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: intent.hostname,
    existingAgents: [],
    nowMs: NOW,
  });
  const revokeOther = prepareAgentRevocation(OTHER);
  const globalData = encodeFunctionData({
    abi: POPDEX_ACCOUNT_ABI,
    functionName: "approveAgent",
    args: [
      AGENT,
      MAIN,
      agentNameBytes32(intent.hostname),
      BigInt(NOW + 2_592_000_000),
      BigInt(Math.floor(NOW / 1000)),
      true,
    ],
  });
  const stale = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: intent.hostname,
    existingAgents: [],
    nowMs: NOW - 600_000,
  });
  const mutated = [
    { ...prepared, to: OTHER },
    { ...prepared, value: "0x1" },
    { ...prepared, gasPrice: "0x1" },
    { ...prepared, data: revokeOther.data },
    { ...prepared, data: globalData },
    stale,
  ];

  for (const transaction of mutated) {
    assert.throws(
      () =>
        safety.checkedAgentTransaction(
          ethers,
          { from: MAIN, ...transaction },
          MAIN,
          intent,
          NOW
        ),
      /交易参数/
    );
  }
});

test("checkedAgentTransaction binds revoke to the configured Agent", () => {
  const safety = loadDashboardSafety();
  const prepared = prepareAgentRevocation(AGENT);
  assert.doesNotThrow(() =>
    safety.checkedAgentTransaction(
      ethers,
      { from: MAIN, ...prepared },
      MAIN,
      { kind: "revoke", agentAddress: AGENT },
      NOW
    )
  );
  assert.throws(
    () =>
      safety.checkedAgentTransaction(
        ethers,
        { from: MAIN, ...prepareAgentRevocation(OTHER) },
        MAIN,
        { kind: "revoke", agentAddress: AGENT },
        NOW
      ),
    /交易参数/
  );
});
