# PopDEX Agent Async State Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve an Agent private key after its transaction may have been submitted and serialize all browser Agent lifecycle operations.

**Architecture:** Extend the existing browser-memory state with a sticky `authorizationSubmitted` flag and a page-local `operationInProgress` mutex. Keep the existing VM test harness, adding controllable async wallet/API boundaries so the exact race paths fail before the production fix and pass afterward.

**Tech Stack:** Browser JavaScript, Node.js `node:test`, `node:vm`, TypeScript tests executed through `tsx`.

---

### Task 1: Extend the VM harness with controllable async boundaries

**Files:**
- Modify: `test/popdex-agent-ui.test.ts`

- [ ] **Step 1: Add a reusable deferred promise helper**

```ts
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

- [ ] **Step 2: Extend `loadAgentPage` options**

Replace its options type with:

```ts
options: {
  status?: Record<string, unknown>;
  confirmations?: boolean[];
  waitForTransaction?: () => Promise<{ status: number }>;
  verifyError?: Error;
  saveAgent?: () => Promise<unknown>;
  sendError?: Error;
  onTransactionSubmitted?: () => void;
  onSaveStarted?: () => void;
} = {}
```

Update the fake endpoints and wallet boundaries:

```ts
if (url === "/api/popdex/agent/verify") {
  if (options.verifyError) throw options.verifyError;
  return jsonResponse({ verified: true });
}
if (url === "/api/popdex/agent/save") {
  options.onSaveStarted?.();
  return jsonResponse(options.saveAgent ? await options.saveAgent() : { saved: true });
}
```

```ts
BrowserProvider: class {
  async waitForTransaction() {
    return options.waitForTransaction
      ? options.waitForTransaction()
      : { status: 1 };
  }
},
```

```ts
if (method === "eth_sendTransaction") {
  if (options.sendError) throw options.sendError;
  configuredStatus = { ...configuredStatus, exists: false, authorized: false };
  options.onTransactionSubmitted?.();
  return "0xtx";
}
```

- [ ] **Step 3: Run the existing UI tests**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: all 8 existing UI tests pass.

- [ ] **Step 4: Commit the harness extension**

```bash
git add test/popdex-agent-ui.test.ts
git commit -m "test: 支持 Agent 异步状态复现"
```

### Task 2: Preserve a draft after transaction submission

**Files:**
- Modify: `test/popdex-agent-ui.test.ts`
- Modify: `public/popdex-agent.js:6-10,89-109,151-210,212-230,252-261`

- [ ] **Step 1: Add failing tests for confirmed and uncertain transactions**

```ts
test("verification failure after transaction submission keeps the draft non-discardable", async () => {
  const page = await loadAgentPage({
    confirmations: [true, true],
    verifyError: new Error("verify failed"),
  });
  await page.click("popdex-agent-generate");
  const privateKey = page.elements.get("popdex-agent-private")?.textContent;
  await page.click("popdex-agent-authorize");
  await page.click("popdex-agent-generate");
  assert.equal(page.walletCount(), 1);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, privateKey);
});

test("transaction submission locks the draft before receipt confirmation", async () => {
  const receipt = deferred<{ status: number }>();
  const submitted = deferred<void>();
  const page = await loadAgentPage({
    confirmations: [true, true],
    waitForTransaction: () => receipt.promise,
    onTransactionSubmitted: () => submitted.resolve(),
  });
  await page.click("popdex-agent-generate");
  const privateKey = page.elements.get("popdex-agent-private")?.textContent;
  const authorizing = page.click("popdex-agent-authorize");
  await submitted.promise;
  await page.click("popdex-agent-generate");
  assert.equal(page.walletCount(), 1);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, privateKey);
  receipt.resolve({ status: 1 });
  await authorizing;
});

test("wallet rejection before a transaction hash leaves the draft replaceable", async () => {
  const page = await loadAgentPage({
    confirmations: [true, true],
    sendError: new Error("wallet rejected"),
  });
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");
  await page.click("popdex-agent-generate");
  assert.equal(page.walletCount(), 2);
});
```

- [ ] **Step 2: Run the UI tests and verify RED**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: the first two new tests fail because generation is allowed when `authorizationVerified` is still false; the wallet-rejection boundary test passes.

- [ ] **Step 3: Record submission immediately after the wallet returns a hash**

Add state:

```js
let authorizationSubmitted = false;
```

Strengthen generation and reset transitions:

```js
if (authorizationSubmitted || authorizationVerified) {
  throw new Error("当前 Agent 的链上授权交易已提交，请保留并保存该私钥。");
}
```

Set `authorizationSubmitted = false` when a new wallet is created, after a successful save, and inside `resetAgentState()`.

Change transaction submission to expose the hash before waiting:

```js
async function sendAndConfirm(transaction, onSubmitted = null) {
  const transactionHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [transaction],
  });
  if (onSubmitted) onSubmitted(transactionHash);
  const provider = new ethers.BrowserProvider(window.ethereum);
  const receipt = await provider.waitForTransaction(transactionHash, 1, RECEIPT_TIMEOUT_MS);
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`PopDEX Agent 链上交易未成功确认：${transactionHash}`);
  }
  return transactionHash;
}
```

Pass a callback only for authorization:

```js
transactionHash = await sendAndConfirm(checked.transaction, (submittedHash) => {
  transactionHash = submittedHash;
  authorizationSubmitted = true;
});
```

- [ ] **Step 4: Run the UI tests and verify GREEN**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: all UI tests pass.

- [ ] **Step 5: Commit the submitted-transaction protection**

```bash
git add test/popdex-agent-ui.test.ts public/popdex-agent.js
git commit -m "fix: 保留已提交授权交易的 Agent 私钥"
```

### Task 3: Serialize Agent lifecycle operations

**Files:**
- Modify: `test/popdex-agent-ui.test.ts`
- Modify: `public/popdex-agent.js:10-76,321-364`

- [ ] **Step 1: Add a failing save/clear interleaving test**

First extend `verification failure after transaction submission keeps the draft non-discardable` with final button-state assertions:

```ts
assert.equal(page.elements.get("popdex-agent-generate")?.disabled, true);
assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, true);
```

Then add the concurrency test:

```ts
test("clear cannot enter while Agent save is in progress", async () => {
  const save = deferred<unknown>();
  const saveStarted = deferred<void>();
  const page = await loadAgentPage({
    status: {
      configured: true,
      exists: false,
      authorized: false,
      mainAccount: "0x1000000000000000000000000000000000000001",
      agentAddress: "0x2000000000000000000000000000000000000002",
    },
    confirmations: [true, true, true],
    saveAgent: () => save.promise,
    onSaveStarted: () => saveStarted.resolve(),
  });
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");
  const saving = page.click("popdex-agent-save");
  await saveStarted.promise;
  await page.click("popdex-agent-clear");
  assert.equal(
    page.requests.filter((request) => request === "POST /api/popdex/agent/clear").length,
    0
  );
  save.resolve({ saved: true });
  await saving;
});
```

- [ ] **Step 2: Run the UI tests and verify RED**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: the concurrency test fails because `run()` disables only the save button and the clear request enters concurrently; the button-state assertions also fail because the old `finally` branch re-enables Generate.

- [ ] **Step 3: Add one operation mutex and one button-state synchronizer**

Add state and button ids:

```js
let operationInProgress = false;
const ACTION_IDS = [
  "popdex-agent-generate",
  "popdex-agent-copy",
  "popdex-agent-authorize",
  "popdex-agent-save",
  "popdex-agent-refresh",
  "popdex-agent-revoke",
  "popdex-agent-clear",
];
```

Add the synchronizer and call it from `renderStatus()` after assigning `configuredStatus`:

```js
function syncActionButtons() {
  if (operationInProgress) {
    for (const id of ACTION_IDS) byId(id).disabled = true;
    return;
  }
  byId("popdex-agent-generate").disabled =
    authorizationSubmitted || authorizationVerified;
  byId("popdex-agent-copy").disabled = !generatedPrivateKey;
  byId("popdex-agent-authorize").disabled =
    !generatedPrivateKey || authorizationSubmitted || authorizationVerified;
  byId("popdex-agent-save").disabled =
    !generatedPrivateKey || !authorizationVerified;
  byId("popdex-agent-refresh").disabled = false;
  byId("popdex-agent-revoke").disabled = !(
    configuredStatus && configuredStatus.configured && configuredStatus.exists
  );
  byId("popdex-agent-clear").disabled = !(
    configuredStatus && configuredStatus.configured && configuredStatus.exists === false
  );
}
```

Replace `run()` with:

```js
function run(button, action) {
  return async () => {
    if (operationInProgress) {
      setStatus("另一项 Agent 操作正在进行中，请等待完成。", "down");
      return;
    }
    operationInProgress = true;
    syncActionButtons();
    try {
      await action();
    } catch (error) {
      setStatus(errorMessage(error), "down");
    } finally {
      operationInProgress = false;
      syncActionButtons();
    }
  };
}
```

Remove the old per-button `finally` branches. Keep the existing action implementations; their temporary button assignments are overwritten by the synchronizer at the operation boundary.

- [ ] **Step 4: Run the UI tests and verify GREEN**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: all UI tests pass, including authorization-in-flight generation and save/clear interleaving.

- [ ] **Step 5: Commit the operation mutex**

```bash
git add test/popdex-agent-ui.test.ts public/popdex-agent.js
git commit -m "fix: 串行化 Agent 生命周期操作"
```

### Task 4: Full verification

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run TypeScript diagnostics**

Run: `npx tsc --noEmit`

Expected: no diagnostics in `public/popdex-agent.js` or `test/popdex-agent-ui.test.ts`; report the unchanged baseline diagnostics in `src/officialStats.ts` and legacy venue files separately.

- [ ] **Step 3: Inspect the final branch**

Run: `git diff HEAD~3..HEAD --check`

Expected: exit code 0 with no whitespace errors.

Run: `git status --short`

Expected: no uncommitted files.

- [ ] **Step 4: Re-read acceptance criteria**

Confirm every requirement in `docs/superpowers/specs/2026-09-19-popdex-agent-async-state-design.md` is covered by a passing VM state test or an explicitly documented external limitation.
