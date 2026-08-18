import fs from "node:fs";
import path from "node:path";
import type { DashboardVenueRow } from "./dashboard.js";

const LEDGER_PATH = () => path.resolve(process.cwd(), "data", "ledger.json");

export type LedgerDay = {
  day: string;
  /** 当日网格毛利累计（估计，仅参考） */
  gridProfit: number;
  /** 今日赚/亏 = 总余额 − 日切开盘总余额（交易所权益） */
  dayProfit: number;
  /** 当日估计成交名义：Σ Δrungs × size × mid（仅参考） */
  todayVolume: number;
  /**
   * 官方成交量累计（各所 officialVolume 之和）。
   * 只增不减，避免 429/缺所把历史刷低；日切后留在昨日行。
   */
  officialVolume?: number;
  /** 官方手续费累计（同上） */
  officialFees?: number;
  equity: number;
  equityChange: number;
  /** 当日已确认的外部净资金流：充值为正、提现为负 */
  externalCashFlow?: number;
  updatedAt: string;
};

export type LedgerState = {
  dayKey: string;
  /** @deprecated 旧「完成格净值」基准，不再用于今日赚/亏 */
  dayOpenProfit: number | null;
  /** 当日首见（或日切后）权益合计基准 */
  dayOpenEquity: number | null;
  /**
   * 已计入 dayOpenEquity 的所。新所当日首次入账（入金）会并入开盘基准，
   * 避免「今日盈亏」被新入金抬高。
   */
  venuesInOpenEquity?: string[];
  /** 当日已处理的外部资金流水，带 venue 前缀，重启后继续去重 */
  processedCashFlowIds?: string[];
  calendar: LedgerDay[];
  /** venue -> last seen counters */
  last: Record<
    string,
    {
      completedRungs: number;
      gridProfit: number;
      unrealizedPnl: number;
      mid: number;
      sizeBase: number;
    }
  >;
  combined: {
    todayVolume: number;
    volumeWindow: string;
  };
};

/**
 * 启动时恢复当日各所已累计的完成格/毛利（写在 ledger.last）。
 * 跨日切日会清空 last，次日自然从 0 开始。
 */
export function loadVenueSessionCounters(): Record<
  string,
  { completedRungs: number; gridProfit: number }
> {
  try {
    const state = loadLedger();
    if (state.dayKey !== shanghaiDayKey()) return {};
    const out: Record<string, { completedRungs: number; gridProfit: number }> = {};
    for (const [k, v] of Object.entries(state.last || {})) {
      out[k] = {
        completedRungs: Number(v?.completedRungs) || 0,
        gridProfit: Number(v?.gridProfit) || 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function shanghaiDayKey(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function emptyState(): LedgerState {
  const dayKey = shanghaiDayKey();
  return {
    dayKey,
    dayOpenProfit: null,
    dayOpenEquity: null,
    processedCashFlowIds: [],
    calendar: [
      {
        day: dayKey,
        gridProfit: 0,
        dayProfit: 0,
        todayVolume: 0,
        equity: 0,
        equityChange: 0,
        externalCashFlow: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
    last: {},
    combined: {
      todayVolume: 0,
      volumeWindow: "网格估计：完成格 × size × mid · Asia/Shanghai 日切",
    },
  };
}

export function loadLedger(): LedgerState {
  try {
    const p = LEDGER_PATH();
    if (!fs.existsSync(p)) return emptyState();
    const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as LedgerState;
    if (!parsed || !Array.isArray(parsed.calendar)) return emptyState();
    if (parsed.dayOpenEquity === undefined) parsed.dayOpenEquity = null;
    return parsed;
  } catch {
    return emptyState();
  }
}

function saveLedger(state: LedgerState): void {
  const dir = path.dirname(LEDGER_PATH());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEDGER_PATH(), JSON.stringify(state, null, 2), "utf8");
}

function ensureToday(state: LedgerState): LedgerDay {
  const dayKey = shanghaiDayKey();
  if (state.dayKey !== dayKey) {
    // 日切：固化昨日，开新日
    // 先记下昨有哪些所，避免 last 清空后晚连上的所被当成「新入金」叠进开盘基准
    const prevVenueKeys = Object.keys(state.last || {});
    state.dayKey = dayKey;
    state.last = {};
    state.combined.todayVolume = 0;
    state.dayOpenProfit = null;
    state.dayOpenEquity = null;
    // null=未初始化；勿用 []，否则会走「新所并入」把全所权益再加一遍
    state.venuesInOpenEquity = undefined;
    state.processedCashFlowIds = [];
    (state as any)._rolloverVenueKeys = prevVenueKeys;
    const prev = state.calendar[0];
    state.calendar.unshift({
      day: dayKey,
      gridProfit: 0,
      dayProfit: 0,
      todayVolume: 0,
      equity: prev?.equity ?? 0,
      equityChange: 0,
      externalCashFlow: 0,
      updatedAt: new Date().toISOString(),
    });
    // 保留最近 60 天
    if (state.calendar.length > 60) state.calendar = state.calendar.slice(0, 60);
  }
  let today = state.calendar.find((d) => d.day === dayKey);
  if (!today) {
    today = {
      day: dayKey,
      gridProfit: 0,
      dayProfit: 0,
      todayVolume: 0,
      equity: 0,
      equityChange: 0,
      externalCashFlow: 0,
      updatedAt: new Date().toISOString(),
    };
    state.calendar.unshift(today);
  }
  return today;
}

/** 用各所看板行推进账本：今日赚/亏按权益差；完成格仅估成交量与参考毛利 */
export function ingestVenuesForLedger(venues: DashboardVenueRow[]): LedgerState {
  const state = loadLedger();
  if (state.dayOpenEquity === undefined) state.dayOpenEquity = null;
  const today = ensureToday(state);
  const venueKeysBeforeIngest = [
    ...new Set([
      ...Object.keys(state.last || {}),
      ...(((state as any)._rolloverVenueKeys as string[]) || []),
    ]),
  ];

  let totalProfit = 0;
  let totalEquity = 0;
  let equityCount = 0;
  let volDelta = 0;

  for (const v of venues) {
    const key = v.venue;
    const prev = state.last[key];
    let rungs = Number(v.completedRungs) || 0;
    let profit = Number(v.gridProfit) || 0;
    const upnl = Number(v.unrealizedPnl) || 0;
    const mid = Number(v.mid) || 0;
    const size = Number(v.sizeBase) || 0;
    const eq = Number(v.equityUsd);
    if (Number.isFinite(eq) && eq > 0) {
      totalEquity += eq;
      equityCount += 1;
    }

    // 重启瞬间内存计数归 0、但账本里已有更高累计 → 不回写下、不重复计成交量
    if (prev && rungs < prev.completedRungs) {
      rungs = prev.completedRungs;
      profit = Math.max(profit, prev.gridProfit);
    }

    totalProfit += profit;

    if (prev) {
      const dRungs = Math.max(0, rungs - prev.completedRungs);
      const px = mid > 0 ? mid : prev.mid;
      const sz = size > 0 ? size : prev.sizeBase;
      if (dRungs > 0 && px > 0 && sz > 0) {
        volDelta += dRungs * sz * px;
      }
    }
    state.last[key] = {
      completedRungs: rungs,
      gridProfit: profit,
      unrealizedPnl: upnl,
      mid,
      sizeBase: size,
    };
  }

  today.todayVolume = round(today.todayVolume + volDelta);
  state.combined.todayVolume = today.todayVolume;
  // 参考毛利只增不减（防重启写回低于已记账）
  today.gridProfit = round(Math.max(today.gridProfit || 0, totalProfit));

  // 官方量/费：只升不降，日切后留在昨日日历（看板「今日」与历史口径一致）
  let offVol = 0;
  let offFees = 0;
  let offVolN = 0;
  let offFeeN = 0;
  for (const v of venues) {
    if (v.officialVolume != null && Number.isFinite(Number(v.officialVolume))) {
      offVol += Number(v.officialVolume);
      offVolN += 1;
    }
    if (v.officialFees != null && Number.isFinite(Number(v.officialFees))) {
      offFees += Number(v.officialFees);
      offFeeN += 1;
    }
  }
  if (offVolN > 0) {
    today.officialVolume = round(
      Math.max(Number(today.officialVolume) || 0, offVol)
    );
  }
  if (offFeeN > 0) {
    today.officialFees = round(
      Math.max(Number(today.officialFees) || 0, offFees)
    );
  }

  const yesterday = state.calendar.find((d) => d.day !== today.day);
  if (equityCount > 0) {
    today.equity = round(totalEquity);
    const processedCashFlowIds = new Set(state.processedCashFlowIds || []);
    const newlyBaselinedVenues = new Set<string>();
    const cashFlowTrackingWasMissing = !Array.isArray(state.processedCashFlowIds);
    let baselineInitializedFromCurrent = false;

    // 旧账本无 venuesInOpenEquity：只能用本轮入账前已经存在的所恢复名单。
    // 不能用本轮更新后的 state.last，否则新加入的所会被误判为日切时已存在。
    if (!Array.isArray(state.venuesInOpenEquity)) {
      state.venuesInOpenEquity = venueKeysBeforeIngest;
    }

    // 缺少历史所名单时无法拆分已有总权益，只能把当前所视为已在基准中。
    if (
      state.dayOpenEquity != null &&
      state.venuesInOpenEquity.length === 0 &&
      venueKeysBeforeIngest.length === 0
    ) {
      state.venuesInOpenEquity = venues
        .filter((v) => {
          const eq = Number(v.equityUsd);
          return Number.isFinite(eq) && eq > 0;
        })
        .map((v) => v.venue);
      console.log(
        `[ledger] 开盘名单缺失，已按当前所补齐（不叠权益） dayOpen=${Number(state.dayOpenEquity).toFixed(2)}`
      );
    }

    if (state.dayOpenEquity == null) {
      // 优先用昨日收盘权益作今日开盘；没有则冻结当前权益（当日差从 0 起）
      if (yesterday && Number(yesterday.equity) > 0) {
        state.dayOpenEquity = Number(yesterday.equity);
        state.venuesInOpenEquity = venueKeysBeforeIngest;
      } else {
        state.dayOpenEquity = today.equity;
        baselineInitializedFromCurrent = true;
        state.venuesInOpenEquity = venues
          .filter((v) => {
            const e = Number(v.equityUsd);
            return Number.isFinite(e) && e > 0;
          })
          .map((v) => v.venue);
      }
    }

    for (const v of venues) {
      const eq = Number(v.equityUsd);
      if (!(Number.isFinite(eq) && eq > 0)) continue;
      if (state.venuesInOpenEquity.includes(v.venue)) continue;
      // 新所当日入账（含入金）：并入开盘基准，不进今日盈亏
      state.dayOpenEquity = round(Number(state.dayOpenEquity) + eq);
      state.venuesInOpenEquity.push(v.venue);
      newlyBaselinedVenues.add(v.venue);
      console.log(
        `[ledger] 新所 ${v.venue} 权益 ${eq.toFixed(2)}U 并入开盘基准（不计今日盈亏）`
      );
    }

    for (const v of venues) {
      for (const flow of v.cashFlows || []) {
        const id = String(flow.id || "").trim();
        const amount = Number(flow.amountUsd);
        const timestampMs = Number(flow.timestampMs);
        if (!id) throw new Error(`[ledger] ${v.venue} 资金流水缺少 id`);
        if (!(Number.isFinite(amount) && amount !== 0)) {
          throw new Error(`[ledger] ${v.venue} 资金流水 ${id} amountUsd 无效`);
        }
        if (!(Number.isFinite(timestampMs) && timestampMs > 0)) {
          throw new Error(`[ledger] ${v.venue} 资金流水 ${id} timestampMs 无效`);
        }
        if (shanghaiDayKey(new Date(timestampMs)) !== today.day) continue;
        const scopedId = `${v.venue}:${id}`;
        if (processedCashFlowIds.has(scopedId)) continue;

        const alreadyInsideCurrentBaseline =
          baselineInitializedFromCurrent ||
          newlyBaselinedVenues.has(v.venue) ||
          (cashFlowTrackingWasMissing && !yesterday);
        processedCashFlowIds.add(scopedId);
        if (alreadyInsideCurrentBaseline) {
          console.log(
            `[ledger] ${v.venue} 资金流水 ${id} 已包含在当前基准，登记但不重复调整`
          );
          continue;
        }

        state.dayOpenEquity = round(Number(state.dayOpenEquity) + amount);
        today.externalCashFlow = round((Number(today.externalCashFlow) || 0) + amount);
        console.log(
          `[ledger] ${v.venue} 外部资金流 ${amount > 0 ? "+" : ""}${amount.toFixed(2)}U ` +
            `已调整开盘基准至 ${Number(state.dayOpenEquity).toFixed(2)}U`
        );
      }
    }
    state.processedCashFlowIds = [...processedCashFlowIds];
    delete (state as any)._rolloverVenueKeys;

    today.dayProfit = round(today.equity - state.dayOpenEquity);
    if (yesterday && Number(yesterday.equity) > 0) {
      today.equityChange = round(today.equity - Number(yesterday.equity));
    } else {
      today.equityChange = today.dayProfit;
    }
  }

  today.updatedAt = new Date().toISOString();

  state.calendar = [today, ...state.calendar.filter((d) => d.day !== today.day)];
  saveLedger(state);
  return state;
}

export function ledgerPublicView(state: LedgerState = loadLedger()) {
  return {
    dayKey: state.dayKey || shanghaiDayKey(),
    calendar: state.calendar.map((d) => ({
      day: d.day,
      todayVolume: d.todayVolume,
      officialVolume: d.officialVolume ?? null,
      officialFees: d.officialFees ?? null,
      equity: d.equity,
      equityChange: d.equityChange,
      externalCashFlow: d.externalCashFlow ?? 0,
      dayProfit: d.dayProfit,
      gridProfit: d.gridProfit,
    })),
    combined: state.combined,
  };
}
