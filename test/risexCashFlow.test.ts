import assert from "node:assert/strict";
import { RisexExecutor } from "../src/venues/risex.js";

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

console.log("risexCashFlow.test.ts OK");
