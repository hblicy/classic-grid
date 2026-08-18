# RISEx 资金流水响应兼容设计

日期：2026-08-18

## 背景与根因

看板使用账户总权益与当日开盘权益的差值计算今日盈亏。RISEx 当天充值 800U 后，程序未识别这笔外部资金流，导致充值被计入今日收益。

主网实测响应为：

- 列表字段：`data.items`
- 时间字段：`block_time`（纳秒）
- 类型字段：`type=DEPOSIT`
- 金额字段：`amount`
- 唯一标识：`transaction_hash`

当前 `risex-client` 的 `getTransferHistory()` 只读取 `data.transfers`，并把不存在的字段静默转换成空数组；项目解析器又只接受 `timestamp`。因此接口 HTTP 200 且包含充值记录时，项目仍得到空流水。

## 目标

1. 正确读取 RISEx 当前主网的 `items + block_time` 响应。
2. 继续兼容 SDK 声明的旧版 `transfers + timestamp` 响应。
3. 未知响应结构必须显式报错，不能再次静默当成空流水。
4. 保持现有账本去重、上海时区日期过滤和开盘权益调整逻辑不变。
5. 不把钱包地址、交易哈希等流水明细暴露到 Dashboard API。

## 方案选择

### 采用：在项目 RISEx 封装层兼容真实响应

`vendor/risex/risex.js` 直接通过现有 `InfoClient` 的 HTTP 客户端请求 `/v1/account/transfer-history`，从响应中读取 `items` 或 `transfers`。`src/venues/risex.ts` 将 `block_time` 或 `timestamp` 统一转换为毫秒。

优点：改动局部、保留现有多交易所总权益算法、可准确处理充值和提现，并能在 SDK 更新前工作。

### 不采用：修改 `node_modules/risex-client`

安装依赖后会丢失修改，无法作为项目代码可靠发布。

### 暂不采用：用 `pnl-calendar` 替换本地权益算法

官方 `daily_pnl` 已排除资金流，但当前看板合并 RISEx 与 Decibel 总权益。只替换 RISEx 会引入每交易所独立基准、官方数据延迟及跨所汇总口径调整，范围明显大于本次响应兼容问题。

## 数据流

1. RISEx executor 每五分钟获取一次 transfer history。
2. 封装层验证返回值必须包含数组形式的 `items` 或 `transfers`。
3. executor 将每条记录标准化为 `{ id, amountUsd, timestampMs }`：
   - `DEPOSIT` 为正数；
   - `WITHDRAW`/`WITHDRAWAL` 为负数；
   - `transaction_hash` 作为重启去重 ID；
   - `block_time`/`timestamp` 的纳秒值转换为毫秒。
4. ledger 只处理上海时区当天的流水，并使用 `venue:id` 持久化去重。
5. 当天充值增加 `dayOpenEquity`，提现减少 `dayOpenEquity`，再重新计算 `dayProfit`。

按当前账本和实测数据，部署后只处理 2026-08-18 的 800U 充值；较早日期的另一笔 800U 会被日期过滤。`dayOpenEquity` 预计从 `1497.8279` 调整为 `2297.8279`。

## 错误处理与可观测性

- HTTP 非成功状态沿用 SDK HTTP 客户端异常并中断当次 snapshot。
- 响应既没有 `items` 也没有 `transfers`，或字段不是数组时，抛出包含实际顶层字段名的结构错误。
- 流水缺少金额、类型或时间时显式报错。
- ledger 成功处理时继续输出外部资金流金额、交易所和调整后的开盘基准；日志不打印私钥或 signer key。

## 测试

先添加失败测试，再修改生产代码：

1. 用实测 `data.items + block_time + DEPOSIT` 响应验证能得到 `+800U` 流水。
2. 验证旧版 `transfers + timestamp` 仍可解析。
3. 验证未知响应结构会抛错，而不是返回空数组。
4. 运行现有 ledger 测试，确认仅当天充值调整基准、旧日期充值被过滤、重启不会重复处理。
5. 运行完整 `npm test` 和 `git diff --check`。

## 非目标

- 不修改 Decibel 或其他交易所盈亏口径。
- 不重构 Dashboard 总权益算法。
- 不自动修改或删除现有 `data/ledger.json`。
- 不修改 `node_modules`。
