import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionResult } from "viem";
import { POPDEX_ACCOUNT_ABI, agentNameBytes32 } from "../src/popdex/agent.js";
import { PopdexAgentRpc } from "../src/popdex/agentRpc.js";

const MAIN = "0x1000000000000000000000000000000000000001";
const AGENT = "0x3000000000000000000000000000000000000003";
const AGENT2 = "0x4000000000000000000000000000000000000004";
const ZERO = "0x0000000000000000000000000000000000000000";
const NAME = agentNameBytes32("grid.example");

function infoResult(options: {
  exists?: boolean;
  delegator?: `0x${string}`;
  expiry?: bigint;
  expired?: boolean;
  global?: boolean;
} = {}) {
  return encodeFunctionResult({
    abi: POPDEX_ACCOUNT_ABI,
    functionName: "getAgentInfo",
    result: [
      options.exists ?? true,
      options.expiry ?? 1_702_592_000_000n,
      options.expired ?? false,
      options.delegator ?? MAIN,
      NAME,
      options.global ?? false,
    ],
  });
}

test("Agent RPC verifies chain and preserves uint64 expiry as a string", async () => {
  const calls: string[] = [];
  const client = new PopdexAgentRpc({
    request: async (method) => {
      calls.push(method);
      if (method === "eth_chainId") return "0x888";
      return infoResult();
    },
  });
  await client.verifyChain();
  assert.deepEqual(await client.getAgentInfo(AGENT), {
    exists: true,
    expiresAt: "1702592000000",
    isExpired: false,
    delegator: MAIN,
    name: NAME,
    isGlobal: false,
  });
  assert.deepEqual(calls, ["eth_chainId", "eth_call"]);
});

test("Agent RPC rejects a different chain before lifecycle work", async () => {
  const client = new PopdexAgentRpc({ request: async () => "0x1" });
  await assert.rejects(client.verifyChain(), /chainId.*0x1.*0x888/i);
});

test("missing Agent requires the zero delegator", async () => {
  const valid = new PopdexAgentRpc({
    request: async () => infoResult({ exists: false, delegator: ZERO, expiry: 0n }),
  });
  assert.deepEqual(await valid.getAgentInfo(AGENT), {
    exists: false,
    expiresAt: "0",
    isExpired: false,
    delegator: null,
    name: NAME,
    isGlobal: false,
  });
  const invalid = new PopdexAgentRpc({
    request: async () => infoResult({ exists: false, delegator: MAIN, expiry: 0n }),
  });
  await assert.rejects(invalid.getAgentInfo(AGENT), /不存在.*delegator/);
});

test("getAgents rejects unequal arrays and maps exact public facts", async () => {
  const goodRaw = encodeFunctionResult({
    abi: POPDEX_ACCOUNT_ABI,
    functionName: "getAgents",
    result: [[AGENT, AGENT2], [10n, 20n], [false, true], [NAME, NAME], [false, false]],
  });
  const good = new PopdexAgentRpc({ request: async () => goodRaw });
  assert.deepEqual(await good.getAgents(MAIN), [
    { agent: AGENT, expiresAt: "10", isExpired: false, name: NAME, isGlobal: false },
    { agent: AGENT2, expiresAt: "20", isExpired: true, name: NAME, isGlobal: false },
  ]);

  const badRaw = encodeFunctionResult({
    abi: POPDEX_ACCOUNT_ABI,
    functionName: "getAgents",
    result: [[AGENT], [], [false], [NAME], [false]],
  });
  const bad = new PopdexAgentRpc({ request: async () => badRaw });
  await assert.rejects(bad.getAgents(MAIN), /数组长度不一致/);
});

test("malformed result fails with method context", async () => {
  const client = new PopdexAgentRpc({ request: async () => "0x1234" });
  await assert.rejects(client.getAgentInfo(AGENT), /getAgentInfo 解码失败/);
});
