import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(path.resolve("public/index.html"), "utf8");
const scriptPath = path.resolve("public/popdex-agent.js");

type FakeElement = {
  id: string;
  textContent: string;
  className: string;
  disabled: boolean;
  listener?: () => Promise<void>;
  addEventListener: (name: string, listener: () => Promise<void>) => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadAgentPage(
  options: {
    status?: Record<string, unknown>;
    confirmations?: boolean[];
    waitForTransaction?: () => Promise<{ status: number | null } | null>;
    getTransactionReceipt?: (hash: string) => Promise<{ status: number | null } | null>;
    getNetwork?: () => Promise<{ chainId: bigint }>;
    verifyError?: Error;
    saveAgent?: () => Promise<unknown>;
    sendError?: Error;
    onTransactionSubmitted?: () => void;
    onSaveStarted?: () => void;
  } = {}
) {
  const ids = [
    "popdex-agent-status",
    "popdex-agent-main",
    "popdex-agent-address",
    "popdex-agent-private",
    "popdex-agent-generate",
    "popdex-agent-copy",
    "popdex-agent-authorize",
    "popdex-agent-save",
    "popdex-agent-refresh",
    "popdex-agent-revoke",
    "popdex-agent-clear",
  ];
  const elements = new Map<string, FakeElement>();
  for (const id of ids) {
    const element: FakeElement = {
      id,
      textContent: "",
      className: "",
      disabled: false,
      addEventListener(name, listener) {
        assert.equal(name, "click");
        element.listener = listener;
      },
    };
    elements.set(id, element);
  }

  let configuredStatus = options.status ?? {
    configured: false,
    exists: false,
    authorized: false,
    mainAccount: null,
    agentAddress: null,
  };
  let walletCount = 0;
  let transactionCount = 0;
  const requests: string[] = [];
  const confirmations = [...(options.confirmations ?? [])];
  const wallets = [
    {
      privateKey: "0xkey1",
      address: "0x3000000000000000000000000000000000000003",
    },
    {
      privateKey: "0xkey2",
      address: "0x4000000000000000000000000000000000000004",
    },
  ];
  const jsonResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });

  const context = {
    document: { getElementById: (id: string) => elements.get(id) },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async (url: string, init?: { method?: string }) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/popdex/agent/status") return jsonResponse(configuredStatus);
      if (url === "/api/popdex/agent/clear") {
        configuredStatus = {
          configured: false,
          exists: false,
          authorized: false,
          mainAccount: null,
          agentAddress: null,
        };
        return jsonResponse({ cleared: true });
      }
      if (url === "/api/popdex/agent/prepare-approval") return jsonResponse({});
      if (url === "/api/popdex/agent/prepare-revoke") return jsonResponse({});
      if (url === "/api/popdex/agent/verify") {
        if (options.verifyError) throw options.verifyError;
        return jsonResponse({ verified: true });
      }
      if (url === "/api/popdex/agent/save") {
        options.onSaveStarted?.();
        const saved = options.saveAgent ? await options.saveAgent() : { saved: true };
        return jsonResponse(saved);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    ethers: {
      Wallet: { createRandom: () => wallets[walletCount++] },
      getAddress: (value: string) => value,
      BrowserProvider: class {
        async getNetwork() {
          return options.getNetwork ? options.getNetwork() : { chainId: 2184n };
        }
        async getTransactionReceipt(hash: string) {
          return options.getTransactionReceipt ? options.getTransactionReceipt(hash) : { status: 1 };
        }
        async waitForTransaction() {
          return options.waitForTransaction
            ? options.waitForTransaction()
            : { status: 1 };
        }
      },
    },
    DashboardSafety: {
      readAgentAuthorizationIntent: async () => ({ kind: "approve" }),
      checkedAgentTransaction: () => ({
        action: "approve",
        newAgent: wallets[0].address,
        transaction: {},
      }),
    },
    window: {
      location: { hostname: "localhost" },
      confirm: () => confirmations.shift() ?? true,
      ethereum: {
        request: async ({ method }: { method: string }) => {
          if (method === "eth_requestAccounts") {
            return ["0x1000000000000000000000000000000000000001"];
          }
          if (method === "eth_chainId") return "0x888";
          if (method === "eth_sendTransaction") {
            if (options.sendError) throw options.sendError;
            transactionCount += 1;
            configuredStatus = { ...configuredStatus, exists: false, authorized: false };
            options.onTransactionSubmitted?.();
            return `0xtx${transactionCount}`;
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
  vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), context, {
    filename: scriptPath,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    elements,
    requests,
    confirmations,
    walletCount: () => walletCount,
    transactionCount: () => transactionCount,
    setStatus: (status: Record<string, unknown>) => {
      configuredStatus = status;
    },
    click: async (id: string) => {
      const listener = elements.get(id)?.listener;
      assert.ok(listener, `missing listener for ${id}`);
      await listener();
    },
  };
}

test("Dashboard includes local ethers and the complete Agent controls", () => {
  assert.match(html, /\/vendor\/ethers\.js\?v=6\.13\.5-umd/);
  assert.match(html, /\/popdex-agent\.js/);
  assert.match(html, /授权、替换、保存、撤销或清理前请先暂停 PopDEX/);
  for (const id of [
    "popdex-agent-generate",
    "popdex-agent-copy",
    "popdex-agent-authorize",
    "popdex-agent-save",
    "popdex-agent-refresh",
    "popdex-agent-revoke",
    "popdex-agent-clear",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test("Agent browser code keeps secrets in memory and protects mutations", () => {
  assert.equal(fs.existsSync(scriptPath), true);
  const script = fs.readFileSync(scriptPath, "utf8");
  assert.match(script, /ethers\.Wallet\.createRandom\(\)/);
  assert.match(script, /window\.ethereum/);
  assert.match(script, /X-Grid-Request/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(script, /URLSearchParams.*private|location\.(?:search|hash).*private/i);
  assert.match(script, /async function clearLocalAgent/);
  assert.match(script, /status\.exists\s*===\s*false/);
  assert.match(script, /configuredStatus\.exists/);
});

test("Agent authorization order validates before confirmation and sending", () => {
  const script = fs.readFileSync(scriptPath, "utf8");
  const authorizeStart = script.indexOf("async function authorizeAgent()");
  const authorizeEnd = script.indexOf("async function persistAgent()", authorizeStart);
  const authorize = script.slice(authorizeStart, authorizeEnd);
  const readIntentAt = authorize.indexOf("readAgentAuthorizationIntent");
  const checkAt = authorize.indexOf("checkedAgentTransaction");
  const confirmAt = authorize.indexOf("window.confirm");
  const sendAt = authorize.indexOf("sendAndConfirm(checked.transaction");
  assert.ok(readIntentAt >= 0);
  assert.ok(readIntentAt < checkAt);
  assert.ok(checkAt < confirmAt);
  assert.ok(confirmAt < sendAt);
  assert.doesNotMatch(authorize, /prepared\.action/);
  assert.match(authorize, /checked\.action\s*===\s*["']replace["']/);
  assert.match(authorize, /checked\.oldAgent/);
  assert.match(authorize, /checked\.newAgent/);
});

test("authorized unsaved Agent draft cannot be regenerated", async () => {
  const page = await loadAgentPage();
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");
  const original = page.elements.get("popdex-agent-private")?.textContent;
  await page.click("popdex-agent-generate");
  assert.equal(page.walletCount(), 1);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, original);
  assert.match(page.elements.get("popdex-agent-status")?.textContent ?? "", /保留并保存/);
});

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
  assert.equal(page.elements.get("popdex-agent-generate")?.disabled, true);
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, true);
});

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

test("submitted authorization waiting for a receipt keeps the draft non-discardable", async () => {
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
  await new Promise((resolve) => setImmediate(resolve));
  await page.click("popdex-agent-generate");
  assert.equal(page.walletCount(), 1);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, privateKey);
  receipt.resolve({ status: 1 });
  await authorizing;
});

test("reverted authorization preserves the draft and allows authorizing it again", async () => {
  let attempts = 0;
  const page = await loadAgentPage({
    waitForTransaction: async () => ({ status: attempts++ === 0 ? 0 : 1 }),
  });
  await page.click("popdex-agent-generate");
  const privateKey = page.elements.get("popdex-agent-private")?.textContent;
  const address = page.elements.get("popdex-agent-address")?.textContent;
  await page.click("popdex-agent-authorize");

  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-generate")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-save")?.disabled, true);
  assert.equal(page.elements.get("popdex-agent-copy")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, privateKey);
  assert.equal(page.elements.get("popdex-agent-address")?.textContent, address);
  assert.equal(page.elements.get("popdex-agent-main")?.textContent, "—");
  assert.match(page.elements.get("popdex-agent-status")?.textContent ?? "", /回滚/);
  assert.ok(!page.requests.includes("POST /api/popdex/agent/verify"));
  await page.click("popdex-agent-save");
  assert.ok(!page.requests.includes("POST /api/popdex/agent/save"));

  await page.click("popdex-agent-authorize");
  assert.equal(page.transactionCount(), 2);
  assert.equal(page.walletCount(), 1);
  assert.equal(page.elements.get("popdex-agent-save")?.disabled, false);
  await page.click("popdex-agent-save");
  assert.equal(page.elements.get("popdex-agent-private")?.textContent,
    "私钥已保存；请重启进程后生效");
});

for (const outcome of ["missing receipt", "unknown status", "RPC timeout"]) {
  test(`${outcome} keeps submitted authorization locked against resending`, async () => {
    const page = await loadAgentPage({
      waitForTransaction: async () => {
        if (outcome === "RPC timeout") throw new Error("RPC timeout");
        return outcome === "missing receipt" ? null : { status: null };
      },
    });
    await page.click("popdex-agent-generate");
    await page.click("popdex-agent-authorize");
    assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, true);
    assert.equal(page.elements.get("popdex-agent-generate")?.disabled, true);
    assert.equal(page.elements.get("popdex-agent-save")?.disabled, false);
    await page.click("popdex-agent-authorize");
    assert.equal(page.transactionCount(), 1);
    assert.equal(page.elements.get("popdex-agent-private")?.textContent, "0xkey1");
  });
}

test("submitted draft account stays visible after verification failure and refresh", async () => {
  const page = await loadAgentPage({
    status: {
      configured: true,
      exists: true,
      authorized: true,
      mainAccount: "0x5000000000000000000000000000000000000005",
      agentAddress: "0x2000000000000000000000000000000000000002",
    },
    verifyError: new Error("verify failed"),
  });
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");
  assert.equal(page.elements.get("popdex-agent-main")?.textContent,
    "0x1000000000000000000000000000000000000001");
  await page.click("popdex-agent-refresh");
  assert.equal(page.elements.get("popdex-agent-main")?.textContent,
    "0x1000000000000000000000000000000000000001");
});

test("refresh recovers a late revert and tracks only the retried authorization", async () => {
  const queriedHashes: string[] = [];
  let receiptStatus = 0;
  const page = await loadAgentPage({
    waitForTransaction: async () => { throw new Error("RPC timeout"); },
    getTransactionReceipt: async (hash) => {
      queriedHashes.push(hash);
      return { status: receiptStatus };
    },
  });
  await page.click("popdex-agent-generate");
  const address = page.elements.get("popdex-agent-address")?.textContent;
  await page.click("popdex-agent-authorize");
  await page.click("popdex-agent-refresh");
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-generate")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-save")?.disabled, true);
  assert.equal(page.elements.get("popdex-agent-copy")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, "0xkey1");
  assert.equal(page.elements.get("popdex-agent-address")?.textContent, address);
  assert.equal(page.elements.get("popdex-agent-main")?.textContent, "—");
  assert.match(page.elements.get("popdex-agent-status")?.textContent ?? "", /回滚.*重新授权/);
  assert.deepEqual(queriedHashes, ["0xtx1"]);
  await page.click("popdex-agent-refresh");
  assert.deepEqual(queriedHashes, ["0xtx1"]);
  await page.click("popdex-agent-save");
  assert.ok(!page.requests.includes("POST /api/popdex/agent/save"));

  receiptStatus = 1;
  await page.click("popdex-agent-authorize");
  await page.click("popdex-agent-refresh");
  assert.deepEqual(queriedHashes, ["0xtx1", "0xtx2"]);
  assert.equal(page.transactionCount(), 2);
  assert.equal(page.walletCount(), 1);
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, true);
  await page.click("popdex-agent-save");
  await page.click("popdex-agent-refresh");
  assert.deepEqual(queriedHashes, ["0xtx1", "0xtx2"]);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent,
    "私钥已保存；请重启进程后生效");
});

for (const outcome of ["pending", "unknown status", "successful receipt", "RPC failure"]) {
  test(`refresh after timeout preserves the draft lock on ${outcome}`, async () => {
    const queriedHashes: string[] = [];
    const page = await loadAgentPage({
      waitForTransaction: async () => { throw new Error("RPC timeout"); },
      getTransactionReceipt: async (hash) => {
        queriedHashes.push(hash);
        if (outcome === "RPC failure") throw new Error("receipt RPC unavailable");
        if (outcome === "pending") return null;
        return { status: outcome === "unknown status" ? null : 1 };
      },
    });
    await page.click("popdex-agent-generate");
    await page.click("popdex-agent-authorize");
    await page.click("popdex-agent-refresh");
    assert.deepEqual(queriedHashes, ["0xtx1"]);
    assert.equal(page.elements.get("popdex-agent-generate")?.disabled, true);
    assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, true);
    assert.equal(page.elements.get("popdex-agent-save")?.disabled, false);
    assert.equal(page.elements.get("popdex-agent-private")?.textContent, "0xkey1");
    if (outcome === "RPC failure") {
      assert.match(page.elements.get("popdex-agent-status")?.textContent ?? "", /receipt RPC unavailable/);
    }
    await page.click("popdex-agent-authorize");
    assert.equal(page.transactionCount(), 1);
  });
}

test("receipt refresh rejects the wrong wallet network and recovers after switching back", async () => {
  let chainId = 1n;
  let receiptCalls = 0;
  const page = await loadAgentPage({
    waitForTransaction: async () => { throw new Error("RPC timeout"); },
    getNetwork: async () => ({ chainId }),
    getTransactionReceipt: async () => { receiptCalls++; return { status: 0 }; },
  });
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");
  await page.click("popdex-agent-refresh");
  assert.equal(receiptCalls, 0);
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, true);
  assert.match(page.elements.get("popdex-agent-status")?.textContent ?? "", /网络/);
  chainId = 2184n;
  await page.click("popdex-agent-refresh");
  assert.equal(receiptCalls, 1);
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, false);
});

test("failed save preserves submitted draft for retry without another transaction", async () => {
  let saveAttempts = 0;
  const page = await loadAgentPage({
    verifyError: new Error("verify failed"),
    saveAgent: async () => {
      if (saveAttempts++ === 0) return { error: "chain verification unavailable" };
      return { saved: true };
    },
  });
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");
  await page.click("popdex-agent-save");
  assert.match(page.elements.get("popdex-agent-status")?.textContent ?? "",
    /chain verification unavailable/);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, "0xkey1");
  assert.equal(page.elements.get("popdex-agent-save")?.disabled, false);
  assert.equal(page.elements.get("popdex-agent-authorize")?.disabled, true);
  assert.equal(page.elements.get("popdex-agent-generate")?.disabled, true);

  await page.click("popdex-agent-save");
  assert.equal(saveAttempts, 2);
  assert.equal(page.transactionCount(), 1);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent,
    "私钥已保存；请重启进程后生效");
  assert.equal(page.elements.get("popdex-agent-save")?.disabled, true);
});

test("wallet rejection before submission still allows replacing the draft", async () => {
  const page = await loadAgentPage({
    confirmations: [true, true],
    sendError: new Error("wallet rejected"),
  });
  await page.click("popdex-agent-generate");
  await page.click("popdex-agent-authorize");
  await page.click("popdex-agent-generate");
  assert.equal(page.walletCount(), 2);
  assert.equal(page.elements.get("popdex-agent-private")?.textContent, "0xkey2");
});

test("saving an Agent blocks a concurrent clear operation", async () => {
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
