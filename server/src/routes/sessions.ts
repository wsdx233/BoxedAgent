import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { store } from "../core/store.js";
import { agentManager } from "../agent/agent-manager.js";
import { dockerService } from "../docker/docker-service.js";
import { attachMessageMeta } from "../agent/message-truncation.js";

const CreateSession = z.object({
  boxId: z.string().min(1),
  name: z.string().optional(),
  cwd: z.string().optional().transform(normalizeSessionCwd),
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  autostart: z.boolean().default(false)
});

const PromptBody = z.object({
  message: z.string().default(""),
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
  images: z.array(z.object({ type: z.literal("image").default("image"), data: z.string(), mimeType: z.string() })).optional()
});

const ThinkingLevelBody = z.object({ level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]) });
const ModelBody = z.object({ provider: z.string().min(1), modelId: z.string().min(1) });
const AutoCompactionBody = z.object({ enabled: z.boolean() });
const CompactBody = z.object({ customInstructions: z.string().optional() }).default({});
const DuplicateBody = z.object({ name: z.string().optional(), autostart: z.boolean().optional() }).default({});
const CloneBody = z.object({ name: z.string().optional() }).default({});
const ForkBody = z.object({ entryId: z.string().min(1), name: z.string().optional() });
const TreeNavigateBody = z.object({ targetId: z.string().min(1) });
const SelectedSessionBody = z.object({ sessionId: z.string().optional().nullable(), activeSessionId: z.string().optional().nullable() }).default({});
const ACTIVE_SESSION_COOKIE = "boxedagent_active_session";
const ACTIVE_SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export async function registerSessionRoutes(app: FastifyInstance) {
  app.get("/api/current-session", async (req) => selectedSessionResponse(readCookie(req, ACTIVE_SESSION_COOKIE)));
  app.get("/api/selected-session", async (req) => selectedSessionResponse(readCookie(req, ACTIVE_SESSION_COOKIE)));

  app.post("/api/current-session", async (req, reply) => setSelectedSession(req, reply));
  app.post("/api/selected-session", async (req, reply) => setSelectedSession(req, reply));
  app.put("/api/current-session", async (req, reply) => setSelectedSession(req, reply));
  app.put("/api/selected-session", async (req, reply) => setSelectedSession(req, reply));
  app.delete("/api/current-session", async (_req, reply) => clearSelectedSession(reply));
  app.delete("/api/selected-session", async (_req, reply) => clearSelectedSession(reply));

  app.get("/api/sessions", async (req) => {
    const query = z.object({ boxId: z.string().optional() }).parse(req.query ?? {});
    return { sessions: store.listSessions(query.boxId) };
  });

  app.get("/api/sessions/:sessionId", async (req) => store.getSession((req.params as any).sessionId));

  app.post("/api/sessions", async (req, reply) => {
    const body = CreateSession.parse(req.body);
    const box = store.getBox(body.boxId);
    await dockerService.assertDirectory(box, cwdToWorkspaceRel(body.cwd));
    const session = await agentManager.createSession(body);
    if (body.autostart) await agentManager.start(session.id);
    reply.code(201);
    return store.getSession(session.id);
  });

  app.post("/api/sessions/:sessionId/start", async (req) => agentManager.start((req.params as any).sessionId));

  app.post("/api/sessions/:sessionId/stop", async (req) => {
    await agentManager.stop((req.params as any).sessionId);
    return store.getSession((req.params as any).sessionId);
  });

  app.post("/api/sessions/:sessionId/abort", async (req) => {
    await agentManager.abort((req.params as any).sessionId);
    return { ok: true };
  });

  app.post("/api/sessions/:sessionId/reload", async (req) => ({ session: await agentManager.reload((req.params as any).sessionId) }));

  app.post("/api/sessions/:sessionId/duplicate", async (req) => {
    const body = DuplicateBody.parse(req.body ?? {});
    return { session: await agentManager.duplicateSession((req.params as any).sessionId, body) };
  });

  app.post("/api/sessions/:sessionId/clone", async (req) => {
    const body = CloneBody.parse(req.body ?? {});
    return agentManager.cloneSession((req.params as any).sessionId, body);
  });

  app.get("/api/sessions/:sessionId/tree", async (req) => ({ tree: await agentManager.sessionTree((req.params as any).sessionId) }));

  app.post("/api/sessions/:sessionId/tree/navigate", async (req) => {
    const body = TreeNavigateBody.parse(req.body ?? {});
    return agentManager.navigateTree((req.params as any).sessionId, body);
  });

  app.get("/api/sessions/:sessionId/fork-messages", async (req) => ({ messages: await agentManager.forkMessages((req.params as any).sessionId) }));

  app.post("/api/sessions/:sessionId/fork", async (req) => {
    const body = ForkBody.parse(req.body ?? {});
    return agentManager.forkSession((req.params as any).sessionId, body);
  });

  app.post("/api/sessions/:sessionId/prompt", async (req) => {
    const body = PromptBody.parse(req.body);
    const sessionId = (req.params as any).sessionId as string;
    if (body.message.trim() === "/reload" && !body.streamingBehavior && !body.images?.length) {
      return { ok: true, reloaded: true, session: await agentManager.reload(sessionId) };
    }
    const result = await agentManager.prompt(sessionId, body);
    return { ok: true, result };
  });

  app.get("/api/sessions/:sessionId/state", async (req) => ({ state: await agentManager.state((req.params as any).sessionId) }));

  app.get("/api/sessions/:sessionId/stats", async (req) => ({ stats: await agentManager.stats((req.params as any).sessionId) }));

  app.get("/api/sessions/:sessionId/messages", async (req) => {
    const query = z.object({ expand: z.string().optional() }).parse(req.query ?? {});
    const expandedMessageIds = parseMessageIdList(query.expand);
    return { messages: await agentManager.messages((req.params as any).sessionId, { expandedMessageIds }) };
  });

  app.get("/api/sessions/:sessionId/messages/:messageId", async (req, reply) => {
    const { sessionId, messageId } = req.params as { sessionId: string; messageId: string };
    const message = await agentManager.message(sessionId, messageId);
    if (message === undefined) {
      reply.code(404);
      return { error: "Message not found" };
    }
    return { message: attachMessageMeta(message, messageId) };
  });

  app.get("/api/sessions/:sessionId/models", async (req) => ({ models: await agentManager.availableModels((req.params as any).sessionId) }));

  app.patch("/api/sessions/:sessionId/model", async (req) => {
    const body = ModelBody.parse(req.body ?? {});
    return agentManager.setModel((req.params as any).sessionId, body.provider, body.modelId);
  });

  app.patch("/api/sessions/:sessionId/thinking", async (req) => {
    const body = ThinkingLevelBody.parse(req.body ?? {});
    return agentManager.setThinkingLevel((req.params as any).sessionId, body.level);
  });

  app.patch("/api/sessions/:sessionId/auto-compaction", async (req) => {
    const body = AutoCompactionBody.parse(req.body ?? {});
    return agentManager.setAutoCompaction((req.params as any).sessionId, body.enabled);
  });

  app.post("/api/sessions/:sessionId/compact", async (req) => {
    const body = CompactBody.parse(req.body ?? {});
    const result = await agentManager.compact((req.params as any).sessionId, body.customInstructions);
    return { ok: true, result };
  });

  app.patch("/api/sessions/:sessionId", async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const body = z.object({ name: z.string().min(1).optional(), cwd: z.string().optional().transform((value) => value === undefined ? undefined : normalizeSessionCwd(value)), model: z.string().optional(), provider: z.string().optional(), thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional() }).parse(req.body ?? {});
    return store.patchSession(sessionId, body);
  });

  app.delete("/api/sessions/:sessionId", async (req) => {
    await agentManager.delete((req.params as any).sessionId);
    return { ok: true };
  });
}

function clearSelectedSession(reply: FastifyReply) {
  clearCookie(reply, ACTIVE_SESSION_COOKIE);
  return { ok: true, sessionId: undefined, activeSessionId: undefined };
}

async function setSelectedSession(req: FastifyRequest, reply: FastifyReply) {
  const body = SelectedSessionBody.parse(req.body ?? {});
  const sessionId = (body.sessionId ?? body.activeSessionId ?? "").trim();
  if (!sessionId) {
    clearCookie(reply, ACTIVE_SESSION_COOKIE);
    return { ok: true, sessionId: undefined, activeSessionId: undefined };
  }
  const session = store.getSession(sessionId);
  setCookie(reply, req, ACTIVE_SESSION_COOKIE, session.id);
  return { ok: true, sessionId: session.id, activeSessionId: session.id, boxId: session.boxId, session };
}

function selectedSessionResponse(sessionId?: string) {
  if (!sessionId) return { sessionId: undefined, activeSessionId: undefined };
  try {
    const session = store.getSession(sessionId);
    return { sessionId: session.id, activeSessionId: session.id, boxId: session.boxId, session };
  } catch {
    return { sessionId: undefined, activeSessionId: undefined };
  }
}

function setCookie(reply: FastifyReply, req: FastifyRequest, name: string, value: string) {
  const secure = shouldUseSecureCookie(req);
  reply.header("set-cookie", `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${ACTIVE_SESSION_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`);
}

function clearCookie(reply: FastifyReply, name: string) {
  reply.header("set-cookie", `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
}

function shouldUseSecureCookie(req: FastifyRequest) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  return forwardedProto === "https";
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    const value = safeDecode(part.slice(idx + 1).trim()).trim();
    return value.length > 0 && value.length <= 200 ? value : undefined;
  }
  return undefined;
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function normalizeSessionCwd(value?: string): string {
  const cwd = value?.trim() || "/workspace";
  if (cwd === "/workspace" || cwd.startsWith("/workspace/")) return cwd.replace(/\/+$/, "") || "/workspace";
  const rel = cwd.replace(/^\/+/, "");
  if (!rel || rel === ".") return "/workspace";
  if (rel.includes("..")) return "/workspace";
  return `/workspace/${rel}`.replace(/\/+$/, "");
}

function cwdToWorkspaceRel(cwd?: string): string {
  const normalized = normalizeSessionCwd(cwd);
  if (normalized === "/workspace") return ".";
  return normalized.slice("/workspace/".length) || ".";
}

function parseMessageIdList(value?: string): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter((item) => /^[A-Za-z0-9_-]{1,120}$/.test(item)).slice(0, 200);
}
