# Order Ownership Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist exchange-confirmed grid order IDs and provide an explicit adoption command so RISEx and Decibel can restart without cancelling and rebuilding their grids.

**Architecture:** A standalone `OrderOwnershipStore` owns strict JSON validation, atomic persistence, grid fingerprints, adoption records, and live-order reconciliation. The live loop restores only exact persisted IDs, preserves the existing unknown-order pause, and records every successful placement before another write cycle. A separate read-only adoption workflow previews current exchange orders and writes the first ownership snapshot only after an explicit confirmation flag.

**Tech Stack:** TypeScript ESM, Node.js filesystem APIs, existing venue executors, existing grid matching helpers, `node:assert/strict`, `tsx`.

---

## File map

- Create `src/orderOwnership.ts`: state schema, validation, atomic store, fingerprint comparison, reconciliation, and order adoption mapping.
- Create `src/adoptOrders.ts`: dependency-injected preview/confirmation workflow that never calls venue write APIs.
- Create `src/cli/adopt-orders.ts`: production CLI entrypoint and argument handling.
- Modify `src/loop.ts`: load ownership before trading, restore runtime IDs/active orders, prune stale records, preserve unknown-order pauses, and persist successful placements.
- Modify `package.json`: add `adopt-orders` and ownership test scripts.
- Create `test/orderOwnership.test.ts`: filesystem, validation, fingerprint, reconciliation, and restart tests.
- Create `test/adoptOrders.test.ts`: read-only preview, explicit confirmation, and all-or-nothing tests.
- Modify `README.md`: first adoption, normal restart, and recovery instructions.

### Task 1: Strict ownership state and atomic persistence

**Files:**
- Create: `src/orderOwnership.ts`
- Create: `test/orderOwnership.test.ts`

- [ ] **Step 1: Write the failing state-store test**

Create `test/orderOwnership.test.ts` with a temporary working directory and these public API expectations:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OrderOwnershipStore,
  emptyOrderOwnershipState,
  type GridFingerprint,
} from "../src/orderOwnership.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-grid-ownership-"));
const file = path.join(dir, "order-ownership.json");
const grid: GridFingerprint = {
  anchorMid: 63_314.2,
  gridCount: 65,
  spacing: 89.9136568,
  sizeBase: 0.0040822,
  mode: "neutral",
};

try {
  const store = new OrderOwnershipStore(file);
  assert.deepEqual(store.load(), emptyOrderOwnershipState());

  store.replaceVenue("decibel", {
    market: "BTC",
    grid,
    orders: [
      { id: "d-1", side: "buy", price: 62_000, size: 0.0040822, level: 18 },
    ],
    updatedAt: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(store.load().venues.decibel?.orders[0]?.id, "d-1");

  fs.writeFileSync(file, "{broken", "utf8");
  assert.throws(() => store.load(), /order-ownership\.json.*JSON/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --import tsx test/orderOwnership.test.ts
```

Expected: fail because `src/orderOwnership.ts` does not exist.

- [ ] **Step 3: Implement the minimal strict store**

Create `src/orderOwnership.ts` with these types and methods:

```ts
import fs from "node:fs";
import path from "node:path";
import type { GridMode, LiveOrder, Side, VenueId } from "./types.js";

export type GridFingerprint = {
  anchorMid: number;
  gridCount: number;
  spacing: number;
  sizeBase: number;
  mode: GridMode;
};

export type OwnedOrderRecord = {
  id: string;
  side: Side;
  price: number;
  size: number;
  level: number;
};

export type VenueOwnership = {
  market: string;
  grid: GridFingerprint;
  orders: OwnedOrderRecord[];
  updatedAt: string;
};

export type OrderOwnershipState = {
  version: 1;
  venues: Partial<Record<VenueId, VenueOwnership>>;
};

export function emptyOrderOwnershipState(): OrderOwnershipState {
  return { version: 1, venues: {} };
}

export class OrderOwnershipStore {
  constructor(
    readonly file = path.resolve(process.cwd(), "data", "order-ownership.json")
  ) {}

  load(): OrderOwnershipState;
  save(state: OrderOwnershipState): void;
  replaceVenue(venue: VenueId, value: VenueOwnership): void;
  recordPlaced(
    venue: VenueId,
    market: string,
    grid: GridFingerprint,
    orders: OwnedOrderRecord[]
  ): void;
  reconcile(
    venue: VenueId,
    market: string,
    liveOrders: LiveOrder[]
  ): {
    ownedOrderIds: Set<string>;
    active: Map<string, { levelIndex: number; side: Side; price: number; size: number }>;
    unknownOrderIds: string[];
    removedOrderIds: string[];
  };
}
```

`load()` must return an empty state only when the file is absent. It must throw a path-qualified error for malformed JSON, wrong version, unknown venue, invalid market, non-finite/non-positive price or size, invalid level, or duplicate ID. `save()` must validate first, write `${file}.${process.pid}.tmp`, then `renameSync` it over the final file; on failure it must remove only its own temporary file and rethrow.

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
node --import tsx test/orderOwnership.test.ts
```

Expected: `orderOwnership.test.ts OK`.

- [ ] **Step 5: Add reconciliation and fingerprint tests first**

Extend the test before changing implementation:

```ts
fs.unlinkSync(file);
store.replaceVenue("decibel", {
  market: "BTC",
  grid,
  orders: [
    { id: "d-1", side: "buy", price: 62_000, size: 0.0040822, level: 18 },
  ],
  updatedAt: "2026-08-14T00:00:00.000Z",
});

const restored = store.reconcile("decibel", "BTC", [
  { id: "d-1", market: "BTC", side: "buy", price: 62_000, size: 0.0040822, level: 0 },
  { id: "manual", market: "BTC", side: "sell", price: 64_000, size: 0.0040822, level: 0 },
]);
assert.deepEqual([...restored.ownedOrderIds], ["d-1"]);
assert.deepEqual(restored.unknownOrderIds, ["manual"]);

store.reconcile("decibel", "BTC", []);
assert.deepEqual(store.load().venues.decibel?.orders, []);

assert.throws(
  () => store.assertGrid("decibel", "BTC", { ...grid, gridCount: 64 }),
  /gridCount/
);
```

Run the test and expect failure because `assertGrid()` and full reconciliation are missing.

- [ ] **Step 6: Implement reconciliation and exact grid checks**

Add:

```ts
assertGrid(venue: VenueId, market: string, actual: GridFingerprint): void;
```

Use exact equality for `market`, `gridCount`, and `mode`. For numeric fields use:

```ts
const close = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-8);
```

`reconcile()` must preserve only exact persisted/live ID intersections, build `active` from the persisted level plus live side/price/size, report every live non-owned ID as unknown, remove stale persisted IDs, and save only when stale IDs were removed.

- [ ] **Step 7: Run the ownership test**

Run the same command and expect `orderOwnership.test.ts OK`.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/orderOwnership.ts test/orderOwnership.test.ts
git commit -m "新增订单归属持久化存储"
```

### Task 2: Explicit read-only adoption workflow

**Files:**
- Create: `src/adoptOrders.ts`
- Create: `src/cli/adopt-orders.ts`
- Create: `test/adoptOrders.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing adoption test**

Create a fake read-only executor whose `apply`, `cancelAll`, and `closePosition` throw if called. Inject two snapshots and a status snapshot into `runAdoptOrders()`:

```ts
const result = await runAdoptOrders(
  { venues: ["risex", "decibel"], market: "BTC", confirm: false },
  deps
);
assert.equal(result.written, false);
assert.equal(fs.existsSync(file), false);
assert.equal(writeCalls, 0);

const confirmed = await runAdoptOrders(
  { venues: ["risex", "decibel"], market: "BTC", confirm: true },
  deps
);
assert.equal(confirmed.written, true);
assert.equal(store.load().venues.risex?.orders.length, 46);
assert.equal(store.load().venues.decibel?.orders.length, 66);
assert.equal(writeCalls, 0);
```

Also test that one invalid Decibel order causes rejection and leaves the ownership file unchanged for both venues.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --import tsx test/adoptOrders.test.ts
```

Expected: fail because `src/adoptOrders.ts` does not exist.

- [ ] **Step 3: Implement the dependency-injected adoption core**

Define:

```ts
export type AdoptOrdersOptions = {
  venues: VenueId[];
  market: string;
  confirm: boolean;
};

export type AdoptOrdersDeps = {
  store: OrderOwnershipStore;
  createExecutor: (venue: VenueId) => VenueExecutor;
  loadStatus: () => DashboardSnapshot;
  gridMode: (venue: VenueId) => GridMode;
  output: (line: string) => void;
};

export async function runAdoptOrders(
  options: AdoptOrdersOptions,
  deps: AdoptOrdersDeps
): Promise<{ written: boolean; counts: Partial<Record<VenueId, number>> }>;
```

For every venue, connect, snapshot, find the same venue/market in status, rebuild levels from the saved `lower`, `upper`, and `gridCount`, and map every order with `matchLevelIndex`. Reject empty IDs, duplicates, invalid prices/sizes, or prices outside the saved grid. Build all venue records in memory; call `store.save()` exactly once only after every venue validates and `confirm` is true. Always disconnect all executors in `finally`.

- [ ] **Step 4: Implement CLI parsing without an environment backdoor**

`src/cli/adopt-orders.ts` must accept only:

```ts
--venues=risex,decibel
--market=BTC
--confirm-all-bot-orders
```

It must reject `DRY_RUN=1`, load the existing runtime config and status file, construct live executors with `createExecutor(venue, false)`, and call `runAdoptOrders`. No `.env` flag may imply confirmation.

Add scripts:

```json
"adopt-orders": "node --import tsx src/cli/adopt-orders.ts",
"test": "node --import tsx test/grid.test.ts && node --import tsx test/security.test.ts && node --import tsx test/orderOwnership.test.ts && node --import tsx test/adoptOrders.test.ts"
```

- [ ] **Step 5: Run adoption tests and existing tests**

Run:

```bash
node --import tsx test/adoptOrders.test.ts
node --import tsx test/grid.test.ts
node --import tsx test/security.test.ts
```

Expected: all commands exit 0 and print their `OK` lines.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/adoptOrders.ts src/cli/adopt-orders.ts test/adoptOrders.test.ts package.json
git commit -m "新增现有机器人挂单接管命令"
```

### Task 3: Restore and maintain ownership in the live loop

**Files:**
- Modify: `src/orderOwnership.ts`
- Modify: `src/loop.ts`
- Modify: `test/orderOwnership.test.ts`

- [ ] **Step 1: Write the failing restart-safety test**

Add a pure runtime preparation API expectation to `test/orderOwnership.test.ts`:

```ts
store.replaceVenue("decibel", {
  market: "BTC",
  grid,
  orders: [
    { id: "d-1", side: "buy", price: 62_000, size: 0.0040822, level: 18 },
  ],
  updatedAt: "2026-08-14T00:00:00.000Z",
});

const restart = store.prepareRuntime("decibel", "BTC", grid, [
  { id: "d-1", market: "BTC", side: "buy", price: 62_000, size: 0.0040822, level: 0 },
]);
assert.equal(restart.pauseReason, undefined);
assert.deepEqual([...restart.ownedOrderIds], ["d-1"]);
assert.equal(restart.active.get("d-1")?.levelIndex, 18);

const withUnknown = store.prepareRuntime("decibel", "BTC", grid, [
  { id: "d-1", market: "BTC", side: "buy", price: 62_000, size: 0.0040822, level: 0 },
  { id: "manual", market: "BTC", side: "sell", price: 64_000, size: 0.0040822, level: 0 },
]);
assert.match(withUnknown.pauseReason || "", /1 个无法确认归属/);

const failedWrite = persistPlacedOrders({
  store: { recordPlaced: () => { throw new Error("disk full"); } },
  venue: "decibel",
  market: "BTC",
  grid,
  orders: [
    { id: "d-2", side: "sell", price: 64_000, size: 0.0040822, level: 40 },
  ],
});
assert.equal(failedWrite.ok, false);
assert.match(failedWrite.ok ? "" : failedWrite.pauseReason, /d-2.*disk full/);
```

Run the ownership test and expect failure because `prepareRuntime()` and `persistPlacedOrders()` are missing.

- [ ] **Step 2: Implement `prepareRuntime()`**

Add a method that calls `assertGrid()` and `reconcile()`, then returns restored sets/maps plus a standard pause message when unknown IDs exist. If no venue record exists and live orders are non-empty, every live ID must be unknown. It must never add a live ID to ownership by price alone.

Add a small live-write wrapper with a discriminated result:

```ts
export function persistPlacedOrders(p: {
  store: Pick<OrderOwnershipStore, "recordPlaced">;
  venue: VenueId;
  market: string;
  grid: GridFingerprint;
  orders: OwnedOrderRecord[];
}): { ok: true } | { ok: false; pauseReason: string };
```

It calls `recordPlaced` once. On failure it returns an explicit pause message containing the confirmed order IDs and filesystem error; it must not report success or omit the error.

- [ ] **Step 3: Integrate ownership loading before the first write**

In `runLoop`:

```ts
const ownershipStore = new OrderOwnershipStore();
const ownershipState = ownershipStore.load();
softResumeAnchors = loadSoftResumeAnchors(ownershipState);
```

Change `loadSoftResumeAnchors` to prefer `ownershipState.venues[venue].grid.anchorMid/gridCount`; use `data/status.json` only for venues without ownership state. Do not catch malformed ownership JSON.

Add to `VenueRuntime`:

```ts
ownershipRestored: boolean;
ownershipPause?: string;
```

Immediately after `ensureAnchored()` and before `manageRecenter()`, construct the current fingerprint, call `prepareRuntime()` once, restore both `ownedOrderIds` and `active`, and log loaded/matched/removed/unknown counts. A fingerprint error or unknown result must set `recenterPhase="paused"` and `recenterNotice` without calling `apply`.

- [ ] **Step 4: Persist every successful placement before continuing**

After `rt.ex.apply(plan.intents)` returns, add all returned IDs to the in-memory sets, then call `persistPlacedOrders` with:

```ts
persistPlacedOrders({
  store: ownershipStore,
  venue: rt.ex.id,
  market,
  grid: currentFingerprint(rt, market),
  orders: result.placedOrders.map(({ id, order }) => ({
    id,
    side: order.side,
    price: order.price,
    size: order.size,
    level: order.level,
  })),
});
```

If the result is not `ok` after one or more placements, set the venue to paused using `pauseReason`, retain the confirmed IDs in memory, log and notify Telegram, and return from the tick before any later writes. Do not count failed exchange intents as owned.

- [ ] **Step 5: Prune only after live confirmation**

At the beginning of later ticks, call reconciliation before planning. Preserve the previous `active` map until `planFromFillsAndSeed` sees missing IDs so fill detection still works; update only `ownedOrderIds` and the persisted file. Use restored `active` only on the first tick after process start.

- [ ] **Step 6: Run targeted and full tests**

Run:

```bash
node --import tsx test/orderOwnership.test.ts
node --import tsx test/adoptOrders.test.ts
npm test
```

Expected: all ownership/adoption tests pass and the complete npm test script exits 0.

Run:

```bash
node node_modules/typescript/bin/tsc --noEmit
```

Expected: no new errors in `src/orderOwnership.ts`, `src/adoptOrders.ts`, `src/cli/adopt-orders.ts`, or `src/loop.ts`. Record the repository's pre-existing N1/Phoenix SDK errors separately if they remain.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/orderOwnership.ts src/loop.ts test/orderOwnership.test.ts
git commit -m "恢复并持续记录机器人订单归属"
```

### Task 4: Operator documentation and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the safe first deployment**

Add a section with the exact sequence:

```bash
# 1. Stop the bot; do not cancel exchange orders.
npm run adopt-orders -- --venues=risex,decibel --market=BTC
npm run adopt-orders -- --venues=risex,decibel --market=BTC --confirm-all-bot-orders
npm start
```

Document expected logs, the location and backup importance of `data/order-ownership.json`, the fact that it contains no credentials, and the recovery rule: unknown orders or a grid fingerprint mismatch require inspection and a new explicit adoption; never delete the file while live orders remain.

- [ ] **Step 2: Run final verification from a clean status**

Run:

```bash
npm test
git diff --check fork/main...HEAD
git status --short --branch
```

Expected: tests pass, diff check exits 0, and only intentional committed changes exist.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "文档：补充挂单接管与安全重启流程"
```

- [ ] **Step 4: Review final diff and deployment safety**

Confirm the final diff contains no `.env`, `data/`, private keys, API keys, tokens, or live order data. Confirm no automated test constructs a real executor or sends a network request.
