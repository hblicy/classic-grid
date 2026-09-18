import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import test from "node:test";
import {
  popdexAgentMutationAllowed,
  startDashboardServer,
} from "../src/dashboard.js";
import { POPDEX_ACCOUNT_PRECOMPILE } from "../src/popdex/agent.js";

const TOKEN = "1234567890abcdef";
const MAIN = "0x1000000000000000000000000000000000000001";
const AGENT = "0x3000000000000000000000000000000000000003";
const SECRET = `0x${"11".repeat(32)}`;

function basic(): string {
  return `Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`;
}

async function listening(server: Server): Promise<number> {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

async function request(
  port: number,
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; origin?: string } = {}
): Promise<{ status: number; body: any }> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          ...(options.auth === false ? {} : { Authorization: basic() }),
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                "X-Grid-Request": "1",
                Origin: options.origin ?? `http://127.0.0.1:${port}`,
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : null });
        });
      }
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function fakeService(options: { failSave?: boolean } = {}) {
  const calls: string[] = [];
  const transaction = {
    to: POPDEX_ACCOUNT_PRECOMPILE,
    data: "0x12" as const,
    value: "0x0" as const,
    chainId: "0x888" as const,
    type: "0x0" as const,
    gas: "0x0" as const,
    gasPrice: "0x0" as const,
  };
  return {
    calls,
    async status() {
      calls.push("status");
      return { configured: true, mainAccount: MAIN, agentAddress: AGENT, authorized: true };
    },
    async prepareApproval(body: any) {
      calls.push(`prepare:${body.agentAddress}`);
      return { from: MAIN, ...transaction };
    },
    async verifyAuthorization(body: any) {
      calls.push(`verify:${body.agentAddress}`);
      return { configured: true, mainAccount: MAIN, agentAddress: AGENT, authorized: true };
    },
    async save(body: any) {
      calls.push(`save:${body.mainAccount}`);
      if (options.failSave) throw new Error(`bad private key ${body.agentPrivateKey}`);
      return { configured: true, mainAccount: MAIN, agentAddress: AGENT, authorized: true };
    },
    async prepareRevoke(body: any) {
      calls.push(`revoke:${body.agentAddress}`);
      return { from: MAIN, ...transaction, data: "0x34" as const };
    },
    async clear() {
      calls.push("clear");
      return { configured: false as const, mainAccount: MAIN };
    },
  };
}

test("live configured PopDEX blocks Agent mutation before snapshot visibility", () => {
  assert.equal(
    popdexAgentMutationAllowed({
      dryRun: false,
      popdexConfigured: true,
      globallyPaused: false,
      venuePaused: false,
    }),
    false
  );
  assert.equal(
    popdexAgentMutationAllowed({
      dryRun: false,
      popdexConfigured: true,
      globallyPaused: true,
      venuePaused: false,
    }),
    true
  );
  assert.equal(
    popdexAgentMutationAllowed({
      dryRun: true,
      popdexConfigured: true,
      globallyPaused: false,
      venuePaused: false,
    }),
    true
  );
});

test("Dashboard maps all six protected Agent routes", async () => {
  const service = fakeService();
  const server = startDashboardServer(0, {
    env: { DASHBOARD_TOKEN: TOKEN },
    agentService: service,
  });
  assert.ok(server);
  const port = await listening(server);
  try {
    assert.equal((await request(port, "/api/popdex/agent/status")).status, 200);
    assert.equal(
      (await request(port, "/api/popdex/agent/prepare-approval", {
        method: "POST",
        body: { agentAddress: AGENT, delegator: MAIN, hostname: "grid.example" },
      })).status,
      200
    );
    assert.equal(
      (await request(port, "/api/popdex/agent/verify", {
        method: "POST",
        body: { mainAccount: MAIN, agentAddress: AGENT },
      })).status,
      200
    );
    assert.equal(
      (await request(port, "/api/popdex/agent/save", {
        method: "POST",
        body: { mainAccount: MAIN, agentPrivateKey: SECRET },
      })).status,
      200
    );
    assert.equal(
      (await request(port, "/api/popdex/agent/prepare-revoke", {
        method: "POST",
        body: { mainAccount: MAIN, agentAddress: AGENT },
      })).status,
      200
    );
    assert.equal(
      (await request(port, "/api/popdex/agent/clear", { method: "POST", body: {} })).status,
      200
    );
    assert.deepEqual(service.calls, [
      "status",
      `prepare:${AGENT}`,
      `verify:${AGENT}`,
      `save:${MAIN}`,
      `revoke:${AGENT}`,
      "clear",
    ]);
  } finally {
    await close(server);
  }
});

test("Agent routes enforce auth and same-origin mutation headers", async () => {
  const server = startDashboardServer(0, {
    env: { DASHBOARD_TOKEN: TOKEN },
    agentService: fakeService(),
  });
  assert.ok(server);
  const port = await listening(server);
  try {
    assert.equal(
      (await request(port, "/api/popdex/agent/status", { auth: false })).status,
      401
    );
    assert.equal(
      (await request(port, "/api/popdex/agent/clear", {
        method: "POST",
        body: {},
        origin: "https://evil.test",
      })).status,
      403
    );
  } finally {
    await close(server);
  }
});

test("Agent API never reflects a submitted private key in errors", async () => {
  const server = startDashboardServer(0, {
    env: { DASHBOARD_TOKEN: TOKEN },
    agentService: fakeService({ failSave: true }),
  });
  assert.ok(server);
  const port = await listening(server);
  try {
    const response = await request(port, "/api/popdex/agent/save", {
      method: "POST",
      body: { mainAccount: MAIN, agentPrivateKey: SECRET },
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(SECRET));
  } finally {
    await close(server);
  }
});
