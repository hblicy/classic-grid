# PopDEX Agent Wallet Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PopDEX main-wallet signing in `classic-grid` with an authorized Agent signer and add the complete browser authorization, verification, save, revoke, and clear lifecycle.

**Architecture:** Add focused TypeScript modules for Agent ABI encoding, RPC reads, environment persistence, and lifecycle orchestration. Keep the existing grid engine intact: account facts and calldata belong to `POPDEX_MAIN_ACCOUNT`, while `POPDEX_AGENT_PRIVATE_KEY` is the only signer; the Dashboard exposes protected lifecycle routes and a browser-only Agent UI.

**Tech Stack:** Node.js 20, TypeScript/tsx, viem, ethers 6.13.5 UMD in the browser, Node `http`, Node test runner.

---

## File map

- Create `src/popdex/agent.ts`: strict address/private-key validation and Account-precompile ABI encoding.
- Create `src/popdex/agentRpc.ts`: `eth_chainId`, `getAgentInfo`, and `getAgents` read client.
- Create `src/popdex/agentService.ts`: lifecycle rules and `.env` mutation.
- Create `src/envFile.ts`: owner-only `.env` write helper.
- Create `src/dashboardSecurity.ts`: Basic Auth, mutation guards, bounded JSON reader.
- Create `public/popdex-agent.js`: browser-only Agent lifecycle controller.
- Create focused tests under `test/` for every new boundary.
- Modify `src/dashboard.ts`: secure all requests, serve local assets, and route Agent API calls.
- Modify `src/venues/popdex.ts`: main-account/Agent split and authorization preflight.
- Modify `src/officialStats.ts`: PopDEX statistics use the main account only.
- Modify `public/index.html`: Agent panel and local scripts.
- Modify `.env.example`, `README.md`, `SECURITY.md`, `package.json`, and `package-lock.json`.

### Task 1: Agent ABI and identity primitives

**Files:**
- Create: `src/popdex/agent.ts`
- Create: `test/popdex-agent.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Register the first focused test file**

Change the test script to run the existing regression and named Node test files explicitly:

```json
"test": "node --import tsx test/grid.test.ts && node --test --import tsx test/popdex-agent.test.ts"
```

- [ ] **Step 2: Write failing ABI and identity tests**

Create `test/popdex-agent.test.ts` with tests that:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, hexToString } from "viem";
import {
  POPDEX_ACCOUNT_ABI,
  agentNameBytes32,
  deriveAgentAddress,
  prepareAgentAuthorization,
  prepareAgentRevocation,
} from "../src/popdex/agent.js";

const MAIN = "0x1000000000000000000000000000000000000001";
const AGENT_KEY = `0x${"11".repeat(32)}`;
const OLD_AGENT = "0x2000000000000000000000000000000000000002";

test("Agent private key derives an address and invalid input is never echoed", () => {
  assert.match(deriveAgentAddress(AGENT_KEY), /^0x[0-9A-Fa-f]{40}$/);
  const secret = "not-a-key-secret";
  assert.throws(
    () => deriveAgentAddress(secret),
    (error: Error) => /私钥格式无效/.test(error.message) && !error.message.includes(secret),
  );
});

test("new authorization is non-global and uses millisecond expiry", () => {
  const agentAddress = deriveAgentAddress(AGENT_KEY);
  const tx = prepareAgentAuthorization({
    agentAddress,
    delegator: MAIN,
    hostname: "grid.example",
    existingAgents: [],
    nowMs: 1_700_000_000_000,
  });
  assert.equal(tx.action, "approve");
  assert.equal(tx.chainId, "0x888");
  const decoded = decodeFunctionData({ abi: POPDEX_ACCOUNT_ABI, data: tx.data });
  assert.equal(decoded.functionName, "approveAgent");
  assert.deepEqual(decoded.args?.slice(0, 2), [agentAddress, MAIN]);
  assert.equal(decoded.args?.[3], 1_702_592_000_000n);
  assert.equal(decoded.args?.[4], 1_700_000_000n);
  assert.equal(decoded.args?.[5], false);
});

test("same Agent label replaces the unique previous Agent", () => {
  const name = agentNameBytes32("grid.example");
  const tx = prepareAgentAuthorization({
    agentAddress: deriveAgentAddress(AGENT_KEY),
    delegator: MAIN,
    hostname: "grid.example",
    existingAgents: [{ agent: OLD_AGENT, name }],
    nowMs: 1_700_000_000_000,
  });
  const decoded = decodeFunctionData({ abi: POPDEX_ACCOUNT_ABI, data: tx.data });
  assert.equal(decoded.functionName, "replaceAgent");
  assert.equal(decoded.args?.[0], OLD_AGENT);
});

test("revocation contains only the selected public Agent address", () => {
  const agentAddress = deriveAgentAddress(AGENT_KEY);
  const decoded = decodeFunctionData({
    abi: POPDEX_ACCOUNT_ABI,
    data: prepareAgentRevocation(agentAddress).data,
  });
  assert.equal(decoded.functionName, "revokeAgent");
  assert.equal(decoded.args?.[0], agentAddress);
});

test("Agent label is deterministic, ASCII-only, and bytes32 bounded", () => {
  const name = agentNameBytes32("grid.example");
  assert.equal(agentNameBytes32("grid.example"), name);
  assert.ok(hexToString(name, { size: 32 }).replace(/\0+$/, "").length <= 31);
  assert.throws(() => agentNameBytes32("坏主机名"), /hostname/);
});
```

- [ ] **Step 3: Run the test and verify RED**

Run: `npm test`

Expected: FAIL because `src/popdex/agent.ts` does not exist.

- [ ] **Step 4: Implement the Agent primitives**

Create `src/popdex/agent.ts` exporting:

```ts
export const POPDEX_ACCOUNT_PRECOMPILE = "0x0000000000000000000000000000000000001008";
export const POPDEX_CHAIN_ID = 0x888;
export const POPDEX_ACCOUNT_ABI = [
  { type: "function", name: "approveAgent", stateMutability: "nonpayable", inputs: [
    { name: "agent", type: "address" }, { name: "delegator", type: "address" },
    { name: "name", type: "bytes32" }, { name: "expiresAt", type: "uint64" },
    { name: "initialNonce", type: "uint64" }, { name: "isGlobal", type: "bool" },
  ], outputs: [] },
  { type: "function", name: "replaceAgent", stateMutability: "nonpayable", inputs: [
    { name: "oldAgent", type: "address" }, { name: "newAgent", type: "address" },
    { name: "expiresAt", type: "uint64" }, { name: "initialNonce", type: "uint64" },
  ], outputs: [] },
  { type: "function", name: "revokeAgent", stateMutability: "nonpayable", inputs: [
    { name: "agent", type: "address" },
  ], outputs: [] },
  { type: "function", name: "getAgentInfo", stateMutability: "view", inputs: [
    { name: "agent", type: "address" },
  ], outputs: [
    { name: "exists", type: "bool" }, { name: "expiresAt", type: "uint64" },
    { name: "isExpired", type: "bool" }, { name: "delegator", type: "address" },
    { name: "name", type: "bytes32" }, { name: "isGlobal", type: "bool" },
  ] },
  { type: "function", name: "getAgents", stateMutability: "view", inputs: [
    { name: "delegator", type: "address" },
  ], outputs: [
    { name: "agents", type: "address[]" }, { name: "expiresAts", type: "uint64[]" },
    { name: "isExpireds", type: "bool[]" }, { name: "names", type: "bytes32[]" },
    { name: "isGlobals", type: "bool[]" },
  ] },
] as const;
```

Use viem `getAddress`, `encodeFunctionData`, `stringToHex`, `pad`, and `privateKeyToAccount`. Validate private keys with `/^0x[0-9a-fA-F]{64}$/`, validate hostnames with `/^[A-Za-z0-9.-]+$/`, reject identical main/Agent addresses, reject duplicate labels, and return legacy transaction fields `{to,data,value:"0x0",chainId:"0x888",type:"0x0",gas:"0x0",gasPrice:"0x0"}`.

- [ ] **Step 5: Run the test and verify GREEN**

Run: `npm test`

Expected: existing `grid.test.ts` and all five Agent tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add package.json src/popdex/agent.ts test/popdex-agent.test.ts
git commit -m "功能：增加 PopDEX Agent 编解码"
```

### Task 2: Strict Agent RPC reader

**Files:**
- Create: `src/popdex/agentRpc.ts`
- Create: `test/popdex-agent-rpc.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the RPC test to the test script**

Append `test/popdex-agent-rpc.test.ts` to the explicit `node --test --import tsx` command.

- [ ] **Step 2: Write failing RPC tests**

Test a fetch-injected `PopdexAgentRpc` against JSON-RPC fixtures. Assert:

```ts
test("Agent RPC verifies chain and preserves uint64 expiry as a string", async () => {
  const calls: string[] = [];
  const client = new PopdexAgentRpc({ request: async (method, params) => {
    calls.push(method);
    if (method === "eth_chainId") return "0x888";
    return encodeFunctionResult({
      abi: POPDEX_ACCOUNT_ABI,
      functionName: "getAgentInfo",
      result: [true, 1_702_592_000_000n, false, MAIN, NAME, false],
    });
  }});
  await client.verifyChain();
  assert.deepEqual(await client.getAgentInfo(AGENT), {
    exists: true,
    expiresAt: "1702592000000",
    isExpired: false,
    delegator: MAIN,
    name: NAME,
    isGlobal: false,
  });
  assert.deepEqual(calls, ["eth_chainId", "eth_call"]);
});
```

Also assert wrong chain rejection, malformed result rejection, absent Agent requires the zero delegator, and `getAgents` rejects unequal output-array lengths.

- [ ] **Step 3: Run RED**

Run: `npm test`

Expected: FAIL because `PopdexAgentRpc` does not exist.

- [ ] **Step 4: Implement `PopdexAgentRpc`**

Define:

```ts
export type PopdexRpcRequest = (method: string, params?: unknown[]) => Promise<unknown>;

export class PopdexAgentRpc {
  constructor(options: { request?: PopdexRpcRequest; endpoint?: string } = {})
  async verifyChain(): Promise<void>
  async getAgentInfo(agentAddress: string): Promise<AgentInfo>
  async getAgents(delegatorAddress: string): Promise<ExistingAgent[]>
}
```

The default request implementation POSTs JSON-RPC to `https://api.popdex.xyz/api/v1/web3/rpc`, rejects HTTP/non-JSON/JSON-RPC errors with sanitized context, and never retries. Decode through `decodeFunctionResult`, normalize addresses through `getAddress`, require booleans to be booleans, return `expiresAt` values as decimal strings, and validate `bytes32` lengths.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test`

Expected: all tests PASS.

```powershell
git add package.json src/popdex/agentRpc.ts test/popdex-agent-rpc.test.ts
git commit -m "功能：增加 PopDEX Agent 链上查询"
```

### Task 3: Agent lifecycle service and owner-only environment writes

**Files:**
- Create: `src/envFile.ts`
- Create: `src/popdex/agentService.ts`
- Create: `test/popdex-agent-service.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing service tests**

Build in-memory `fsImpl`, `processEnv`, and RPC fakes. Cover these exact behaviors:

```ts
test("save refuses an unauthorized Agent", async () => {
  const ctx = service({ info: { ...activeInfo(), exists: false } });
  await assert.rejects(
    ctx.service.save({ mainAccount: MAIN, agentPrivateKey: AGENT_KEY }),
    /尚未获得有效授权/,
  );
  assert.equal(ctx.fsImpl.writes.length, 0);
});

test("save writes only main account and Agent key after exact verification", async () => {
  const ctx = service();
  const status = await ctx.service.save({ mainAccount: MAIN, agentPrivateKey: AGENT_KEY });
  assert.equal(status.authorized, true);
  assert.match(ctx.fsImpl.content, new RegExp(`^POPDEX_MAIN_ACCOUNT=${MAIN}$`, "m"));
  assert.match(ctx.fsImpl.content, new RegExp(`^POPDEX_AGENT_PRIVATE_KEY=${AGENT_KEY}$`, "m"));
  assert.doesNotMatch(JSON.stringify(status), new RegExp(AGENT_KEY));
});

test("clear preserves a still-active Agent and removes only a revoked key", async () => {
  const active = service({ processEnv: configuredEnv() });
  await assert.rejects(active.service.clear(), /撤销尚未确认/);
  const revoked = service({ processEnv: configuredEnv(), info: { ...activeInfo(), exists: false } });
  await revoked.service.clear();
  assert.equal(revoked.processEnv.POPDEX_MAIN_ACCOUNT, MAIN);
  assert.equal(revoked.processEnv.POPDEX_AGENT_PRIVATE_KEY, undefined);
});
```

Add cases for expired/global/mismatched delegator, identical addresses, configured status never exposing the key, disk-write failure not mutating `process.env`, approval selecting a unique same-name replacement, and POSIX mode `0600`.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: FAIL because `envFile.ts` and `agentService.ts` do not exist.

- [ ] **Step 3: Implement owner-only environment persistence**

Create `src/envFile.ts`:

```ts
export function writeEnvFile(
  envFile: string,
  content: string,
  options: { fsImpl?: typeof fs; platform?: NodeJS.Platform } = {},
): void {
  const fsImpl = options.fsImpl ?? fs;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && fsImpl.existsSync(envFile)) fsImpl.chmodSync(envFile, 0o600);
  fsImpl.writeFileSync(envFile, content, { encoding: "utf8", mode: 0o600 });
  if (platform !== "win32") fsImpl.chmodSync(envFile, 0o600);
}
```

- [ ] **Step 4: Implement `PopdexAgentService`**

Port the verified service behavior into strict TypeScript with constructor injection:

```ts
export class PopdexAgentService {
  constructor(options: {
    rpcClient?: PopdexAgentRpc;
    envFile: string;
    processEnv?: NodeJS.ProcessEnv;
    fsImpl?: typeof fs;
    platform?: NodeJS.Platform;
    now?: () => number;
    canMutate?: () => boolean;
  })
  status(): Promise<PublicAgentStatus>
  prepareApproval(input: { agentAddress: string; delegator: string; hostname: string }): Promise<PreparedAgentTransaction & { from: string }>
  verifyAuthorization(input: { mainAccount: string; agentAddress: string }): Promise<PublicAgentStatus>
  save(input: { mainAccount: string; agentPrivateKey: string }): Promise<PublicAgentStatus>
  prepareRevoke(input: { mainAccount: string; agentAddress: string }): Promise<PreparedAgentTransaction & { from: string }>
  clear(): Promise<{ configured: false; mainAccount: string | null }>
}
```

`save`, `prepareRevoke`, and `clear` call `canMutate`; a false result throws `PopDEX 正在实盘运行，请先暂停后再修改 Agent。`. Write `.env` lines deterministically, preserve unrelated lines, comment the cleared key as `# POPDEX_AGENT_PRIVATE_KEY=`, and update `process.env` only after `writeEnvFile` succeeds.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test`

Expected: all tests PASS.

```powershell
git add package.json src/envFile.ts src/popdex/agentService.ts test/popdex-agent-service.test.ts
git commit -m "功能：增加 PopDEX Agent 生命周期服务"
```

### Task 4: Dashboard authentication and mutation security

**Files:**
- Create: `src/dashboardSecurity.ts`
- Create: `test/dashboard-security.test.ts`
- Modify: `src/dashboard.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing security unit tests**

Use lightweight fake requests/responses. Verify:

```ts
test("token enables Basic Auth and wrong credentials receive a challenge", () => {
  const cfg = dashboardSecurityConfig({ DASHBOARD_TOKEN: "1234567890abcdef" });
  assert.equal(cfg.bindHost, "0.0.0.0");
  assert.equal(authorizeRequest(request({ authorization: basic("admin", cfg.token) }), cfg), true);
  assert.equal(authorizeRequest(request({ authorization: basic("admin", "wrong") }), cfg), false);
});

test("missing token forces loopback binding", () => {
  assert.equal(dashboardSecurityConfig({}).bindHost, "127.0.0.1");
});

test("mutation guard requires JSON, X-Grid-Request and same Origin", () => {
  const req = request({ host: "localhost:8088", origin: "http://localhost:8088",
    "content-type": "application/json", "x-grid-request": "1" });
  assert.doesNotThrow(() => validateMutationRequest(req));
  assert.throws(() => validateMutationRequest(request({ ...req.headers, origin: "https://evil.test" })), /Origin/);
});
```

Test `readJsonBody(req, 4096)` rejects oversized, empty, and malformed JSON bodies with status 413/400.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: FAIL because `dashboardSecurity.ts` does not exist.

- [ ] **Step 3: Implement the security helpers**

Create `HttpRequestError`, `dashboardSecurityConfig`, constant-time Basic credential comparison with `timingSafeEqual`, `sendUnauthorized`, `validateMutationRequest`, and bounded `readJsonBody`. A configured token must be at least 16 characters and contain no control characters. Mutation requests require an exact same-origin `http:` or `https:` Origin.

- [ ] **Step 4: Integrate security into the Dashboard server**

Change the public signature without breaking current callers:

```ts
export type DashboardServerOptions = {
  env?: NodeJS.ProcessEnv;
  agentService?: PopdexAgentService;
};

export function startDashboardServer(
  port: number,
  options: DashboardServerOptions = {},
): http.Server | null
```

At the start of every request, enforce Basic Auth when configured. Before every POST route, run `validateMutationRequest`. Replace duplicate unbounded body readers with `readJsonBody`; preserve route-specific response shapes. Listen on `security.bindHost`, not hard-coded `0.0.0.0`. Existing browser POST calls in `public/index.html` must add `X-Grid-Request: 1` in this same task so regression tests can exercise the protected endpoints.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test`

Expected: all tests PASS and existing Dashboard behavior remains available after valid security headers.

```powershell
git add package.json src/dashboardSecurity.ts src/dashboard.ts public/index.html test/dashboard-security.test.ts
git commit -m "安全：保护看板和写接口"
```

### Task 5: Agent Dashboard API and browser lifecycle

**Files:**
- Create: `public/popdex-agent.js`
- Create: `test/popdex-agent-api.test.ts`
- Create: `test/popdex-agent-ui.test.ts`
- Modify: `src/dashboard.ts`
- Modify: `public/index.html`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the fixed browser dependency**

Run: `npm install ethers@6.13.5 --save-exact`

Expected: `package.json` contains `"ethers": "6.13.5"` and the lock file records the exact dependency.

- [ ] **Step 2: Write failing API integration tests**

Start the Dashboard on port `0` with an injected fake Agent service and a token. Test all six routes with valid Basic/Auth mutation headers; verify bad auth is `401`, bad Origin/header/content type is `403/415`, service errors retain their status category without including a submitted private key, and `save`, `prepare-revoke`, and `clear` call the injected safety guard.

The successful route mapping must be exact:

```ts
GET  /api/popdex/agent/status            -> service.status()
POST /api/popdex/agent/prepare-approval -> service.prepareApproval(body)
POST /api/popdex/agent/verify           -> service.verifyAuthorization(body)
POST /api/popdex/agent/save             -> service.save(body)
POST /api/popdex/agent/prepare-revoke   -> service.prepareRevoke(body)
POST /api/popdex/agent/clear            -> service.clear()
```

- [ ] **Step 3: Write failing static UI tests**

Read `public/index.html` and `public/popdex-agent.js` as text. Assert local `/vendor/ethers.js?v=6.13.5-umd` and `/popdex-agent.js` scripts exist; the six UI controls exist; the script uses `ethers.Wallet.createRandom()` and `window.ethereum`; all mutation calls add `X-Grid-Request`; and none of `localStorage`, `sessionStorage`, `document.cookie`, or query-string private-key persistence appear.

- [ ] **Step 4: Run RED**

Run: `npm test`

Expected: API route and UI tests FAIL because the routes/assets/UI do not exist.

- [ ] **Step 5: Implement the API routes and static assets**

Instantiate the default service with `path.resolve(process.cwd(), ".env")`, `new PopdexAgentRpc()`, and:

```ts
canMutate: () => {
  const popdexVisible = snapshot.venues.some((venue) => venue.venue === "popdex");
  if (snapshot.dryRun || !popdexVisible || snapshot.paused) return true;
  return allVenueControl().popdex?.paused === true;
}
```

Serve `/vendor/ethers.js` from `node_modules/ethers/dist/ethers.umd.min.js` and `/popdex-agent.js` from `public/`, both behind the same request authentication.

- [ ] **Step 6: Implement the browser workflow**

Port `dex-wangge/public/popdex-agent.js` while changing paths to `/api/popdex/agent/*` and adding the required request header. Keep the private key only in a module-scoped variable. Implement exact stages: generate, connect/switch chain, prepare, wallet broadcast, wait for receipt, verify, save, zero the in-memory reference, refresh, prepare revoke, wallet broadcast, poll status, clear.

Add a self-contained Agent card to `public/index.html` showing authorization status, main account, Agent address, one-time private key display, and six buttons. Add explicit warnings that save/revoke requires PopDEX pause and a process restart.

- [ ] **Step 7: Run GREEN and commit**

Run: `npm test`

Expected: all API/UI/security/service tests PASS.

```powershell
git add package.json package-lock.json src/dashboard.ts public/index.html public/popdex-agent.js test/popdex-agent-api.test.ts test/popdex-agent-ui.test.ts
git commit -m "功能：增加 PopDEX Agent 网页管理"
```

### Task 6: Move PopDEX execution to main-account/Agent identities

**Files:**
- Modify: `src/venues/popdex.ts`
- Modify: `src/officialStats.ts`
- Create: `test/popdex-executor-agent.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing runtime identity tests**

Export and test a pure resolver:

```ts
test("live identity rejects legacy main-wallet secrets", () => {
  assert.throws(
    () => resolvePopdexIdentity({ POPDEX_PRIVATE_KEY: AGENT_KEY }),
    /旧配置 POPDEX_PRIVATE_KEY.*停用/,
  );
  assert.throws(
    () => resolvePopdexIdentity({ POPDEX_KEY_PATH: "secrets/popdex.key" }),
    /旧配置 POPDEX_KEY_PATH.*停用/,
  );
});

test("identity separates the main account from the Agent signer", () => {
  const identity = resolvePopdexIdentity({
    POPDEX_MAIN_ACCOUNT: MAIN,
    POPDEX_AGENT_PRIVATE_KEY: AGENT_KEY,
  });
  assert.equal(identity.mainAccount, MAIN);
  assert.equal(identity.agentAccount.address, AGENT);
});
```

Add a constructor-injected executor test that captures account REST URLs and a signed transaction. Decode `placeOrder` and assert the first calldata argument is `MAIN`, while the wallet client account is `AGENT`. Test `connect()` refuses missing/expired/global/mismatched Agent authorization before any write client is usable.

- [ ] **Step 2: Write failing official-statistics test**

Extract/export `resolvePopdexStatsAddress(env)` and assert it returns `POPDEX_MAIN_ACCOUNT`, rejects invalid/missing values with an unavailable reason, and never reads `POPDEX_AGENT_PRIVATE_KEY` or legacy private-key fields.

- [ ] **Step 3: Run RED**

Run: `npm test`

Expected: identity tests FAIL because runtime still uses `POPDEX_PRIVATE_KEY` as both signer and account.

- [ ] **Step 4: Implement the executor identity split**

In `src/venues/popdex.ts`:

- Remove `fs`, `path`, `POPDEX_PRIVATE_KEY`, and `POPDEX_KEY_PATH` loading.
- Add `mainAccount` and `agentAccount` fields; remove the ambiguous `address` field.
- Resolve and validate the new environment variables once during `connect()`.
- Reject any non-empty legacy variable before private configuration is used.
- Use `PopdexAgentRpc.verifyChain()` and `getAgentInfo()` plus the shared authorization predicate before building a wallet client.
- Use `mainAccount` in all REST paths and all order/cancel calldata account arguments.
- Create the viem wallet client with `agentAccount`; log only public main and Agent addresses.
- Keep public-market dry-run working without private credentials; partial/conflicting private configuration fails explicitly.
- On `disconnect()`, clear both public identities and all clients.

- [ ] **Step 5: Switch official statistics to the main account**

Replace PopDEX private-key derivation in `src/officialStats.ts` with strict `POPDEX_MAIN_ACCOUNT` validation. Return the existing unavailable result when no valid main account is configured; never consult legacy or Agent private-key variables.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm test`

Expected: runtime identity tests and all regressions PASS.

```powershell
git add package.json src/venues/popdex.ts src/officialStats.ts test/popdex-executor-agent.test.ts
git commit -m "安全：PopDEX 改用 Agent 签名"
```

### Task 7: Configuration and operator documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Create: `test/popdex-docs.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing documentation contract tests**

Assert `.env.example` contains empty `DASHBOARD_TOKEN`, `POPDEX_MAIN_ACCOUNT`, and `POPDEX_AGENT_PRIVATE_KEY`; contains neither `POPDEX_PRIVATE_KEY` nor `POPDEX_KEY_PATH`; README documents the six-step Agent lifecycle and restart rule; SECURITY documents loopback-without-token and authenticated remote access.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: FAIL because the old PopDEX private-key template remains.

- [ ] **Step 3: Update operator-facing configuration**

Replace the PopDEX section with:

```dotenv
# ---- PopDEX — 主账户只提供公开地址，交易由已授权 Agent 签名 ----
POPDEX_MAIN_ACCOUNT=
POPDEX_AGENT_PRIVATE_KEY=
POPDEX_SYMBOL=
POPDEX_EQUITY_USD=800
POPDEX_GRID_COUNT=80
POPDEX_LEVERAGE=30
POPDEX_HALF_BAND=
POPDEX_ORDER_GAP_MS=200
```

Add `DASHBOARD_TOKEN=` with text explaining that a value of at least 16 characters enables remote binding and Basic Auth; without it, the server binds only to `127.0.0.1`.

- [ ] **Step 4: Update README and SECURITY**

Document generate → authorize/replace → verify → save → restart → pause/revoke/clear. State that the main private key must never be entered, the Agent key is revocable, configuration changes are not hot-swapped, and remote access requires a token plus TLS/SSH/Tailscale transport.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test`

Expected: all tests PASS.

```powershell
git add package.json .env.example README.md SECURITY.md test/popdex-docs.test.ts
git commit -m "文档：说明 PopDEX Agent 配置流程"
```

### Task 8: Full verification and focused security review

**Files:**
- Modify only files already in scope if verification exposes a direct defect.

- [ ] **Step 1: Run TypeScript compilation**

Run: `npx tsc --noEmit`

Expected: exit code 0 with no diagnostics.

- [ ] **Step 2: Run the full automated suite**

Run: `npm test`

Expected: exit code 0; grid regression and every Agent/security/UI/runtime/doc test PASS.

- [ ] **Step 3: Scan for forbidden legacy/private-key exposure**

Run:

```powershell
rg -n "POPDEX_PRIVATE_KEY|POPDEX_KEY_PATH" src public .env.example README.md SECURITY.md
rg -n "localStorage|sessionStorage|document\.cookie" public/popdex-agent.js
```

Expected: first command only finds intentional migration-error text in the executor/README; second command returns no matches.

- [ ] **Step 4: Verify the production package graph**

Run: `npm ls --depth=0`

Expected: exit code 0 and `ethers@6.13.5` appears without invalid/extraneous dependencies.

- [ ] **Step 5: Review the exact diff**

Run: `git status --short` and `git diff --check 7c89d92..HEAD`

Expected: only planned project files changed; no `.env`, secret, data, or unrelated file is present; no whitespace errors.

- [ ] **Step 6: Record manual verification boundary**

Do not broadcast authorization, revocation, cancellation, or order transactions automatically. Report the manual sequence and commands to the user; real wallet acceptance remains user-operated through the Dashboard.
