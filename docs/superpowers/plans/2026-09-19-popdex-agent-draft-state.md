# PopDEX Agent Draft State Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repeated generation and configured-Agent cleanup from discarding an in-memory PopDEX Agent private key without the required user decision.

**Architecture:** Keep configured backend state and browser-only draft state independent. Exercise the real browser script in a Node VM with minimal DOM, fetch, wallet, and ethers fakes so regressions are verified through the same button handlers used by the page.

**Tech Stack:** Browser JavaScript, Node.js `node:test`, `node:vm`, TypeScript test runner via `tsx`.

---

### Task 1: Build an executable browser-state test harness

**Files:**
- Modify: `test/popdex-agent-ui.test.ts`

- [ ] **Step 1: Add a VM harness around the real browser script**

Add `node:vm`, load `public/popdex-agent.js` once per test, and provide real button callbacks instead of matching source text only. The helper must return the element map, wallet creation count, request log, mutable configured status, confirmation queue, and an async `click(id)` function.

```ts
import vm from "node:vm";

type FakeElement = {
  id: string;
  textContent: string;
  className: string;
  disabled: boolean;
  listener?: () => Promise<void>;
  addEventListener: (name: string, listener: () => Promise<void>) => void;
};

async function loadAgentPage(options: {
  status?: Record<string, unknown>;
  confirmations?: boolean[];
} = {}) {
  const ids = [
    "popdex-agent-status", "popdex-agent-main", "popdex-agent-address",
    "popdex-agent-private", "popdex-agent-generate", "popdex-agent-copy",
    "popdex-agent-authorize", "popdex-agent-save", "popdex-agent-refresh",
    "popdex-agent-revoke", "popdex-agent-clear",
  ];
  const elements = new Map<string, FakeElement>();
  for (const id of ids) {
    const element: FakeElement = {
      id, textContent: "", className: "", disabled: false,
      addEventListener(name, listener) {
        assert.equal(name, "click");
        element.listener = listener;
      },
    };
    elements.set(id, element);
  }

  let configuredStatus = options.status ?? {
    configured: false, exists: false, authorized: false,
    mainAccount: null, agentAddress: null,
  };
  let walletCount = 0;
  const requests: string[] = [];
  const confirmations = [...(options.confirmations ?? [])];
  const wallets = [
    { privateKey: "0xkey1", address: "0x3000000000000000000000000000000000000003" },
    { privateKey: "0xkey2", address: "0x4000000000000000000000000000000000000004" },
  ];
  const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  const context = {
    document: { getElementById: (id: string) => elements.get(id) },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async (url: string, init?: { method?: string }) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/popdex/agent/status") return jsonResponse(configuredStatus);
      if (url === "/api/popdex/agent/clear") {
        configuredStatus = {
          configured: false, exists: false, authorized: false,
          mainAccount: null, agentAddress: null,
        };
        return jsonResponse({ cleared: true });
      }
      if (url === "/api/popdex/agent/prepare-approval") return jsonResponse({});
      if (url === "/api/popdex/agent/prepare-revoke") return jsonResponse({});
      if (url === "/api/popdex/agent/verify") return jsonResponse({ verified: true });
      throw new Error(`unexpected fetch ${url}`);
    },
    ethers: {
      Wallet: { createRandom: () => wallets[walletCount++] },
      getAddress: (value: string) => value,
      BrowserProvider: class { async waitForTransaction() { return { status: 1 }; } },
    },
    DashboardSafety: {
      readAgentAuthorizationIntent: async () => ({ kind: "approve" }),
      checkedAgentTransaction: () => ({
        action: "approve", newAgent: wallets[0].address, transaction: {},
      }),
    },
    window: {
      location: { hostname: "localhost" },
      confirm: () => confirmations.shift() ?? true,
      ethereum: {
        request: async ({ method }: { method: string }) => {
          if (method === "eth_requestAccounts") return ["0x1000000000000000000000000000000000000001"];
          if (method === "eth_chainId") return "0x888";
          if (method === "eth_sendTransaction") {
            configuredStatus = { ...configuredStatus, exists: false, authorized: false };
            return "0xtx";
          }
          return null;
        },
      },
    },
    setTimeout: (callback: () => void) => callback(),
  };
  Object.assign(context.window, {
    document: context.document,
    navigator: context.navigator,
    fetch: context.fetch,
    ethers: context.ethers,
    DashboardSafety: context.DashboardSafety,
  });
  vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), context, { filename: scriptPath });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    elements,
    requests,
    confirmations,
    walletCount: () => walletCount,
    setStatus: (status: Record<string, unknown>) => { configuredStatus = status; },
    click: async (id: string) => {
      const listener = elements.get(id)?.listener;
      assert.ok(listener, `missing listener for ${id}`);
      await listener();
    },
  };
}
```

- [ ] **Step 2: Run the existing UI test file**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: all existing tests pass with the new harness unused by assertions.

- [ ] **Step 3: Commit the harness**

```bash
git add test/popdex-agent-ui.test.ts
git commit -m "test: 增加 Agent 页面状态测试框架"
```

### Task 2: Protect an existing draft from repeated generation

**Files:**
- Modify: `test/popdex-agent-ui.test.ts`
- Modify: `public/popdex-agent.js:89-101`

- [ ] **Step 1: Add failing state tests**

```ts
test("authorized unsaved Agent draft cannot be regenerated", async () => {
  const page = await loadAgentPage();
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");
  const original = page.elements.get("popdex-agent-private")?.textContent;
  await page.click("popdex-agent-generate");
  assert.equal(page.walletCount(), 1);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, original);
  assert.match(page.elements.get("popdex-agent-status")?.textContent ?? "", /先保存/);
});

test("unverified Agent draft is replaced only after confirmation", async () => {
  const cancelled = await loadAgentPage({ confirmations: [false] });
  await cancelled.click("popdex-agent-generate");
  const original = cancelled.elements.get("popdex-agent-private")?.textContent;
  await cancelled.click("popdex-agent-generate");
  assert.equal(cancelled.walletCount(), 1);
  assert.equal(cancelled.elements.get("popdex-agent-private")?.textContent, original);

  const confirmed = await loadAgentPage({ confirmations: [true] });
  await confirmed.click("popdex-agent-generate");
  await confirmed.click("popdex-agent-generate");
  assert.equal(confirmed.walletCount(), 2);
  assert.equal(confirmed.elements.get("popdex-agent-private")?.textContent, "0xkey2");
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: both new tests fail because `generateAgent()` creates a second wallet without checking the existing draft.

- [ ] **Step 3: Add the minimal guard before wallet creation**

```js
function generateAgent() {
  if (generatedPrivateKey) {
    if (authorizationVerified) {
      throw new Error("当前 Agent 已完成链上授权，请先保存私钥后再生成新的 Agent。");
    }
    if (!window.confirm("当前未保存的 Agent 私钥将被永久覆盖，确认重新生成？")) {
      return;
    }
  }
  const wallet = ethers.Wallet.createRandom();
  // existing assignments remain unchanged
}
```

- [ ] **Step 4: Run the UI tests and verify GREEN**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: all UI tests pass.

- [ ] **Step 5: Commit the protected generation flow**

```bash
git add test/popdex-agent-ui.test.ts public/popdex-agent.js
git commit -m "fix: 防止覆盖未保存的 Agent 草稿"
```

### Task 3: Keep a draft when clearing configured Agent state

**Files:**
- Modify: `test/popdex-agent-ui.test.ts`
- Modify: `public/popdex-agent.js:244-269`

- [ ] **Step 1: Add a failing cleanup regression test**

```ts
test("clearing a revoked configured Agent preserves a different draft", async () => {
  const page = await loadAgentPage({
    status: {
      configured: true,
      exists: false,
      authorized: false,
      mainAccount: "0x1000000000000000000000000000000000000001",
      agentAddress: "0x2000000000000000000000000000000000000002",
    },
    confirmations: [true],
  });
  await page.click("popdex-agent-generate");
  const privateKey = page.elements.get("popdex-agent-private")?.textContent;
  const address = page.elements.get("popdex-agent-address")?.textContent;
  await page.click("popdex-agent-clear");
  assert.ok(page.requests.includes("POST /api/popdex/agent/clear"));
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, privateKey);
  assert.equal(page.elements.get("popdex-agent-address")?.textContent, address);
  assert.equal(page.elements.get("popdex-agent-copy")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, false);
});

test("revoking a configured Agent preserves a different draft during automatic cleanup", async () => {
  const page = await loadAgentPage({
    status: {
      configured: true,
      exists: true,
      authorized: true,
      mainAccount: "0x1000000000000000000000000000000000000001",
      agentAddress: "0x2000000000000000000000000000000000000002",
    },
    confirmations: [true],
  });
  await page.click("popdex-agent-generate");
  const privateKey = page.elements.get("popdex-agent-private")?.textContent;
  await page.click("popdex-agent-revoke");
  assert.ok(page.requests.includes("POST /api/popdex/agent/clear"));
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, privateKey);
  assert.equal(page.elements.get("popdex-agent-copy")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, false);
});

test("clearing without a draft keeps the existing reset behavior", async () => {
  const page = await loadAgentPage({
    status: {
      configured: true,
      exists: false,
      authorized: false,
      mainAccount: "0x1000000000000000000000000000000000000001",
      agentAddress: "0x2000000000000000000000000000000000000002",
    },
    confirmations: [true],
  });
  await page.click("popdex-agent-clear");
  assert.equal(
    page.elements.get("popdex-agent-private")?.textContent,
    "已清除本地 Agent 私钥"
  );
  assert.equal(page.elements.get("popdex-agent-copy")?.disabled, true);
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, true);
  assert.equal(page.elements.get("popdex-agent-save")?.disabled, true);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: both new tests fail because `clearLocalAgent()` calls `resetAgentState()` unconditionally.

- [ ] **Step 3: Reset controls only when no draft exists**

```js
await clearAgent();
if (!generatedPrivateKey) {
  resetAgentState("已清除本地 Agent 私钥");
}
await refresh();
```

Do not change `revokeAgent()`: its existing `clearLocalAgent(true)` call automatically receives the same draft-preserving behavior.

- [ ] **Step 4: Run the UI tests and verify GREEN**

Run: `node --test --import tsx test/popdex-agent-ui.test.ts`

Expected: all UI tests pass, including the cleanup regression.

- [ ] **Step 5: Commit the cleanup fix**

```bash
git add test/popdex-agent-ui.test.ts public/popdex-agent.js
git commit -m "fix: 清理旧配置时保留 Agent 草稿"
```

### Task 4: Full verification

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run TypeScript diagnostics**

Run: `npx tsc --noEmit`

Expected: no diagnostics in `public/popdex-agent.js` or `test/popdex-agent-ui.test.ts`; separately report any unchanged baseline diagnostics in legacy venue files.

- [ ] **Step 3: Inspect the final patch**

Run: `git diff HEAD~2..HEAD --check`

Expected: exit code 0 with no whitespace errors.

Run: `git status --short`

Expected: no uncommitted files.

- [ ] **Step 4: Re-read the design acceptance criteria**

Confirm every item in `docs/superpowers/specs/2026-09-19-popdex-agent-draft-state-design.md` has a passing regression test or an explicitly documented external limitation.
