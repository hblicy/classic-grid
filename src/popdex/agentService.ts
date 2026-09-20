import fs from "node:fs";
import {
  deriveAgentAddress,
  prepareAgentAuthorization,
  prepareAgentRevocation,
  strictAddress,
  type PreparedAgentTransaction,
} from "./agent.js";
import {
  PopdexAgentRpc,
  type AgentInfo,
  type AgentListEntry,
} from "./agentRpc.js";
import { writeEnvFile, type EnvFileSystem } from "../envFile.js";

const MAIN_ACCOUNT_KEY = "POPDEX_MAIN_ACCOUNT";
const AGENT_PRIVATE_KEY = "POPDEX_AGENT_PRIVATE_KEY";

type AgentRpc = {
  verifyChain(): Promise<void>;
  getAgentInfo(agentAddress: string): Promise<AgentInfo>;
  getAgents(delegatorAddress: string): Promise<AgentListEntry[]>;
};

export type PublicAgentStatus = {
  configured: boolean;
  mainAccount: string | null;
  agentAddress?: string;
  exists?: boolean;
  authorized?: boolean;
  reason?: string | null;
  expiresAt?: string;
  isGlobal?: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setEnvLine(content: string, key: string, value: string): string {
  const line = value ? `${key}=${value}` : `# ${key}=`;
  const pattern = new RegExp(`^\\s*(?:#\\s*)?${escapeRegExp(key)}\\s*=.*$`);
  const prefix = content
    .split(/\r?\n/)
    .filter((existingLine) => !pattern.test(existingLine))
    .join("\n")
    .trimEnd();
  return `${prefix}${prefix ? "\n" : ""}${line}\n`;
}

function exactExpiry(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("PopDEX Agent expiresAt 必须是非负整数字符串。");
  }
  return BigInt(value);
}

export function agentAuthorizationFailure(
  mainAccount: string,
  agentAddress: string,
  info: AgentInfo,
  nowMs = Date.now()
): string | null {
  const main = strictAddress(mainAccount, "mainAccount");
  const agent = strictAddress(agentAddress, "agentAddress");
  if (main === agent) throw new Error("PopDEX Agent 地址与主账户不能相同。");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("PopDEX Agent 当前时间无效。");
  }
  const expiry = exactExpiry(info.expiresAt);
  if (!info.exists) return "Agent 不存在或已撤销";
  if (info.isExpired || expiry <= BigInt(nowMs)) return "Agent 授权已过期";
  if (info.delegator !== main) return "Agent delegator 与主账户不一致";
  if (info.isGlobal) return "Agent 被授权为全局权限";
  return null;
}

export class PopdexAgentService {
  private readonly rpcClient: AgentRpc;
  private readonly envFile: string;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly fsImpl: EnvFileSystem;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly canMutate: () => boolean;
  private identityWriteTail: Promise<void> = Promise.resolve();

  constructor(options: {
    rpcClient?: AgentRpc;
    envFile: string;
    processEnv?: NodeJS.ProcessEnv;
    fsImpl?: EnvFileSystem;
    platform?: NodeJS.Platform;
    now?: () => number;
    canMutate?: () => boolean;
  }) {
    if (!options.envFile) throw new Error("PopDEX Agent envFile 必须是非空路径。");
    this.rpcClient = options.rpcClient ?? new PopdexAgentRpc();
    this.envFile = options.envFile;
    this.processEnv = options.processEnv ?? process.env;
    this.fsImpl = options.fsImpl ?? fs;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => Date.now());
    this.canMutate = options.canMutate ?? (() => true);
  }

  private assertMutationAllowed(): void {
    if (!this.canMutate()) {
      throw new Error("PopDEX 正在实盘运行，请先暂停后再修改 Agent。");
    }
  }

  private async withIdentityWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.identityWriteTail;
    let release!: () => void;
    this.identityWriteTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async inspectAuthorization(
    mainAccount: string,
    agentAddress: string
  ): Promise<PublicAgentStatus & { info: AgentInfo }> {
    const main = strictAddress(mainAccount, "mainAccount");
    const agent = strictAddress(agentAddress, "agentAddress");
    await this.rpcClient.verifyChain();
    const info = await this.rpcClient.getAgentInfo(agent);
    const nowMs = this.now();
    const reason = agentAuthorizationFailure(main, agent, info, nowMs);

    return {
      configured: true,
      mainAccount: main,
      agentAddress: agent,
      exists: info.exists,
      authorized: reason === null,
      reason,
      expiresAt: info.expiresAt,
      isGlobal: info.isGlobal,
      info,
    };
  }

  async verifyAuthorization(input: {
    mainAccount: string;
    agentAddress: string;
  }): Promise<PublicAgentStatus> {
    const status = await this.inspectAuthorization(input.mainAccount, input.agentAddress);
    if (!status.authorized) {
      throw new Error(`PopDEX Agent 尚未获得有效授权：${status.reason}。`);
    }
    const { info: _info, ...publicStatus } = status;
    return publicStatus;
  }

  async status(): Promise<PublicAgentStatus> {
    const rawMain = this.processEnv[MAIN_ACCOUNT_KEY] || "";
    const privateKey = this.processEnv[AGENT_PRIVATE_KEY] || "";
    if (!privateKey) {
      return {
        configured: false,
        mainAccount: rawMain ? strictAddress(rawMain, "mainAccount") : null,
      };
    }
    if (!rawMain) throw new Error("PopDEX Agent 已配置私钥但缺少主账户。");
    const status = await this.inspectAuthorization(rawMain, deriveAgentAddress(privateKey));
    const { info: _info, ...publicStatus } = status;
    return publicStatus;
  }

  async prepareApproval(input: {
    agentAddress: string;
    delegator: string;
    hostname: string;
  }): Promise<PreparedAgentTransaction & { from: string }> {
    this.assertMutationAllowed();
    const main = strictAddress(input.delegator, "delegator");
    await this.rpcClient.verifyChain();
    const existingAgents = await this.rpcClient.getAgents(main);
    return {
      from: main,
      ...prepareAgentAuthorization({
        agentAddress: input.agentAddress,
        delegator: main,
        hostname: input.hostname,
        existingAgents,
        nowMs: this.now(),
      }),
    };
  }

  async save(input: {
    mainAccount: string;
    agentPrivateKey: string;
  }): Promise<PublicAgentStatus> {
    return this.withIdentityWrite(async () => {
      this.assertMutationAllowed();
      const main = strictAddress(input.mainAccount, "mainAccount");
      const agentAddress = deriveAgentAddress(input.agentPrivateKey);
      const status = await this.verifyAuthorization({ mainAccount: main, agentAddress });
      this.writeSettings({
        [MAIN_ACCOUNT_KEY]: main,
        [AGENT_PRIVATE_KEY]: input.agentPrivateKey,
      });
      return status;
    });
  }

  async prepareRevoke(input: {
    mainAccount: string;
    agentAddress: string;
  }): Promise<PreparedAgentTransaction & { from: string }> {
    this.assertMutationAllowed();
    const main = strictAddress(input.mainAccount, "mainAccount");
    const agent = strictAddress(input.agentAddress, "agentAddress");
    if (main === agent) throw new Error("PopDEX Agent 地址与主账户不能相同。");
    const status = await this.inspectAuthorization(main, agent);
    if (!status.info.exists) {
      throw new Error("PopDEX Agent 链上不存在，无需撤销。");
    }
    if (status.info.delegator !== main) {
      throw new Error(
        `PopDEX Agent delegator=${status.info.delegator || "null"}，预期 ${main}。`
      );
    }
    return {
      from: main,
      ...prepareAgentRevocation(agent),
    };
  }

  async clear(): Promise<{ configured: false; mainAccount: string | null }> {
    return this.withIdentityWrite(async () => {
      this.assertMutationAllowed();
      const rawMain = this.processEnv[MAIN_ACCOUNT_KEY] || "";
      const privateKey = this.processEnv[AGENT_PRIVATE_KEY] || "";
      const main = rawMain ? strictAddress(rawMain, "mainAccount") : null;
      if (!privateKey) return { configured: false, mainAccount: main };
      if (!main) throw new Error("PopDEX Agent 已配置私钥但缺少主账户。");
      const agentAddress = deriveAgentAddress(privateKey);
      await this.rpcClient.verifyChain();
      const info = await this.rpcClient.getAgentInfo(agentAddress);
      if (info.exists) {
        throw new Error("PopDEX Agent 链上撤销尚未确认，拒绝清除本地私钥。");
      }
      if ((this.processEnv[AGENT_PRIVATE_KEY] || "") !== privateKey) {
        throw new Error("PopDEX Agent 配置已变化，拒绝清除当前私钥。");
      }
      this.writeSettings({ [AGENT_PRIVATE_KEY]: "" });
      return { configured: false, mainAccount: main };
    });
  }

  private writeSettings(values: Record<string, string>): void {
    this.assertMutationAllowed();
    let content = this.fsImpl.existsSync(this.envFile)
      ? String(this.fsImpl.readFileSync(this.envFile, "utf8"))
      : "";
    for (const [key, value] of Object.entries(values)) {
      content = setEnvLine(content, key, value);
    }
    if (!content.endsWith("\n")) content += "\n";
    writeEnvFile(this.envFile, content, {
      fsImpl: this.fsImpl,
      platform: this.platform,
    });
    for (const [key, value] of Object.entries(values)) {
      if (value) this.processEnv[key] = value;
      else delete this.processEnv[key];
    }
  }
}
