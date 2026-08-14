import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAdoptOrdersArgs, runAdoptOrders } from "../src/adoptOrders.js";
import { OrderOwnershipStore } from "../src/orderOwnership.js";
import type { DashboardSnapshot, DashboardVenueRow } from "../src/dashboard.js";
import type { LiveOrder, VenueId, VenueSnapshot } from "../src/types.js";
import type { VenueExecutor } from "../src/venues/index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-grid-adopt-"));
const file = path.join(dir, "order-ownership.json");

function statusRow(venue: VenueId, gridCount: number): DashboardVenueRow {
  const lower = venue === "risex" ? 61_400 : 60_400;
  const upper = venue === "risex" ? 65_200 : 66_400;
  return {
    venue,
    market: "BTC",
    mid: 63_300,
    anchorMid: 63_300,
    lower,
    upper,
    spacing: (upper - lower) / gridCount,
    sizeBase: venue === "risex" ? 0.0048 : 0.004,
    gridCount,
    position: 0,
    openOrders: gridCount,
    seeded: true,
    completedRungs: 0,
    gridProfit: 0,
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function ordersFor(row: DashboardVenueRow): LiveOrder[] {
  return Array.from({ length: row.gridCount }, (_, level) => ({
    id: `${row.venue}-${level}`,
    market: "BTC",
    side: level < row.gridCount / 2 ? "buy" : "sell",
    price: row.lower + row.spacing * level,
    size: row.sizeBase,
    level: 0,
  }));
}

function snapshotFor(row: DashboardVenueRow, orders: LiveOrder[]): VenueSnapshot {
  return {
    venue: row.venue as VenueId,
    market: "BTC",
    mid: row.mid,
    position: 0,
    openOrders: orders,
  };
}

try {
  assert.deepEqual(
    parseAdoptOrdersArgs([
      "--venues=risex,decibel",
      "--market=btc",
      "--confirm-all-bot-orders",
    ]),
    {
      venues: ["risex", "decibel"],
      market: "BTC",
      confirm: true,
    }
  );
  assert.throws(
    () => parseAdoptOrdersArgs(["--venues=risex", "--market=BTC", "--confirm=yes"]),
    /unknown argument/
  );
  assert.throws(
    () => parseAdoptOrdersArgs(["--venues=unknown", "--market=BTC"]),
    /unknown venue/
  );

  const risex = statusRow("risex", 46);
  const decibel = statusRow("decibel", 66);
  const snapshots: Record<string, VenueSnapshot> = {
    risex: snapshotFor(risex, ordersFor(risex)),
    decibel: snapshotFor(decibel, ordersFor(decibel)),
  };
  const status: DashboardSnapshot = {
    startedAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    dryRun: false,
    venues: [risex, decibel],
  };
  let writeCalls = 0;
  let disconnectCalls = 0;
  const createExecutor = (venue: VenueId): VenueExecutor => ({
    id: venue,
    async connect() {},
    disconnect() {
      disconnectCalls += 1;
    },
    async snapshot() {
      return snapshots[venue]!;
    },
    async apply() {
      writeCalls += 1;
      throw new Error("adoption must not apply orders");
    },
    async cancelAll() {
      writeCalls += 1;
      throw new Error("adoption must not cancel orders");
    },
    async closePosition() {
      writeCalls += 1;
      throw new Error("adoption must not close positions");
    },
  });
  const store = new OrderOwnershipStore(file);
  const deps = {
    store,
    createExecutor,
    loadStatus: () => status,
    gridMode: () => "neutral" as const,
    output: (_line: string) => {},
  };

  const preview = await runAdoptOrders(
    { venues: ["risex", "decibel"], market: "BTC", confirm: false },
    deps
  );
  assert.equal(preview.written, false);
  assert.deepEqual(preview.counts, { risex: 46, decibel: 66 });
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
  assert.equal(disconnectCalls, 4);

  const badFile = path.join(dir, "bad-order-ownership.json");
  const badStore = new OrderOwnershipStore(badFile);
  snapshots.decibel = snapshotFor(decibel, [
    ...ordersFor(decibel).slice(0, -1),
    {
      id: "decibel-outside-grid",
      market: "BTC",
      side: "sell",
      price: decibel.upper + decibel.spacing,
      size: decibel.sizeBase,
      level: 0,
    },
  ]);
  await assert.rejects(
    runAdoptOrders(
      { venues: ["risex", "decibel"], market: "BTC", confirm: true },
      { ...deps, store: badStore }
    ),
    /decibel-outside-grid.*outside saved grid/
  );
  assert.equal(fs.existsSync(badFile), false);
  assert.equal(writeCalls, 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("adoptOrders.test.ts OK");
