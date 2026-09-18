import {
  decodeFunctionResult,
  encodeFunctionData,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  POPDEX_ACCOUNT_ABI,
  POPDEX_ACCOUNT_PRECOMPILE,
  POPDEX_CHAIN_ID,
  strictAddress,
  type ExistingAgent,
} from "./agent.js";

const DEFAULT_RPC = "https://api.popdex.xyz/api/v1/web3/rpc";
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export type PopdexRpcRequest = (
  method: string,
  params?: unknown[]
) => Promise<unknown>;

export type AgentInfo = {
  exists: boolean;
  expiresAt: string;
  isExpired: boolean;
  delegator: Address | null;
  name: Hex;
  isGlobal: boolean;
};

export type AgentListEntry = ExistingAgent & {
  expiresAt: string;
  isExpired: boolean;
  isGlobal: boolean;
};

function strictHex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new Error(`PopDEX RPC ${field} 返回值不是十六进制数据。`);
  }
  return value as Hex;
}

function strictBytes32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value)) {
    throw new Error(`PopDEX RPC ${field} 不是 bytes32。`);
  }
  return value as Hex;
}

function sanitizedCause(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 240);
}

function defaultRequest(endpoint: string): PopdexRpcRequest {
  let id = 0;
  return async (method, params = []) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!response.ok) {
      throw new Error(`PopDEX RPC ${method} HTTP ${response.status}。`);
    }
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      body = (await response.json()) as typeof body;
    } catch (error) {
      throw new Error(`PopDEX RPC ${method} 返回无效 JSON：${sanitizedCause(error)}`);
    }
    if (body.error) {
      throw new Error(
        `PopDEX RPC ${method} 失败：${String(body.error.code ?? "unknown")} ${String(
          body.error.message ?? "unknown"
        ).slice(0, 160)}`
      );
    }
    if (!("result" in body)) throw new Error(`PopDEX RPC ${method} 缺少 result。`);
    return body.result;
  };
}

export class PopdexAgentRpc {
  private readonly request: PopdexRpcRequest;

  constructor(options: { request?: PopdexRpcRequest; endpoint?: string } = {}) {
    this.request = options.request ?? defaultRequest(options.endpoint ?? DEFAULT_RPC);
  }

  async verifyChain(): Promise<void> {
    const value = await this.request("eth_chainId", []);
    if (typeof value !== "string") {
      throw new Error("PopDEX RPC chainId 返回值无效。");
    }
    let chainId: bigint;
    try {
      chainId = BigInt(value);
    } catch {
      throw new Error(`PopDEX RPC chainId 无效：${value.slice(0, 40)}。`);
    }
    if (chainId !== BigInt(POPDEX_CHAIN_ID)) {
      throw new Error(
        `PopDEX RPC chainId=${value}，预期 0x${POPDEX_CHAIN_ID.toString(16)}。`
      );
    }
  }

  async getAgentInfo(agentAddress: string): Promise<AgentInfo> {
    const agent = strictAddress(agentAddress, "agentAddress");
    const data = encodeFunctionData({
      abi: POPDEX_ACCOUNT_ABI,
      functionName: "getAgentInfo",
      args: [agent],
    });
    const raw = strictHex(
      await this.request("eth_call", [{ to: POPDEX_ACCOUNT_PRECOMPILE, data }, "latest"]),
      "getAgentInfo"
    );
    let decoded: readonly [boolean, bigint, boolean, Address, Hex, boolean];
    try {
      decoded = decodeFunctionResult({
        abi: POPDEX_ACCOUNT_ABI,
        functionName: "getAgentInfo",
        data: raw,
      });
    } catch (error) {
      throw new Error(
        `PopDEX RPC getAgentInfo 解码失败：${sanitizedCause(error)}`,
        { cause: error }
      );
    }
    const [exists, expiresAt, isExpired, rawDelegator, rawName, isGlobal] = decoded;
    if (
      typeof exists !== "boolean" ||
      typeof isExpired !== "boolean" ||
      typeof isGlobal !== "boolean"
    ) {
      throw new Error("PopDEX RPC getAgentInfo 布尔字段无效。");
    }
    const delegatorAddress = strictAddress(rawDelegator, "agent.delegator");
    let delegator: Address | null = delegatorAddress;
    if (!exists) {
      if (delegatorAddress !== zeroAddress) {
        throw new Error("PopDEX RPC Agent 不存在却返回非零 delegator。");
      }
      delegator = null;
    }
    return {
      exists,
      expiresAt: expiresAt.toString(),
      isExpired,
      delegator,
      name: strictBytes32(rawName, "agent.name"),
      isGlobal,
    };
  }

  async getAgents(delegatorAddress: string): Promise<AgentListEntry[]> {
    const delegator = strictAddress(delegatorAddress, "delegator");
    const data = encodeFunctionData({
      abi: POPDEX_ACCOUNT_ABI,
      functionName: "getAgents",
      args: [delegator],
    });
    const raw = strictHex(
      await this.request("eth_call", [{ to: POPDEX_ACCOUNT_PRECOMPILE, data }, "latest"]),
      "getAgents"
    );
    let decoded: readonly [
      readonly Address[],
      readonly bigint[],
      readonly boolean[],
      readonly Hex[],
      readonly boolean[],
    ];
    try {
      decoded = decodeFunctionResult({
        abi: POPDEX_ACCOUNT_ABI,
        functionName: "getAgents",
        data: raw,
      });
    } catch (error) {
      throw new Error(`PopDEX RPC getAgents 解码失败：${sanitizedCause(error)}`, {
        cause: error,
      });
    }
    const [agents, expiresAts, isExpireds, names, isGlobals] = decoded;
    const length = agents.length;
    if (
      expiresAts.length !== length ||
      isExpireds.length !== length ||
      names.length !== length ||
      isGlobals.length !== length
    ) {
      throw new Error("PopDEX RPC getAgents 数组长度不一致。");
    }
    return agents.map((value, index) => ({
      agent: strictAddress(value, `agents[${index}]`),
      expiresAt: expiresAts[index]!.toString(),
      isExpired: isExpireds[index]!,
      name: strictBytes32(names[index], `names[${index}]`),
      isGlobal: isGlobals[index]!,
    }));
  }
}
