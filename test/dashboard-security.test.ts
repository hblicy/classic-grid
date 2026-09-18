import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import {
  HttpRequestError,
  authorizeRequest,
  dashboardSecurityConfig,
  readJsonBody,
  validateMutationRequest,
} from "../src/dashboardSecurity.js";

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function request(
  headers: Record<string, string> = {},
  body?: string
): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as IncomingMessage;
  Object.assign(req, { headers, method: "POST", url: "/api/test" });
  return req;
}

test("token enables Basic Auth and wrong credentials are rejected", () => {
  const cfg = dashboardSecurityConfig({ DASHBOARD_TOKEN: "1234567890abcdef" });
  assert.equal(cfg.bindHost, "0.0.0.0");
  assert.equal(
    authorizeRequest(request({ authorization: basic("admin", cfg.token) }), cfg),
    true
  );
  assert.equal(
    authorizeRequest(request({ authorization: basic("admin", "wrong") }), cfg),
    false
  );
  assert.equal(
    authorizeRequest(request({ authorization: basic("someone", cfg.token) }), cfg),
    false
  );
});

test("missing token forces loopback and short tokens fail startup", () => {
  assert.equal(dashboardSecurityConfig({}).bindHost, "127.0.0.1");
  assert.throws(
    () => dashboardSecurityConfig({ DASHBOARD_TOKEN: "too-short" }),
    /至少 16 个字符/
  );
});

test("mutation guard requires JSON, X-Grid-Request and same Origin", () => {
  const valid = {
    host: "localhost:8088",
    origin: "http://localhost:8088",
    "content-type": "application/json; charset=utf-8",
    "x-grid-request": "1",
  };
  assert.doesNotThrow(() => validateMutationRequest(request(valid)));
  assert.throws(
    () => validateMutationRequest(request({ ...valid, origin: "https://evil.test" })),
    (error: HttpRequestError) => error.statusCode === 403 && /Origin/.test(error.message)
  );
  assert.throws(
    () => validateMutationRequest(request({ ...valid, "x-grid-request": "0" })),
    (error: HttpRequestError) => error.statusCode === 403
  );
  assert.throws(
    () => validateMutationRequest(request({ ...valid, "content-type": "text/plain" })),
    (error: HttpRequestError) => error.statusCode === 415
  );
});

test("bounded JSON reader accepts objects and rejects empty, malformed and oversized bodies", async () => {
  assert.deepEqual(await readJsonBody(request({}, '{"ok":true}'), 64), { ok: true });
  await assert.rejects(
    readJsonBody(request({}, ""), 64),
    (error: HttpRequestError) => error.statusCode === 400
  );
  await assert.rejects(
    readJsonBody(request({}, "{"), 64),
    (error: HttpRequestError) => error.statusCode === 400
  );
  await assert.rejects(
    readJsonBody(request({}, JSON.stringify({ value: "x".repeat(100) })), 32),
    (error: HttpRequestError) => error.statusCode === 413
  );
});
