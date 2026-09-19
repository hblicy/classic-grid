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

async function loadAgentPage(
  options: {
    status?: Record<string, unknown>;
    confirmations?: boolean[];
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
      if (url === "/api/popdex/agent/verify") return jsonResponse({ verified: true });
      throw new Error(`unexpected fetch ${url}`);
    },
    ethers: {
      Wallet: { createRandom: () => wallets[walletCount++] },
      getAddress: (value: string) => value,
      BrowserProvider: class {
        async waitForTransaction() {
          return { status: 1 };
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
  vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), context, {
    filename: scriptPath,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    elements,
    requests,
    confirmations,
    walletCount: () => walletCount,
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
  const sendAt = authorize.indexOf("sendAndConfirm(checked.transaction)");
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
