import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DashboardVenueRow } from "../src/dashboard.js";
import { ingestVenuesForLedger } from "../src/ledger.js";

function venue(venue: string, equityUsd: number): DashboardVenueRow {
  return {
    venue,
    market: "BTC",
    mid: 100,
    anchorMid: 100,
    lower: 90,
    upper: 110,
    spacing: 1,
    sizeBase: 1,
    gridCount: 10,
    position: 0,
    openOrders: 0,
    seeded: true,
    completedRungs: 0,
    gridProfit: 0,
    unrealizedPnl: 0,
    equityUsd,
    updatedAt: new Date().toISOString(),
  };
}

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-grid-ledger-"));

try {
  process.chdir(tempDir);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const dataDir = path.join(tempDir, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(
    path.join(dataDir, "ledger.json"),
    JSON.stringify({
      dayKey: day,
      dayOpenProfit: null,
      dayOpenEquity: 800,
      calendar: [
        {
          day,
          gridProfit: 0,
          dayProfit: 0,
          todayVolume: 0,
          equity: 800,
          equityChange: 0,
          updatedAt: new Date().toISOString(),
        },
      ],
      last: {
        risex: {
          completedRungs: 0,
          gridProfit: 0,
          unrealizedPnl: 0,
          mid: 100,
          sizeBase: 1,
        },
      },
      combined: { todayVolume: 0, volumeWindow: "test" },
    }),
    "utf8"
  );

  const state = ingestVenuesForLedger([
    venue("risex", 805),
    venue("decibel", 800),
  ]);

  assert.equal(state.dayOpenEquity, 1600);
  assert.equal(state.calendar[0]?.dayProfit, 5);
  assert.deepEqual(state.venuesInOpenEquity?.sort(), ["decibel", "risex"]);

  const restartedState = ingestVenuesForLedger([
    venue("risex", 806),
    venue("decibel", 802),
  ]);
  assert.equal(restartedState.dayOpenEquity, 1600);
  assert.equal(restartedState.calendar[0]?.dayProfit, 8);

  const yesterday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  fs.writeFileSync(
    path.join(dataDir, "ledger.json"),
    JSON.stringify({
      dayKey: yesterday,
      dayOpenProfit: null,
      dayOpenEquity: 800,
      calendar: [
        {
          day: yesterday,
          gridProfit: 0,
          dayProfit: 0,
          todayVolume: 0,
          equity: 800,
          equityChange: 0,
          updatedAt: new Date().toISOString(),
        },
      ],
      last: {
        risex: {
          completedRungs: 0,
          gridProfit: 0,
          unrealizedPnl: 0,
          mid: 100,
          sizeBase: 1,
        },
      },
      combined: { todayVolume: 0, volumeWindow: "test" },
    }),
    "utf8"
  );

  const rolloverState = ingestVenuesForLedger([
    venue("risex", 805),
    venue("decibel", 800),
  ]);
  assert.equal(rolloverState.dayOpenEquity, 1600);
  assert.equal(rolloverState.calendar[0]?.dayProfit, 5);
  assert.deepEqual(rolloverState.venuesInOpenEquity?.sort(), [
    "decibel",
    "risex",
  ]);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("ledger.test.ts OK");
