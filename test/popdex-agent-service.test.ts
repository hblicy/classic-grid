import assert from "node:assert/strict";
import test from "node:test";
import { agentNameBytes32, deriveAgentAddress } from "../src/popdex/agent.js";
import type { AgentInfo, AgentListEntry } from "../src/popdex/agentRpc.js";
import { PopdexAgentService } from "../src/popdex/agentService.js";
import type { EnvFileSystem } from "../src/envFile.js";

const MAIN = "0x1000000000000000000000000000000000000001";
const OTHER_MAIN = "0x2000000000000000000000000000000000000002";
const AGENT_KEY = `0x${"11".repeat(32)}`;
const AGENT = deriveAgentAddress(AGENT_KEY);
const NEW_AGENT_KEY = `0x${"22".repeat(32)}`;
const NEW_AGENT = deriveAgentAddress(NEW_AGENT_KEY);
const NAME = agentNameBytes32("grid.example");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryFs {
  content = "EXISTING=value\n";
  exists = true;
  failWrite = false;
  writes: Array<{ content: string; mode?: number }> = [];
  chmods: number[] = [];
  files = new Map<string, string>();

  existsSync(file: string): boolean {
    return file === "C:/app/.env" ? this.exists : this.files.has(file);
  }
  readFileSync(): string {
    return this.content;
  }
  writeFileSync(file: string, content: string, options: { mode?: number }): void {
    if (this.failWrite) throw new Error("disk full");
    this.files.set(file, content);
    this.writes.push({ content, mode: options.mode });
  }
  chmodSync(_file: string, mode: number): void {
    this.chmods.push(mode);
  }
  renameSync(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing temporary file ${from}`);
    if (to !== "C:/app/.env") throw new Error(`unexpected target ${to}`);
    this.content = content;
    this.exists = true;
    this.files.delete(from);
  }
  unlinkSync(file: string): void {
    this.files.delete(file);
  }
}

function activeInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    exists: true,
    expiresAt: "1702592000000",
    isExpired: false,
    delegator: MAIN,
    name: NAME,
    isGlobal: false,
    ...overrides,
  };
}

function configuredEnv(): NodeJS.ProcessEnv {
  return { POPDEX_MAIN_ACCOUNT: MAIN, POPDEX_AGENT_PRIVATE_KEY: AGENT_KEY };
}

function service(options: {
  info?: AgentInfo;
  agents?: AgentListEntry[];
  processEnv?: NodeJS.ProcessEnv;
  canMutate?: () => boolean;
  fsImpl?: MemoryFs;
  getAgentInfo?: (agent: string) => AgentInfo | Promise<AgentInfo>;
} = {}) {
  const fsImpl = options.fsImpl ?? new MemoryFs();
  const processEnv = options.processEnv ?? {};
  const info = options.info ?? activeInfo();
  const calls: string[] = [];
  const rpcClient = {
    async verifyChain() {
      calls.push("chain");
    },
    async getAgentInfo(agent: string) {
      calls.push(`info:${agent}`);
      return options.getAgentInfo ? options.getAgentInfo(agent) : info;
    },
    async getAgents(main: string) {
      calls.push(`agents:${main}`);
      return options.agents ?? [];
    },
  };
  return {
    fsImpl,
    processEnv,
    calls,
    service: new PopdexAgentService({
      rpcClient,
      envFile: "C:/app/.env",
      processEnv,
      fsImpl: fsImpl as unknown as EnvFileSystem,
      platform: "linux",
      now: () => 1_700_000_000_000,
      canMutate: options.canMutate,
    }),
  };
}

test("save refuses an unauthorized Agent", async () => {
  const ctx = service({ info: activeInfo({ exists: false, delegator: null }) });
  await assert.rejects(
    ctx.service.save({ mainAccount: MAIN, agentPrivateKey: AGENT_KEY }),
    /尚未获得有效授权/
  );
  assert.equal(ctx.fsImpl.writes.length, 0);
});

test("save writes only main account and Agent key after exact verification", async () => {
  const ctx = service();
  const status = await ctx.service.save({ mainAccount: MAIN, agentPrivateKey: AGENT_KEY });
  assert.equal(status.authorized, true);
  assert.match(ctx.fsImpl.content, new RegExp(`^POPDEX_MAIN_ACCOUNT=${MAIN}$`, "m"));
  assert.match(
    ctx.fsImpl.content,
    new RegExp(`^POPDEX_AGENT_PRIVATE_KEY=${AGENT_KEY}$`, "m")
  );
  assert.equal(ctx.processEnv.POPDEX_MAIN_ACCOUNT, MAIN);
  assert.equal(ctx.processEnv.POPDEX_AGENT_PRIVATE_KEY, AGENT_KEY);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(AGENT_KEY));
  assert.deepEqual(ctx.fsImpl.chmods, [0o600]);
  assert.equal(ctx.fsImpl.writes[0]?.mode, 0o600);
});

test("clear preserves an active Agent and removes only a revoked key", async () => {
  const active = service({ processEnv: configuredEnv() });
  await assert.rejects(active.service.clear(), /撤销尚未确认/);
  assert.equal(active.processEnv.POPDEX_AGENT_PRIVATE_KEY, AGENT_KEY);

  const revoked = service({
    processEnv: configuredEnv(),
    info: activeInfo({ exists: false, delegator: null, expiresAt: "0" }),
  });
  await revoked.service.clear();
  assert.equal(revoked.processEnv.POPDEX_MAIN_ACCOUNT, MAIN);
  assert.equal(revoked.processEnv.POPDEX_AGENT_PRIVATE_KEY, undefined);
  assert.match(revoked.fsImpl.content, /^# POPDEX_AGENT_PRIVATE_KEY=$/m);
});

test("clear removes every duplicate Agent key from the env file", async () => {
  const fsImpl = new MemoryFs();
  fsImpl.content =
    `POPDEX_AGENT_PRIVATE_KEY=${AGENT_KEY}\n` +
    "# POPDEX_AGENT_PRIVATE_KEY=old\n" +
    "POPDEX_AGENT_PRIVATE_KEY=stale\n";
  const revoked = service({
    fsImpl,
    processEnv: configuredEnv(),
    info: activeInfo({ exists: false, delegator: null, expiresAt: "0" }),
  });

  await revoked.service.clear();

  assert.equal(
    (fsImpl.content.match(/^# POPDEX_AGENT_PRIVATE_KEY=$/gm) || []).length,
    1
  );
  assert.doesNotMatch(fsImpl.content, /^POPDEX_AGENT_PRIVATE_KEY=/m);
});

test("concurrent clear cannot remove a newly saved Agent key", async () => {
  const oldLookupStarted = deferred<void>();
  const releaseOldLookup = deferred<void>();
  const ctx = service({
    processEnv: configuredEnv(),
    getAgentInfo: async (agent) => {
      if (agent === AGENT) {
        oldLookupStarted.resolve();
        await releaseOldLookup.promise;
        return activeInfo({ exists: false, delegator: null, expiresAt: "0" });
      }
      assert.equal(agent, NEW_AGENT);
      return activeInfo();
    },
  });

  const clearing = ctx.service.clear();
  await oldLookupStarted.promise;
  let saveSettled = false;
  const saving = ctx.service
    .save({ mainAccount: MAIN, agentPrivateKey: NEW_AGENT_KEY })
    .then(() => {
      saveSettled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  const saveSettledBeforeRelease = saveSettled;

  releaseOldLookup.resolve();
  await Promise.all([clearing, saving]);
  assert.equal(saveSettledBeforeRelease, false);
  assert.equal(ctx.processEnv.POPDEX_AGENT_PRIVATE_KEY, NEW_AGENT_KEY);
  assert.match(
    ctx.fsImpl.content,
    new RegExp(`^POPDEX_AGENT_PRIVATE_KEY=${NEW_AGENT_KEY}$`, "m")
  );
});

test("clear refuses to erase an Agent key changed during revocation verification", async () => {
  const lookupStarted = deferred<void>();
  const releaseLookup = deferred<void>();
  const processEnv = configuredEnv();
  const ctx = service({
    processEnv,
    getAgentInfo: async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return activeInfo({ exists: false, delegator: null, expiresAt: "0" });
    },
  });

  const clearing = ctx.service.clear();
  await lookupStarted.promise;
  processEnv.POPDEX_AGENT_PRIVATE_KEY = NEW_AGENT_KEY;
  releaseLookup.resolve();

  await assert.rejects(clearing, /配置已变化.*拒绝清除/);
  assert.equal(processEnv.POPDEX_AGENT_PRIVATE_KEY, NEW_AGENT_KEY);
  assert.equal(ctx.fsImpl.writes.length, 0);
});

test("failed identity write releases the queue for the next save", async () => {
  const firstLookupStarted = deferred<void>();
  const releaseFirstLookup = deferred<void>();
  let attempts = 0;
  let secondLookupStarted = false;
  const ctx = service({
    getAgentInfo: async () => {
      attempts += 1;
      if (attempts === 1) {
        firstLookupStarted.resolve();
        await releaseFirstLookup.promise;
        throw new Error("rpc unavailable");
      }
      secondLookupStarted = true;
      return activeInfo();
    },
  });

  const first = ctx.service.save({ mainAccount: MAIN, agentPrivateKey: AGENT_KEY });
  await firstLookupStarted.promise;
  const second = ctx.service.save({
    mainAccount: MAIN,
    agentPrivateKey: NEW_AGENT_KEY,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondLookupStartedBeforeRelease = secondLookupStarted;

  releaseFirstLookup.resolve();
  await assert.rejects(first, /rpc unavailable/);
  await second;
  assert.equal(secondLookupStartedBeforeRelease, false);
  assert.equal(ctx.processEnv.POPDEX_AGENT_PRIVATE_KEY, NEW_AGENT_KEY);
});

test("status returns public identity without the configured private key", async () => {
  const ctx = service({ processEnv: configuredEnv() });
  const status = await ctx.service.status();
  assert.equal(status.exists, true);
  assert.equal(status.agentAddress, AGENT);
  assert.equal(status.mainAccount, MAIN);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(AGENT_KEY));
});

test("authorization rejects expired, global, mismatched and identical identities", async () => {
  for (const [info, pattern] of [
    [activeInfo({ isExpired: true }), /已过期/],
    [activeInfo({ isGlobal: true }), /全局权限/],
    [activeInfo({ delegator: OTHER_MAIN }), /delegator/],
  ] as const) {
    const ctx = service({ info });
    await assert.rejects(
      ctx.service.verifyAuthorization({ mainAccount: MAIN, agentAddress: AGENT }),
      pattern
    );
  }
  const ctx = service();
  await assert.rejects(
    ctx.service.verifyAuthorization({ mainAccount: AGENT, agentAddress: AGENT }),
    /不能相同/
  );
});

test("write failure leaves runtime credentials unchanged", async () => {
  const fsImpl = new MemoryFs();
  fsImpl.failWrite = true;
  const processEnv: NodeJS.ProcessEnv = { KEEP: "yes" };
  const ctx = service({ fsImpl, processEnv });
  await assert.rejects(
    ctx.service.save({ mainAccount: MAIN, agentPrivateKey: AGENT_KEY }),
    /disk full/
  );
  assert.deepEqual(processEnv, { KEEP: "yes" });
});

test("mutation guard blocks save, revoke preparation and clear", async () => {
  const ctx = service({ processEnv: configuredEnv(), canMutate: () => false });
  await assert.rejects(
    ctx.service.prepareApproval({
      agentAddress: AGENT,
      delegator: MAIN,
      hostname: "grid.example",
    }),
    /请先暂停/
  );
  await assert.rejects(
    ctx.service.save({ mainAccount: MAIN, agentPrivateKey: AGENT_KEY }),
    /请先暂停/
  );
  await assert.rejects(
    ctx.service.prepareRevoke({ mainAccount: MAIN, agentAddress: AGENT }),
    /请先暂停/
  );
  await assert.rejects(ctx.service.clear(), /请先暂停/);
  assert.deepEqual(ctx.calls, []);
});

test("revoke allows expired and global Agents owned by the main account", async () => {
  for (const info of [activeInfo({ isExpired: true }), activeInfo({ isGlobal: true })]) {
    const ctx = service({ info });
    const prepared = await ctx.service.prepareRevoke({
      mainAccount: MAIN,
      agentAddress: AGENT,
    });
    assert.equal(prepared.from, MAIN);
  }
});

test("revoke rejects a mismatched delegator", async () => {
  const ctx = service({ info: activeInfo({ delegator: OTHER_MAIN }) });
  await assert.rejects(
    ctx.service.prepareRevoke({ mainAccount: MAIN, agentAddress: AGENT }),
    /delegator/
  );
});

test("approval preparation selects a unique same-name replacement", async () => {
  const oldAgent = "0x3000000000000000000000000000000000000003";
  const ctx = service({
    agents: [
      { agent: oldAgent, expiresAt: "1", isExpired: false, name: NAME, isGlobal: false },
    ],
  });
  const prepared = await ctx.service.prepareApproval({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: "grid.example",
  });
  assert.equal(prepared.action, "replace");
  assert.equal(prepared.replacedAgent, oldAgent);
  assert.equal(prepared.from, MAIN);
});
