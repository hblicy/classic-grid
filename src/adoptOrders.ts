import type { DashboardSnapshot, DashboardVenueRow } from "./dashboard.js";
import { buildGrid, matchLevelIndex } from "./grid.js";
import type { GridFingerprint, OwnedOrderRecord, OrderOwnershipStore } from "./orderOwnership.js";
import type { GridMode, Side, VenueId } from "./types.js";
import type { VenueExecutor } from "./venues/index.js";

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

export type AdoptOrdersResult = {
  written: boolean;
  counts: Partial<Record<VenueId, number>>;
};

const KNOWN_VENUES = new Set<VenueId>([
  "extended",
  "risex",
  "decibel",
  "n1",
  "phoenix",
]);

export function parseAdoptOrdersArgs(args: string[]): AdoptOrdersOptions {
  let venuesValue: string | undefined;
  let marketValue: string | undefined;
  let confirm = false;
  for (const arg of args) {
    if (arg === "--confirm-all-bot-orders") {
      if (confirm) throw new Error("duplicate argument --confirm-all-bot-orders");
      confirm = true;
    } else if (arg.startsWith("--venues=")) {
      if (venuesValue != null) throw new Error("duplicate argument --venues");
      venuesValue = arg.slice("--venues=".length);
    } else if (arg.startsWith("--market=")) {
      if (marketValue != null) throw new Error("duplicate argument --market");
      marketValue = arg.slice("--market=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!venuesValue) throw new Error("required argument missing: --venues=...");
  if (!marketValue) throw new Error("required argument missing: --market=...");
  const venues = venuesValue
    .split(",")
    .map((venue) => venue.trim().toLowerCase())
    .filter(Boolean);
  if (venues.length === 0) throw new Error("--venues must not be empty");
  for (const venue of venues) {
    if (!KNOWN_VENUES.has(venue as VenueId)) throw new Error(`unknown venue: ${venue}`);
  }
  if (new Set(venues).size !== venues.length) {
    throw new Error("--venues must not contain duplicates");
  }
  const market = marketValue.trim().toUpperCase();
  if (!market) throw new Error("--market must not be empty");
  return { venues: venues as VenueId[], market, confirm };
}

function requirePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function statusFor(
  status: DashboardSnapshot,
  venue: VenueId,
  market: string
): DashboardVenueRow {
  const matches = status.venues.filter(
    (row) => row.venue === venue && row.market === market
  );
  if (matches.length !== 1) {
    throw new Error(
      `status must contain exactly one ${venue}/${market} row, found ${matches.length}`
    );
  }
  return matches[0]!;
}

function gridFromStatus(
  row: DashboardVenueRow,
  mode: GridMode
): { fingerprint: GridFingerprint; levels: number[]; spacing: number } {
  requirePositive(row.anchorMid, `${row.venue}/${row.market} anchorMid`);
  requirePositive(row.lower, `${row.venue}/${row.market} lower`);
  requirePositive(row.upper, `${row.venue}/${row.market} upper`);
  requirePositive(row.sizeBase, `${row.venue}/${row.market} sizeBase`);
  if (!Number.isInteger(row.gridCount) || row.gridCount < 2) {
    throw new Error(`${row.venue}/${row.market} gridCount must be an integer >= 2`);
  }
  const built = buildGrid({
    lower: row.lower,
    upper: row.upper,
    gridCount: row.gridCount,
  });
  const expectedSpacing = requirePositive(
    row.spacing,
    `${row.venue}/${row.market} spacing`
  );
  const close =
    Math.abs(expectedSpacing - built.spacing) <=
    Math.max(1e-8, Math.abs(built.spacing) * 1e-8);
  if (!close) {
    throw new Error(
      `${row.venue}/${row.market} spacing mismatch: status=${expectedSpacing} rebuilt=${built.spacing}`
    );
  }
  return {
    fingerprint: {
      anchorMid: row.anchorMid,
      gridCount: row.gridCount,
      spacing: built.spacing,
      sizeBase: row.sizeBase,
      mode,
    },
    levels: built.levels,
    spacing: built.spacing,
  };
}

export async function runAdoptOrders(
  options: AdoptOrdersOptions,
  deps: AdoptOrdersDeps
): Promise<AdoptOrdersResult> {
  if (options.venues.length === 0) throw new Error("at least one venue is required");
  if (new Set(options.venues).size !== options.venues.length) {
    throw new Error("venues must not contain duplicates");
  }
  const market = options.market.trim().toUpperCase();
  if (!market) throw new Error("market is required");

  const status = deps.loadStatus();
  if (status.dryRun) {
    throw new Error("status.json is from dry-run mode; refusing live-order adoption");
  }
  const nextState = deps.store.load();
  const counts: Partial<Record<VenueId, number>> = {};
  const executors: VenueExecutor[] = [];
  let result: AdoptOrdersResult | undefined;
  let failure: unknown;

  try {
    const updatedAt = new Date().toISOString();
    for (const venue of options.venues) {
      const row = statusFor(status, venue, market);
      const grid = gridFromStatus(row, deps.gridMode(venue));
      const executor = deps.createExecutor(venue);
      executors.push(executor);
      await executor.connect();
      const snapshot = await executor.snapshot(market);
      if (snapshot.venue !== venue || snapshot.market !== market) {
        throw new Error(
          `${venue}/${market} snapshot identity mismatch: ${snapshot.venue}/${snapshot.market}`
        );
      }

      const ids = new Set<string>();
      const orders: OwnedOrderRecord[] = snapshot.openOrders.map((order) => {
        const id = String(order.id || "").trim();
        if (!id) throw new Error(`${venue}/${market} contains an order with empty ID`);
        if (ids.has(id)) throw new Error(`${venue}/${market} contains duplicate order ID ${id}`);
        ids.add(id);
        const price = requirePositive(order.price, `${venue}/${market} order ${id} price`);
        const size = requirePositive(order.size, `${venue}/${market} order ${id} size`);
        if (order.side !== "buy" && order.side !== "sell") {
          throw new Error(`${venue}/${market} order ${id} has invalid side`);
        }
        const level = matchLevelIndex(price, grid.levels, grid.spacing);
        if (level < 0) {
          throw new Error(`${venue}/${market} order ${id} is outside saved grid`);
        }
        return { id, side: order.side as Side, price, size, level };
      });

      nextState.venues[venue] = {
        market,
        grid: grid.fingerprint,
        orders,
        updatedAt,
      };
      counts[venue] = orders.length;
      deps.output(
        `[adopt-orders] ${venue}/${market}: validated ${orders.length} live orders`
      );
    }

    if (options.confirm) {
      deps.store.save(nextState);
      deps.output(
        `[adopt-orders] wrote ${deps.store.file}; no exchange orders were changed`
      );
      result = { written: true, counts };
    } else {
      deps.output(
        "[adopt-orders] preview only; rerun with --confirm-all-bot-orders to write ownership"
      );
      result = { written: false, counts };
    }
  } catch (error) {
    failure = error;
  }

  const disconnectErrors: unknown[] = [];
  for (const executor of executors.reverse()) {
    try {
      executor.disconnect();
    } catch (error) {
      disconnectErrors.push(error);
    }
  }
  if (failure && disconnectErrors.length > 0) {
    throw new AggregateError(
      [failure, ...disconnectErrors],
      "adoption and executor disconnect both failed"
    );
  }
  if (failure) throw failure;
  if (disconnectErrors.length > 0) {
    throw new AggregateError(disconnectErrors, "executor disconnect failed");
  }
  return result!;
}
