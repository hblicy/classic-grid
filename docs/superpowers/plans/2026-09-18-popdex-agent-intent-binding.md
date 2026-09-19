# PopDEX Agent 交易意图绑定修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浏览器通过钱包 RPC 独立确定 approve/replace 意图，并在发送交易前把 selector、精确旧 Agent 和确认文案绑定到同一份已校验结果。

**Architecture:** 在现有无构建步骤的 `DashboardSafety` 助手中增加只读 `eth_call getAgents` 和严格结果校验，返回显式 `approve` 或 `replace` 意图。prepared transaction 校验器只接受与该显式意图完全匹配的 ABI 调用，并返回包含规范化交易与已校验展示字段的结果；Dashboard 先校验、再确认、最后只发送规范化交易。

**Tech Stack:** 浏览器 JavaScript、ethers 6.13.5、Node.js test runner、TypeScript 测试、PopDEX Account precompile ABI。

---

## 文件职责与变更边界

- 修改 `public/dashboard-safety.js`：负责钱包 RPC 的 Agent 状态读取、显式授权意图生成、prepared transaction 的 ABI 与精确参数绑定；不负责 DOM 或网络写操作。
- 修改 `public/popdex-agent.js`：负责授权流程编排；确认文案只读取安全助手返回的已校验字段，钱包只接收规范化 transaction。
- 修改 `test/dashboard-safety.test.ts`：覆盖钱包 RPC 返回值、重复同名 Agent、selector/intent 不一致和 `oldAgent` 篡改。
- 修改 `test/popdex-agent-ui.test.ts`：静态验证授权顺序为“读取意图 → 校验交易 → 用户确认 → 发送”，并禁止信任 `prepared.action`。
- 不修改服务端 prepared-transaction API、PopDEX ABI 定义、授权有效期规则或撤销业务规则。

### Task 1: 通过钱包 RPC 独立生成授权意图

**Files:**
- Modify: `test/dashboard-safety.test.ts`
- Modify: `public/dashboard-safety.js`

- [ ] **Step 1: 为钱包 RPC 读取写失败测试**

在 `test/dashboard-safety.test.ts` 的常量区增加第二个旧 Agent，并增加可编码 `getAgents` 返回值的测试钱包：

```ts
const THIRD = "0x4000000000000000000000000000000000000004";

function walletAgentReader(result: {
  agents: string[];
  expiresAts: bigint[];
  isExpireds: boolean[];
  names: string[];
  isGlobals: boolean[];
}): any {
  const accountInterface = new ethers.Interface(POPDEX_ACCOUNT_ABI);
  return {
    async request(payload: { method: string; params: unknown[] }) {
      assert.equal(payload.method, "eth_call");
      assert.deepEqual(payload.params, [
        {
          to: POPDEX_ACCOUNT_PRECOMPILE,
          data: accountInterface.encodeFunctionData("getAgents", [MAIN]),
        },
        "latest",
      ]);
      return accountInterface.encodeFunctionResult("getAgents", [
        result.agents,
        result.expiresAts,
        result.isExpireds,
        result.names,
        result.isGlobals,
      ]);
    },
  };
}
```

追加以下用例，分别固定无同名 Agent、单个同名 Agent、重复同名 Agent、返回数组长度不一致、新旧地址相同和 ABI 无法解码的行为：

```ts
test("readAgentAuthorizationIntent derives approve and exact replace from wallet RPC", async () => {
  const safety = loadDashboardSafety();
  const hostname = "grid.example";
  const otherName = ethers.encodeBytes32String("UI_other.example");
  const expectedName = agentNameBytes32(hostname);

  const approve = await safety.readAgentAuthorizationIntent(
    ethers,
    walletAgentReader({
      agents: [OTHER],
      expiresAts: [1n],
      isExpireds: [false],
      names: [otherName],
      isGlobals: [false],
    }),
    MAIN,
    AGENT,
    hostname
  );
  assert.equal(approve.kind, "approve");
  assert.equal(approve.agentAddress, AGENT);
  assert.equal(approve.delegator, MAIN);
  assert.equal(approve.hostname, hostname);

  const replace = await safety.readAgentAuthorizationIntent(
    ethers,
    walletAgentReader({
      agents: [OTHER],
      expiresAts: [1n],
      isExpireds: [false],
      names: [expectedName],
      isGlobals: [false],
    }),
    MAIN,
    AGENT,
    hostname
  );
  assert.equal(replace.kind, "replace");
  assert.equal(replace.oldAgent, OTHER);
  assert.equal(replace.agentAddress, AGENT);
  assert.equal(replace.delegator, MAIN);
  assert.equal(replace.hostname, hostname);
});

test("readAgentAuthorizationIntent rejects ambiguous or malformed wallet state", async () => {
  const safety = loadDashboardSafety();
  const hostname = "grid.example";
  const name = agentNameBytes32(hostname);
  const invalidResults = [
    {
      agents: [OTHER, THIRD],
      expiresAts: [1n, 2n],
      isExpireds: [false, false],
      names: [name, name],
      isGlobals: [false, false],
    },
    {
      agents: [OTHER],
      expiresAts: [],
      isExpireds: [false],
      names: [name],
      isGlobals: [false],
    },
    {
      agents: [AGENT],
      expiresAts: [1n],
      isExpireds: [false],
      names: [name],
      isGlobals: [false],
    },
  ];

  for (const result of invalidResults) {
    await assert.rejects(
      safety.readAgentAuthorizationIntent(
        ethers,
        walletAgentReader(result),
        MAIN,
        AGENT,
        hostname
      ),
      /链上 Agent 状态/
    );
  }

  await assert.rejects(
    safety.readAgentAuthorizationIntent(
      ethers,
      { request: async () => "0x1234" },
      MAIN,
      AGENT,
      hostname
    ),
    /链上 Agent 状态/
  );
});
```

- [ ] **Step 2: 运行定向测试并确认 RED**

Run: `node --test --import tsx test/dashboard-safety.test.ts`

Expected: FAIL，错误明确指出 `readAgentAuthorizationIntent` 不存在。

- [ ] **Step 3: 实现最小的钱包 RPC 读取与意图生成**

在 `public/dashboard-safety.js` 的 `ACCOUNT_ABI` 中加入：

```js
"function getAgents(address delegator) view returns (address[] agents,uint64[] expiresAts,bool[] isExpireds,bytes32[] names,bool[] isGlobals)",
```

在 `sameAddress` 后增加 hostname/name 规范化与只读 RPC 函数：

```js
  function checkedAgentName(ethers, hostname) {
    try {
      if (
        typeof hostname !== "string" ||
        hostname.length === 0 ||
        hostname.length > 253 ||
        !/^[A-Za-z0-9.-]+$/.test(hostname)
      ) {
        invalidTransaction();
      }
      return ethers.encodeBytes32String(`UI_${hostname}`.slice(0, 31));
    } catch {
      return invalidTransaction();
    }
  }

  function invalidAgentState() {
    throw new Error("钱包返回的链上 Agent 状态无效或不唯一。");
  }

  async function readAgentAuthorizationIntent(
    ethers,
    ethereum,
    account,
    agentAddress,
    hostname
  ) {
    if (!ethers || !ethereum || typeof ethereum.request !== "function") {
      invalidAgentState();
    }
    const delegator = checkedAddress(ethers, account);
    const agent = checkedAddress(ethers, agentAddress);
    const expectedName = checkedAgentName(ethers, hostname);
    const accountInterface = new ethers.Interface(ACCOUNT_ABI);
    const data = accountInterface.encodeFunctionData("getAgents", [delegator]);
    const encoded = await ethereum.request({
      method: "eth_call",
      params: [{ to: POPDEX_ACCOUNT_PRECOMPILE, data }, "latest"],
    });

    let decoded;
    try {
      decoded = accountInterface.decodeFunctionResult("getAgents", encoded);
    } catch {
      return invalidAgentState();
    }
    const [agents, expiresAts, isExpireds, names, isGlobals] = decoded;
    const length = agents.length;
    if (
      expiresAts.length !== length ||
      isExpireds.length !== length ||
      names.length !== length ||
      isGlobals.length !== length
    ) {
      invalidAgentState();
    }

    const normalizedAgents = [];
    for (let index = 0; index < length; index += 1) {
      try {
        normalizedAgents.push(checkedAddress(ethers, agents[index]));
      } catch {
        return invalidAgentState();
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(names[index]))) {
        invalidAgentState();
      }
    }
    const matchingIndexes = names
      .map((name, index) =>
        String(name).toLowerCase() === String(expectedName).toLowerCase() ? index : -1
      )
      .filter((index) => index >= 0);

    if (matchingIndexes.length > 1) invalidAgentState();
    if (matchingIndexes.length === 0) {
      return Object.freeze({
        kind: "approve",
        agentAddress: agent,
        delegator,
        hostname,
      });
    }

    const oldAgent = normalizedAgents[matchingIndexes[0]];
    if (sameAddress(ethers, oldAgent, agent)) invalidAgentState();
    return Object.freeze({
      kind: "replace",
      oldAgent,
      agentAddress: agent,
      delegator,
      hostname,
    });
  }
```

把浏览器导出改为：

```js
  window.DashboardSafety = Object.freeze({
    escapeHtml,
    readAgentAuthorizationIntent,
    checkedAgentTransaction,
  });
```

- [ ] **Step 4: 运行定向测试并确认 GREEN**

Run: `node --test --import tsx test/dashboard-safety.test.ts`

Expected: PASS；RPC 请求固定发往 `0x...1008` 的 `getAgents(MAIN)`，无匹配返回 approve，唯一匹配返回携带精确 `oldAgent` 的 replace，歧义与畸形状态全部拒绝。

- [ ] **Step 5: 提交钱包 RPC 意图生成**

```bash
git add public/dashboard-safety.js test/dashboard-safety.test.ts
git commit -m "fix: 从钱包状态确定 Agent 授权意图"
```

### Task 2: 把 selector、oldAgent、确认文案和发送交易绑定到已校验结果

**Files:**
- Modify: `test/dashboard-safety.test.ts`
- Modify: `test/popdex-agent-ui.test.ts`
- Modify: `public/dashboard-safety.js`
- Modify: `public/popdex-agent.js`

- [ ] **Step 1: 把交易测试改为显式 approve/replace 意图**

在 `test/dashboard-safety.test.ts` 中把原“accepts exact approve and replace intents”用例替换为：

```ts
test("checkedAgentTransaction accepts only the selector and oldAgent bound to intent", () => {
  const safety = loadDashboardSafety();
  const hostname = "grid.example";
  const approve = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname,
    existingAgents: [],
    nowMs: NOW,
  });
  const checkedApprove = safety.checkedAgentTransaction(
    ethers,
    { from: MAIN, ...approve },
    MAIN,
    { kind: "approve", agentAddress: AGENT, delegator: MAIN, hostname },
    NOW
  );
  assert.equal(checkedApprove.action, "approve");
  assert.equal(checkedApprove.newAgent, AGENT);
  assert.equal(checkedApprove.transaction.to, POPDEX_ACCOUNT_PRECOMPILE);
  assert.equal(checkedApprove.transaction.from, MAIN);

  const replace = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname,
    existingAgents: [{ agent: OTHER, name: agentNameBytes32(hostname) }],
    nowMs: NOW,
  });
  const checkedReplace = safety.checkedAgentTransaction(
    ethers,
    { from: MAIN, ...replace },
    MAIN,
    {
      kind: "replace",
      oldAgent: OTHER,
      agentAddress: AGENT,
      delegator: MAIN,
      hostname,
    },
    NOW
  );
  assert.equal(checkedReplace.action, "replace");
  assert.equal(checkedReplace.oldAgent, OTHER);
  assert.equal(checkedReplace.newAgent, AGENT);
  assert.equal(checkedReplace.transaction.data, replace.data);

  assert.throws(
    () =>
      safety.checkedAgentTransaction(
        ethers,
        { from: MAIN, ...replace },
        MAIN,
        { kind: "approve", agentAddress: AGENT, delegator: MAIN, hostname },
        NOW
      ),
    /交易参数/
  );
  assert.throws(
    () =>
      safety.checkedAgentTransaction(
        ethers,
        { from: MAIN, ...replace },
        MAIN,
        {
          kind: "replace",
          oldAgent: THIRD,
          agentAddress: AGENT,
          delegator: MAIN,
          hostname,
        },
        NOW
      ),
    /交易参数/
  );
});
```

把其余授权交易测试里的 intent 从 `kind: "authorize"` 改成：

```ts
const intent = {
  kind: "approve",
  agentAddress: AGENT,
  delegator: MAIN,
  hostname: "grid.example",
};
```

把撤销测试的成功断言改为检查结构化返回值，失败断言保持不变：

```ts
  const checked = safety.checkedAgentTransaction(
    ethers,
    { from: MAIN, ...prepared },
    MAIN,
    { kind: "revoke", agentAddress: AGENT },
    NOW
  );
  assert.equal(checked.action, "revoke");
  assert.equal(checked.agentAddress, AGENT);
  assert.equal(checked.transaction.data, prepared.data);
```

- [ ] **Step 2: 为 Dashboard 授权顺序写失败测试**

在 `test/popdex-agent-ui.test.ts` 追加独立的授权顺序用例：

```ts
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
```

- [ ] **Step 3: 运行两组测试并确认 RED**

Run: `node --test --import tsx test/dashboard-safety.test.ts test/popdex-agent-ui.test.ts`

Expected: FAIL；旧校验器仍接受宽泛 `authorize`，不返回 `action/transaction` 结构，授权页仍在校验前根据 `prepared.action` 确认。

- [ ] **Step 4: 收紧交易校验器并返回唯一可信展示结果**

在 `public/dashboard-safety.js` 中新增规范化交易函数：

```js
  function normalizedTransaction(ethers, prepared, account) {
    return Object.freeze({
      from: checkedAddress(ethers, account),
      to: POPDEX_ACCOUNT_PRECOMPILE,
      data: prepared.data,
      value: "0x0",
      chainId: POPDEX_CHAIN_ID,
      type: "0x0",
      gas: "0x0",
      gasPrice: "0x0",
    });
  }
```

把 `checkedAgentTransaction` 中 `if (intent.kind === "authorize")` 到最终 `return` 的分支替换为：

```js
    const transaction = normalizedTransaction(ethers, prepared, account);
    if (intent.kind === "approve") {
      if (parsed.name !== "approveAgent") invalidTransaction();
      const agent = checkedAddress(ethers, intent.agentAddress);
      const [actualAgent, delegator, name, expiresAt, initialNonce, isGlobal] = parsed.args;
      const expectedName = checkedAgentName(ethers, intent.hostname);
      if (
        !sameAddress(ethers, actualAgent, agent) ||
        !sameAddress(ethers, delegator, intent.delegator) ||
        String(name).toLowerCase() !== String(expectedName).toLowerCase() ||
        isGlobal !== false
      ) {
        invalidTransaction();
      }
      checkedTimes(expiresAt, initialNonce, nowMs);
      return Object.freeze({ action: "approve", newAgent: agent, transaction });
    }

    if (intent.kind === "replace") {
      if (parsed.name !== "replaceAgent") invalidTransaction();
      const oldAgent = checkedAddress(ethers, intent.oldAgent);
      const newAgent = checkedAddress(ethers, intent.agentAddress);
      const [actualOldAgent, actualNewAgent, expiresAt, initialNonce] = parsed.args;
      if (
        !sameAddress(ethers, actualOldAgent, oldAgent) ||
        !sameAddress(ethers, actualNewAgent, newAgent) ||
        sameAddress(ethers, oldAgent, newAgent)
      ) {
        invalidTransaction();
      }
      checkedTimes(expiresAt, initialNonce, nowMs);
      return Object.freeze({
        action: "replace",
        oldAgent,
        newAgent,
        transaction,
      });
    }

    if (intent.kind === "revoke") {
      const agentAddress = checkedAddress(ethers, intent.agentAddress);
      if (
        parsed.name !== "revokeAgent" ||
        !sameAddress(ethers, parsed.args[0], agentAddress)
      ) {
        invalidTransaction();
      }
      return Object.freeze({ action: "revoke", agentAddress, transaction });
    }

    return invalidTransaction();
```

删除旧分支末尾直接返回裸 transaction 的对象；公共 envelope 校验保持原样。

- [ ] **Step 5: 调整 Dashboard 为先校验、后确认、再发送**

在 `public/popdex-agent.js` 的 `authorizeAgent` 中，把获取 `prepared` 后直到 `let transactionHash` 之前的代码替换为：

```js
    const intent = await DashboardSafety.readAgentAuthorizationIntent(
      ethers,
      window.ethereum,
      mainAccount,
      generatedAgentAddress,
      window.location.hostname
    );
    const prepared = await prepareApproval({
      agentAddress: generatedAgentAddress,
      delegator: mainAccount,
      hostname: window.location.hostname,
    });
    const checked = DashboardSafety.checkedAgentTransaction(
      ethers,
      prepared,
      mainAccount,
      intent
    );
    const confirmation =
      checked.action === "replace"
        ? `确认使用主钱包 ${mainAccount} 替换现有同名 Agent？\n旧 Agent：${checked.oldAgent}\n新 Agent：${checked.newAgent}`
        : `确认使用主钱包 ${mainAccount} 授权新 Agent？\nAgent：${checked.newAgent}`;
    if (!window.confirm(confirmation)) return;
    let transactionHash = null;
```

把授权 `try` 中原来的嵌套校验调用替换为：

```js
      transactionHash = await sendAndConfirm(checked.transaction);
```

在 `revokeAgent` 中先保存校验结果，并只发送其 transaction：

```js
    const checked = DashboardSafety.checkedAgentTransaction(
      ethers,
      prepared,
      mainAccount,
      { kind: "revoke", agentAddress: status.agentAddress }
    );
```

保留现有撤销确认文案，然后把发送调用替换为：

```js
      transactionHash = await sendAndConfirm(checked.transaction);
```

- [ ] **Step 6: 运行两组测试并确认 GREEN**

Run: `node --test --import tsx test/dashboard-safety.test.ts test/popdex-agent-ui.test.ts`

Expected: PASS；approve intent 拒绝 replace selector，replace intent 拒绝不同的 `oldAgent`，授权代码不再读取 `prepared.action`，并严格按“读取 → 校验 → 确认 → 发送”执行。

- [ ] **Step 7: 提交交易与 UI 绑定修复**

```bash
git add public/dashboard-safety.js public/popdex-agent.js test/dashboard-safety.test.ts test/popdex-agent-ui.test.ts
git commit -m "fix: 绑定 Agent 替换目标与确认意图"
```

### Task 3: 完整验证和差异复审

**Files:**
- Verify only: `public/dashboard-safety.js`
- Verify only: `public/popdex-agent.js`
- Verify only: `test/dashboard-safety.test.ts`
- Verify only: `test/popdex-agent-ui.test.ts`

- [ ] **Step 1: 运行全部回归测试**

Run: `npm test`

Expected: 现有测试和新增测试全部 PASS，退出码为 0。

- [ ] **Step 2: 运行 TypeScript 静态检查**

Run: `npx tsc --noEmit`

Expected: 不出现本次四个文件引入的新错误；若仍失败，只记录并逐条核对仓库中已知的 `officialStats` 与 legacy venues 基线错误，不借本修复扩大范围。

- [ ] **Step 3: 复跑原始恶意输入和顺序断言**

Run: `node --test --import tsx --test-name-pattern="selector and oldAgent|authorization order|ambiguous or malformed" test/dashboard-safety.test.ts test/popdex-agent-ui.test.ts`

Expected: 所有匹配用例 PASS；错误 `oldAgent`、重复同名 Agent、畸形 RPC 返回和 selector/intent 不一致均在 `eth_sendTransaction` 之前被拒绝。

- [ ] **Step 4: 检查提交差异和工作区**

Run: `git diff origin/main...HEAD --check`

Expected: 无空白错误。

Run: `git status --short`

Expected: 无未提交修改。

- [ ] **Step 5: 记录验证结论**

最终交付需明确列出：新增测试数量与全部测试结果、`tsc` 是否仅剩已知基线错误、未发送任何真实链上交易，以及该分支尚未推送/创建 PR（除非用户另行要求）。
