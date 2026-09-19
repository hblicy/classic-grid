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
const THIRD = "0x4000000000000000000000000000000000000004";

function loadDashboardSafety(): any {
  assert.equal(fs.existsSync(safetyPath), true, "public/dashboard-safety.js must exist");
  const context = { window: {} as Record<string, unknown> };
  vm.runInNewContext(fs.readFileSync(safetyPath, "utf8"), context, {
    filename: safetyPath,
  });
  return context.window.DashboardSafety;
}

function walletAgentReader(result: {
  agents: string[];
  expiresAts: bigint[];
  isExpireds: boolean[];
  names: string[];
  isGlobals: boolean[];
}): any {
  const accountInterface = new ethers.Interface(POPDEX_ACCOUNT_ABI);
  return {
    async request(payload: { method: string; params: unknown[] }) {
      assert.equal(payload.method, "eth_call");
      const call = payload.params[0] as { to: string; data: string };
      assert.equal(call.to, POPDEX_ACCOUNT_PRECOMPILE);
      assert.equal(
        call.data,
        accountInterface.encodeFunctionData("getAgents", [MAIN])
      );
      assert.equal(payload.params[1], "latest");
      return accountInterface.encodeFunctionResult("getAgents", [
        result.agents,
        result.expiresAts,
        result.isExpireds,
        result.names,
        result.isGlobals,
      ]);
    },
  };
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

test("readAgentAuthorizationIntent derives approve and exact replace from wallet RPC", async () => {
  const safety = loadDashboardSafety();
  const hostname = "grid.example";
  const otherName = ethers.encodeBytes32String("UI_other.example");
  const expectedName = agentNameBytes32(hostname);

  const approve = await safety.readAgentAuthorizationIntent(
    ethers,
    walletAgentReader({
      agents: [OTHER],
      expiresAts: [1n],
      isExpireds: [false],
      names: [otherName],
      isGlobals: [false],
    }),
    MAIN,
    AGENT,
    hostname
  );
  assert.equal(approve.kind, "approve");
  assert.equal(approve.agentAddress, AGENT);
  assert.equal(approve.delegator, MAIN);
  assert.equal(approve.hostname, hostname);

  const replace = await safety.readAgentAuthorizationIntent(
    ethers,
    walletAgentReader({
      agents: [OTHER],
      expiresAts: [1n],
      isExpireds: [false],
      names: [expectedName],
      isGlobals: [false],
    }),
    MAIN,
    AGENT,
    hostname
  );
  assert.equal(replace.kind, "replace");
  assert.equal(replace.oldAgent, OTHER);
  assert.equal(replace.agentAddress, AGENT);
  assert.equal(replace.delegator, MAIN);
  assert.equal(replace.hostname, hostname);
});

test("readAgentAuthorizationIntent rejects ambiguous or malformed wallet state", async () => {
  const safety = loadDashboardSafety();
  const hostname = "grid.example";
  const name = agentNameBytes32(hostname);
  const invalidResults = [
    {
      agents: [OTHER, THIRD],
      expiresAts: [1n, 2n],
      isExpireds: [false, false],
      names: [name, name],
      isGlobals: [false, false],
    },
    {
      agents: [OTHER],
      expiresAts: [],
      isExpireds: [false],
      names: [name],
      isGlobals: [false],
    },
    {
      agents: [AGENT],
      expiresAts: [1n],
      isExpireds: [false],
      names: [name],
      isGlobals: [false],
    },
  ];

  for (const result of invalidResults) {
    await assert.rejects(
      safety.readAgentAuthorizationIntent(
        ethers,
        walletAgentReader(result),
        MAIN,
        AGENT,
        hostname
      ),
      /链上 Agent 状态/
    );
  }

  await assert.rejects(
    safety.readAgentAuthorizationIntent(
      ethers,
      { request: async () => "0x1234" },
      MAIN,
      AGENT,
      hostname
    ),
    /链上 Agent 状态/
  );
});

test("checkedAgentTransaction accepts only the selector and oldAgent bound to intent", () => {
  const safety = loadDashboardSafety();
  const hostname = "grid.example";
  const approve = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname,
    existingAgents: [],
    nowMs: NOW,
  });
  const checkedApprove = safety.checkedAgentTransaction(
    ethers,
    { from: MAIN, ...approve },
    MAIN,
    { kind: "approve", agentAddress: AGENT, delegator: MAIN, hostname },
    NOW
  );
  assert.equal(checkedApprove.action, "approve");
  assert.equal(checkedApprove.newAgent, AGENT);
  assert.equal(checkedApprove.transaction.to, POPDEX_ACCOUNT_PRECOMPILE);
  assert.equal(checkedApprove.transaction.from, MAIN);

  const replace = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname,
    existingAgents: [{ agent: OTHER, name: agentNameBytes32(hostname) }],
    nowMs: NOW,
  });
  const checkedReplace = safety.checkedAgentTransaction(
    ethers,
    { from: MAIN, ...replace },
    MAIN,
    {
      kind: "replace",
      oldAgent: OTHER,
      agentAddress: AGENT,
      delegator: MAIN,
      hostname,
    },
    NOW
  );
  assert.equal(checkedReplace.action, "replace");
  assert.equal(checkedReplace.oldAgent, OTHER);
  assert.equal(checkedReplace.newAgent, AGENT);
  assert.equal(checkedReplace.transaction.data, replace.data);

  assert.throws(
    () =>
      safety.checkedAgentTransaction(
        ethers,
        { from: MAIN, ...replace },
        MAIN,
        { kind: "approve", agentAddress: AGENT, delegator: MAIN, hostname },
        NOW
      ),
    /交易参数/
  );
  assert.throws(
    () =>
      safety.checkedAgentTransaction(
        ethers,
        { from: MAIN, ...replace },
        MAIN,
        {
          kind: "replace",
          oldAgent: THIRD,
          agentAddress: AGENT,
          delegator: MAIN,
          hostname,
        },
        NOW
      ),
    /交易参数/
  );
});

test("checkedAgentTransaction rejects changed envelope and authorization calldata", () => {
  const safety = loadDashboardSafety();
  const intent = {
    kind: "approve",
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
  const checked = safety.checkedAgentTransaction(
    ethers,
    { from: MAIN, ...prepared },
    MAIN,
    { kind: "revoke", agentAddress: AGENT },
    NOW
  );
  assert.equal(checked.action, "revoke");
  assert.equal(checked.agentAddress, AGENT);
  assert.equal(checked.transaction.data, prepared.data);
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
