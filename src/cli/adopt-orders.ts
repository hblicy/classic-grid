import fs from "node:fs";
import path from "node:path";
import { parseAdoptOrdersArgs, runAdoptOrders } from "../adoptOrders.js";
import { gridFor, loadRuntimeConfig } from "../config.js";
import type { DashboardSnapshot } from "../dashboard.js";
import { OrderOwnershipStore } from "../orderOwnership.js";
import { createExecutor } from "../venues/index.js";

function loadStatus(): DashboardSnapshot {
  const file = path.resolve(process.cwd(), "data", "status.json");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: failed to read status JSON: ${message}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file}: status must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.dryRun !== "boolean" || !Array.isArray(candidate.venues)) {
    throw new Error(`${file}: status is missing dryRun or venues`);
  }
  return value as DashboardSnapshot;
}

const options = parseAdoptOrdersArgs(process.argv.slice(2));
const config = loadRuntimeConfig();
if (config.dryRun) {
  throw new Error("拒绝接管：请显式设置 DRY_RUN=0，确认当前读取的是实盘账户");
}

await runAdoptOrders(options, {
  store: new OrderOwnershipStore(),
  createExecutor: (venue) => createExecutor(venue, false),
  loadStatus,
  gridMode: (venue) => gridFor(config, venue).mode,
  output: console.log,
});
