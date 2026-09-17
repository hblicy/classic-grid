/**
 * PopDEX（Morph Tachyon CLOB）VenueExecutor
 *
 * 读（面板 snapshot）：
 *   GET /api/v1/public/market/tickers
 *   GET /api/v1/account/{wallet}/overview|positions|orders
 *   GET /api/v1/config/symbol
 * 写：
 *   Order 预编译 0x…1000 placeOrder / cancelOrder / cancelAllOrders
 *   经 POST /api/v1/web3/rpc eth_sendRawTransaction（gasless）
 *
 * WS（可选，当前轮询即可）：wss://ws.popdex.xyz/v1/ws/public
 *   ticker / books / order / position / fill / account
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  pad,
  parseUnits,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { ApplyResult, Intent, LiveOrder, Side, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import { dryApply, type VenueExecutor } from "./types.js";
import { strictAddress } from "../popdex/agent.js";
import { PopdexAgentRpc, type AgentInfo, type PopdexRpcRequest } from "../popdex/agentRpc.js";
import { agentAuthorizationFailure } from "../popdex/agentService.js";

const API = "https://api.popdex.xyz";
const ORDER = "0x0000000000000000000000000000000000001000" as const;
const CHAIN_ID = 0x888;
const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_SYMBOL_ID = 20000;

const Category = { Spot: 0, Margin: 1, Futures: 2 } as const;
const OrderType = { Limit: 0, Market: 1, Plan: 2, Tpsl: 3 } as const;
const SideEnum = { Buy: 0, Sell: 1 } as const;
const TimeInForce = { Default: 0, GTC: 1, IOC: 2, FOK: 3, PostOnly: 4 } as const;
const MarketUnit = { BaseToken: 0, QuoteToken: 1 } as const;
const PositionSide = { None: 0, Long: 1, Short: 2 } as const;
const OrderCategory = { Regular: 0, Plan: 1, Tpsl: 2 } as const;

export const POPDEX_PLACE_ORDER_ABI = [
  {
    type: "function",
    name: "placeOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "clientOrderId", type: "bytes32" },
      { name: "symbolId", type: "uint16" },
      { name: "orderParams", type: "bytes32" },
      { name: "price", type: "uint256" },
      { name: "qty", type: "uint256" },
      { name: "slippage", type: "uint256" },
      { name: "builder", type: "address" },
      { name: "builderFeeRate", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

const cancelAbi = [
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "orderId", type: "uint128" },
      { name: "clientOrderId", type: "bytes32" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

const cancelAllAbi = [
  {
    type: "function",
    name: "cancelAllOrders",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "symbolId", type: "uint16" },
      {
        name: "category",
        type: "tuple",
        components: [
          { name: "isSome", type: "bool" },
          { name: "value", type: "uint8" },
        ],
      },
      {
        name: "orderCategory",
        type: "tuple",
        components: [
          { name: "isSome", type: "bool" },
          { name: "value", type: "uint8" },
        ],
      },
      {
        name: "isFullPositionTpsl",
        type: "tuple",
        components: [
          { name: "isSome", type: "bool" },
          { name: "value", type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function packOrderParams(p: {
  category: number;
  orderType: number;
  side: number;
  timeInForce: number;
  marketUnit?: number;
  bbo?: number;
  isReduceOnly?: number;
  positionSide?: number;
}): Hex {
  const buf = new Uint8Array(32);
  buf[0] = p.category;
  buf[1] = p.orderType;
  buf[2] = p.side;
  buf[3] = p.timeInForce;
  buf[4] = p.marketUnit ?? 0;
  buf[5] = p.bbo ?? 0;
  buf[6] = p.isReduceOnly ?? 0;
  buf[7] = p.positionSide ?? 0;
  return toHex(buf);
}

function clientOid(label: string): Hex {
  return pad(stringToHex(label.slice(0, 31)), { size: 32, dir: "right" });
}

const popdexChain = defineChain({
  id: CHAIN_ID,
  name: "PopDEX",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [`${API}/api/v1/web3/rpc`] } },
});

async function defaultRpcRequest(method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(`${API}/api/v1/web3/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function defaultApiGet<T = any>(pathname: string): Promise<T> {
  const r = await fetch(`${API}${pathname}`, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  const j = (await r.json()) as { code?: string; msg?: string; data?: T };
  if (String(j.code) !== "200") {
    throw new Error(`${pathname} => ${j.code} ${j.msg || JSON.stringify(j).slice(0, 180)}`);
  }
  return j.data as T;
}

export function resolvePopdexIdentity(env: NodeJS.ProcessEnv): {
  mainAccount: Address;
  agentAccount: PrivateKeyAccount;
} {
  if (String(env.POPDEX_PRIVATE_KEY || "").trim()) {
    throw new Error("PopDEX 旧配置 POPDEX_PRIVATE_KEY 已停用；请改用代理钱包模式。");
  }
  if (String(env.POPDEX_KEY_PATH || "").trim()) {
    throw new Error("PopDEX 旧配置 POPDEX_KEY_PATH 已停用；请改用代理钱包模式。");
  }
  const rawMain = String(env.POPDEX_MAIN_ACCOUNT || "").trim();
  const rawAgentKey = String(env.POPDEX_AGENT_PRIVATE_KEY || "").trim();
  if (!rawMain) throw new Error("PopDEX 缺少 POPDEX_MAIN_ACCOUNT。");
  if (!rawAgentKey) throw new Error("PopDEX 缺少 POPDEX_AGENT_PRIVATE_KEY。");
  const mainAccount = strictAddress(rawMain, "mainAccount");
  let agentAccount: PrivateKeyAccount;
  try {
    agentAccount = privateKeyToAccount(rawAgentKey as Hex);
  } catch {
    throw new Error("PopDEX Agent 私钥格式无效。");
  }
  if (mainAccount === agentAccount.address) {
    throw new Error("PopDEX Agent 地址与主账户不能相同。");
  }
  return { mainAccount, agentAccount };
}

type WalletClientLike = {
  sendTransaction(transaction: Record<string, unknown>): Promise<Hex>;
};

type PublicClientLike = {
  getTransactionReceipt(input: { hash: Hex }): Promise<{ status: "success" | "reverted" } | null>;
};

type AgentRpcLike = {
  verifyChain(): Promise<void>;
  getAgentInfo(agentAddress: string): Promise<AgentInfo>;
};

export type PopdexExecutorDeps = {
  env?: NodeJS.ProcessEnv;
  apiGet?: <T = any>(pathname: string) => Promise<T>;
  rpcRequest?: PopdexRpcRequest;
  agentRpc?: AgentRpcLike;
  createWallet?: (account: PrivateKeyAccount) => WalletClientLike;
  createPublic?: () => PublicClientLike;
  sleep?: (ms: number) => Promise<void>;
};

export class PopdexExecutor implements VenueExecutor {
  readonly id = "popdex" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly apiGet: <T = any>(pathname: string) => Promise<T>;
  private readonly rpcRequest: PopdexRpcRequest;
  private readonly agentRpc: AgentRpcLike;
  private readonly createWallet: (account: PrivateKeyAccount) => WalletClientLike;
  private readonly createPublic: () => PublicClientLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private agentAccount: PrivateKeyAccount | null = null;
  private mainAccount: Address | null = null;
  private symbol = DEFAULT_SYMBOL;
  private symbolId = DEFAULT_SYMBOL_ID;
  private tickSize = 1;
  private lotSize = 0.0001;
  private minQty = 0.0001;
  private minNotional = 10;
  private wallet: WalletClientLike | null = null;
  private pub: PublicClientLike | null = null;

  constructor(
    private dryRun: boolean,
    deps: PopdexExecutorDeps = {}
  ) {
    this.env = deps.env ?? process.env;
    this.apiGet = deps.apiGet ?? defaultApiGet;
    this.rpcRequest = deps.rpcRequest ?? defaultRpcRequest;
    this.agentRpc = deps.agentRpc ?? new PopdexAgentRpc({ request: this.rpcRequest });
    const transport = custom({
      request: async ({ method, params }) =>
        this.rpcRequest(method, (params as unknown[]) ?? []),
    });
    this.createWallet =
      deps.createWallet ??
      ((account) =>
        createWalletClient({ account, chain: popdexChain, transport }) as unknown as WalletClientLike);
    this.createPublic =
      deps.createPublic ??
      (() => createPublicClient({ chain: popdexChain, transport }) as unknown as PublicClientLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private roundPrice(px: number): number {
    const t = this.tickSize > 0 ? this.tickSize : 1;
    return Math.round(px / t) * t;
  }

  private roundSize(size: number): number {
    if (!(size > 0)) return 0;
    const lot = this.lotSize > 0 ? this.lotSize : 0.0001;
    const rounded = Math.floor(size / lot + 1e-12) * lot;
    return Number(rounded.toFixed(8));
  }

  private ensureSize(size: number, price: number): number {
    let s = this.roundSize(size);
    const minByNotional =
      price > 0 ? Math.ceil(this.minNotional / price / this.lotSize) * this.lotSize : this.minQty;
    const minSz = Math.max(this.minQty, minByNotional);
    if (s > 0 && s < minSz) s = minSz;
    return Number(s.toFixed(8));
  }

  async connect(): Promise<void> {
    if (this.env === process.env) loadEnv();
    this.symbol = (this.env.POPDEX_SYMBOL || DEFAULT_SYMBOL).trim() || DEFAULT_SYMBOL;
    try {
      const cfg = await this.apiGet<any>(
        `/api/v1/config/symbol?symbol=${encodeURIComponent(this.symbol)}&category=Futures`
      );
      this.symbolId = Math.max(1, num(cfg.symbolId, DEFAULT_SYMBOL_ID));
      this.tickSize = num(cfg.tickSize, 1) || 1;
      this.lotSize = num(cfg.lotSize, 0.0001) || 0.0001;
      this.minQty = num(cfg.minQty, this.lotSize) || this.lotSize;
      this.minNotional = num(cfg.minNotional, 10) || 10;
    } catch (e: any) {
      console.warn(`[popdex] symbol config fallback: ${String(e?.message || e).slice(0, 120)}`);
    }

    const privateConfigured = [
      this.env.POPDEX_PRIVATE_KEY,
      this.env.POPDEX_KEY_PATH,
      this.env.POPDEX_MAIN_ACCOUNT,
      this.env.POPDEX_AGENT_PRIVATE_KEY,
    ].some((value) => String(value || "").trim().length > 0);
    if (this.dryRun && !privateConfigured) {
      console.log(`[popdex] dry-run connected symbol=${this.symbol} id=${this.symbolId} (public only)`);
      return;
    }

    const identity = resolvePopdexIdentity(this.env);
    await this.agentRpc.verifyChain();
    const info = await this.agentRpc.getAgentInfo(identity.agentAccount.address);
    const reason = agentAuthorizationFailure(
      identity.mainAccount,
      identity.agentAccount.address,
      info
    );
    if (reason) throw new Error(`PopDEX Agent 尚未获得有效授权：${reason}。`);
    this.mainAccount = identity.mainAccount;
    this.agentAccount = identity.agentAccount;
    this.wallet = this.createWallet(identity.agentAccount);
    this.pub = this.createPublic();
    console.log(
      `[popdex] main=${this.mainAccount} agent=${this.agentAccount.address} symbol=${this.symbol} id=${this.symbolId} tick=${this.tickSize} lot=${this.lotSize}`
    );
  }

  disconnect(): void {
    this.agentAccount = null;
    this.mainAccount = null;
    this.wallet = null;
    this.pub = null;
  }

  private async mid(): Promise<number> {
    const rows = await this.apiGet<any[]>(
      `/api/v1/public/market/tickers?category=Futures&symbol=${encodeURIComponent(this.symbol)}`
    );
    const list = Array.isArray(rows) ? rows : [];
    const t =
      list.find((x) => String(x.symbol).toUpperCase() === this.symbol.toUpperCase()) || list[0];
    if (!t) throw new Error("PopDEX 无 ticker");
    const bid = num(t.bid1Price);
    const ask = num(t.ask1Price);
    const mark = num(t.markPrice);
    const last = num(t.lastPrice);
    const mid =
      bid > 0 && ask > 0 ? (bid + ask) / 2 : mark > 0 ? mark : last > 0 ? last : 0;
    if (!(mid > 0)) throw new Error("PopDEX 无效 mid");
    return mid;
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    if (this.dryRun && !this.mainAccount) {
      const mid = await this.mid().catch(() => 100_000);
      return { venue: this.id, market, mid, position: 0, openOrders: [] };
    }
    const addr = this.mainAccount;
    if (!addr) throw new Error("PopDEX 未 connect");
    const mid = await this.mid();
    const [overview, positions, orders] = await Promise.all([
      this.apiGet<any>(`/api/v1/account/${addr}/overview`).catch(() => null),
      this.apiGet<any[]>(`/api/v1/account/${addr}/positions`).catch(() => []),
      this.apiGet<any[]>(
        `/api/v1/account/${addr}/orders?status=pending&category=Futures&symbol=${encodeURIComponent(this.symbol)}`
      ).catch(() => []),
    ]);

    let position = 0;
    let unrealizedPnl: number | undefined;
    for (const p of positions || []) {
      if (String(p.symbol || "").toUpperCase() !== this.symbol.toUpperCase()) continue;
      // PopDEX 实盘字段：holdQty + positionSide(Long/Short)；兼容 size/qty
      const sz = num(
        p.holdQty ?? p.size ?? p.holdSize ?? p.qty ?? p.positionSize
      );
      const side = String(p.side || p.positionSide || "").toLowerCase();
      const signed =
        side.includes("short") || side === "sell" ? -Math.abs(sz) : Math.abs(sz);
      // oneway 也可能用正负 size
      if (p.size != null && Number(p.size) < 0) position += num(p.size);
      else position += signed;
      const upl = num(
        p.unPnl ?? p.unrealizedPnl ?? p.upl ?? p.unrealizedProfit,
        NaN
      );
      if (Number.isFinite(upl)) unrealizedPnl = (unrealizedPnl ?? 0) + upl;
    }

    const openOrders: LiveOrder[] = [];
    for (const o of orders || []) {
      const rem = num(o.remainingQty ?? o.qty);
      if (!(rem > 0)) continue;
      const sideRaw = String(o.side || "").toLowerCase();
      const side: Side = sideRaw.startsWith("s") ? "sell" : "buy";
      openOrders.push({
        id: String(o.orderId || o.clientOid || ""),
        market,
        side,
        price: this.roundPrice(num(o.price)),
        size: rem,
        level: 0,
      });
    }

    const equityUsd = overview ? num(overview.accountEquity, NaN) : NaN;
    return {
      venue: this.id,
      market,
      mid,
      position,
      openOrders: openOrders.filter((o) => o.id),
      equityUsd: Number.isFinite(equityUsd) && equityUsd > 0 ? equityUsd : undefined,
      unrealizedPnl:
        unrealizedPnl != null && Number.isFinite(unrealizedPnl) ? unrealizedPnl : undefined,
    };
  }

  private async send(to: Hex, data: Hex, gas = 500_000n): Promise<Hex> {
    if (!this.wallet || !this.pub || !this.agentAccount) {
      throw new Error("PopDEX 未 connect");
    }
    const hash = await this.wallet.sendTransaction({
      account: this.agentAccount,
      to,
      data,
      value: 0n,
      gas,
      gasPrice: 0n,
    });
    for (let i = 0; i < 30; i++) {
      await this.sleep(400);
      const receipt = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt) {
        if (receipt.status !== "success") {
          throw new Error(`tx reverted ${hash}`);
        }
        return hash;
      }
    }
    console.warn(`[popdex] tx receipt timeout ${hash}`);
    return hash;
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    const result: ApplyResult = { placed: 0, cancelled: 0, failed: 0, errors: [] };
    const gapMs = Math.max(0, Number(this.env.POPDEX_ORDER_GAP_MS || 200) || 200);
    let wrote = 0;
    let liveMid = 0;
    try {
      liveMid = await this.mid();
    } catch {
      /* place 时再试 */
    }

    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          const id = String(intent.orderId || "");
          if (!/^\d+$/.test(id)) throw new Error(`无效 orderId=${id}`);
          const data = encodeFunctionData({
            abi: cancelAbi,
            functionName: "cancelOrder",
            args: [this.mainAccount!, BigInt(id), pad("0x", { size: 32 })],
          });
          if (wrote > 0 && gapMs > 0) await this.sleep(gapMs);
          await this.send(ORDER, data, 300_000n);
          result.cancelled += 1;
          wrote += 1;
        } else {
          const px = this.roundPrice(intent.order.price);
          if (!(px > 0)) throw new Error(`无效价格 ${intent.order.price}`);
          const size = this.ensureSize(intent.order.size, px);
          if (!(size > 0)) throw new Error(`size 过小 lot=${this.lotSize}`);

          if (liveMid > 0) {
            if (intent.order.side === "sell" && px <= liveMid) {
              console.log(`[popdex] skip cross sell@${px} mid=${liveMid.toFixed(2)}`);
              continue;
            }
            if (intent.order.side === "buy" && px >= liveMid) {
              console.log(`[popdex] skip cross buy@${px} mid=${liveMid.toFixed(2)}`);
              continue;
            }
          }

          if (wrote > 0 && gapMs > 0) await this.sleep(gapMs);
          const oid = clientOid(`g${Date.now().toString(36)}${wrote}`);
          const orderParams = packOrderParams({
            category: Category.Futures,
            orderType: OrderType.Limit,
            side: intent.order.side === "buy" ? SideEnum.Buy : SideEnum.Sell,
            timeInForce: TimeInForce.PostOnly,
            marketUnit: MarketUnit.BaseToken,
            positionSide: PositionSide.None,
          });
          const data = encodeFunctionData({
            abi: POPDEX_PLACE_ORDER_ABI,
            functionName: "placeOrder",
            args: [
              this.mainAccount!,
              oid,
              this.symbolId,
              orderParams,
              parseUnits(String(px), 18),
              parseUnits(String(size), 18),
              0n,
              "0x0000000000000000000000000000000000000000",
              0n,
            ],
          });
          await this.send(ORDER, data);
          result.placed += 1;
          wrote += 1;
        }
      } catch (e: any) {
        result.failed += 1;
        result.errors.push(String(e?.message || e).slice(0, 200));
      }
    }
    return result;
  }

  async cancelAll(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[popdex:dry] cancelAll ${market}`);
      return;
    }
    const data = encodeFunctionData({
      abi: cancelAllAbi,
      functionName: "cancelAllOrders",
      args: [
        this.mainAccount!,
        this.symbolId,
        { isSome: true, value: Category.Futures },
        { isSome: true, value: OrderCategory.Regular },
        { isSome: false, value: false },
      ],
    });
    await this.send(ORDER, data, 400_000n);
  }

  async closePosition(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[popdex:dry] closePosition ${market}`);
      return;
    }
    const snap = await this.snapshot(market);
    const pos = snap.position;
    if (!(Math.abs(pos) > this.minQty / 2)) return;
    const mid = snap.mid > 0 ? snap.mid : await this.mid();
    const size = this.ensureSize(Math.abs(pos), mid);
    const isLong = pos > 0;
    const orderParams = packOrderParams({
      category: Category.Futures,
      orderType: OrderType.Market,
      side: isLong ? SideEnum.Sell : SideEnum.Buy,
      timeInForce: TimeInForce.IOC,
      marketUnit: MarketUnit.BaseToken,
      isReduceOnly: 1,
      positionSide: PositionSide.None,
    });
    const oid = clientOid(`c${Date.now().toString(36)}`);
    const data = encodeFunctionData({
      abi: POPDEX_PLACE_ORDER_ABI,
      functionName: "placeOrder",
      args: [
        this.mainAccount!,
        oid,
        this.symbolId,
        orderParams,
        0n,
        parseUnits(String(size), 18),
        parseUnits("0.01", 18),
        "0x0000000000000000000000000000000000000000",
        0n,
      ],
    });
    await this.send(ORDER, data);
  }
}
