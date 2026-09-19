(() => {
  "use strict";

  const HTML_ENTITIES = Object.freeze({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  });
  const POPDEX_ACCOUNT_PRECOMPILE = "0x0000000000000000000000000000000000001008";
  const POPDEX_CHAIN_ID = "0x888";
  const THIRTY_DAYS_MS = 2_592_000_000;
  const TIME_TOLERANCE_MS = 300_000;
  const ACCOUNT_ABI = Object.freeze([
    "function approveAgent(address agent,address delegator,bytes32 name,uint64 expiresAt,uint64 initialNonce,bool isGlobal)",
    "function replaceAgent(address oldAgent,address newAgent,uint64 expiresAt,uint64 initialNonce)",
    "function revokeAgent(address agent)",
    "function getAgents(address delegator) view returns (address[] agents,uint64[] expiresAts,bool[] isExpireds,bytes32[] names,bool[] isGlobals)",
  ]);

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
  }

  function invalidTransaction() {
    throw new Error("服务端返回的 Agent 交易参数与当前意图不一致。");
  }

  function checkedAddress(ethers, value) {
    try {
      return ethers.getAddress(value);
    } catch {
      return invalidTransaction();
    }
  }

  function sameAddress(ethers, left, right) {
    return checkedAddress(ethers, left) === checkedAddress(ethers, right);
  }

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

  function within(actual, expected, tolerance) {
    const difference = actual >= expected ? actual - expected : expected - actual;
    return difference <= tolerance;
  }

  function checkedTimes(expiresAt, initialNonce, nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalidTransaction();
    const now = BigInt(nowMs);
    const expectedExpiry = now + BigInt(THIRTY_DAYS_MS);
    const expectedNonce = BigInt(Math.floor(nowMs / 1000));
    if (
      !within(BigInt(expiresAt), expectedExpiry, BigInt(TIME_TOLERANCE_MS)) ||
      !within(BigInt(initialNonce), expectedNonce, BigInt(TIME_TOLERANCE_MS / 1000))
    ) {
      invalidTransaction();
    }
  }

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

  function checkedAgentTransaction(ethers, prepared, account, intent, nowMs = Date.now()) {
    if (
      !ethers ||
      !prepared ||
      !intent ||
      typeof prepared.data !== "string" ||
      prepared.chainId !== POPDEX_CHAIN_ID ||
      prepared.value !== "0x0" ||
      prepared.type !== "0x0" ||
      prepared.gas !== "0x0" ||
      prepared.gasPrice !== "0x0" ||
      !sameAddress(ethers, prepared.from, account) ||
      !sameAddress(ethers, prepared.to, POPDEX_ACCOUNT_PRECOMPILE)
    ) {
      invalidTransaction();
    }

    let parsed;
    try {
      parsed = new ethers.Interface(ACCOUNT_ABI).parseTransaction({ data: prepared.data });
    } catch {
      invalidTransaction();
    }
    if (!parsed) invalidTransaction();

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
  }

  window.DashboardSafety = Object.freeze({
    escapeHtml,
    readAgentAuthorizationIntent,
    checkedAgentTransaction,
  });
})();
