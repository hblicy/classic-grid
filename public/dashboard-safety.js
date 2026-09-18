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

    if (intent.kind === "authorize") {
      const agent = checkedAddress(ethers, intent.agentAddress);
      if (parsed.name === "approveAgent") {
        const [actualAgent, delegator, name, expiresAt, initialNonce, isGlobal] = parsed.args;
        let expectedName;
        try {
          if (
            typeof intent.hostname !== "string" ||
            intent.hostname.length === 0 ||
            intent.hostname.length > 253 ||
            !/^[A-Za-z0-9.-]+$/.test(intent.hostname)
          ) {
            invalidTransaction();
          }
          expectedName = ethers.encodeBytes32String(`UI_${intent.hostname}`.slice(0, 31));
        } catch {
          invalidTransaction();
        }
        if (
          !sameAddress(ethers, actualAgent, agent) ||
          !sameAddress(ethers, delegator, intent.delegator) ||
          String(name).toLowerCase() !== String(expectedName).toLowerCase() ||
          isGlobal !== false
        ) {
          invalidTransaction();
        }
        checkedTimes(expiresAt, initialNonce, nowMs);
      } else if (parsed.name === "replaceAgent") {
        const [oldAgent, newAgent, expiresAt, initialNonce] = parsed.args;
        if (
          !sameAddress(ethers, newAgent, agent) ||
          sameAddress(ethers, oldAgent, agent)
        ) {
          invalidTransaction();
        }
        checkedTimes(expiresAt, initialNonce, nowMs);
      } else {
        invalidTransaction();
      }
    } else if (intent.kind === "revoke") {
      if (
        parsed.name !== "revokeAgent" ||
        !sameAddress(ethers, parsed.args[0], intent.agentAddress)
      ) {
        invalidTransaction();
      }
    } else {
      invalidTransaction();
    }

    return {
      from: checkedAddress(ethers, account),
      to: POPDEX_ACCOUNT_PRECOMPILE,
      data: prepared.data,
      value: "0x0",
      chainId: POPDEX_CHAIN_ID,
      type: "0x0",
      gas: "0x0",
      gasPrice: "0x0",
    };
  }

  window.DashboardSafety = Object.freeze({ escapeHtml, checkedAgentTransaction });
})();
