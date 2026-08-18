# RISEx Transfer Response Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correctly ingest current RISEx mainnet `items + block_time` transfer responses so same-day deposits and withdrawals adjust the ledger baseline instead of inflating daily PnL.

**Architecture:** Keep the existing `VenueSnapshot.cashFlows` and ledger accounting path. Repair only the RISEx adapter boundary: the vendored exchange wrapper validates and returns either current `items` or legacy `transfers`, while `RisexExecutor` normalizes `block_time` or `timestamp` into the existing cash-flow type. Unknown schemas fail loudly.

**Tech Stack:** TypeScript, Node.js 20+, `tsx`, Node `assert`, vendored `risex-client`

---

## File map

- Modify `vendor/risex/risex.js`: fetch and validate the raw transfer-history response without the outdated SDK `data.transfers` projection.
- Modify `src/venues/risex.ts`: accept `block_time` and legacy `timestamp`, then normalize them to `timestampMs`.
- Modify `test/risexCashFlow.test.ts`: reproduce the real mainnet response, retain legacy-format coverage, and assert unknown schemas fail.
- Modify `test/ledger.test.ts`: prove an old transfer is ignored while a same-day transfer is applied once.

### Task 1: Reproduce and fix the RISEx adapter mismatch

**Files:**
- Modify: `test/risexCashFlow.test.ts`
- Modify: `vendor/risex/risex.js:909-911`
- Modify: `src/venues/risex.ts:32-40`
- Modify: `src/venues/risex.ts:71-100`

- [ ] **Step 1: Add a failing test for the current mainnet response**

Add the vendored wrapper import and a current-response fixture to `test/risexCashFlow.test.ts` before the existing legacy `timestamp` test:

```ts
import { RiseExchange } from "../vendor/risex/risex.js";

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
```

- [ ] **Step 2: Add a failing test for unknown response schemas**

Append this assertion to the same test file:

```ts
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
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --import tsx test/risexCashFlow.test.ts
```

Expected: FAIL because the current vendored method projects `data.transfers` and returns `[]` for `{ items: [...] }`.

- [ ] **Step 4: Replace the outdated wrapper projection with validated raw-response handling**

Replace `RiseExchange.getTransferHistory()` in `vendor/risex/risex.js` with:

```js
  async getTransferHistory(limit = 1000) {
    const data = await this.info.http.get(
      `/v1/account/transfer-history?account=${encodeURIComponent(this.account)}&limit=${limit}`
    );
    const rows = data?.items ?? data?.transfers;
    if (!Array.isArray(rows)) {
      const keys =
        data && typeof data === 'object'
          ? Object.keys(data).join(',')
          : typeof data;
      throw new Error(
        `RISEx transfer-history 响应结构无效 keys=${keys || '(none)'}`
      );
    }
    return rows;
  }
```

- [ ] **Step 5: Accept current and legacy timestamp fields in the executor**

Change the transfer row fields in `src/venues/risex.ts` to:

```ts
      amount: string;
      type: string;
      timestamp?: string;
      block_time?: string;
      transaction_hash?: string;
      id?: string;
      tx_hash?: string;
```

Apply the same optional fields to the `parseTransfer()` parameter, then normalize the timestamp and fallback ID using:

```ts
  const rawTimestamp = row.timestamp ?? row.block_time;
  const timestampMs = parseTransferTimestampMs(rawTimestamp);
  const amountUsd = Math.abs(rawAmount) * sign;
  const id =
    String(row.transaction_hash || row.tx_hash || row.id || "").trim() ||
    `${type}:${String(rawTimestamp)}:${Math.abs(rawAmount)}`;
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
node --import tsx test/risexCashFlow.test.ts
```

Expected: `risexCashFlow.test.ts OK`.

- [ ] **Step 7: Commit the adapter fix**

```bash
git add test/risexCashFlow.test.ts vendor/risex/risex.js src/venues/risex.ts
git commit -m "修复 RISEx 资金流水响应解析"
```

### Task 2: Lock down ledger date filtering and restart behavior

**Files:**
- Modify: `test/ledger.test.ts`

- [ ] **Step 1: Add an old transfer to the existing deposit fixture**

Immediately before the existing `deposit` fixture, add:

```ts
  const oldDeposit = {
    id: "0xold-deposit",
    amountUsd: 800,
    timestampMs: Date.parse(`${yesterday}T12:00:00+08:00`),
  };
```

Change the first deposit ingest call to include both records:

```ts
  const afterDeposit = ingestVenuesForLedger([
    venue("risex", 1605, [oldDeposit, deposit]),
  ]);
```

Keep these assertions and add the explicit old-ID exclusion:

```ts
  assert.equal(afterDeposit.dayOpenEquity, 1600);
  assert.equal(afterDeposit.calendar[0]?.dayProfit, 5);
  assert.equal(afterDeposit.calendar[0]?.externalCashFlow, 800);
  assert.deepEqual(afterDeposit.processedCashFlowIds, ["risex:0xdeposit:1"]);
  assert.ok(!afterDeposit.processedCashFlowIds?.includes("risex:0xold-deposit"));
```

- [ ] **Step 2: Run the ledger regression test**

Run:

```bash
node --import tsx test/ledger.test.ts
```

Expected: `ledger.test.ts OK`; the old 800U transfer is ignored, and the current 800U transfer adjusts the baseline exactly once.

- [ ] **Step 3: Commit the ledger regression coverage**

```bash
git add test/ledger.test.ts
git commit -m "补充 RISEx 跨日流水回归测试"
```

### Task 3: Full verification

**Files:**
- Verify only; no production files added.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: all six test files end in `OK`, including `risexCashFlow.test.ts` and `ledger.test.ts`.

- [ ] **Step 2: Run whitespace validation**

Run:

```bash
git diff --check fork/main...HEAD
```

Expected: exit code 0 with no whitespace errors.

- [ ] **Step 3: Run TypeScript validation and classify existing failures**

Run:

```bash
npx tsc --noEmit
```

Expected repository baseline errors may remain in `src/officialStats.ts`, `src/venues/n1.ts`, and `src/venues/phoenix.ts`. There must be no new error in `src/venues/risex.ts`, `test/risexCashFlow.test.ts`, or `test/ledger.test.ts`.

- [ ] **Step 4: Verify branch scope and cleanliness**

Run:

```bash
git status -sb
git diff --stat fork/main...HEAD
git log --oneline fork/main..HEAD
```

Expected: only the design, plan, RISEx adapter, and related tests differ from `fork/main`; the working tree is clean.
