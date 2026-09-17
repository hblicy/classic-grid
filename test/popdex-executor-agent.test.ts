import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolvePopdexStatsAddress } from "../src/officialStats.js";
import {
  POPDEX_PLACE_ORDER_ABI,
  PopdexExecutor,
  resolvePopdexIdentity,
} from "../src/venues/popdex.js";

const MAIN = "0x1000000000000000000000000000000000000001";
const OTHER_MAIN = "0x2000000000000000000000000000000000000002";
const AGENT_KEY = `0x${"11".repeat(32)}` as `0x${string}`;
const AGENT = privateKeyToAccount(AGENT_KEY).address;
const HASH = `0x${"ab".repeat(32)}` as const;

test("live identity rejects legacy main-wallet secrets", () => {
  assert.throws(
    () => resolvePopdexIdentity({ POPDEX_PRIVATE_KEY: AGENT_KEY }),
    /旧配置 POPDEX_PRIVATE_KEY.*停用/
  );
  assert.throws(
    () => resolvePopdexIdentity({ POPDEX_KEY_PATH: "secrets/popdex.key" }),
    /旧配置 POPDEX_KEY_PATH.*停用/
  );
});

test("identity separates the main account from the Agent signer", () => {
  const identity = resolvePopdexIdentity({
    POPDEX_MAIN_ACCOUNT: MAIN,
    POPDEX_AGENT_PRIVATE_KEY: AGENT_KEY,
  });
  assert.equal(identity.mainAccount, MAIN);
  assert.equal(identity.agentAccount.address, AGENT);
  assert.throws(
    () =>
      resolvePopdexIdentity({
        POPDEX_MAIN_ACCOUNT: AGENT,
        POPDEX_AGENT_PRIVATE_KEY: AGENT_KEY,
      }),
    /不能相同/
  );
});

test("executor reads the main account, signs as Agent, and encodes main ownership", async () => {
  const paths: string[] = [];
  const sent: any[] = [];
  const walletAccounts: string[] = [];
  const executor = new PopdexExecutor(false, {
    env: {
      POPDEX_MAIN_ACCOUNT: MAIN,
      POPDEX_AGENT_PRIVATE_KEY: AGENT_KEY,
      POPDEX_SYMBOL: "BTCUSDT",
      POPDEX_ORDER_GAP_MS: "0",
    },
    apiGet: async <T,>(pathname: string): Promise<T> => {
      paths.push(pathname);
      if (pathname.startsWith("/api/v1/config/symbol")) {
        return { symbolId: 20000, tickSize: 1, lotSize: 0.0001, minQty: 0.0001, minNotional: 10 } as T;
      }
      if (pathname.startsWith("/api/v1/public/market/tickers")) {
        return [{ symbol: "BTCUSDT", bid1Price: "99", ask1Price: "101" }] as T;
      }
      if (pathname.endsWith("/overview")) return { accountEquity: "1000" } as T;
      return [] as T;
    },
    agentRpc: {
      async verifyChain() {},
      async getAgentInfo() {
        return {
          exists: true,
          expiresAt: String(Date.now() + 86_400_000),
          isExpired: false,
          delegator: MAIN,
          name: `0x${"00".repeat(32)}` as const,
          isGlobal: false,
        };
      },
    },
    createWallet: (account) => {
      walletAccounts.push(account.address);
      return {
        async sendTransaction(transaction: any) {
          sent.push(transaction);
          return HASH;
        },
      };
    },
    createPublic: () => ({
      async getTransactionReceipt() {
        return { status: "success" as const };
      },
    }),
    sleep: async () => {},
  });

  await executor.connect();
  await executor.snapshot("BTC");
  const result = await executor.apply([
    {
      type: "place",
      order: { market: "BTC", side: "buy", price: 90, size: 0.2, level: 1 },
    },
  ]);
  assert.equal(result.placed, 1);
  assert.deepEqual(walletAccounts, [AGENT]);
  assert.ok(paths.some((value) => value.includes(`/account/${MAIN}/overview`)));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].account.address, AGENT);
  const decoded = decodeFunctionData({
    abi: POPDEX_PLACE_ORDER_ABI,
    data: sent[0].data,
  });
  assert.equal(decoded.functionName, "placeOrder");
  assert.equal(decoded.args?.[0], MAIN);
});

test("executor refuses invalid authorization before creating a signer", async () => {
  let wallets = 0;
  const executor = new PopdexExecutor(false, {
    env: { POPDEX_MAIN_ACCOUNT: MAIN, POPDEX_AGENT_PRIVATE_KEY: AGENT_KEY },
    apiGet: async <T,>() => ({}) as T,
    agentRpc: {
      async verifyChain() {},
      async getAgentInfo() {
        return {
          exists: true,
          expiresAt: String(Date.now() + 86_400_000),
          isExpired: false,
          delegator: OTHER_MAIN,
          name: `0x${"00".repeat(32)}` as const,
          isGlobal: false,
        };
      },
    },
    createWallet: () => {
      wallets += 1;
      throw new Error("must not create wallet");
    },
  });
  await assert.rejects(executor.connect(), /delegator/);
  assert.equal(wallets, 0);
});

test("official statistics resolve only POPDEX_MAIN_ACCOUNT", () => {
  assert.equal(
    resolvePopdexStatsAddress({
      POPDEX_MAIN_ACCOUNT: MAIN,
      POPDEX_AGENT_PRIVATE_KEY: AGENT_KEY,
      POPDEX_PRIVATE_KEY: `0x${"22".repeat(32)}`,
    }),
    MAIN
  );
  assert.throws(() => resolvePopdexStatsAddress({}), /POPDEX_MAIN_ACCOUNT/);
  assert.throws(
    () => resolvePopdexStatsAddress({ POPDEX_MAIN_ACCOUNT: "bad" }),
    /地址无效/
  );
});
