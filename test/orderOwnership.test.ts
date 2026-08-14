import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OrderOwnershipStore,
  emptyOrderOwnershipState,
  persistPlacedOrders,
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
    {
      id: "d-1",
      market: "BTC",
      side: "buy",
      price: 62_000,
      size: 0.0040822,
      level: 0,
    },
    {
      id: "manual",
      market: "BTC",
      side: "sell",
      price: 64_000,
      size: 0.0040822,
      level: 0,
    },
  ]);
  assert.deepEqual([...restored.ownedOrderIds], ["d-1"]);
  assert.equal(restored.active.get("d-1")?.levelIndex, 18);
  assert.deepEqual(restored.unknownOrderIds, ["manual"]);

  const emptied = store.reconcile("decibel", "BTC", []);
  assert.deepEqual(emptied.removedOrderIds, ["d-1"]);
  assert.deepEqual(store.load().venues.decibel?.orders, []);

  assert.throws(
    () => store.assertGrid("decibel", "BTC", { ...grid, gridCount: 64 }),
    /gridCount/
  );

  store.replaceVenue("decibel", {
    market: "BTC",
    grid,
    orders: [
      { id: "d-1", side: "buy", price: 62_000, size: 0.0040822, level: 18 },
    ],
    updatedAt: "2026-08-14T00:00:00.000Z",
  });
  const restart = store.prepareRuntime("decibel", "BTC", grid, [
    {
      id: "d-1",
      market: "BTC",
      side: "buy",
      price: 62_000,
      size: 0.0040822,
      level: 0,
    },
  ]);
  assert.equal(restart.pauseReason, undefined);
  assert.deepEqual([...restart.ownedOrderIds], ["d-1"]);
  assert.equal(restart.active.get("d-1")?.levelIndex, 18);
  assert.deepEqual(restart.counts, {
    loaded: 1,
    matched: 1,
    removed: 0,
    unknown: 0,
  });

  const withUnknown = store.prepareRuntime("decibel", "BTC", grid, [
    {
      id: "d-1",
      market: "BTC",
      side: "buy",
      price: 62_000,
      size: 0.0040822,
      level: 0,
    },
    {
      id: "manual",
      market: "BTC",
      side: "sell",
      price: 64_000,
      size: 0.0040822,
      level: 0,
    },
  ]);
  assert.match(withUnknown.pauseReason || "", /1 个无法确认归属/);

  const failedWrite = persistPlacedOrders({
    store: {
      recordPlaced: () => {
        throw new Error("disk full");
      },
    },
    venue: "decibel",
    market: "BTC",
    grid,
    orders: [
      { id: "d-2", side: "sell", price: 64_000, size: 0.0040822, level: 40 },
    ],
  });
  assert.equal(failedWrite.ok, false);
  assert.match(failedWrite.ok ? "" : failedWrite.pauseReason, /d-2.*disk full/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("orderOwnership.test.ts OK");
