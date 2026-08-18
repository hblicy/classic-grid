import assert from "node:assert/strict";
import { RisexExecutor } from "../src/venues/risex.js";
import { RiseExchange } from "../vendor/risex/risex.js";

function fakeExchange(transfers: unknown[]) {
  return {
    markets: new Map([[1, { name: "BTC-PERP" }]]),
    marketIdForName: () => 1,
    _refreshAllPositions: async () => undefined,
    refreshOpenOrders: async () => [],
    getPrice: async () => 64_000,
    getPosition: () => null,
    getAllPositions: () => [],
    _refreshAccount: async function (this: { equity?: number }) {
      this.equity = 800;
    },
    getTransferHistory: async () => transfers,
  };
}

const currentRow = {
  address: "0x0000000000000000000000000000000000000001",
  type: "DEPOSIT",
  block_number: "19416414",
  transaction_hash: "0xcurrent-deposit",
  token_address: "0x0000000000000000000000000000000000000002",
  amount: "800",
  block_time: "1787022173000000000",
};

const wrapped = new RiseExchange({
  account: "0x0000000000000000000000000000000000000001",
  signerKey: `0x${"01".repeat(32)}`,
  apiUrl: "https://api.rise.trade",
  wsUrl: "wss://ws.rise.trade/ws",
}) as any;
wrapped.info.http.get = async () => ({
  items: [currentRow],
  page: 1,
  has_next_page: false,
});

const currentRows = await wrapped.getTransferHistory(50);
assert.deepEqual(currentRows, [currentRow]);

const currentExecutor = new RisexExecutor(false) as any;
currentExecutor.ex = fakeExchange(currentRows);
const currentSnapshot = await currentExecutor.snapshot("BTC");
assert.deepEqual(currentSnapshot.cashFlows, [
  {
    id: "0xcurrent-deposit",
    amountUsd: 800,
    timestampMs: 1787022173000,
  },
]);

const timestampMs = Date.now();
const timestampNs = (BigInt(timestampMs) * 1_000_000n).toString();
const executor = new RisexExecutor(false) as any;
executor.ex = fakeExchange([
  {
    type: "deposit",
    amount: "800",
    timestamp: timestampNs,
    transaction_hash: "0xdeposit",
  },
  {
    type: "withdrawal",
    amount: "200",
    timestamp: timestampNs,
    transaction_hash: "0xwithdraw",
  },
]);

const snapshot = await executor.snapshot("BTC");
assert.deepEqual(snapshot.cashFlows, [
  { id: "0xdeposit", amountUsd: 800, timestampMs },
  { id: "0xwithdraw", amountUsd: -200, timestampMs },
]);

const invalid = new RisexExecutor(false) as any;
invalid.ex = fakeExchange([
  {
    type: "mystery",
    amount: "1",
    timestamp: timestampNs,
    transaction_hash: "0xunknown",
  },
]);
await assert.rejects(
  () => invalid.snapshot("BTC"),
  /未知 RISEx 资金流水类型/
);

const malformed = new RiseExchange({
  account: "0x0000000000000000000000000000000000000001",
  signerKey: `0x${"01".repeat(32)}`,
  apiUrl: "https://api.rise.trade",
  wsUrl: "wss://ws.rise.trade/ws",
}) as any;
malformed.info.http.get = async () => ({ unexpected: [] });
await assert.rejects(
  () => malformed.getTransferHistory(50),
  /transfer-history 响应结构无效.*unexpected/
);

console.log("risexCashFlow.test.ts OK");
