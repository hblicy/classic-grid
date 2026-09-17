# PopDEX 代理钱包完整迁移设计

日期：2026-09-17

## 目标

将 `dex-wangge` 已验证的 PopDEX Agent 钱包生命周期迁移到 `classic-grid`，使主钱包私钥不再进入应用。`classic-grid` 使用主账户地址读取账户事实并作为订单归属账户，仅使用经主钱包链上授权的临时 Agent 私钥签名 PopDEX 交易。

迁移范围包含浏览器生成 Agent、主钱包授权或替换、链上回验、保存到 `.env`、状态查询、主钱包撤销及撤销确认后的本地清除，同时把现有 PopDEX 实盘执行器和官方统计切换到主账户/Agent 双身份模型。

## 范围边界

- 保留 `classic-grid` 现有网格策略、执行循环、订单计划和 Dashboard 数据结构。
- 不迁移 `dex-wangge` 的操作日志、订单所有权存储、恢复状态机或其他交易所实现。
- 停用 `POPDEX_PRIVATE_KEY` 和 `POPDEX_KEY_PATH`；实盘发现旧配置时明确拒绝启动，不做静默回退。
- 新配置只使用 `POPDEX_MAIN_ACCOUNT` 与 `POPDEX_AGENT_PRIVATE_KEY`。
- Agent 配置变更不热切换正在运行的 PopDEX 执行器，配置在进程重启后生效。
- 不修改与本功能无关的交易所、策略、记账和通知行为。

## 组件设计

### Agent 编解码模块

新增独立模块封装 PopDEX Account 预编译：

- 严格校验 EVM 地址和 `0x` 开头的 32 字节私钥。
- 从 Agent 私钥派生公开地址，错误只返回固定描述，不回显输入。
- 编解码 `approveAgent`、`replaceAgent`、`revokeAgent`、`getAgentInfo` 和 `getAgents`。
- Agent 名称固定为 `UI_<dashboard hostname>`，裁剪到单个 `bytes32` 可容纳的 31 个 ASCII 字节。
- 新授权使用 `initialNonce=floor(Date.now()/1000)`、`expiresAt=Date.now()+2592e6`、`isGlobal=false`。
- 同一名称存在唯一旧 Agent 时生成 `replaceAgent`；无同名 Agent 时生成 `approveAgent`；同名结果不唯一时拒绝猜测。

### Agent 链上读取模块

通过 PopDEX RPC 的 `eth_call` 读取 Agent 信息并严格解码：

- 验证链 ID 为 `0x888`。
- `getAgentInfo` 保留完整整数精度，输出十进制字符串形式的 `expiresAt`。
- `getAgents` 要求各返回数组长度一致，并逐项校验地址、名称和状态字段。
- RPC 错误、ABI 解码失败或字段类型异常直接向调用方抛出带上下文但不含密钥的错误。

### Agent 服务模块

服务模块编排链上读取、授权状态和 `.env` 持久化：

- `status`：返回是否配置、主账户、Agent 地址、授权状态、到期时间和公开失败原因；永不返回私钥。
- `prepareApproval`：读取主账户现有 Agent，返回由主钱包发送的授权或替换交易数据，不在服务端广播。
- `verifyAuthorization`：要求 Agent 存在、未过期、非全局授权、delegator 精确匹配主账户，且主账户与 Agent 地址不同。
- `save`：从提交的私钥派生 Agent 地址，再次链上回验；成功后才写入 `POPDEX_MAIN_ACCOUNT` 和 `POPDEX_AGENT_PRIVATE_KEY`。
- `prepareRevoke`：只为当前有效 Agent 返回撤销交易数据，不在服务端广播。
- `clear`：再次读取链上状态；仅当 Agent 已不存在时清除 `POPDEX_AGENT_PRIVATE_KEY`，保留主账户地址。
- `.env` 写入在 POSIX 系统保持 `0600`，落盘成功后才更新当前进程环境变量。

### PopDEX 实盘执行器

`PopdexExecutor` 分离两个身份：

- `mainAccount` 来自 `POPDEX_MAIN_ACCOUNT`，用于账户概览、订单、仓位和官方统计查询，也用于 `placeOrder`、`cancelOrder`、`cancelAllOrders` 的 `account` 参数。
- `agentAccount` 从 `POPDEX_AGENT_PRIVATE_KEY` 派生，只用于构造、签名和广播交易。

实盘 `connect()` 在创建可写客户端前回验 Agent 授权。缺少配置、存在旧主钱包私钥配置、Agent 授权无效或链 ID 不符时，PopDEX 连接失败且不进入执行循环。Dry-run 在没有 Agent 配置时仍可读取公共行情；一旦提供不完整或冲突的 PopDEX 私有配置则明确报错。

`officialStats.ts` 直接使用 `POPDEX_MAIN_ACCOUNT` 获取官方统计，不再读取私钥或从私钥推导账户地址。

## Dashboard API

新增六个独立 API：

- `GET /api/popdex/agent/status`
- `POST /api/popdex/agent/prepare-approval`
- `POST /api/popdex/agent/verify`
- `POST /api/popdex/agent/save`
- `POST /api/popdex/agent/prepare-revoke`
- `POST /api/popdex/agent/clear`

请求体使用严格字段白名单和大小限制。敏感请求正文不写日志，响应错误不得包含 Agent 私钥。

当 Dashboard 快照显示 PopDEX 正在实盘运行且该交易所未暂停时，`save`、`prepare-revoke` 和 `clear` 拒绝执行，并提示先暂停 PopDEX。授权准备和只读回验不改变运行身份，允许执行。

## Dashboard 安全边界

- 配置 `DASHBOARD_TOKEN` 后，页面、静态资源和 API 均要求用户名固定为 `admin` 的 HTTP Basic Auth。
- 未配置 `DASHBOARD_TOKEN` 时，Dashboard 强制绑定 `127.0.0.1`，不得监听所有网卡。
- Agent 写接口要求 `Content-Type: application/json`、`X-Grid-Request: 1`，并校验 `Origin` 与当前请求主机同源。
- 非 Agent 的现有写接口也纳入相同的认证和同源边界，避免新增保护旁路。
- 请求认证、来源或正文格式不满足要求时返回明确的 4xx，不执行任何状态修改。

## 浏览器 Agent 页面

在现有 Dashboard 增加独立的 PopDEX Agent 面板：

1. 增加与来源项目一致的 `ethers@6.13.5` 运行依赖，并由 Dashboard 从本地 `node_modules` 提供固定版本 UMD 文件；页面使用 `ethers.Wallet.createRandom()` 在浏览器内存中生成 Agent 私钥和地址，不加载第三方 CDN。
2. 私钥只显示一次，不写入 Local Storage、Session Storage、Cookie、URL 或 Dashboard 快照。
3. 连接注入式 EVM 钱包，要求当前账户与主账户一致并切换到 PopDEX 链 `0x888`。
4. 调用后端准备授权交易，由主钱包通过 `eth_sendTransaction` 广播并等待成功回执。
5. 调用后端只读回验；只有授权有效时启用保存。
6. 保存成功后清除页面中的私钥文本和内存引用，并提示重启进程后生效。
7. 撤销时由主钱包发送 `revokeAgent`；页面轮询链上状态，确认不存在后再请求后端清除本地私钥。

页面不会提供新的下单、杠杆或平仓入口。运行期身份变更前必须先暂停 PopDEX，完成后重启进程。

## 失败处理

- 链 ID、RPC、回执、ABI、地址、授权期限或 delegator 不确定时全部失败关闭，不猜测成功。
- 用户拒签或交易回执失败时保持原配置，不自动重发授权或撤销交易。
- 链上授权成功但本地保存失败时明确提示“链上已授权、本地未保存”，不得再次自动授权。
- 保存成功后只读回验异常时保留配置并显示“已配置但不可验证”，不得静默清除。
- 撤销交易发出但未确认时保留本地 Agent 私钥，供用户继续查询和恢复。
- 实盘运行中尝试改变 Agent 身份时返回可识别冲突错误，不影响其他交易所。

## 测试与验收

自动测试覆盖：

- Agent 私钥校验和地址派生不泄露输入。
- Agent 名称、授权时间单位、`isGlobal=false`、approve/replace/revoke ABI 参数。
- `getAgentInfo/getAgents` 的严格解码、链 ID 校验和大整数保真。
- 不存在、过期、全局、delegator 不匹配和主账户/Agent 相同的拒绝路径。
- 未授权不能保存；合法保存只更新目标环境变量；写入失败不修改当前进程环境。
- 撤销未确认不能清除；撤销确认后只清除 Agent 私钥。
- 状态和错误响应不包含私钥。
- Dashboard Basic Auth、仅本机无 Token 模式、同源、JSON、自定义请求头和请求体大小限制。
- 实盘运行且 PopDEX 未暂停时禁止改变 Agent 配置。
- PopDEX 私有读取使用主账户，交易签名使用 Agent，交易 calldata 的账户参数仍是主账户。
- 旧 `POPDEX_PRIVATE_KEY` / `POPDEX_KEY_PATH` 被明确拒绝。
- `officialStats.ts` 使用主账户而非私钥。
- TypeScript 编译、Agent 专项测试和现有测试全部通过。

人工验收顺序：

1. 本机或受认证保护的 Dashboard 生成 Agent。
2. 主钱包授权并等待成功回执。
3. 后端回验授权并保存配置，确认页面与日志不泄露私钥。
4. 重启进程，确认 PopDEX 使用主账户读取事实且由 Agent 签名。
5. 暂停 PopDEX，使用主钱包撤销 Agent。
6. 链上回验撤销后清除本地私钥，重启确认 PopDEX 实盘拒绝连接。

人工验收不自动发送任何网格订单；真实下单继续由用户现有的实盘启动流程和确认开关控制。

## 完成标准

- 主钱包私钥不再进入 `classic-grid` 的配置、内存、前端、后端或日志。
- Agent 生命周期在页面和 API 中完整可用，且每个状态变化都有链上事实回验。
- PopDEX 所有账户事实归属主账户，所有写交易只由有效 Agent 签名。
- 运行中不能无保护地替换或撤销正在使用的 Agent。
- Dashboard 敏感接口不暴露在匿名公网访问路径上。
- 现有网格策略和其他交易所行为无回归。
