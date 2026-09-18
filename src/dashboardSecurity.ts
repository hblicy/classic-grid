import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export type DashboardSecurityConfig = {
  authRequired: boolean;
  token: string;
  bindHost: "0.0.0.0" | "127.0.0.1";
};

export function dashboardSecurityConfig(
  env: NodeJS.ProcessEnv = process.env
): DashboardSecurityConfig {
  const token = String(env.DASHBOARD_TOKEN || "");
  if (token && (token.length < 16 || /[\x00-\x1f\x7f]/.test(token))) {
    throw new Error("DASHBOARD_TOKEN 至少 16 个字符且不能包含控制字符。");
  }
  return {
    authRequired: token.length > 0,
    token,
    bindHost: token ? "0.0.0.0" : "127.0.0.1",
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseBasic(value: string | undefined): { username: string; password: string } | null {
  if (!value) return null;
  const match = value.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

export function authorizeRequest(
  req: IncomingMessage,
  config: DashboardSecurityConfig
): boolean {
  if (!config.authRequired) return true;
  const credentials = parseBasic(req.headers.authorization);
  if (!credentials) return false;
  return (
    safeEqual(credentials.username, "admin") &&
    safeEqual(credentials.password, config.token)
  );
}

export function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="classic-grid"',
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

export function validateMutationRequest(
  req: IncomingMessage,
  config: DashboardSecurityConfig
): void {
  const contentType = singleHeader(req, "content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpRequestError(415, "Content-Type 必须是 application/json");
  }
  if (singleHeader(req, "x-grid-request") !== "1") {
    throw new HttpRequestError(403, "缺少 X-Grid-Request 请求头");
  }
  const originValue = singleHeader(req, "origin");
  const host = singleHeader(req, "host");
  if (!originValue || !host) {
    throw new HttpRequestError(403, "缺少 Origin 或 Host 请求头");
  }
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new HttpRequestError(403, "Origin 无效");
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.host.toLowerCase() !== host.toLowerCase()
  ) {
    throw new HttpRequestError(403, "Origin 与当前 Dashboard 不同源");
  }
  if (
    !config.authRequired &&
    !new Set(["localhost", "127.0.0.1", "[::1]"]).has(origin.hostname.toLowerCase())
  ) {
    throw new HttpRequestError(403, "无 Token 模式只允许 loopback Host");
  }
}

export function readJsonBody(
  req: IncomingMessage,
  maxBytes = 1_000_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        fail(new HttpRequestError(413, "请求正文过大"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", (error) => fail(error));
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        fail(new HttpRequestError(400, "请求正文不能为空"));
        return;
      }
      try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          fail(new HttpRequestError(400, "JSON 正文必须是对象"));
          return;
        }
        settled = true;
        resolve(value as Record<string, unknown>);
      } catch {
        fail(new HttpRequestError(400, "JSON 正文无效"));
      }
    });
  });
}
