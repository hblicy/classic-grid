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

const VENUES = new Set<VenueId>([
  "extended",
  "risex",
  "decibel",
  "n1",
  "phoenix",
]);
const MODES = new Set<GridMode>(["neutral", "long", "short"]);
const SIDES = new Set<Side>(["buy", "sell"]);

type TrackedOrder = {
  levelIndex: number;
  side: Side;
  price: number;
  size: number;
};

export function emptyOrderOwnershipState(): OrderOwnershipState {
  return { version: 1, venues: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function parseGrid(value: unknown, label: string): GridFingerprint {
  const grid = requireRecord(value, label);
  const mode = grid.mode;
  if (typeof mode !== "string" || !MODES.has(mode as GridMode)) {
    throw new Error(`${label}.mode is invalid`);
  }
  return {
    anchorMid: requirePositiveNumber(grid.anchorMid, `${label}.anchorMid`),
    gridCount: requireInteger(grid.gridCount, `${label}.gridCount`, 2),
    spacing: requirePositiveNumber(grid.spacing, `${label}.spacing`),
    sizeBase: requirePositiveNumber(grid.sizeBase, `${label}.sizeBase`),
    mode: mode as GridMode,
  };
}

function parseVenueOwnership(value: unknown, label: string): VenueOwnership {
  const venue = requireRecord(value, label);
  const market = requireNonEmptyString(venue.market, `${label}.market`);
  const grid = parseGrid(venue.grid, `${label}.grid`);
  if (!Array.isArray(venue.orders)) throw new Error(`${label}.orders must be an array`);

  const ids = new Set<string>();
  const orders = venue.orders.map((raw, index): OwnedOrderRecord => {
    const orderLabel = `${label}.orders[${index}]`;
    const order = requireRecord(raw, orderLabel);
    const id = requireNonEmptyString(order.id, `${orderLabel}.id`);
    if (ids.has(id)) throw new Error(`${orderLabel}.id duplicates ${id}`);
    ids.add(id);
    const side = order.side;
    if (typeof side !== "string" || !SIDES.has(side as Side)) {
      throw new Error(`${orderLabel}.side is invalid`);
    }
    const level = requireInteger(order.level, `${orderLabel}.level`, 0);
    if (level > grid.gridCount) {
      throw new Error(`${orderLabel}.level exceeds gridCount`);
    }
    return {
      id,
      side: side as Side,
      price: requirePositiveNumber(order.price, `${orderLabel}.price`),
      size: requirePositiveNumber(order.size, `${orderLabel}.size`),
      level,
    };
  });

  const updatedAt = requireNonEmptyString(venue.updatedAt, `${label}.updatedAt`);
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new Error(`${label}.updatedAt must be an ISO timestamp`);
  }
  return { market, grid, orders, updatedAt };
}

function parseState(value: unknown): OrderOwnershipState {
  const state = requireRecord(value, "state");
  if (state.version !== 1) throw new Error("state.version must be 1");
  const rawVenues = requireRecord(state.venues, "state.venues");
  const venues: Partial<Record<VenueId, VenueOwnership>> = {};
  for (const [rawVenue, rawValue] of Object.entries(rawVenues)) {
    if (!VENUES.has(rawVenue as VenueId)) {
      throw new Error(`state.venues contains unknown venue ${rawVenue}`);
    }
    venues[rawVenue as VenueId] = parseVenueOwnership(
      rawValue,
      `state.venues.${rawVenue}`
    );
  }
  return { version: 1, venues };
}

function fileError(file: string, action: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${file}: ${action} failed: ${message}`, { cause: error });
}

function closeNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-8);
}

export class OrderOwnershipStore {
  constructor(
    readonly file = path.resolve(process.cwd(), "data", "order-ownership.json")
  ) {}

  load(): OrderOwnershipState {
    if (!fs.existsSync(this.file)) return emptyOrderOwnershipState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      throw fileError(this.file, "JSON parse", error);
    }
    try {
      return parseState(parsed);
    } catch (error) {
      throw fileError(this.file, "validation", error);
    }
  }

  save(state: OrderOwnershipState): void {
    let validated: OrderOwnershipState;
    try {
      validated = parseState(state);
    } catch (error) {
      throw fileError(this.file, "validation", error);
    }

    const dir = path.dirname(this.file);
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, this.file);
    } catch (error) {
      let cleanupError: unknown;
      if (fs.existsSync(temporary)) {
        try {
          fs.unlinkSync(temporary);
        } catch (cleanup) {
          cleanupError = cleanup;
        }
      }
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${this.file}: atomic save and temporary-file cleanup failed`
        );
      }
      throw fileError(this.file, "atomic save", error);
    }
  }

  replaceVenue(venue: VenueId, value: VenueOwnership): void {
    const state = this.load();
    state.venues[venue] = value;
    this.save(state);
  }

  recordPlaced(
    venue: VenueId,
    market: string,
    grid: GridFingerprint,
    orders: OwnedOrderRecord[]
  ): void {
    if (orders.length === 0) return;
    const state = this.load();
    const previous = state.venues[venue];
    if (previous) this.assertGridValue(venue, previous, market, grid);
    const merged = new Map(previous?.orders.map((order) => [order.id, order]) ?? []);
    for (const order of orders) merged.set(order.id, order);
    state.venues[venue] = {
      market,
      grid,
      orders: [...merged.values()],
      updatedAt: new Date().toISOString(),
    };
    this.save(state);
  }

  assertGrid(venue: VenueId, market: string, actual: GridFingerprint): void {
    const saved = this.load().venues[venue];
    if (!saved) return;
    this.assertGridValue(venue, saved, market, actual);
  }

  private assertGridValue(
    venue: VenueId,
    saved: VenueOwnership,
    market: string,
    actual: GridFingerprint
  ): void {
    if (saved.market !== market) {
      throw new Error(
        `${this.file}: ${venue} market mismatch: saved=${saved.market} actual=${market}`
      );
    }
    if (saved.grid.gridCount !== actual.gridCount) {
      throw new Error(
        `${this.file}: ${venue} gridCount mismatch: saved=${saved.grid.gridCount} actual=${actual.gridCount}`
      );
    }
    if (saved.grid.mode !== actual.mode) {
      throw new Error(
        `${this.file}: ${venue} mode mismatch: saved=${saved.grid.mode} actual=${actual.mode}`
      );
    }
    for (const field of ["anchorMid", "spacing", "sizeBase"] as const) {
      if (!closeNumber(saved.grid[field], actual[field])) {
        throw new Error(
          `${this.file}: ${venue} ${field} mismatch: saved=${saved.grid[field]} actual=${actual[field]}`
        );
      }
    }
  }

  reconcile(
    venue: VenueId,
    market: string,
    liveOrders: LiveOrder[]
  ): {
    ownedOrderIds: Set<string>;
    active: Map<string, TrackedOrder>;
    unknownOrderIds: string[];
    removedOrderIds: string[];
  } {
    const state = this.load();
    const saved = state.venues[venue];
    const ownedOrderIds = new Set<string>();
    const active = new Map<string, TrackedOrder>();
    if (!saved) {
      return {
        ownedOrderIds,
        active,
        unknownOrderIds: liveOrders.map((order) => order.id),
        removedOrderIds: [],
      };
    }
    if (saved.market !== market) {
      throw new Error(
        `${this.file}: ${venue} market mismatch: saved=${saved.market} actual=${market}`
      );
    }

    const savedById = new Map(saved.orders.map((order) => [order.id, order]));
    const liveIds = new Set(liveOrders.map((order) => order.id));
    const unknownOrderIds: string[] = [];
    for (const live of liveOrders) {
      const persisted = savedById.get(live.id);
      if (!persisted) {
        unknownOrderIds.push(live.id);
        continue;
      }
      ownedOrderIds.add(live.id);
      active.set(live.id, {
        levelIndex: persisted.level,
        side: live.side,
        price: live.price,
        size: live.size,
      });
    }
    const removedOrderIds = saved.orders
      .filter((order) => !liveIds.has(order.id))
      .map((order) => order.id);
    if (removedOrderIds.length > 0) {
      saved.orders = saved.orders.filter((order) => liveIds.has(order.id));
      saved.updatedAt = new Date().toISOString();
      this.save(state);
    }
    return { ownedOrderIds, active, unknownOrderIds, removedOrderIds };
  }
}
