# PopDEX Agent 审查问题修复设计

## 目标

修复合并提交 `7168845896d07799258004e83dbcad98cff57bdf` 审查确认的 9 个问题，使 PopDEX Agent 写交易符合协议、Agent 生命周期在实盘状态下保持一致，并关闭 Dashboard 与本地凭据持久化中的安全缺口。

本次只修复已确认问题，不引入 Agent 热更新、远程 TLS 服务、交易策略调整或其他重构。

## 交易 nonce

`PopdexExecutor` 为 Agent 写交易维护进程内单调毫秒 nonce：每笔交易取 `max(Date.now(), lastNonce + 1)`，并显式传给 viem `sendTransaction`。时钟函数通过 executor 依赖注入，以便测试同一毫秒内连续交易和系统时间回拨。

这与迁移来源 `dex-wangge` 的已验证路径一致。nonce 不从普通 EVM `eth_getTransactionCount` 获取，也不改变授权交易中的 `initialNonce` 编码。

## Agent 生命周期与暂停门禁

所有会改变 Agent 身份或本地凭据的操作都必须经过同一个服务端暂停门禁：

- `prepareApproval` 在查询或生成 approve/replace calldata 前调用 `assertMutationAllowed()`。
- `save`、`prepareRevoke`、`clear` 继续使用相同门禁。
- 实盘配置了 PopDEX 时，启动阶段默认视为不可修改；只有全局暂停或 PopDEX venue 暂停后才允许修改。
- dry-run 或启动配置未启用 PopDEX 时允许修改。

撤销条件与交易授权条件分离。交易使用仍要求 Agent 存在、未过期、delegator 精确匹配且非 global；撤销只要求 Agent 存在、Agent 与主账户不同、delegator 精确匹配。这样可以撤销已过期或误设为 global 的 Agent，同时禁止当前主账户撤销其他 delegator 的 Agent。

公开 Agent 状态增加链上 `exists` 字段。浏览器据此区分：

- `exists=true`：允许发起撤销，即使 Agent 已过期或为 global。
- `exists=false` 且本地仍 configured：允许单独重试清除本地私钥。
- `authorized=true`：仍只表示该 Agent 可供机器人交易使用。

撤销按钮与新增的“清除本地配置”操作分别处理链上撤销和本地清理，避免撤销成功但写盘失败后没有恢复入口。

## Dashboard 安全边界

### DNS rebinding

无 `DASHBOARD_TOKEN` 时，POST 除现有 JSON、自定义头和同源检查外，还要求 Host 为实际 loopback 主机：`localhost`、`127.0.0.1` 或 `[::1]`，端口可变。配置 Token 的远程模式保留当前同源 Host 行为，因为其主机名由部署决定，并继续依赖文档要求的 TLS、SSH 或私有网络。

校验函数接收 Dashboard 安全配置，使 loopback 与认证模式采用不同的 Host 规则。

### 外部错误文本

Dashboard 中来自 snapshot 的 `lastError` 必须先经过统一 HTML 转义再进入现有表格模板。修复点位于最接近 `innerHTML` sink 的渲染边界，覆盖 PopDEX 及其他 venue 的外部错误，不改变错误文本本身或 API 数据结构。

### 主钱包 prepared transaction

浏览器在调用 `eth_sendTransaction` 前对服务端返回值做完整意图绑定：

- `from` 等于当前连接主账户；`chainId` 为 `0x888`。
- `to` 等于固定 Account precompile。
- `value`、`gas`、`gasPrice` 为协议准备器返回的固定零值，交易类型为 legacy。
- 用本地 ethers ABI 解码 `data`，只接受 `approveAgent`、`replaceAgent`、`revokeAgent`。
- approve/replace 的新 Agent、delegator、hostname 派生 name 与当前页面意图一致；有效期和初始 nonce 必须为合理整数并处于服务端允许的当前时间窗口。
- revoke 的目标 Agent 必须等于当前状态中的 Agent。

前端不信任服务端声明的 action，而以 ABI selector 和解码参数为准。钱包仍保留最终用户确认步骤。

## `.env` 持久化

`setEnvLine` 改为按行重建内容：删除所有活动或注释形式的同名 key，再追加唯一的新值或唯一注释行。这样保存和清除都不会遗留重复私钥。

`writeEnvFile` 使用同目录临时文件、权限设置和原子 rename：

1. 将完整内容写入唯一临时文件。
2. POSIX 下把临时文件设为 `0600`。
3. rename 替换目标文件。
4. 失败时尽力删除临时文件并重新抛出原错误。

只有 rename 成功后才更新 `process.env`。不吞掉磁盘错误，也不删除原 `.env` 作为替换前置步骤。

## 测试策略

严格按测试驱动顺序实施，每组测试先确认在当前代码上因对应缺陷失败：

- executor 测试验证显式毫秒 nonce、同毫秒递增和时钟回拨。
- service 测试验证 approval pause gate、过期/global 撤销、delegator 拒绝、重复 env key 清理。
- env writer 测试使用真实临时目录验证原子替换和写入失败时原文件保留。
- Dashboard security 测试验证 loopback Host allowlist 和 DNS rebinding Host 拒绝。
- UI 测试验证恶意 `lastError` 只作为文本、prepared transaction 的合法与篡改输入、撤销后独立清理重试。
- API/启动测试验证配置了 PopDEX 的 live 启动窗口默认拒绝身份修改，暂停后允许。

最终运行完整 `npm test`、TypeScript `tsc --noEmit`（若仓库已有无关基线错误则精确区分）以及目标恶意输入复现。不会发送真实链上交易；真实 PopDEX 测试网验证作为剩余外部验证项报告。

## 验收标准

- 所有 Agent 写交易携带单调毫秒 nonce。
- live PopDEX 未暂停时不能 approve、replace、save、revoke 或 clear。
- 过期/global Agent 可由其 delegator 撤销，其他账户不可撤销。
- 撤销成功后的本地清理可以独立重试。
- 恶意错误 HTML 不执行，prepared transaction 任一关键字段或 ABI 参数被篡改都会在钱包调用前失败。
- 无 Token 模式拒绝非 loopback Host。
- `.env` 更新只保留一个目标 key，失败不损坏原文件。
- 全部相关回归测试及原有测试通过。
