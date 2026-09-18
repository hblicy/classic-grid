import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestVenuesForLedger,
  ledgerPublicView,
  loadLedger,
  applyCapitalFlow,
  recordOfficialDayVolume,
  patchOfficialVolumeForDay,
  trimLedgerCalendar,
} from "./ledger.js";
import type { OfficialBundle } from "./officialStats.js";
import type { VenueId } from "./types.js";
import {
  getBotPauseState,
  loadBotPauseState,
  setBotPaused,
  type BotPauseState,
} from "./botControl.js";
import {
  allVenueControl,
  enqueueVenueCommand,
  getPendingCommands,
  isVenuePaused,
  loadVenueControl,
  type VenueControlAction,
} from "./venueControl.js";
import {
  HttpRequestError,
  authorizeRequest,
  dashboardSecurityConfig,
  readJsonBody,
  sendUnauthorized,
  validateMutationRequest,
} from "./dashboardSecurity.js";
import { PopdexAgentService } from "./popdex/agentService.js";
import { PopdexAgentRpc } from "./popdex/agentRpc.js";

export type DashboardVenueRow = {
  venue: string;
  market: string;
  mid: number;
  anchorMid: number;
  lower: number;
  upper: number;
  spacing: number;
  sizeBase: number;
  gridCount: number;
  position: number;
  openOrders: number;
  seeded: boolean;
  completedRungs: number;
  gridProfit: number;
  unrealizedPnl?: number;
  /** 官方爆仓价 */
  liquidationPrice?: number;
  equityUsd?: number;
  orders?: Array<{ side: string; price: number }>;
  /** 官方今日量/费/平仓盈亏；无则 null，前端回退本地 */
  officialVolume?: number | null;
  officialFees?: number | null;
  officialRealizedPnl?: number | null;
  officialSource?: "official" | "unavailable" | "local";
  lastError?: string;
  updatedAt: string;
};

export type DashboardSnapshot = {
  startedAt: string;
  updatedAt: string;
  dryRun: boolean;
  /** 紧急暂停：不下单/不撤单/不补单，仅刷新看板只读 */
  paused: boolean;
  pausedAt?: string;
  venues: DashboardVenueRow[];
  ledger?: ReturnType<typeof ledgerPublicView>;
  official?: OfficialBundle | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const ETHERS_JS_FILE = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "ethers",
  "dist",
  "ethers.umd.min.js"
);

loadBotPauseState();
loadVenueControl();

let snapshot: DashboardSnapshot = {
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  dryRun: true,
  paused: getBotPauseState().paused,
  pausedAt: getBotPauseState().paused ? getBotPauseState().updatedAt : undefined,
  venues: [],
  ledger: ledgerPublicView(loadLedger()),
};

function syncPauseIntoSnapshot(): void {
  const p = getBotPauseState();
  snapshot = {
    ...snapshot,
    paused: p.paused,
    pausedAt: p.paused ? p.updatedAt : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export function getDashboardSnapshot(): DashboardSnapshot {
  return snapshot;
}

export function setDashboardMeta(p: { dryRun: boolean }): void {
  syncPauseIntoSnapshot();
  snapshot = {
    ...snapshot,
    dryRun: p.dryRun,
    updatedAt: new Date().toISOString(),
    ledger: ledgerPublicView(loadLedger()),
  };
}

export function applyBotPause(paused: boolean, reason?: string): BotPauseState {
  const next = setBotPaused(paused, reason);
  syncPauseIntoSnapshot();
  persistStatus();
  return next;
}

export function setDashboardOfficial(official: OfficialBundle | null): void {
  let ledger = snapshot.ledger || ledgerPublicView(loadLedger());
  if (official?.venues) {
    let sum = 0;
    let n = 0;
    for (const o of Object.values(official.venues)) {
      if (!o || o.source !== "official") continue;
      if (o.volume != null && Number.isFinite(Number(o.volume))) {
        sum += Number(o.volume);
        n += 1;
      }
    }
    if (n > 0) {
      try {
        ledger = ledgerPublicView(recordOfficialDayVolume(sum));
      } catch {
        /* ignore */
      }
    }
  }
  snapshot = {
    ...snapshot,
    official,
    ledger,
    updatedAt: new Date().toISOString(),
  };
  persistStatus();
}

function persistStatus(): void {
  try {
    const dataDir = path.resolve(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "status.json"),
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

export function upsertDashboardVenue(row: DashboardVenueRow): void {
  const next = snapshot.venues.filter((v) => v.venue !== row.venue);
  next.push(row);
  next.sort((a, b) => a.venue.localeCompare(b.venue));
  let ledger;
  try {
    ledger = ledgerPublicView(ingestVenuesForLedger(next));
  } catch {
    ledger = ledgerPublicView(loadLedger());
  }
  snapshot = {
    ...snapshot,
    venues: next,
    updatedAt: new Date().toISOString(),
    ledger,
  };
  persistStatus();
}

export type DashboardServerOptions = {
  env?: NodeJS.ProcessEnv;
  popdexConfigured?: boolean;
  agentService?: Pick<
    PopdexAgentService,
    | "status"
    | "prepareApproval"
    | "verifyAuthorization"
    | "save"
    | "prepareRevoke"
    | "clear"
  >;
};

export function popdexAgentMutationAllowed(input: {
  dryRun: boolean;
  popdexConfigured: boolean;
  globallyPaused: boolean;
  venuePaused: boolean;
}): boolean {
  return (
    input.dryRun ||
    !input.popdexConfigured ||
    input.globallyPaused ||
    input.venuePaused
  );
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function startDashboardServer(
  port: number,
  options: DashboardServerOptions = {}
): http.Server | null {
  if (!(port >= 0)) return null;
  const env = options.env ?? process.env;
  const security = dashboardSecurityConfig(env);
  const agentService =
    options.agentService ??
    new PopdexAgentService({
      rpcClient: new PopdexAgentRpc(),
      envFile: path.resolve(process.cwd(), ".env"),
      processEnv: env,
      canMutate: () =>
        popdexAgentMutationAllowed({
          dryRun: snapshot.dryRun,
          popdexConfigured: options.popdexConfigured ?? false,
          globallyPaused: snapshot.paused,
          venuePaused: isVenuePaused("popdex"),
        }),
    });

  const server = http.createServer(async (req, res) => {
    const sensitiveValues: string[] = [];
    try {
      if (!authorizeRequest(req, security)) {
        sendUnauthorized(res);
        return;
      }
      if (req.method === "POST") validateMutationRequest(req, security);

      const url = req.url?.split("?")[0] || "/";
      if (url === "/api/snapshot" || url === "/api/status" || url === "/api/overview") {
        syncPauseIntoSnapshot();
        sendJson(res, 200, {
          ...snapshot,
          ledger: ledgerPublicView(loadLedger()),
          venueControl: {
            venues: allVenueControl(),
            pending: getPendingCommands(),
          },
        });
        return;
      }
      if (url === "/api/meta") {
        sendJson(res, 200, {
          authRequired: security.authRequired,
          port,
          bindHost: security.bindHost,
        });
        return;
      }
      if (url === "/api/popdex/agent/status" && req.method === "GET") {
        sendJson(res, 200, await agentService.status());
        return;
      }
      if (url === "/api/popdex/agent/prepare-approval" && req.method === "POST") {
        const body = await readJsonBody(req, 4096);
        sendJson(
          res,
          200,
          await agentService.prepareApproval({
            agentAddress: String(body.agentAddress || ""),
            delegator: String(body.delegator || ""),
            hostname: String(body.hostname || ""),
          })
        );
        return;
      }
      if (url === "/api/popdex/agent/verify" && req.method === "POST") {
        const body = await readJsonBody(req, 4096);
        sendJson(
          res,
          200,
          await agentService.verifyAuthorization({
            mainAccount: String(body.mainAccount || ""),
            agentAddress: String(body.agentAddress || ""),
          })
        );
        return;
      }
      if (url === "/api/popdex/agent/save" && req.method === "POST") {
        const body = await readJsonBody(req, 4096);
        const agentPrivateKey = String(body.agentPrivateKey || "");
        if (agentPrivateKey) sensitiveValues.push(agentPrivateKey);
        sendJson(
          res,
          200,
          await agentService.save({
            mainAccount: String(body.mainAccount || ""),
            agentPrivateKey,
          })
        );
        return;
      }
      if (url === "/api/popdex/agent/prepare-revoke" && req.method === "POST") {
        const body = await readJsonBody(req, 4096);
        sendJson(
          res,
          200,
          await agentService.prepareRevoke({
            mainAccount: String(body.mainAccount || ""),
            agentAddress: String(body.agentAddress || ""),
          })
        );
        return;
      }
      if (url === "/api/popdex/agent/clear" && req.method === "POST") {
        await readJsonBody(req, 4096);
        sendJson(res, 200, await agentService.clear());
        return;
      }
      if (
        (url === "/api/pause" || url === "/api/resume" || url === "/api/bot-pause") &&
        req.method === "POST"
      ) {
        const body = await readJsonBody(req, 16_384);
        const reason = body.reason ? String(body.reason) : undefined;
        const paused =
          url === "/api/bot-pause" && typeof body.paused === "boolean"
            ? body.paused
            : url === "/api/pause";
        const state = applyBotPause(paused, reason || "dashboard");
        sendJson(res, 200, { ok: true, ...state });
        return;
      }
      if (url === "/api/venue-control" && req.method === "GET") {
        sendJson(res, 200, {
          venues: allVenueControl(),
          pending: getPendingCommands(),
        });
        return;
      }
      if (url === "/api/venue-control" && req.method === "POST") {
        const body = await readJsonBody(req, 16_384);
        const venue = String(body.venue || "").trim();
        const action = String(body.action || "").trim() as VenueControlAction;
        const actions: VenueControlAction[] = [
          "cancel-sells",
          "cancel-buys",
          "close-half",
          "pause",
          "resume",
          "flat-reseed",
        ];
        const validVenues = [
          "extended",
          "risex",
          "decibel",
          "n1",
          "phoenix",
          "phoenix2",
          "nado",
          "popdex",
        ];
        if (!venue || !validVenues.includes(venue) || !actions.includes(action)) {
          throw new HttpRequestError(400, `非法参数 venue=${venue} action=${action}`);
        }
        const command = enqueueVenueCommand(venue as VenueId, action);
        sendJson(res, 200, { ok: true, command });
        return;
      }
      if (url === "/api/capital-flow" && req.method === "POST") {
        const body = await readJsonBody(req, 65_536);
        const items = Array.isArray(body.flows)
          ? body.flows
          : [
              {
                venue: body.venue,
                amount:
                  body.amount != null
                    ? Number(body.amount)
                    : body.withdraw != null
                      ? -Math.abs(Number(body.withdraw))
                      : body.deposit != null
                        ? Math.abs(Number(body.deposit))
                        : NaN,
                note: body.note,
              },
            ];
        const applied = [];
        for (const item of items) {
          const entry = item as Record<string, unknown>;
          const venue = String(entry.venue || "manual");
          let amount = Number(entry.amount);
          if (!Number.isFinite(amount) && entry.withdraw != null) {
            amount = -Math.abs(Number(entry.withdraw));
          }
          if (!Number.isFinite(amount) && entry.deposit != null) {
            amount = Math.abs(Number(entry.deposit));
          }
          const state = applyCapitalFlow({
            venue,
            amount,
            note: entry.note ? String(entry.note) : undefined,
          });
          applied.push({
            venue,
            amount,
            dayProfit: state.calendar[0]?.dayProfit,
            dayOpenEquity: state.dayOpenEquity,
          });
        }
        const ledger = ledgerPublicView();
        snapshot = { ...snapshot, ledger, updatedAt: new Date().toISOString() };
        persistStatus();
        sendJson(res, 200, { ok: true, applied, ledger });
        return;
      }
      if (url === "/api/ledger/official-volume" && req.method === "POST") {
        const body = await readJsonBody(req, 65_536);
        const items = Array.isArray(body.days)
          ? body.days
          : [{ day: body.day, volume: body.volume }];
        const applied = [];
        for (const item of items) {
          const entry = item as Record<string, unknown>;
          const day = String(entry.day || "");
          const volume = Number(entry.volume);
          const state = patchOfficialVolumeForDay(day, volume);
          const row = state.calendar.find((value) => value.day === day);
          applied.push({ day, volume: row?.officialVolume ?? volume });
        }
        const ledger = ledgerPublicView();
        snapshot = { ...snapshot, ledger, updatedAt: new Date().toISOString() };
        persistStatus();
        sendJson(res, 200, { ok: true, applied, ledger });
        return;
      }
      if (url === "/api/ledger/calendar-trim" && req.method === "POST") {
        const body = await readJsonBody(req, 16_384);
        const from = String(body.from || body.keepFrom || "");
        const state = trimLedgerCalendar(from);
        const ledger = ledgerPublicView(state);
        snapshot = { ...snapshot, ledger, updatedAt: new Date().toISOString() };
        persistStatus();
        sendJson(res, 200, {
          ok: true,
          from,
          days: ledger.calendar.map((day) => day.day),
          ledger,
        });
        return;
      }
      if (url === "/vendor/ethers.js") {
        if (!fs.existsSync(ETHERS_JS_FILE)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("ethers browser bundle missing");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        fs.createReadStream(ETHERS_JS_FILE).pipe(res);
        return;
      }
      if (url === "/popdex-agent.js") {
        const scriptPath = path.join(PUBLIC_DIR, "popdex-agent.js");
        if (!fs.existsSync(scriptPath)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("public/popdex-agent.js missing");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(fs.readFileSync(scriptPath));
        return;
      }
      if (url === "/" || url === "/index.html") {
        const htmlPath = path.join(PUBLIC_DIR, "index.html");
        if (!fs.existsSync(htmlPath)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("public/index.html missing");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        });
        res.end(fs.readFileSync(htmlPath));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (error) {
      const status = error instanceof HttpRequestError ? error.statusCode : 400;
      let message = String(error instanceof Error ? error.message : error);
      for (const value of sensitiveValues) message = message.replaceAll(value, "[REDACTED]");
      message = message.slice(0, 240);
      sendJson(res, status, { ok: false, error: message });
    }
  });
  server.listen(port, security.bindHost, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(
      `[dashboard] http://${security.bindHost}:${actualPort}/  api=/api/snapshot auth=${security.authRequired ? "basic" : "loopback"}`
    );
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(`[dashboard] listen failed: ${error.message}`);
  });
  return server;
}
