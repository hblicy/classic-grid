import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getDashboardSnapshot,
  upsertDashboardVenue,
  type DashboardVenueRow,
} from "../src/dashboard.js";
import { ingestVenuesForLedger } from "../src/ledger.js";

function venue(
  venue: string,
  equityUsd: number,
  cashFlows: Array<{ id: string; amountUsd: number; timestampMs: number }> = []
): DashboardVenueRow {
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
    cashFlows,
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

  fs.writeFileSync(
    path.join(dataDir, "ledger.json"),
    JSON.stringify({
      dayKey: day,
      dayOpenProfit: null,
      dayOpenEquity: 800,
      venuesInOpenEquity: ["risex"],
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

  const oldDeposit = {
    id: "0xold-deposit",
    amountUsd: 800,
    timestampMs: Date.parse(`${yesterday}T12:00:00+08:00`),
  };
  const deposit = {
    id: "0xdeposit:1",
    amountUsd: 800,
    timestampMs: Date.now(),
  };
  const afterDeposit = ingestVenuesForLedger([
    venue("risex", 1605, [oldDeposit, deposit]),
  ]);
  assert.equal(afterDeposit.dayOpenEquity, 1600);
  assert.equal(afterDeposit.calendar[0]?.dayProfit, 5);
  assert.equal(afterDeposit.calendar[0]?.externalCashFlow, 800);
  assert.deepEqual(afterDeposit.processedCashFlowIds, ["risex:0xdeposit:1"]);
  assert.ok(!afterDeposit.processedCashFlowIds?.includes("risex:0xold-deposit"));

  const afterDuplicateRefresh = ingestVenuesForLedger([
    venue("risex", 1606, [deposit]),
  ]);
  assert.equal(afterDuplicateRefresh.dayOpenEquity, 1600);
  assert.equal(afterDuplicateRefresh.calendar[0]?.dayProfit, 6);
  assert.equal(afterDuplicateRefresh.calendar[0]?.externalCashFlow, 800);

  const withdrawal = {
    id: "0xwithdraw:2",
    amountUsd: -200,
    timestampMs: Date.now(),
  };
  const afterWithdrawal = ingestVenuesForLedger([
    venue("risex", 1407, [deposit, withdrawal]),
  ]);
  assert.equal(afterWithdrawal.dayOpenEquity, 1400);
  assert.equal(afterWithdrawal.calendar[0]?.dayProfit, 7);
  assert.equal(afterWithdrawal.calendar[0]?.externalCashFlow, 600);
  assert.deepEqual(afterWithdrawal.processedCashFlowIds?.sort(), [
    "risex:0xdeposit:1",
    "risex:0xwithdraw:2",
  ]);

  fs.writeFileSync(
    path.join(dataDir, "ledger.json"),
    JSON.stringify({
      dayKey: day,
      dayOpenProfit: null,
      dayOpenEquity: 800,
      venuesInOpenEquity: ["risex"],
      processedCashFlowIds: [],
      calendar: [
        {
          day,
          gridProfit: 0,
          dayProfit: 0,
          todayVolume: 0,
          equity: 800,
          equityChange: 0,
          externalCashFlow: 0,
          updatedAt: new Date().toISOString(),
        },
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
  const newVenueWithDeposit = ingestVenuesForLedger([
    venue("risex", 805),
    venue("decibel", 800, [
      { id: "decibel-first-deposit", amountUsd: 800, timestampMs: Date.now() },
    ]),
  ]);
  assert.equal(newVenueWithDeposit.dayOpenEquity, 1600);
  assert.equal(newVenueWithDeposit.calendar[0]?.dayProfit, 5);
  assert.equal(newVenueWithDeposit.calendar[0]?.externalCashFlow, 0);
  assert.deepEqual(newVenueWithDeposit.processedCashFlowIds, [
    "decibel:decibel-first-deposit",
  ]);

  upsertDashboardVenue(
    venue("risex", 1407, [
      { id: "0xprivate", amountUsd: 1, timestampMs: Date.now() },
    ])
  );
  assert.equal(
    getDashboardSnapshot().venues.find((item) => item.venue === "risex")
      ?.cashFlows,
    undefined
  );

  assert.throws(
    () =>
      upsertDashboardVenue(
        venue("risex", 1407, [
          { id: "0xinvalid", amountUsd: 0, timestampMs: Date.now() },
        ])
      ),
    /amountUsd 无效/
  );
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("ledger.test.ts OK");
