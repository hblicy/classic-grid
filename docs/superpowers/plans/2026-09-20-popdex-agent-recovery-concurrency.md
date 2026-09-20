# PopDEX Agent Recovery and Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已提交授权交易的 Agent 草稿能够安全重试验证并保存，同时防止多标签页/API 并发清除刚保存的新 Agent 私钥。

**Architecture:** 浏览器端复用现有“验证并保存”动作：交易哈希返回后记住主账户，并允许 save API 重新执行权威链上回验；不增加按钮、不重发授权交易。服务端在单个 `PopdexAgentService` 实例内用 FIFO 队列串行化 `save()`/`clear()`，并在清除前对当前私钥做一致性检查。

**Tech Stack:** TypeScript、Node.js test runner、浏览器原生 JavaScript、VM DOM 测试、viem、原子 `.env` 写入

---

## 文件结构

- `test/popdex-agent-ui.test.ts`：扩展浏览器测试夹具并覆盖回验失败后的保存恢复路径。
- `public/popdex-agent.js`：记录已提交交易对应的主账户，并从 submitted 状态开放“验证并保存”。
- `test/popdex-agent-service.test.ts`：用可控 RPC 延迟复现跨请求 save/clear 交错及配置变化。
- `src/popdex/agentService.ts`：为身份配置写操作增加实例级 FIFO 串行化和清除前一致性检查。

### Task 1: 恢复已提交授权草稿的保存路径

**Files:**
- Modify: `test/popdex-agent-ui.test.ts`
- Modify: `public/popdex-agent.js:32-43, 226-261`

- [ ] **Step 1: 扩展 UI 测试夹具以记录交易发送次数**

在 `loadAgentPage()` 内新增计数器，在 `eth_sendTransaction` 分支递增，并从返回对象暴露：

```ts
let transactionCount = 0;

// eth_sendTransaction 分支
transactionCount += 1;

// loadAgentPage 返回值
transactionCount: () => transactionCount,
```

- [ ] **Step 2: 写入“回验失败后可直接重试保存”失败测试**

```ts
test("submitted authorization can be verified and saved without resending", async () => {
  const page = await loadAgentPage({
    confirmations: [true, true],
    verifyError: new Error("verify failed"),
  });
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");

  assert.equal(page.elements.get("popdex-agent-save")?.disabled, false);
  assert.equal(page.transactionCount(), 1);
  await page.click("popdex-agent-save");

  assert.ok(page.requests.includes("POST /api/popdex/agent/save"));
  assert.equal(page.transactionCount(), 1);
  assert.equal(
    page.elements.get("popdex-agent-private")?.textContent,
    "私钥已保存；请重启进程后生效"
  );
});
```

- [ ] **Step 3: 运行测试并确认按正确原因失败**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: 新测试失败，`popdex-agent-save.disabled` 实际为 `true`；既有测试继续通过。

- [ ] **Step 4: 在交易提交边界保存主账户**

```js
transactionHash = await sendAndConfirm(checked.transaction, (submittedHash) => {
  transactionHash = submittedHash;
  connectedMainAccount = mainAccount;
  authorizationSubmitted = true;
});
```

- [ ] **Step 5: 允许 submitted 草稿调用权威 save API**

按钮条件改为：

```js
byId("popdex-agent-save").disabled =
  !generatedPrivateKey ||
  !connectedMainAccount ||
  (!authorizationSubmitted && !authorizationVerified);
```

`persistAgent()` 前置条件改为：

```js
if (
  (!authorizationSubmitted && !authorizationVerified) ||
  !generatedPrivateKey ||
  !connectedMainAccount
) {
  throw new Error("Agent 授权交易尚未提交，拒绝保存。");
}
```

保持 `saveAgent()` 调用不变；服务端仍在写盘前做精确链上回验。

- [ ] **Step 6: 运行 UI 定向测试并确认通过**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: 13 个 UI 测试全部通过，恢复流程只发送一次交易。

- [ ] **Step 7: 提交浏览器端修复**

```powershell
git add test/popdex-agent-ui.test.ts public/popdex-agent.js
git commit -m "fix: 允许重试保存已提交的 Agent"
```

### Task 2: 串行化服务端身份写操作

**Files:**
- Modify: `test/popdex-agent-service.test.ts`
- Modify: `src/popdex/agentService.ts:75-99, 184-196, 222-236`

- [ ] **Step 1: 为服务测试增加可控异步 RPC 夹具**

增加第二个 Agent 和 deferred helper：

```ts
const NEW_AGENT_KEY = `0x${"22".repeat(32)}`;
const NEW_AGENT = deriveAgentAddress(NEW_AGENT_KEY);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
```

扩展 `service()` 参数并修改 RPC 夹具：

```ts
getAgentInfo?: (agent: string) => AgentInfo | Promise<AgentInfo>;

async getAgentInfo(agent: string) {
  calls.push(`info:${agent}`);
  return options.getAgentInfo ? options.getAgentInfo(agent) : info;
},
```

- [ ] **Step 2: 写入 save/clear 交错的失败测试**

```ts
test("concurrent clear cannot remove a newly saved Agent key", async () => {
  const oldLookupStarted = deferred<void>();
  const releaseOldLookup = deferred<void>();
  const ctx = service({
    processEnv: configuredEnv(),
    getAgentInfo: async (agent) => {
      if (agent === AGENT) {
        oldLookupStarted.resolve();
        await releaseOldLookup.promise;
        return activeInfo({ exists: false, delegator: null, expiresAt: "0" });
      }
      assert.equal(agent, NEW_AGENT);
      return activeInfo();
    },
  });

  const clearing = ctx.service.clear();
  await oldLookupStarted.promise;
  let saveSettled = false;
  const saving = ctx.service
    .save({ mainAccount: MAIN, agentPrivateKey: NEW_AGENT_KEY })
    .then(() => { saveSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saveSettled, false);

  releaseOldLookup.resolve();
  await Promise.all([clearing, saving]);
  assert.equal(ctx.processEnv.POPDEX_AGENT_PRIVATE_KEY, NEW_AGENT_KEY);
  assert.match(
    ctx.fsImpl.content,
    new RegExp(`^POPDEX_AGENT_PRIVATE_KEY=${NEW_AGENT_KEY}$`, "m")
  );
});
```

- [ ] **Step 3: 写入清除前一致性检查的失败测试**

```ts
test("clear refuses to erase an Agent key changed during revocation verification", async () => {
  const lookupStarted = deferred<void>();
  const releaseLookup = deferred<void>();
  const processEnv = configuredEnv();
  const ctx = service({
    processEnv,
    getAgentInfo: async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return activeInfo({ exists: false, delegator: null, expiresAt: "0" });
    },
  });

  const clearing = ctx.service.clear();
  await lookupStarted.promise;
  processEnv.POPDEX_AGENT_PRIVATE_KEY = NEW_AGENT_KEY;
  releaseLookup.resolve();

  await assert.rejects(clearing, /配置已变化.*拒绝清除/);
  assert.equal(processEnv.POPDEX_AGENT_PRIVATE_KEY, NEW_AGENT_KEY);
  assert.equal(ctx.fsImpl.writes.length, 0);
});
```

- [ ] **Step 4: 写入“失败后释放队列”的失败测试**

```ts
test("failed identity write releases the queue for the next save", async () => {
  const firstLookupStarted = deferred<void>();
  const releaseFirstLookup = deferred<void>();
  let attempts = 0;
  let secondLookupStarted = false;
  const ctx = service({
    getAgentInfo: async () => {
      attempts += 1;
      if (attempts === 1) {
        firstLookupStarted.resolve();
        await releaseFirstLookup.promise;
        throw new Error("rpc unavailable");
      }
      secondLookupStarted = true;
      return activeInfo();
    },
  });

  const first = ctx.service.save({ mainAccount: MAIN, agentPrivateKey: AGENT_KEY });
  await firstLookupStarted.promise;
  const second = ctx.service.save({ mainAccount: MAIN, agentPrivateKey: NEW_AGENT_KEY });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondLookupStarted, false);

  releaseFirstLookup.resolve();
  await assert.rejects(first, /rpc unavailable/);
  await second;
  assert.equal(ctx.processEnv.POPDEX_AGENT_PRIVATE_KEY, NEW_AGENT_KEY);
});
```

- [ ] **Step 5: 运行服务测试并确认按正确原因失败**

Run: `node --test --import tsx test/popdex-agent-service.test.ts`

Expected: 两个并发测试显示后续写入未被队列阻塞；一致性测试显示旧 clear 删除了新值。

- [ ] **Step 6: 增加 FIFO 身份写队列**

```ts
private identityWriteTail: Promise<void> = Promise.resolve();

private async withIdentityWrite<T>(operation: () => Promise<T>): Promise<T> {
  const previous = this.identityWriteTail;
  let release!: () => void;
  this.identityWriteTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
```

- [ ] **Step 7: 将 save 与 clear 的完整工作放入队列**

`save()` 使用以下结构：

```ts
async save(input: {
  mainAccount: string;
  agentPrivateKey: string;
}): Promise<PublicAgentStatus> {
  return this.withIdentityWrite(async () => {
    this.assertMutationAllowed();
    const main = strictAddress(input.mainAccount, "mainAccount");
    const agentAddress = deriveAgentAddress(input.agentPrivateKey);
    const status = await this.verifyAuthorization({ mainAccount: main, agentAddress });
    this.writeSettings({
      [MAIN_ACCOUNT_KEY]: main,
      [AGENT_PRIVATE_KEY]: input.agentPrivateKey,
    });
    return status;
  });
}
```

`clear()` 在同样的 `withIdentityWrite(async () => { ... })` 中执行原有逻辑，并在 `writeSettings()` 前增加：

```ts
if ((this.processEnv[AGENT_PRIVATE_KEY] || "") !== privateKey) {
  throw new Error("PopDEX Agent 配置已变化，拒绝清除当前私钥。");
}
```

- [ ] **Step 8: 运行服务定向测试并确认通过**

Run: `node --test --import tsx test/popdex-agent-service.test.ts`

Expected: 现有 11 个测试及新增 3 个并发测试全部通过。

- [ ] **Step 9: 提交服务端修复**

```powershell
git add test/popdex-agent-service.test.ts src/popdex/agentService.ts
git commit -m "fix: 串行化 Agent 身份配置写入"
```

### Task 3: 全量验证与差异审查

**Files:**
- Verify: `public/popdex-agent.js`
- Verify: `src/popdex/agentService.ts`
- Verify: `test/popdex-agent-ui.test.ts`
- Verify: `test/popdex-agent-service.test.ts`

- [ ] **Step 1: 运行两个定向测试文件**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts test/popdex-agent-service.test.ts`

Expected: 全部通过，0 failures。

- [ ] **Step 2: 运行完整测试套件**

Run: `npm test`

Expected: 在现有 62 个测试基础上新增 4 个，共 66 个测试全部通过。

- [ ] **Step 3: 检查浏览器脚本语法**

Run: `node --check public/popdex-agent.js`

Expected: exit code 0，无输出。

- [ ] **Step 4: 运行 TypeScript 检查并对比基线**

Run: `npx tsc --noEmit`

Expected: 仍只报告修复前已存在的 25 条错误，位置限于未修改的 `src/officialStats.ts` 与旧 venue 文件；`agentService.ts` 和两个测试文件不得出现新错误。

- [ ] **Step 5: 检查差异与工作树**

```powershell
git diff --check 1dda08d..HEAD
git status --short --branch
git log --oneline -5
```

Expected: diff check exit code 0；工作树无未提交文件；日志包含两个中文修复提交。

- [ ] **Step 6: 对照设计验收**

- submitted 草稿可以调用 save API 重试权威回验；
- 重试不会再次调用 `eth_sendTransaction`；
- 保存失败保留草稿；
- 单服务实例上的 save/clear 不交错；
- clear 写入前发现私钥变化时拒绝清除；
- 队列在失败后正常释放；
- API、calldata、页面结构和依赖均未改变。
