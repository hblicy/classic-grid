import {
  encodeFunctionData,
  getAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const POPDEX_ACCOUNT_PRECOMPILE =
  "0x0000000000000000000000000000000000001008" as const;
export const POPDEX_CHAIN_ID = 0x888;

export const POPDEX_ACCOUNT_ABI = [
  {
    type: "function",
    name: "approveAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "delegator", type: "address" },
      { name: "name", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "initialNonce", type: "uint64" },
      { name: "isGlobal", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "replaceAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "oldAgent", type: "address" },
      { name: "newAgent", type: "address" },
      { name: "expiresAt", type: "uint64" },
      { name: "initialNonce", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeAgent",
    stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getAgentInfo",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [
      { name: "exists", type: "bool" },
      { name: "expiresAt", type: "uint64" },
      { name: "isExpired", type: "bool" },
      { name: "delegator", type: "address" },
      { name: "name", type: "bytes32" },
      { name: "isGlobal", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getAgents",
    stateMutability: "view",
    inputs: [{ name: "delegator", type: "address" }],
    outputs: [
      { name: "agents", type: "address[]" },
      { name: "expiresAts", type: "uint64[]" },
      { name: "isExpireds", type: "bool[]" },
      { name: "names", type: "bytes32[]" },
      { name: "isGlobals", type: "bool[]" },
    ],
  },
] as const;

const THIRTY_DAYS_MS = 2_592_000_000;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9.-]+$/;

export type ExistingAgent = {
  agent: string;
  name: Hex;
};

export type PreparedAgentTransaction = {
  action?: "approve" | "replace";
  replacedAgent?: Address;
  name?: Hex;
  initialNonce?: string;
  expiresAt?: string;
  to: typeof POPDEX_ACCOUNT_PRECOMPILE;
  data: Hex;
  value: "0x0";
  chainId: "0x888";
  type: "0x0";
  gas: "0x0";
  gasPrice: "0x0";
};

export function strictAddress(value: unknown, field: string): Address {
  if (typeof value !== "string") throw new Error(`PopDEX ${field} 地址无效。`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`PopDEX ${field} 地址无效。`);
  }
}

export function deriveAgentAddress(privateKey: unknown): Address {
  if (typeof privateKey !== "string" || !PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new Error("PopDEX Agent 私钥格式无效。");
  }
  try {
    return privateKeyToAccount(privateKey as Hex).address;
  } catch {
    throw new Error("PopDEX Agent 私钥格式无效。");
  }
}

export function agentNameBytes32(hostname: unknown): Hex {
  if (
    typeof hostname !== "string" ||
    hostname.length === 0 ||
    hostname.length > 253 ||
    !HOSTNAME_PATTERN.test(hostname)
  ) {
    throw new Error("PopDEX Agent hostname 必须是有效 ASCII 主机名。");
  }
  return stringToHex(`UI_${hostname}`.slice(0, 31), { size: 32 });
}

function transaction(data: Hex): PreparedAgentTransaction {
  return {
    to: POPDEX_ACCOUNT_PRECOMPILE,
    data,
    value: "0x0",
    chainId: "0x888",
    type: "0x0",
    gas: "0x0",
    gasPrice: "0x0",
  };
}

function exactNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("PopDEX Agent nowMs 必须是非负安全整数。");
  }
  return value;
}

export function prepareAgentAuthorization(input: {
  agentAddress: string;
  delegator: string;
  hostname: string;
  existingAgents: ExistingAgent[];
  nowMs?: number;
}): PreparedAgentTransaction {
  const agent = strictAddress(input.agentAddress, "agentAddress");
  const main = strictAddress(input.delegator, "delegator");
  if (agent === main) throw new Error("PopDEX Agent 地址与主账户不能相同。");
  if (!Array.isArray(input.existingAgents)) {
    throw new Error("PopDEX existingAgents 必须是数组。");
  }
  const currentMs = exactNow(input.nowMs ?? Date.now());
  const initialNonce = BigInt(Math.floor(currentMs / 1000));
  const expiresAt = BigInt(currentMs + THIRTY_DAYS_MS);
  const name = agentNameBytes32(input.hostname);
  const matches = input.existingAgents.filter((entry) => entry?.name === name);
  if (matches.length > 1) {
    throw new Error("PopDEX 同名 Agent 不唯一，拒绝猜测替换目标。");
  }

  if (matches.length === 1) {
    const oldAgent = strictAddress(matches[0]!.agent, "existing agent");
    if (oldAgent === agent) throw new Error("PopDEX 新 Agent 与待替换 Agent 地址相同。");
    return {
      action: "replace",
      replacedAgent: oldAgent,
      name,
      initialNonce: initialNonce.toString(),
      expiresAt: expiresAt.toString(),
      ...transaction(
        encodeFunctionData({
          abi: POPDEX_ACCOUNT_ABI,
          functionName: "replaceAgent",
          args: [oldAgent, agent, expiresAt, initialNonce],
        })
      ),
    };
  }

  return {
    action: "approve",
    name,
    initialNonce: initialNonce.toString(),
    expiresAt: expiresAt.toString(),
    ...transaction(
      encodeFunctionData({
        abi: POPDEX_ACCOUNT_ABI,
        functionName: "approveAgent",
        args: [agent, main, name, expiresAt, initialNonce, false],
      })
    ),
  };
}

export function prepareAgentRevocation(agentAddress: string): PreparedAgentTransaction {
  const agent = strictAddress(agentAddress, "agentAddress");
  return transaction(
    encodeFunctionData({
      abi: POPDEX_ACCOUNT_ABI,
      functionName: "revokeAgent",
      args: [agent],
    })
  );
}
