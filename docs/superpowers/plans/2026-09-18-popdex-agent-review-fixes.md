# PopDEX Agent Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 PopDEX Agent 合并审查确认的 nonce、生命周期、Dashboard 安全和 `.env` 持久化问题，并用回归测试证明修复。

**Architecture:** 保留现有 executor、Agent service 和无构建步骤的 Dashboard 结构。协议行为在 executor/service 的最窄边界修复；浏览器不可信数据统一通过一个可独立测试的 `DashboardSafety` 脚本；凭据写入改为同目录临时文件加原子 rename。

**Tech Stack:** Node.js 20、TypeScript、node:test、viem、ethers UMD、原生 HTTP/DOM JavaScript。

---

## 文件映射

- 修改 `src/venues/popdex.ts`：Agent 写交易单调毫秒 nonce。
- 修改 `src/popdex/agentService.ts`：统一暂停门禁、撤销条件、公开 exists 状态、重复 env key 处理。
- 修改 `src/envFile.ts`：原子 `.env` 替换。
- 修改 `src/dashboard.ts`：启动期 fail-closed 门禁、DashboardSafety 静态资源、带配置的 POST 校验。
- 修改 `src/dashboardSecurity.ts`：无 Token loopback Host allowlist。
- 修改 `src/loop.ts`：把 PopDEX 是否启用传给 Dashboard。
- 新建 `public/dashboard-safety.js`：HTML 转义和 prepared transaction 意图校验。
- 修改 `public/index.html`：安全渲染错误、加载安全脚本、增加独立清理按钮。
- 修改 `public/popdex-agent.js`：使用完整交易校验和可恢复的撤销/清理状态机。
- 修改 `package.json` 与相关 `test/*.test.ts`：挂载并覆盖新增回归测试。

### Task 1: Agent 写交易使用单调毫秒 nonce

**Files:**
- Modify: `test/popdex-executor-agent.test.ts`
- Modify: `src/venues/popdex.ts:221-270,430-441`

- [ ] **Step 1: 写失败测试**

在 executor 测试的 wallet mock 中记录 nonce，并用固定/回拨时钟连续调用两次 place：

```ts
test("executor sends explicit monotonic millisecond Agent nonces", async () => {
  const sent: any[] = [];
  const nowValues = [1_700_000_000_123, 1_700_000_000_123, 1_699_999_999_000];
  const executor = makeConnectedExecutor({
    now: () => nowValues.shift()!,
    sendTransaction: async (transaction) => {
      sent.push(transaction);
      return HASH;
    },
  });
  await executor.connect();
  await executor.apply([placeOrder(90)]);
  await executor.apply([placeOrder(91)]);
  await executor.apply([placeOrder(92)]);
  assert.deepEqual(sent.map((tx) => tx.nonce), [
    1_700_000_000_123,
    1_700_000_000_124,
    1_700_000_000_125,
  ]);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test --import tsx test/popdex-executor-agent.test.ts`

Expected: FAIL，记录到的 `transaction.nonce` 为 `undefined`。

- [ ] **Step 3: 写最小实现**

给 `PopdexExecutorDeps` 增加 `now?: () => number`，executor 增加：

```ts
private readonly now: () => number;
private lastNonce = -1;

private nextAgentNonce(): number {
  const wallClock = this.now();
  if (!Number.isSafeInteger(wallClock) || wallClock < 0) {
    throw new Error("PopDEX Agent nonce 时钟无效。");
  }
  const nonce = Math.max(wallClock, this.lastNonce + 1);
  if (!Number.isSafeInteger(nonce)) throw new Error("PopDEX Agent nonce 超出安全整数范围。");
  this.lastNonce = nonce;
  return nonce;
}
```

构造函数设置 `this.now = deps.now ?? Date.now`，`sendTransaction` 增加 `nonce: this.nextAgentNonce()`。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test --import tsx test/popdex-executor-agent.test.ts`

Expected: PASS，三笔 nonce 精确为测试中的递增毫秒值。

- [ ] **Step 5: 提交**

```bash
git add src/venues/popdex.ts test/popdex-executor-agent.test.ts
git commit -m "fix: 修正 PopDEX Agent 交易 nonce"
```

### Task 2: 生命周期门禁和撤销语义

**Files:**
- Modify: `test/popdex-agent-service.test.ts`
- Modify: `src/popdex/agentService.ts:20-237`

- [ ] **Step 1: 写三个失败测试**

```ts
test("mutation guard blocks approval preparation before replace", async () => {
  const ctx = service({ canMutate: () => false });
  await assert.rejects(
    ctx.service.prepareApproval({ agentAddress: AGENT, delegator: MAIN, hostname: "grid.example" }),
    /请先暂停/
  );
  assert.deepEqual(ctx.calls, []);
});

test("revoke allows expired and global Agents owned by the main account", async () => {
  for (const info of [activeInfo({ isExpired: true }), activeInfo({ isGlobal: true })]) {
    const ctx = service({ info });
    const prepared = await ctx.service.prepareRevoke({ mainAccount: MAIN, agentAddress: AGENT });
    assert.equal(prepared.from, MAIN);
  }
});

test("revoke rejects a mismatched delegator", async () => {
  const ctx = service({ info: activeInfo({ delegator: OTHER_MAIN }) });
  await assert.rejects(
    ctx.service.prepareRevoke({ mainAccount: MAIN, agentAddress: AGENT }),
    /delegator/
  );
});
```

同时给 status 断言增加 `exists === true`。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test --import tsx test/popdex-agent-service.test.ts`

Expected: approval 未被阻止、expired/global revoke 被拒绝、status 缺少 exists。

- [ ] **Step 3: 写最小实现**

`PublicAgentStatus` 增加 `exists?: boolean`；`inspectAuthorization()` 返回 `exists: info.exists`。`prepareApproval()` 第一行调用 `assertMutationAllowed()`。

把 `prepareRevoke()` 改为只验证撤销所有权：

```ts
this.assertMutationAllowed();
const main = strictAddress(input.mainAccount, "mainAccount");
const agent = strictAddress(input.agentAddress, "agentAddress");
if (main === agent) throw new Error("PopDEX Agent 地址与主账户不能相同。");
const status = await this.inspectAuthorization(main, agent);
if (!status.info.exists) throw new Error("PopDEX Agent 链上不存在，无需撤销。");
if (status.info.delegator !== main) {
  throw new Error(`PopDEX Agent delegator=${status.info.delegator || "null"}，预期 ${main}。`);
}
return { from: main, ...prepareAgentRevocation(agent) };
```

- [ ] **Step 4: 验证 GREEN**

Run: `node --test --import tsx test/popdex-agent-service.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/popdex/agentService.ts test/popdex-agent-service.test.ts
git commit -m "fix: 完善 Agent 暂停门禁与撤销语义"
```

### Task 3: 启动期 Agent 修改 fail closed

**Files:**
- Modify: `test/popdex-agent-api.test.ts`
- Modify: `src/dashboard.ts:199-237`
- Modify: `src/loop.ts:522-523`

- [ ] **Step 1: 写失败测试**

从 `src/dashboard.ts` 导出纯函数并先写期望 API：

```ts
test("live configured PopDEX blocks Agent mutation before snapshot visibility", () => {
  assert.equal(popdexAgentMutationAllowed({
    dryRun: false,
    popdexConfigured: true,
    globallyPaused: false,
    venuePaused: false,
  }), false);
  assert.equal(popdexAgentMutationAllowed({
    dryRun: false,
    popdexConfigured: true,
    globallyPaused: true,
    venuePaused: false,
  }), true);
  assert.equal(popdexAgentMutationAllowed({
    dryRun: true,
    popdexConfigured: true,
    globallyPaused: false,
    venuePaused: false,
  }), true);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test --import tsx test/popdex-agent-api.test.ts`

Expected: FAIL，`popdexAgentMutationAllowed` 尚未导出。

- [ ] **Step 3: 写最小实现**

```ts
export function popdexAgentMutationAllowed(input: {
  dryRun: boolean;
  popdexConfigured: boolean;
  globallyPaused: boolean;
  venuePaused: boolean;
}): boolean {
  return input.dryRun || !input.popdexConfigured || input.globallyPaused || input.venuePaused;
}
```

`DashboardServerOptions` 增加 `popdexConfigured?: boolean`，service 的 `canMutate` 使用上述函数；`loop.ts` 改为：

```ts
const dash = startDashboardServer(cfg.dashboardPort, {
  popdexConfigured: cfg.venues.includes("popdex"),
});
```

- [ ] **Step 4: 验证 GREEN**

Run: `node --test --import tsx test/popdex-agent-api.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dashboard.ts src/loop.ts test/popdex-agent-api.test.ts
git commit -m "fix: 启动期间禁止修改实盘 Agent"
```

### Task 4: 原子写入与重复 env key 清理

**Files:**
- Create: `test/env-file.test.ts`
- Modify: `test/popdex-agent-service.test.ts`
- Modify: `src/envFile.ts`
- Modify: `src/popdex/agentService.ts:35-44`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试**

`test/env-file.test.ts` 使用注入 FS 验证写临时文件后 rename，并模拟临时写失败时目标内容不变：

```ts
test("writeEnvFile atomically renames a same-directory temporary file", () => {
  const calls: string[] = [];
  const fake = {
    existsSync: () => true,
    readFileSync: () => "OLD=yes\n",
    writeFileSync: (file: string) => calls.push(`write:${file}`),
    chmodSync: (file: string) => calls.push(`chmod:${file}`),
    renameSync: (from: string, to: string) => calls.push(`rename:${from}->${to}`),
    unlinkSync: (file: string) => calls.push(`unlink:${file}`),
  };
  writeEnvFile("C:/app/.env", "NEW=yes\n", { fsImpl: fake as any, platform: "linux" });
  assert.match(calls[0]!, /^write:C:\/app\/\.env\.tmp-/);
  assert.match(calls.at(-1)!, /rename:.*->C:\/app\/\.env$/);
});
```

service 测试设置：

```ts
fsImpl.content = `POPDEX_AGENT_PRIVATE_KEY=${AGENT_KEY}\n# POPDEX_AGENT_PRIVATE_KEY=old\nPOPDEX_AGENT_PRIVATE_KEY=stale\n`;
await revoked.service.clear();
assert.equal((fsImpl.content.match(/^# POPDEX_AGENT_PRIVATE_KEY=$/gm) || []).length, 1);
assert.doesNotMatch(fsImpl.content, /^POPDEX_AGENT_PRIVATE_KEY=/m);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test --import tsx test/env-file.test.ts test/popdex-agent-service.test.ts`

Expected: `renameSync` 未调用，重复活动 key 仍存在。

- [ ] **Step 3: 写最小实现**

扩展 `EnvFileSystem` 为 `writeFileSync | chmodSync | renameSync | unlinkSync | existsSync | readFileSync`。写入逻辑：

```ts
const tempFile = `${envFile}.tmp-${process.pid}-${Date.now()}`;
try {
  fsImpl.writeFileSync(tempFile, content, { encoding: "utf8", mode: 0o600 });
  if (platform !== "win32") fsImpl.chmodSync(tempFile, 0o600);
  fsImpl.renameSync(tempFile, envFile);
  if (platform !== "win32") fsImpl.chmodSync(envFile, 0o600);
} catch (error) {
  try {
    if (fsImpl.existsSync(tempFile)) fsImpl.unlinkSync(tempFile);
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "写入 .env 失败且临时文件清理失败");
  }
  throw error;
}
```

`setEnvLine` 按行过滤所有匹配项后追加唯一行，不使用非全局 `String.replace`。

更新测试 MemoryFs，使 temp write 只修改临时映射，`renameSync` 时才替换 `content`；更新 `package.json` 把 `test/env-file.test.ts` 加入 test script。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test --import tsx test/env-file.test.ts test/popdex-agent-service.test.ts`

Expected: PASS，并且失败测试证明原目标内容未变。

- [ ] **Step 5: 提交**

```bash
git add src/envFile.ts src/popdex/agentService.ts test/env-file.test.ts test/popdex-agent-service.test.ts package.json
git commit -m "fix: 原子保存并彻底清理 Agent 配置"
```

### Task 5: 阻断 loopback DNS rebinding

**Files:**
- Modify: `test/dashboard-security.test.ts`
- Modify: `src/dashboardSecurity.ts:87-112`
- Modify: `src/dashboard.ts:240-248`

- [ ] **Step 1: 写失败测试**

```ts
test("loopback mode rejects rebinding hosts", () => {
  const loopback = dashboardSecurityConfig({});
  const headers = {
    host: "rebind.example:8088",
    origin: "http://rebind.example:8088",
    "content-type": "application/json",
    "x-grid-request": "1",
  };
  assert.throws(
    () => validateMutationRequest(request(headers), loopback),
    (error: HttpRequestError) => error.statusCode === 403 && /Host/.test(error.message)
  );
  for (const host of ["localhost:8088", "127.0.0.1:8088", "[::1]:8088"]) {
    assert.doesNotThrow(() => validateMutationRequest(request({
      ...headers,
      host,
      origin: `http://${host}`,
    }), loopback));
  }
});
```

保留 Token 模式下自定义部署域名同源请求可通过的控制测试。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test --import tsx test/dashboard-security.test.ts`

Expected: FAIL，当前 `rebind.example` 可通过。

- [ ] **Step 3: 写最小实现**

`validateMutationRequest(req, config)` 在同源比较后增加：

```ts
if (!config.authRequired) {
  const hostname = origin.hostname.toLowerCase();
  if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(hostname)) {
    throw new HttpRequestError(403, "无 Token 模式只允许 loopback Host");
  }
}
```

Dashboard 调用点传入 `security`。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test --import tsx test/dashboard-security.test.ts test/popdex-agent-api.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dashboardSecurity.ts src/dashboard.ts test/dashboard-security.test.ts test/popdex-agent-api.test.ts
git commit -m "fix: 阻断 Dashboard DNS 重绑定请求"
```

### Task 6: 浏览器安全边界与 DOM XSS

**Files:**
- Create: `public/dashboard-safety.js`
- Create: `test/dashboard-safety.test.ts`
- Modify: `src/dashboard.ts`
- Modify: `public/index.html`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试**

用 `node:vm` 加载尚不存在的浏览器 helper，验证恶意文本：

```ts
test("escapeHtml renders venue errors as text", () => {
  const safety = loadDashboardSafety();
  assert.equal(
    safety.escapeHtml(`<img src=x onerror="steal()">&'`),
    "&lt;img src=x onerror=&quot;steal()&quot;&gt;&amp;&#39;"
  );
});
```

并断言 HTML 中错误单元调用 `DashboardSafety.escapeHtml(...)`，且 `/dashboard-safety.js` 在 Agent 脚本前加载。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test --import tsx test/dashboard-safety.test.ts`

Expected: FAIL，文件或 helper 不存在。

- [ ] **Step 3: 写最小实现**

`public/dashboard-safety.js` 使用 IIFE 暴露：

```js
(() => {
  "use strict";
  const HTML = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => HTML[char]);
  }
  window.DashboardSafety = Object.freeze({ escapeHtml });
})();
```

`index.html` 的 `v.lastError` 改为 `DashboardSafety.escapeHtml(v.lastError)`。Dashboard 增加静态资源路由并设置 `nosniff`；test script 加入新测试。

- [ ] **Step 4: 验证 GREEN 和恶意控制**

Run: `node --test --import tsx test/dashboard-safety.test.ts test/popdex-agent-ui.test.ts`

Expected: PASS；恶意 `<img onerror>` 只生成转义文本。

- [ ] **Step 5: 提交**

```bash
git add public/dashboard-safety.js public/index.html src/dashboard.ts test/dashboard-safety.test.ts test/popdex-agent-ui.test.ts package.json
git commit -m "fix: 安全渲染 Dashboard 外部错误"
```

### Task 7: 完整绑定主钱包 prepared transaction

**Files:**
- Modify: `public/dashboard-safety.js`
- Modify: `test/dashboard-safety.test.ts`
- Modify: `public/popdex-agent.js:138-170,173-205,247-264`

- [ ] **Step 1: 写合法与篡改交易失败测试**

测试从真实 `prepareAgentAuthorization` / `prepareAgentRevocation` 取得 calldata，再调用浏览器 guard：

```ts
const valid = safety.checkedAgentTransaction(ethers, { from: MAIN, ...prepared }, MAIN, {
  kind: "authorize",
  agentAddress: AGENT,
  delegator: MAIN,
  hostname: "grid.example",
}, NOW);
assert.equal(valid.to, POPDEX_ACCOUNT_PRECOMPILE);

for (const mutated of [
  { ...prepared, to: OTHER_MAIN },
  { ...prepared, value: "0x1" },
  { ...prepared, gasPrice: "0x1" },
  { ...prepared, data: revokeOtherAgentData },
]) {
  assert.throws(() => safety.checkedAgentTransaction(
    ethers, { from: MAIN, ...mutated }, MAIN, authorizeIntent, NOW
  ), /交易参数/);
}
```

另测 revoke 只接受当前状态 Agent，approve 拒绝 `isGlobal=true`、错误 delegator/name/new Agent 和超出五分钟容差的 initialNonce/expiry。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test --import tsx test/dashboard-safety.test.ts`

Expected: FAIL，`checkedAgentTransaction` 不存在。

- [ ] **Step 3: 写最小实现**

在 `DashboardSafety` 内定义固定 precompile 和 ABI，通过 `new ethers.Interface(ABI).parseTransaction({ data })` 解码。公共字段必须精确等于：

```js
const EXPECTED = {
  to: "0x0000000000000000000000000000000000001008",
  value: "0x0",
  chainId: "0x888",
  type: "0x0",
  gas: "0x0",
  gasPrice: "0x0",
};
```

authorize 意图只接受 approve/replace；approve 校验 agent、delegator、bytes32 hostname name 和 `isGlobal=false`，replace 校验 new Agent 且 old/new 不同。两者的 `initialNonce` 必须在 `floor(nowMs/1000) ± 300`，`expiresAt` 必须在 `nowMs + 30 days ± 300000`。revoke 只接受 revokeAgent 且目标完全匹配。

返回对象只复制 EXPECTED 七个交易字段和规范化 from，不透传未知属性。

`popdex-agent.js` 删除旧 `checkedTransaction`，授权时传 authorize intent，撤销时传 revoke intent。

- [ ] **Step 4: 验证 GREEN 和替代恶意输入**

Run: `node --test --import tsx test/dashboard-safety.test.ts test/popdex-agent-ui.test.ts`

Expected: 合法 approve/replace/revoke 通过；任意 to/value/selector/关键参数篡改均在钱包调用前抛错。

- [ ] **Step 5: 提交**

```bash
git add public/dashboard-safety.js public/popdex-agent.js test/dashboard-safety.test.ts test/popdex-agent-ui.test.ts
git commit -m "fix: 绑定主钱包 Agent 交易意图"
```

### Task 8: 撤销与本地清理可独立恢复

**Files:**
- Modify: `public/index.html:338-355`
- Modify: `public/popdex-agent.js:53-70,228-281`
- Modify: `test/popdex-agent-ui.test.ts`
- Modify: `test/popdex-agent-api.test.ts`

- [ ] **Step 1: 写失败测试**

扩展 UI 静态契约：

```ts
assert.match(html, /id=["']popdex-agent-clear["']/);
assert.match(script, /status\.configured\s*&&\s*status\.exists/);
assert.match(script, /status\.configured\s*&&\s*status\.exists\s*===\s*false/);
assert.match(script, /async function clearLocalAgent/);
```

API fake status 返回 `exists`，确保序列化结果保留该字段。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts test/popdex-agent-api.test.ts`

Expected: FAIL，清理按钮和 exists 状态机不存在。

- [ ] **Step 3: 写最小实现**

新增按钮：

```html
<button type="button" id="popdex-agent-clear" class="danger" disabled>仅清除已撤销的本地私钥</button>
```

`renderStatus` 规则：revoke 在 `configured && exists` 时启用；clear 在 `configured && exists === false` 时启用。`waitUntilRevoked` 只以 `exists === false` 成功。`revokeAgent` 不再要求 `authorized`，只要求 configured/exists/main/agent。

新增：

```js
async function clearLocalAgent() {
  const status = await refresh();
  if (!status?.configured || status.exists !== false) {
    throw new Error("只有链上已不存在的 Agent 才能清除本地私钥。");
  }
  await clearAgent();
  resetGeneratedAgentState("已清除本地 Agent 私钥");
  await refresh();
}
```

撤销成功后调用同一清理函数；清理失败时保留可重试状态。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts test/popdex-agent-api.test.ts test/popdex-agent-service.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/popdex-agent.js test/popdex-agent-ui.test.ts test/popdex-agent-api.test.ts
git commit -m "fix: 支持 Agent 撤销后重试本地清理"
```

### Task 9: 全量验证与文档同步

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`

- [ ] **Step 1: 更新操作说明**

README 明确：所有授权、替换、撤销、保存、清理都必须先暂停；撤销成功但清理失败时使用独立清理按钮。SECURITY 说明无 Token 模式只接受 loopback Host，远程模式仍必须使用 TLS/SSH/Tailscale。

- [ ] **Step 2: 运行定向测试**

Run:

```bash
node --test --import tsx test/popdex-executor-agent.test.ts
node --test --import tsx test/popdex-agent-service.test.ts test/env-file.test.ts
node --test --import tsx test/dashboard-security.test.ts test/dashboard-safety.test.ts
node --test --import tsx test/popdex-agent-api.test.ts test/popdex-agent-ui.test.ts
```

Expected: 全部 PASS，无未处理 rejection 或警告。

- [ ] **Step 3: 运行完整测试**

Run: `npm test`

Expected: 原 36 项加新增回归测试全部通过。

- [ ] **Step 4: 运行类型检查并区分基线**

Run: `npx tsc --noEmit`

Expected: 本次修改文件无新增 TypeScript 错误；若仓库既有错误仍存在，保存精确输出并与 `origin/main` 的同命令比较。

- [ ] **Step 5: 检查补丁范围**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
```

Expected: 无空白错误、无临时验证文件、只有设计/计划、目标代码、测试和必要文档。

- [ ] **Step 6: 提交文档和最终调整**

```bash
git add README.md SECURITY.md
git commit -m "docs: 更新 PopDEX Agent 安全操作说明"
```

若 README/SECURITY 已准确覆盖且无需变更，则跳过此提交，不创建空提交。

- [ ] **Step 7: 最终安全复核**

按 `codex-security:fix-finding` 再检查一条等价 XSS 载荷、一条 prepared transaction 参数篡改、合法 approve/revoke 控制路径，以及所有改动 helper 的直接调用方。确认原问题不能复现且正常工作流保持后，才报告 `fixed`。
