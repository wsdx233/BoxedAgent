import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { boxedAgentToken, env } from "./config/env.js";

const COOKIE_NAME = "boxedagent_auth";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SAFE_PUBLIC_PATHS = new Set(["/api/auth/status", "/api/auth/login", "/api/auth/logout"]);

const LoginBody = z.object({ token: z.string().min(1) });

export function authEnabled() {
  return Boolean(boxedAgentToken);
}

export function assertProductionAuthConfigured() {
  if (env.NODE_ENV === "production" && !authEnabled()) {
    throw new Error("BOXEDAGENT_TOKEN is required when NODE_ENV=production. Set it in .env before exposing BoxedAgent.");
  }
  if (authEnabled() && boxedAgentToken.length < 16) {
    // Do not fail local deployments, but make weak public tokens visible in logs.
    console.warn("BOXEDAGENT_TOKEN is shorter than 16 characters. Use a long random token for public deployments.");
  }
}

export async function registerAuth(app: FastifyInstance) {
  app.get("/api/auth/status", async (req) => ({ enabled: authEnabled(), authenticated: !authEnabled() || isAuthorized(req) }));

  app.post("/api/auth/login", async (req, reply) => {
    if (!authEnabled()) return { ok: true, enabled: false };
    const body = LoginBody.parse(req.body ?? {});
    if (!constantTimeEqual(body.token, boxedAgentToken)) {
      reply.code(401);
      return { ok: false, error: "Invalid token" };
    }
    setAuthCookie(reply, makeSessionCookie(), req);
    return { ok: true, enabled: true };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    clearAuthCookie(reply);
    return { ok: true };
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!authEnabled()) return;
    const url = new URL(req.raw.url ?? "/", "http://boxedagent.local");
    if (SAFE_PUBLIC_PATHS.has(url.pathname)) return;
    if (url.pathname === "/api/health") return;
    if (!requiresAuth(url.pathname)) return;
    if (isAuthorized(req)) return;
    reply.code(401).send({ error: "Authentication required", code: "UNAUTHORIZED" });
  });
}

function requiresAuth(pathname: string) {
  return pathname.startsWith("/api/") || pathname.startsWith("/ws/") || pathname.startsWith("/codeserver/") || pathname === "/codeserver" || pathname.startsWith("/ports/") || pathname === "/ports";
}

function isAuthorized(req: FastifyRequest) {
  const bearer = bearerToken(req.headers.authorization);
  if (bearer && constantTimeEqual(bearer, boxedAgentToken)) return true;
  const cookie = parseCookies(req.headers.cookie ?? "")[COOKIE_NAME];
  return Boolean(cookie && verifySessionCookie(cookie));
}

function bearerToken(header: unknown) {
  if (typeof header !== "string") return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function makeSessionCookie() {
  const expires = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SECONDS;
  const nonce = crypto.randomBytes(16).toString("base64url");
  const payload = `v1.${expires}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionCookie(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const payload = parts.slice(0, 3).join(".");
  return constantTimeEqual(parts[3], sign(payload));
}

function sign(payload: string) {
  return crypto.createHmac("sha256", `${env.SESSION_SECRET}:${boxedAgentToken}`).update(payload).digest("base64url");
}

function setAuthCookie(reply: FastifyReply, value: string, req: FastifyRequest) {
  const secure = shouldUseSecureCookie(req);
  reply.header("set-cookie", `${COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
}

function clearAuthCookie(reply: FastifyReply) {
  reply.header("set-cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function shouldUseSecureCookie(req: FastifyRequest) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  return env.PUBLIC_ORIGIN?.startsWith("https://") || forwardedProto === "https";
}

function parseCookies(header: string) {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function constantTimeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    crypto.timingSafeEqual(crypto.createHash("sha256").update(aBuffer).digest(), crypto.createHash("sha256").update(bBuffer).digest());
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}
