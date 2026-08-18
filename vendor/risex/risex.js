// RiseExchange: LIVE adapter for RISEx (https://rise.trade) via risex-client.
// Implements the same IExchange surface as extended.js for GridBot / Fleet.
import { EventEmitter } from 'node:events';
import {
  ExchangeClient, InfoClient, OrderType, TimeInForce, formatWad, parseWad, encodeLeverage,
} from 'risex-client';

const INTERVAL_RES = {
  60: '1', 300: '5', 900: '15', 1800: '30', 3600: '60', 14400: '240', 86400: '1D',
};

function round2(x) { return Math.round(x * 100) / 100; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }

function priceDecimals(step) {
  const s = Number(step) || 0.01;
  if (s >= 1) return 0;
  if (s >= 0.1) return 1;
  if (s >= 0.01) return 2;
  if (s >= 0.001) return 3;
  if (s >= 0.0001) return 4;
  return 6;
}

function snapPrice(px, step) {
  const s = Number(step) || 0.01;
  const mult = 10 ** priceDecimals(s);
  return Math.round(Math.round(Number(px) / s) * s * mult) / mult;
}

/** RISEx 链上数值多为 WAD(1e18) 字符串 */
function wadNum(v) {
  if (v == null || v === '') return 0;
  const n = Number(formatWad(String(v)));
  return Number.isFinite(n) ? n : 0;
}

/**
 * REST history 里 price/size 常为人类可读（"63000" / "0.00015"）。
 * formatWad("63000") 会误当成 WAD → 6.3e-14；短整型/含小数点走 Number。
 */
function apiNum(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  if (!s) return 0;
  if (/[eE.]/.test(s) || s.length <= 12) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  return wadNum(s);
}

function riseTimeMs(t) {
  const n = Number(t?.time ?? t?.timestamp ?? 0);
  if (!n) return 0;
  if (n > 1e15) return Math.floor(n / 1e6);
  if (n > 1e12) return n;
  return n * 1000;
}

export class RiseExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.network = 'mainnet';
    this.account = opts.account;
    this.apiUrl = (opts.apiUrl || '').replace(/\/$/, '');
    this.wsUrl = opts.wsUrl;
    this.signerKey = opts.signerKey;
    this.pollMs = opts.pollMs ?? 5000;
    // Default to no artificial delay; set RISE_ORDER_GAP_MS if the API starts returning quota errors.
    this.orderGapMs = Math.max(0, Number(opts.orderGapMs ?? process.env.RISE_ORDER_GAP_MS ?? 0) || 0);
    this._adaptiveGapMs = this.orderGapMs;
    this._adaptiveSuccesses = 0;
    this._lastPlaceAt = 0;
    this._lastChainAt = 0;
    /** 全账户链上写操作串行队列（place/cancel/杠杆/平仓 共享 10s quota） */
    this._chainQueue = Promise.resolve();
    this._levTarget = new Map();
    this._levPermitMismatch = new Set();
    this._pollTick = 0;
    this.markets = new Map();
    this.balance = null;
    this.equity = null;
    this.availableMargin = null;
    this.unrealisedPnl = null;
    this._statsCache = null;
    this._quota = null;
    this.statsMarketNames = [];
    this._tracked = new Map();
    /** @type {Map<number, Array>} 最近一次 API 拉取的链上挂单（与官网一致） */
    this._officialOpenByMarket = new Map();
    this._officialOpenUpdatedAt = 0;
    this._officialOpenUpdatedAtByMarket = new Map();
    this._orphanOrderMarkets = [];
    this._watch = new Set();
    this._pos = new Map();
    this._allPositions = [];
    this._prices = new Map();
    this._timer = null;
    this._busy = false;

    const rawFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const res = await rawFetch(...args);
      try {
        const url = String(args[0]?.url ?? args[0] ?? '');
        if (res.ok && url.includes('/v1/orders/place')) {
          const earned = res.headers.get('X-Address-Quota-Earned');
          const remaining = res.headers.get('X-Address-Quota-Remaining');
          if (earned != null || remaining != null) {
            this._quota = {
              earned: earned != null ? Number(earned) : null,
              remaining: remaining != null ? Number(remaining) : null,
              updatedAt: Date.now(),
            };
          }
        }
      } catch { /* quota headers are best-effort */ }
      return res;
    };

    const clientOpts = { baseUrl: this.apiUrl, wsUrl: this.wsUrl, logLevel: 'warn' };
    this.info = new InfoClient(clientOpts);
    this.client = new ExchangeClient({
      ...clientOpts,
      account: this.account,
      signerKey: opts.signerKey,
    });
  }

  async init() {
    if (!this.account || !this.signerKey) {
      throw new Error('RISEX_ACCOUNT / RISEX_SIGNER_KEY 未配置。');
    }
    await this.client.init();
    const sysCfg = await this.info.getSystemConfig().catch(() => ({}));
    const addresses = sysCfg?.data?.addresses ?? sysCfg?.addresses ?? {};
    this._perpsManager = addresses.perps_manager || null;
    const http = this.client.info?.http ?? this.info?.http;
    if (http) {
      // 当前 API 要求 permit_params，且 leverage / 签名值都是 1..255 的整数。
      this.client.updateLeverage = async (marketId, leverage, nonce) => {
        const mId = Number(marketId);
        const levInt =
          typeof leverage === 'bigint'
            ? Math.floor(Number(formatWad(String(leverage))))
            : Math.floor(Number(leverage));
        const hash = encodeLeverage(mId, BigInt(levInt));
        const permit_params = await this.client.createPermit(hash, nonce);
        return http.post('/v1/account/leverage', {
          market_id: mId,
          leverage: String(levInt),
          permit_params,
        });
      };
    }
    const registered = await this.client.isSignerRegistered().catch(() => false);
    if (!registered) {
      throw new Error('API Signer 未在 RISEx 注册。请先在 rise.trade → Settings → API Keys 创建并启用 Signer。');
    }

    const list = (await this.info.getMarkets())
      .filter((m) => m.visible !== false)
      .sort((a, b) => Number(b.volume_24h || 0) - Number(a.volume_24h || 0));

    for (const m of list) {
      const id = Number(m.market_id);
      const stepSize = Number(m.config?.step_size || m.config?.min_order_size || 0.0001);
      const stepPrice = Number(m.config?.step_price || 0.01);
      const px = Number(m.last_price || m.mark_price || 0);
      const name = m.display_name || `${m.base_asset_symbol}-PERP`;
      this.markets.set(id, {
        marketId: id,
        name,
        displayName: name,
        symbol: m.base_asset_symbol,
        lastPrice: px,
        stepSize,
        stepPrice,
        maxLeverage: Number(m.config?.max_leverage || 50),
        minOrderSize: Number(m.config?.min_order_size || stepSize),
        qtyStep: String(stepSize),
        priceStep: String(stepPrice),
        _raw: m,
      });
      this._prices.set(id, px);
    }
    if (!this.markets.size) throw new Error('RISEx 未返回可交易市场。');
    this.dataSource = 'real';
    await this._refreshAccount();
    await this._refreshAllPositions();
    this.start();
    return true;
  }

  _market(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m) throw new Error('未知市场 marketId=' + marketId);
    return m;
  }

  _waitChainGap() {
    const gap = Math.max(this.orderGapMs, this._adaptiveGapMs) - (Date.now() - this._lastChainAt);
    if (gap > 0) return new Promise((r) => setTimeout(r, gap));
    return Promise.resolve();
  }

  /** 串行执行链上写操作，避免多 bot 并发触发 429 */
  _chainMutate(fn) {
    const run = async () => {
      await this._waitChainGap();
      try {
        const result = await fn();
        if (this._adaptiveGapMs > this.orderGapMs) {
          this._adaptiveSuccesses += 1;
          if (this._adaptiveSuccesses >= 3) {
            this._adaptiveGapMs = Math.max(
              this.orderGapMs,
              Math.floor(this._adaptiveGapMs / 2)
            );
            this._adaptiveSuccesses = 0;
          }
        }
        return result;
      } catch (error) {
        const message = String(error?.message || error);
        if (/tx quota exceeded|1 request per 10 seconds|429|rate.?limit/i.test(message)) {
          this._adaptiveGapMs = Math.max(this._adaptiveGapMs, 10_000);
          this._adaptiveSuccesses = 0;
        }
        throw error;
      } finally {
        this._lastChainAt = Date.now();
      }
    };
    const p = this._chainQueue.then(run, run);
    this._chainQueue = p.catch(() => {});
    return p;
  }

  priceToTicks(price, marketId) {
    const m = this._market(marketId);
    const step = Number(m.stepPrice) || 0.01;
    return Math.max(1, Math.round(Number(price) / step));
  }

  sizeToSteps(sizeBase, marketId) {
    const m = this._market(marketId);
    const step = Number(m.stepSize) || 0.0001;
    const steps = Math.round(Number(sizeBase) / step);
    if (steps <= 0) throw new Error('数量过小，低于市场最小下单单位。');
    return steps;
  }

  ticksToPrice(ticks, marketId) {
    const m = this._market(marketId);
    return round6(Number(ticks) * Number(m.stepPrice));
  }

  async getMarkets() { return [...this.markets.values()]; }

  marketIdForName(name) {
    for (const [id, m] of this.markets) {
      if (m.name === name || m.displayName === name) return id;
    }
    return null;
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const mId = Number(marketId);
    const count = Math.min(Number(n) || 200, 500);
    const intervalNs = BigInt(intervalSec) * 1_000_000_000n;
    const toNs = BigInt(Date.now()) * 1_000_000n;
    const fromNs = toNs - intervalNs * BigInt(count);
    const path = `/v1/markets/id/${mId}/trading-view-data?interval=${intervalNs}&from=${fromNs}&to=${toNs}`;
    let data;
    try {
      data = await this.info.http.get(path);
    } catch {
      // 兼容旧 SDK 路径（部分环境仍可用）
      const res = INTERVAL_RES[intervalSec] || '60';
      const now = Math.floor(Date.now() / 1000);
      const from = now - intervalSec * count;
      data = await this.info.getCandles(mId, res, String(from), String(now));
      const legacy = data?.candles ?? data;
      return (Array.isArray(legacy) ? legacy : [])
        .map((c) => ({
          time: Number(c.timestamp || c.t || 0) * (Number(c.timestamp) > 1e12 ? 1 : 1000),
          open: +c.open, high: +c.high, low: +c.low, close: +c.close,
          volume: +(c.volume ?? 0),
        }))
        .filter((c) => Number.isFinite(c.close))
        .sort((a, b) => a.time - b.time);
    }
    const rows = data?.data?.data ?? data?.data ?? data?.candles ?? [];
    return (Array.isArray(rows) ? rows : [])
      .map((c) => {
        const tRaw = Number(c.time ?? c.timestamp ?? c.t ?? 0);
        const timeMs = tRaw > 1e15 ? Math.floor(tRaw / 1e6) : (tRaw > 1e12 ? tRaw : tRaw * 1000);
        return {
          time: timeMs,
          open: +c.open, high: +c.high, low: +c.low, close: +c.close,
          volume: +(c.volume ?? 0),
        };
      })
      .filter((c) => Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
  }

  async getPrice(marketId) {
    const mId = Number(marketId);
    this._watch.add(mId);
    const m = this._market(mId);
    try {
      const book = await this.info.getOrderbook(mId, 5);
      const bid = Number(book?.bids?.[0]?.price);
      const ask = Number(book?.asks?.[0]?.price);
      if (bid && ask) {
        const mid = (bid + ask) / 2;
        this._prices.set(mId, mid);
        return mid;
      }
      if (bid || ask) {
        const px = bid || ask;
        this._prices.set(mId, px);
        return px;
      }
    } catch { /* fall back */ }
    return this._prices.get(mId) ?? m.lastPrice;
  }

  async setLeverage(marketId, x) {
    const mId = Number(marketId);
    const target = Math.floor(Number(x));
    return this._chainMutate(async () => {
      let lastErr;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await this.client.updateLeverage(mId, parseWad(String(target)));
          this._levTarget.set(mId, target);
          return true;
        } catch (e) {
          lastErr = e;
          const msg = e?.message || '';
          if (/permit signature mismatch/i.test(msg)) {
            this._levPermitMismatch.add(mId);
            console.warn(`[RISEx] m${mId} 杠杆 permit 签名不匹配，跳过自动设杠杆`);
            return false;
          }
          const quotaWait = /tx quota exceeded|1 request per 10 seconds/i.test(msg);
          const retry = /NonceUsed|nonce|429|rate.?limit/i.test(msg) && attempt < 5;
          if (!retry) break;
          await new Promise((r) =>
            setTimeout(
              r,
              quotaWait ? Math.max(this._adaptiveGapMs, 10_000) : 1500 * attempt
            )
          );
        }
      }
      this.emit('error', lastErr);
      return false;
    });
  }

  /** 持仓杠杆与目标不符时写链上杠杆；大仓不平仓（避免铺单前误平 SOL 等残留） */
  async ensureLeverage(marketId, x) {
    const mId = Number(marketId);
    if (process.env.RISE_SKIP_LEVERAGE === '1' || this._levPermitMismatch?.has(mId)) return false;
    const target = Math.floor(Number(x));
    await this._refreshAllPositions().catch(() => {});
    const pos = this.getPosition(mId);
    const posSz = Math.abs(pos?.sizeBase ?? 0);
    const minSz = Number(this.markets.get(mId)?.minOrderSize) || 0.0001;
    if (pos?.leverage != null && Math.abs(pos.leverage - target) > 0.5) {
      if (posSz > minSz * 8) {
        console.warn(`[RISEx] ${mId} 杠杆 ${pos.leverage}x≠${target}x，持仓 ${posSz} 较大，跳过自动平仓`);
      } else {
        await this.closePosition(mId).catch(() => {});
        await new Promise((r) => setTimeout(r, 2500));
        await this._refreshAllPositions().catch(() => {});
      }
    }
    const ok = await this.setLeverage(mId, target);
    if (!ok) {
      if (this._levPermitMismatch?.has(mId)) return false;
      throw new Error(`RISEx 设置 ${target}x 杠杆失败（请查日志 Nonce/429）`);
    }
    return true;
  }

  getTargetLeverage(marketId) {
    return this._levTarget.get(Number(marketId)) ?? null;
  }

  async placeLimitOrder(o) {
    return this._chainMutate(async () => {
      const mId = Number(o.marketId);
      const m = this._market(mId);
      const sizeSteps = this.sizeToSteps(o.sizeBase, mId);
      const priceTicks = this.priceToTicks(o.price, mId);
      const postOnly = o.postOnly !== false;
      const isBuy = o.side === 'buy';
      const reduceOnly = !!o.reduceOnly;

      let lastErr;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const r = await this.client.placeOrder({
            market_id: mId,
            size_steps: sizeSteps,
            price_ticks: priceTicks,
            side: isBuy ? 0 : 1,
            order_type: 1,
            time_in_force: 0,
            post_only: postOnly,
            reduce_only: reduceOnly,
            stp_mode: 0,
            ttl_units: 0,
          });

          const orderId = String(r.order_id ?? r.sc_order_id ?? r.id ?? '');
          this._watch.add(mId);
          this._tracked.set(orderId, {
            marketId: mId,
            levelIndex: o.levelIndex,
            side: o.side,
            price: o.price,
            sizeBase: o.sizeBase,
            reduceOnly,
            restingOrderId: r.resting_order_id != null ? String(r.resting_order_id) : null,
            wideOrderId: r.wide_order_id != null ? String(r.wide_order_id) : null,
            placedAt: Date.now(),
            seen: false,
          });
          return { orderId };
        } catch (e) {
          lastErr = e;
          const msg = e?.message || '';
          const quotaWait = /tx quota exceeded|1 request per 10 seconds/i.test(msg);
          const retry = /NonceUsed|nonce|429|rate.?limit/i.test(msg) && attempt < 5;
          if (!retry) throw e;
          await new Promise((r) =>
            setTimeout(
              r,
              quotaWait ? Math.max(this._adaptiveGapMs, 10_000) : 1500 * attempt
            )
          );
        }
      }
      throw lastErr;
    });
  }

  async cancelOrder(marketId, orderId, restingOrderId) {
    return this._chainMutate(async () => {
      const t = this._tracked.get(String(orderId));
      let restId = restingOrderId ?? t?.restingOrderId;
      if (restId == null) {
        const cached = this._officialOpenByMarket.get(Number(marketId)) || [];
        const co = cached.find((o) => String(o.orderId) === String(orderId));
        restId = co?.restingOrderId;
      }
      await this.client.cancelOrder({
        market_id: Number(marketId),
        order_id: String(orderId),
        resting_order_id: restId ?? undefined,
      });
      this._tracked.delete(String(orderId));
      return true;
    });
  }

  async cancelOrderConfirmed(marketId, orderId, restingOrderId) {
    await this.cancelOrder(marketId, orderId, restingOrderId);
    const rows = await this.refreshOpenOrders(marketId);
    return !rows.some((o) => String(o.orderId) === String(orderId));
  }

  async cancelAll(marketId) {
    return this._chainMutate(async () => {
      const mId = Number(marketId);
      await this.client.cancelAllOrders(mId);
      for (const [id, t] of [...this._tracked]) {
        if (t.marketId === mId) this._tracked.delete(id);
      }
      this._officialOpenByMarket.set(mId, []);
      return true;
    });
  }

  async cancelAllConfirmed(marketId, { attempts = 3 } = {}) {
    await this.cancelAll(marketId);
    for (let i = 0; i < attempts; i++) {
      const rows = await this.refreshOpenOrders(marketId).catch(() => null);
      if (rows && rows.length === 0) return true;
      await new Promise((r) => setTimeout(r, Math.max(1000, this.pollMs)));
    }
    throw new Error(`RISEx 官方挂单仍未确认清空 marketId=${marketId}`);
  }

  /** 全账户链上挂单（不限于当前 watch 标的） */
  async fetchAllOpenOrders() {
    const rows = await this.info.getOpenOrders(this.account);
    const parsed = (rows || []).map((o) => {
      const mId = Number(o.market_id);
      return { ...this._parseOpenOrder(o, mId), raw: o };
    });
    const byMarket = new Map();
    for (const o of parsed) {
      const mId = Number(o.marketId);
      if (!mId) continue;
      if (!byMarket.has(mId)) byMarket.set(mId, []);
      byMarket.get(mId).push(o);
      this._watch.add(mId);
    }
    for (const [mId, list] of byMarket) {
      this._officialOpenByMarket.set(mId, list);
    }
    this._officialOpenUpdatedAt = Date.now();
    for (const mId of byMarket.keys()) this._officialOpenUpdatedAtByMarket.set(mId, this._officialOpenUpdatedAt);
    return parsed;
  }

  getOpenOrders(marketId) {
    return [...this._tracked.values()].filter((o) => o.marketId === Number(marketId));
  }

  /** 缓存的链上挂单（每 poll 周期刷新，与 RISEx 官网一致） */
  getCachedOpenOrders(marketId) {
    return (this._officialOpenByMarket.get(Number(marketId)) || []).map((o) => ({ ...o }));
  }

  getOfficialOpenOrdersUpdatedAt(marketId = null) {
    return marketId == null
      ? (this._officialOpenUpdatedAt || 0)
      : (this._officialOpenUpdatedAtByMarket.get(Number(marketId)) || 0);
  }

  async refreshOpenOrders(marketId) {
    const mId = Number(marketId);
    const open = await this.info.getOpenOrders(this.account, mId);
    // resting/wide id 会在多次挂单间复用，不能当主键；用 history.id (= order_id) 对齐价量
    const priceByOrderId = new Map();
    const sizeByOrderId = new Map();
    const hist = await this.info.getOrderHistory(this.account, mId, 250).catch(() => []);
    for (const h of hist || []) {
      const id = h.id != null ? String(h.id) : '';
      if (!id) continue;
      const px = apiNum(h.price);
      const sz = apiNum(h.size ?? h.filled_size);
      // 同 id 多条时保留最新（history 通常新在前）
      if (px > 0 && !priceByOrderId.has(id)) priceByOrderId.set(id, px);
      if (sz > 0 && !sizeByOrderId.has(id)) sizeByOrderId.set(id, sz);
    }
    const parsed = (open || []).map((o) => this._parseOpenOrder(o, mId, priceByOrderId, sizeByOrderId));
    this._officialOpenByMarket.set(mId, parsed);
    this._officialOpenUpdatedAt = Date.now();
    this._officialOpenUpdatedAtByMarket.set(mId, this._officialOpenUpdatedAt);
    return parsed;
  }

  _parseOpenOrder(o, mId, priceByOrderId = null, sizeByOrderId = null) {
    const m = this.markets.get(Number(mId));
    const stepP = Number(m?.stepPrice) || 0.01;
    const stepS = Number(m?.stepSize) || 0.0001;
    const sideRaw = o.side;
    const side = sideRaw === 0 || String(sideRaw).toUpperCase() === 'BUY' ? 'buy' : 'sell';
    const orderId = String(o.order_id);
    const restId = o.resting_order_id != null ? String(o.resting_order_id) : null;
    const wideId = o.wide_order_id != null ? String(o.wide_order_id) : null;
    const tracked = this._tracked.get(orderId) || null;
    if (tracked) tracked.seen = true;

    let price = 0;
    if (priceByOrderId?.has(orderId)) {
      price = priceByOrderId.get(orderId);
    } else if (tracked?.price > 0) {
      price = tracked.price;
    } else if (o.price_ticks != null) {
      const ticks = Number(o.price_ticks);
      const tick = ticks <= 16777215 ? ticks : (ticks & 16777215);
      if (tick > 0) price = tick * stepP;
    }
    if (!(price > 0) && o.price != null) price = wadNum(o.price) || Number(o.price);

    let sizeBase = 0;
    if (sizeByOrderId?.has(orderId)) {
      sizeBase = sizeByOrderId.get(orderId);
    } else if (tracked?.sizeBase > 0) {
      sizeBase = tracked.sizeBase;
    } else if (o.size_steps != null) {
      const steps = Number(o.size_steps);
      const step = steps <= 4294967295 ? steps : (steps & 4294967295);
      if (step > 0) sizeBase = step * stepS;
    }
    if (!(sizeBase > 0) && o.size != null) sizeBase = wadNum(o.size) || Number(o.size);

    // RISEx 偶发返回溢出的 packed tick/step；位运算可产生看似为正但完全失真的价格和数量。
    // 只接受围绕当前市场价格、且不超过账户最坏可承受名义的值；其余归为 unresolved。
    const refPrice = Number(this._prices.get(Number(mId)) ?? m?.lastPrice) || 0;
    if (refPrice > 0 && (!(price >= refPrice * 0.5) || !(price <= refPrice * 1.5))) {
      price = 0;
    }
    const maxLeverage = Number(m?.maxLeverage) || 50;
    const equity = Number(this.equity ?? this.balance) || 0;
    const maxSaneSize = refPrice > 0 && equity > 0
      ? Math.max(Number(m?.minOrderSize) || stepS, (equity * maxLeverage * 2) / refPrice)
      : Infinity;
    if (!(sizeBase > 0) || sizeBase > maxSaneSize) sizeBase = 0;

    const reduceOnly = o.reduce_only === true || o.reduce_only === 1
      || (tracked?.reduceOnly === true);
    return {
      orderId,
      marketId: Number(mId),
      side,
      price: snapPrice(price, stepP),
      sizeBase: round6(sizeBase),
      restingOrderId: restId,
      reduceOnly,
      wideOrderId: wideId,
    };
  }

  getPosition(marketId) {
    const p = this._pos.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  _parsePosition(p) {
    const mId = Number(p.market_id);
    const name = this.markets.get(mId)?.displayName
      || p.display_name
      || `M${mId}`;
    const sideStr = String(p.side ?? '').toUpperCase();
    const short = sideStr === 'SELL' || sideStr === 'SHORT' || Number(p.side) === 1;
    const qty = Math.abs(wadNum(p.size));
    if (!(qty > 0)) return null;
    const entry = wadNum(p.avg_entry_price ?? p.entry_price);
    let mark = wadNum(p.mark_price ?? p.markPrice);
    if (!(mark > 0)) {
      mark = this._prices.get(mId) ?? this.markets.get(mId)?.lastPrice ?? 0;
    }
    const value = mark > 0 ? qty * mark : (entry > 0 ? qty * entry : Math.abs(wadNum(p.quote_amount)));
    let upnl = wadNum(p.unrealized_pnl ?? p.unsettled_pnl);
    if (!(upnl !== 0) && entry > 0 && mark > 0) {
      upnl = short ? (entry - mark) * qty : (mark - entry) * qty;
    }
    const lev = p.leverage != null ? wadNum(p.leverage) : null;
    return {
      market: name,
      marketId: mId,
      side: short ? 'short' : 'long',
      size: round6(qty),
      sizeBase: round6(qty * (short ? -1 : 1)),
      entryPrice: round2(entry),
      markPrice: round2(mark),
      valueUsd: round2(value),
      unrealizedPnl: round2(upnl),
      leverage: lev != null ? round2(lev) : (this.getTargetLeverage(mId) ?? null),
    };
  }

  async _refreshAllPositions() {
    try {
      const ps = await this.info.getAllPositions(this.account);
      const parsed = [];
      for (const p of ps || []) {
        const row = this._parsePosition(p);
        if (!row) continue;
        parsed.push(row);
        if (row.marketId) this._watch.add(row.marketId);
        this._pos.set(row.marketId, {
          sizeBase: row.sizeBase,
          entryPrice: row.entryPrice,
          unrealizedPnl: row.unrealizedPnl,
          leverage: row.leverage,
        });
      }
      const seen = new Set(parsed.map((p) => p.marketId));
      for (const id of [...this._pos.keys()]) {
        if (!seen.has(id)) this._pos.delete(id);
      }
      parsed.sort((a, b) => Math.abs(b.valueUsd) - Math.abs(a.valueUsd));
      this._allPositions = parsed;
    } catch { /* keep */ }
  }

  async refreshPositions() {
    await this._refreshAllPositions();
    return this.getAllPositions();
  }

  getAllPositions() {
    return (this._allPositions || []).map((p) => ({ ...p }));
  }

  async closePosition(marketId) {
    return this._chainMutate(async () => {
      await this.client.closePosition(Number(marketId));
      return true;
    });
  }

  async reducePositionIoc(marketId, sizeBase) {
    await this.refreshPositions();
    const mId = Number(marketId);
    const pos = this.getPosition(mId);
    if (!pos) return { ok: true, skipped: true };
    const minSz = Number(this._market(mId).minOrderSize) || 0.0001;
    const abs = Math.abs(pos.sizeBase);
    if (abs > 0 && abs < minSz) {
      await this.closePosition(mId);
      await this.refreshPositions();
      return { ok: true, closedDust: true, sizeBase: abs };
    }
    const size = Math.min(abs, Number(sizeBase));
    const step = Number(this._market(mId).stepSize) || 0.0001;
    let sizeSteps = Math.max(1, Math.floor(size / step + 1e-9));
    const minSteps = Math.max(1, Math.ceil(minSz / step - 1e-9));
    if (sizeSteps < minSteps) {
      await this.closePosition(mId);
      await this.refreshPositions();
      return { ok: true, closedDust: true, sizeBase: abs };
    }
    const submittedSize = sizeSteps * step;
    return this._chainMutate(async () => {
      const r = await this.client.placeOrder({
        market_id: mId,
        size_steps: sizeSteps,
        price_ticks: 0,
        side: pos.sizeBase > 0 ? 1 : 0,
        order_type: OrderType.Market,
        time_in_force: TimeInForce.ImmediateOrCancel,
        post_only: false,
        reduce_only: true,
        stp_mode: 0,
        ttl_units: 0,
      });
      await this.refreshPositions();
      return { ok: true, sizeBase: submittedSize, orderId: String(r.order_id ?? r.sc_order_id ?? r.id ?? '') };
    });
  }

  start() {
    if (!this._timer) {
      this._timer = setInterval(() => this._poll(), this.pollMs);
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _poll() {
    if (this._busy) return;
    this._busy = true;
    this._pollTick += 1;
    try {
      await this._refreshAllPositions().catch(() => {});
      for (const mId of this._watch) {
        const m = this.markets.get(mId);
        if (!m) continue;
        // 订单簿每 3 轮拉一次，减轻 Cloudflare 429
        if (this._pollTick % 3 === 0) {
          this.getPrice(mId).then((px) => {
            if (px) this.emit('price', { marketId: mId, price: px });
          }).catch(() => {});
        } else if (this._prices.get(mId)) {
          this.emit('price', { marketId: mId, price: this._prices.get(mId) });
        }

        let open = [];
        let openOk = false;
        try {
          open = await this.info.getOpenOrders(this.account, mId);
          openOk = true;
        } catch { /* keep */ }

        if (!openOk) continue;

        const priceByOrderId = new Map();
        const sizeByOrderId = new Map();
        try {
          const hist = await this.info.getOrderHistory(this.account, mId, 250);
          for (const h of hist || []) {
            const id = h.id != null ? String(h.id) : '';
            if (!id) continue;
            const px = apiNum(h.price);
            const sz = apiNum(h.size ?? h.filled_size);
            if (px > 0 && !priceByOrderId.has(id)) priceByOrderId.set(id, px);
            if (sz > 0 && !sizeByOrderId.has(id)) sizeByOrderId.set(id, sz);
          }
        } catch { /* keep */ }

        const parsed = (open || []).map((o) => this._parseOpenOrder(o, mId, priceByOrderId, sizeByOrderId));
        this._officialOpenByMarket.set(mId, parsed);
        this._officialOpenUpdatedAt = Date.now();
        this._officialOpenUpdatedAtByMarket.set(mId, this._officialOpenUpdatedAt);
        const liveIds = new Set(parsed.map((o) => o.orderId));

        for (const o of open || []) {
          const t = this._tracked.get(String(o.order_id));
          if (t) {
            t.seen = true;
            if (o.resting_order_id != null) t.restingOrderId = String(o.resting_order_id);
          }
        }
        for (const [id, t] of [...this._tracked]) {
          if (t.marketId !== mId) continue;
          if (t.seen && !liveIds.has(id)) {
            this._tracked.delete(id);
            this._resolveGone(id, t).catch(() => {});
          }
        }

        this.emit('openOrdersSync', { marketId: mId, liveIds, officialList: parsed });
      }
      await this._refreshAccount().catch(() => {});
      this._refreshOfficialStats().catch(() => {});
    } catch (e) {
      this.emit('error', e);
    } finally {
      this._busy = false;
    }
  }

  /** 订单从挂单列表消失：查 order/trade history 确认是否真成交 */
  async _resolveGone(id, t) {
    let filled = false;
    try {
      const history = await this.info.getOrderHistory(this.account, t.marketId, 100);
      const o = (history || []).find((h) => String(h.order_id) === String(id));
      if (o) {
        const status = String(o.status || '').toUpperCase();
        const filledSz = wadNum(o.filled_size ?? o.size);
        if (filledSz > 0 || /FILLED|PARTIAL/i.test(status)) filled = true;
        if (/CANCEL|REJECT|EXPIRE/i.test(status) && filledSz <= 0) filled = false;
      } else {
        const trades = await this.info.getAccountTradeHistory(this.account, t.marketId, 50);
        filled = (trades || []).some((tr) => String(tr.order_id) === String(id));
      }
    } catch {
      return;
    }
    if (!filled) {
      this.emit('orderCancelled', { orderId: id, marketId: t.marketId });
      this.emit('error', new Error(`订单 ${id}（${t.side} @ ${t.price}）已撤单/未成交，未补单。`));
      return;
    }
    this.emit('fill', {
      orderId: id,
      marketId: t.marketId,
      side: t.side,
      price: t.price,
      sizeBase: t.sizeBase,
      levelIndex: t.levelIndex,
    });
  }

  _parseOfficialFill(t) {
    const mid = Number(t.market_id);
    const name = this.markets.get(mid)?.displayName || `M${mid}`;
    const sideStr = String(t.side ?? '').toUpperCase();
    const side = sideStr === 'BUY' || Number(t.side) === 0 ? 'buy' : 'sell';
    const price = Number(t.price) || wadNum(t.price);
    const size = Number(t.size) || wadNum(t.size);
    if (!(price > 0 && size > 0)) return null;
    return {
      id: String(t.id ?? t.fill_id ?? `${t.order_id}-${t.time}`),
      orderId: String(t.order_id ?? ''),
      market: name,
      marketId: mid,
      side,
      price,
      size,
      fee: Number(t.fee || 0),
      realizedPnl: Number(t.realized_pnl || 0),
      t: riseTimeMs(t),
    };
  }

  getOfficialFills(limit = 80, sinceMs = 0) {
    const fills = this._statsCache?.officialFills || [];
    const filtered = sinceMs > 0 ? fills.filter((f) => f.t >= sinceMs) : fills;
    return filtered.slice(0, limit);
  }

  async _refreshAccount() {
    try {
      const b = await this.info.getBalance(this.account);
      const bal = Number(b?.balance ?? b?.collateral_balance ?? b ?? 0);
      const upnl = Number(b?.unrealized_pnl ?? b?.unrealised_pnl ?? 0);
      this.balance = bal;
      this.unrealisedPnl = upnl;
      this.equity = round2(bal + upnl);
      const availableRaw = b?.available_margin ?? b?.available_balance ?? b?.free_collateral;
      this.availableMargin = availableRaw != null
        ? round2(Number(availableRaw) || wadNum(availableRaw))
        : this.equity;
    } catch (e) {
      if (/401|403/.test(e.message)) throw e;
    }
  }

  async getTransferHistory(limit = 1000) {
    return this.info.getTransferHistory(this.account, limit);
  }

  async _fetchAllAccountTrades() {
    const batch = 1000;
    const all = [];
    for (let page = 1; page <= 50; page++) {
      let rows = [];
      try {
        const data = await this.info.http.get(
          `/v1/trade-history?account=${this.account}&limit=${batch}&page=${page}`,
        );
        rows = data.fills ?? data.trades ?? [];
      } catch {
        if (page === 1) {
          rows = await this.info.getAccountTradeHistory(this.account, undefined, batch).catch(() => []);
        }
      }
      if (!rows.length) break;
      all.push(...rows);
      if (rows.length < batch) break;
    }
    return all;
  }

  async _refreshOfficialStats() {
    if (this._statsCache && Date.now() - this._statsCache.ts < 120_000) return this._statsCache;

    let trades = [];
    try {
      trades = await this._fetchAllAccountTrades();
    } catch { /* keep */ }

    let volume = 0;
    let feesPaid = 0;
    let realizedFromTrades = 0;
    const officialFills = [];

    for (const t of trades || []) {
      const row = this._parseOfficialFill(t);
      if (!row) continue;
      officialFills.push(row);
      volume += Math.abs(row.price * row.size);
      feesPaid += Math.abs(row.fee);
      realizedFromTrades += row.realizedPnl;
    }
    officialFills.sort((a, b) => b.t - a.t);
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const dayStartMs = new Date(`${dayKey}T00:00:00+08:00`).getTime();
    const todayFills = officialFills.filter((f) => f.t >= dayStartMs).slice(0, 2500);

    let realizedPnl = null;
    let pnlSource = 'trade-history';
    try {
      const rp = await this.info.getRealizedPnl(this.account);
      const raw = rp?.total_realized_pnl ?? rp?.realized_pnl;
      if (raw != null) {
        realizedPnl = round2(wadNum(raw));
        pnlSource = 'realized-pnl-api';
      }
    } catch { /* RISEx 该端点常 404，回退 trade-history 全量求和 */ }
    if (realizedPnl == null && officialFills.length) {
      realizedPnl = round2(realizedFromTrades);
      pnlSource = 'trade-history-sum';
    }

    const byMarket = {};
    for (const f of todayFills) {
      if (!byMarket[f.market]) byMarket[f.market] = { realizedPnl: 0, fees: 0, volume: 0, fills: 0 };
      const bm = byMarket[f.market];
      bm.fills += 1;
      bm.volume = round2(bm.volume + Math.abs(f.price * f.size));
      bm.fees = round2(bm.fees + Math.abs(f.fee));
      bm.realizedPnl = round2(bm.realizedPnl + f.realizedPnl);
    }

    // RISEx 无 positions/history：用带 realizedPnl 的成交合成平仓明细（供 8088 看板）
    const recentClosed = [];
    for (const f of todayFills) {
      if (!(Math.abs(Number(f.realizedPnl) || 0) > 1e-8)) continue;
      recentClosed.push({
        market: f.market,
        closedTime: f.t,
        realizedPnl: round2(f.realizedPnl),
        side: f.side === 'sell' ? 'long' : 'short',
        size: Math.abs(f.size),
        openPrice: 0,
        exitPrice: f.price,
        fees: round2(Math.abs(f.fee || 0)),
      });
      if (recentClosed.length >= 50) break;
    }

    this._statsCache = {
      ts: Date.now(),
      realizedPnl,
      pnlSource,
      feesPaid: round2(feesPaid),
      volume: round2(volume),
      fillCount: todayFills.length,
      // 只缓存当日，避免全账户成交史常驻内存
      officialFills: todayFills,
      byMarket,
      allClosed: recentClosed,
      recentClosed,
    };
    officialFills.length = 0;
    return this._statsCache;
  }

  async fetchAllTrades(_marketNames) {
    const trades = await this._fetchAllAccountTrades();
    return (trades || []).map((t) => {
      const mid = Number(t.market_id);
      const name = this.markets.get(mid)?.displayName || `M${mid}`;
      return {
        id: String(t.trade_id ?? t.id ?? `${mid}-${t.timestamp}`),
        market: name,
        price: Number(t.price),
        qty: wadNum(t.size ?? t.quantity),
        side: Number(t.side) === 0 ? 'BUY' : 'SELL',
        fee: Number(t.fee || 0),
        createdTime: Number(t.timestamp || 0) > 1e12 ? Number(t.timestamp) : Number(t.timestamp) * 1000,
      };
    });
  }

  getOfficialStats() {
    return this.getTradeStats();
  }

  getTradeStats() {
    if (!this._statsCache) return null;
    const s = this._statsCache;
    let unrealizedPnl = 0;
    for (const p of this.getAllPositions()) unrealizedPnl += p.unrealizedPnl || 0;
    unrealizedPnl = round2(unrealizedPnl);
    const realizedPnl = s.realizedPnl;
    const totalPnl = realizedPnl != null ? round2(realizedPnl + unrealizedPnl) : null;
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const dayStartMs = new Date(`${dayKey}T00:00:00+08:00`).getTime();
    const todayCloseCount = (s.officialFills || []).filter(
      (f) => f.t >= dayStartMs && Math.abs(f.realizedPnl || 0) > 1e-9
    ).length;
    return {
      realizedPnl,
      unrealizedPnl,
      totalPnl,
      pnlSource: s.pnlSource || 'trade-history',
      feesPaid: s.feesPaid,
      volume: s.volume,
      fillCount: s.fillCount,
      officialFills: s.officialFills,
      byMarket: s.byMarket,
      allClosed: s.allClosed || s.recentClosed || [],
      recentClosed: s.recentClosed || [],
      todayCloseCount,
      quota: this._quota,
      updatedAt: s.ts,
    };
  }
}
