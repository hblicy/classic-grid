import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, hexToString } from "viem";
import {
  POPDEX_ACCOUNT_ABI,
  agentNameBytes32,
  deriveAgentAddress,
  prepareAgentAuthorization,
  prepareAgentRevocation,
} from "../src/popdex/agent.js";

const MAIN = "0x1000000000000000000000000000000000000001";
const AGENT_KEY = `0x${"11".repeat(32)}`;
const OLD_AGENT = "0x2000000000000000000000000000000000000002";

test("Agent private key derives an address and invalid input is never echoed", () => {
  assert.match(deriveAgentAddress(AGENT_KEY), /^0x[0-9A-Fa-f]{40}$/);
  const secret = "not-a-key-secret";
  assert.throws(
    () => deriveAgentAddress(secret),
    (error: Error) => /私钥格式无效/.test(error.message) && !error.message.includes(secret)
  );
});

test("new authorization is non-global and uses millisecond expiry", () => {
  const agentAddress = deriveAgentAddress(AGENT_KEY);
  const tx = prepareAgentAuthorization({
    agentAddress,
    delegator: MAIN,
    hostname: "grid.example",
    existingAgents: [],
    nowMs: 1_700_000_000_000,
  });
  assert.equal(tx.action, "approve");
  assert.equal(tx.chainId, "0x888");
  const decoded = decodeFunctionData({ abi: POPDEX_ACCOUNT_ABI, data: tx.data });
  assert.equal(decoded.functionName, "approveAgent");
  assert.deepEqual(decoded.args?.slice(0, 2), [agentAddress, MAIN]);
  assert.equal(decoded.args?.[3], 1_702_592_000_000n);
  assert.equal(decoded.args?.[4], 1_700_000_000n);
  assert.equal(decoded.args?.[5], false);
});

test("same Agent label replaces the unique previous Agent", () => {
  const name = agentNameBytes32("grid.example");
  const tx = prepareAgentAuthorization({
    agentAddress: deriveAgentAddress(AGENT_KEY),
    delegator: MAIN,
    hostname: "grid.example",
    existingAgents: [{ agent: OLD_AGENT, name }],
    nowMs: 1_700_000_000_000,
  });
  const decoded = decodeFunctionData({ abi: POPDEX_ACCOUNT_ABI, data: tx.data });
  assert.equal(decoded.functionName, "replaceAgent");
  assert.equal(decoded.args?.[0], OLD_AGENT);
});

test("revocation contains only the selected public Agent address", () => {
  const agentAddress = deriveAgentAddress(AGENT_KEY);
  const decoded = decodeFunctionData({
    abi: POPDEX_ACCOUNT_ABI,
    data: prepareAgentRevocation(agentAddress).data,
  });
  assert.equal(decoded.functionName, "revokeAgent");
  assert.equal(decoded.args?.[0], agentAddress);
});

test("Agent label is deterministic, ASCII-only, and bytes32 bounded", () => {
  const name = agentNameBytes32("grid.example");
  assert.equal(agentNameBytes32("grid.example"), name);
  assert.ok(hexToString(name, { size: 32 }).replace(/\0+$/, "").length <= 31);
  assert.throws(() => agentNameBytes32("坏主机名"), /hostname/);
});

test("authorization rejects identical identities and duplicate labels", () => {
  const agentAddress = deriveAgentAddress(AGENT_KEY);
  assert.throws(
    () => prepareAgentAuthorization({
      agentAddress,
      delegator: agentAddress,
      hostname: "grid.example",
      existingAgents: [],
    }),
    /不能相同/
  );
  const name = agentNameBytes32("grid.example");
  assert.throws(
    () => prepareAgentAuthorization({
      agentAddress,
      delegator: MAIN,
      hostname: "grid.example",
      existingAgents: [
        { agent: OLD_AGENT, name },
        { agent: "0x3000000000000000000000000000000000000003", name },
      ],
    }),
    /不唯一/
  );
});
