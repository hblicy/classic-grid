# Classic Grid — 八所经典网格（开源）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](./package.json)

等差网格：现价下买上卖，**成交后补相邻反向单**；启动校验格距 > 双边手续费、保证金预检。

适配器：**Extended · RISEx · Decibel · N1 · Phoenix · Phoenix2 · Nado · PopDEX**

> 开源模板，**不含私钥 / API Key / Telegram Token / 服务器地址 / 账本文件**。
> 生产运行只需要：`cp .env.example .env`，填上所需凭据，其余代码零改动。PopDEX 使用独立 Agent，主钱包私钥不得填入本项目。

---

## 注册链接（可选，非投资建议）

| 交易所 | 链接 |
|--------|------|
| **Extended** | https://app.extended.exchange/join/AIQIANG888 |
| **RISEx** | https://rise.trade/（暂无推荐码） |
| **Decibel** | https://app.decibel.trade/r/K7B2QM |
| **N1** | https://app.n1.xyz/r/orderly-loop-curve |
| **Phoenix / Phoenix2** | https://phoenix.trade/?code=35D5NJH3 |
| **Nado** | https://app.nado.xyz?join=aiqiang888 |
| **PopDEX** | https://app.popdex.xyz/referral?referralCode=AIQIANG |

---

## 功能一览

- 多所统一 `VenueExecutor`：`snapshot` / `apply` / 可选 `cancelAll`·`closePosition`
- 经典网格核心：`seed` 铺单 + 成交补反向档 + `skipBand`（近价跳过带宽）
- 本地看板：总览 KPI、今日明细、各所状态、挂单档位横轴（看匀不匀）、日历盈亏
- 官方量 / 费 / 平仓盈亏（节流拉取，避免内存爆）
- Telegram：开/平简报、整点总览、异常去重（可选）
- `SOFT_RESUME`：重启恢复锚点，避免误整表撤单
- 紧急暂停 / 出入金记账（看板按钮 + API）

---

## 我们解决过什么（摘要）

完整版 → [`docs/CHALLENGES.md`](./docs/CHALLENGES.md)

| 难题 | 解法要点 |
|------|----------|
| 成交后网格断档 | 买→上邻卖 / 卖→下邻买，每 level 一单 |
| 重启冲掉挂单 | `SOFT_RESUME` + 本地锚点，只补漏 |
| 官方统计 OOM | 节流拉取 + 加大 Node 堆 |
| 各所盈亏口径不一 | Ex 用已平仓 history；Rise/Dec 用 fill realized 等 |
| 仓位名义差很多 | 净仓路径不同，先对满格名义再对净格数 |
| 限流 / 挂单上限 | `maxOpenOrders`、写频、间隔、错误去重 |
| Decibel tick/lot | 编码前对齐 |
| 链上 CLOB（PopDEX） | viem 签名 + gasless 中继广播 |
| 坏 JSON 回包 | 归类瞬时软错误，不刷 TG、下轮重试 |

---

## 怎么跑起来

### 0. 前置

- Node.js ≥ 20
- 至少一个交易所的账号 + API 密钥（无密钥也能用 `DRY_RUN=1` 跑空转看流程）

### 1. 安装依赖

```bash
npm install
```

### 2. 准备环境变量（**只在本机填密钥，永远不要提交 `.env`**）

```bash
cp .env.example .env
```

打开 `.env`，按需填写。关键项：

- `VENUES=` 只开你有密钥的所，例如 `VENUES=extended,phoenix`
- 各所的 API / 私钥 / keypair 路径（`secrets/*.key`、`secrets/*.json`，已在 `.gitignore`）
- 默认 `DRY_RUN=1`（模拟，只读看板，不下单）
- 实盘必须**同时**满足：`DRY_RUN=0` 且 `LIVE_CONFIRM=YES`

#### PopDEX Agent 配置

PopDEX 不再接受主钱包私钥或旧的 `POPDEX_PRIVATE_KEY` / `POPDEX_KEY_PATH`。交易读取主账户，签名使用权限可撤销的独立 Agent：

1. 启动看板，在「PopDEX Agent 钱包」中生成 Agent；生成的私钥只保存在当前页面内存中。
2. 用主钱包连接钱包插件，完成主钱包授权；后端会做链上回验，确认 Agent 与主账户的授权关系。
3. 点击保存，将主账户公开地址与 Agent 私钥写入本机 `.env`：`POPDEX_MAIN_ACCOUNT`、`POPDEX_AGENT_PRIVATE_KEY`。主钱包私钥不得保存到项目或服务器。
4. 重启进程，使运行时加载新配置；启动时会再次检查链上授权状态。
5. 授权、替换、保存、撤销或清理 Agent 前都必须先暂停 PopDEX 交易。用主钱包提交撤销；若链上撤销成功但本地清理因网络或写盘失败，可在页面点击「仅清除已撤销的本地私钥」重试，完成后重启进程。

看板默认只监听 `127.0.0.1`，且无 Token 模式只接受 `localhost`、`127.0.0.1` 或 `[::1]` Host。如需远程监听，必须设置至少 16 个字符的 `DASHBOARD_TOKEN`；远程访问还应按 [`SECURITY.md`](./SECURITY.md) 配置安全通道。

### 3. 先空转一轮（强烈建议）

```bash
DRY_RUN=1 npm start -- --once
```

会打印各所锚点、格数、档距、size、风险预检，但不下任何单。确认无报错再继续。

### 4. 实盘运行

```bash
DRY_RUN=0 LIVE_CONFIRM=YES npm start
```

看板默认 http://127.0.0.1:8088/（`/api/snapshot` 是机器可读 JSON）。

Windows（PowerShell）：

```powershell
Copy-Item .env.example .env
$env:DRY_RUN="1"; npm start -- --once
```

### 5. 禁止提交

`.env` / `secrets/` / `data/` 永远不提交；见 [`SECURITY.md`](./SECURITY.md)。

---

## Telegram 报警（可选）

代码已包含：`src/telegram.ts`（开/平简报、错误去重、整点总览）。在 **本机 `.env`** 填写：

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=     # BotFather 发的 token，勿提交仓库
TELEGRAM_CHAT_IDS=      # 你的 chat_id；多个用逗号分隔
```

获取方式（自行完成，勿把真实值贴进 Issue/PR）：

1. Telegram 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 得到 `BOT_TOKEN`
2. 先给 bot 发一条任意消息，再用 `https://api.telegram.org/bot<TOKEN>/getUpdates` 看 `chat.id`，填入 `TELEGRAM_CHAT_IDS`
3. 重启进程后：成交开/平、异常、整点总览会推送到该 chat

未启用或 token/chat 为空时，程序照常跑，只是不发 TG。

---

## 默认参数（可改）

| 所 | 格数 | 杠杆 | 半幅 | 备注 |
|----|------|------|------|------|
| Extended | 80 | 30x | ±4.6% | Starknet，预算 800U×70% |
| RISEx | 46 | 25x | ±3% | 单笔偏大，注意降风险 |
| Decibel | 80 | 30x | ±5% | Aptos，`DECIBEL_EQUITY_USD` |
| N1 | 80 | 30x | ±5% | Solana，`N1_EQUITY_USD`，PostOnly |
| Phoenix | 80 | 30x | ±4.5% | Solana，`PHOENIX_HALF_BAND` |
| Phoenix2 | 80 | 30x | ±4.5% | 同 Phoenix，独立 keypair |
| Nado | 80 | 30x | ±4.5% | Ink 链，`NADO_HALF_BAND` |
| PopDEX | 80 | 30x | ±4.5% | Morph Tachyon，`POPDEX_EQUITY_USD` |

`GRID_MARGIN_FRAC` 默认 `0.7`（保证金占预算 70%）。各所格数/杠杆/半幅均可用对应 `*_LEVERAGE`、`*_HALF_BAND`、`*_EQUITY_USD` 覆盖。

---

## 目录

```
src/
  grid.ts             # 网格核心：seed / 补反向 / skipBand
  loop.ts             # 主循环：snapshot → 计划 → apply
  config.ts           # 定档 / 锚点 / env 解析
  dashboard.ts        # 看板服务（/api/snapshot 等）
  ledger.ts           # 每日盈亏 / 出入金记账
  officialStats.ts    # 官方量/费/平仓盈亏（节流）
  telegram.ts         # TG 通知
  botControl.ts       # 紧急暂停 / 恢复
  venues/             # 各所适配器（snapshot/apply/cancelAll/closePosition）
    extended.ts risex.ts decibel.ts decibelLive.ts n1.ts
    phoenix.ts nado.ts popdex.ts index.ts types.ts
public/index.html     # 看板前端（纯静态）
docs/CHALLENGES.md demo-dashboard.html images/
vendor/               # 轻量封装，无密钥
test/                 # 核心网格单测
```

---

## 给 AI / 改代码时

- 策略：`src/grid.ts` · 循环：`src/loop.ts` · 适配器：`src/venues/` · TG：`src/telegram.ts`
- 演示静态页：`docs/demo-dashboard.html`
- 只读看板：`/api/snapshot`；紧急暂停：`POST /api/pause` / `/api/resume`

---

## 免责声明

杠杆与合约有爆仓风险；软件按现状提供，不构成投资建议。注册/推荐链接非投资建议。切勿在 Issue 粘贴私钥。

## License

MIT · 推特 [@aiqiang888](https://twitter.com/aiqiang888)
