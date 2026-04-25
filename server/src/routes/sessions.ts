import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../core/store.js";
import { agentManager } from "../agent/agent-manager.js";
import { dockerService } from "../docker/docker-service.js";

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

export async function registerSessionRoutes(app: FastifyInstance) {
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

  app.post("/api/sessions/:sessionId/prompt", async (req) => {
    const body = PromptBody.parse(req.body);
    const result = await agentManager.prompt((req.params as any).sessionId, body);
    return { ok: true, result };
  });

  app.get("/api/sessions/:sessionId/state", async (req) => ({ state: await agentManager.state((req.params as any).sessionId) }));

  app.get("/api/sessions/:sessionId/stats", async (req) => ({ stats: await agentManager.stats((req.params as any).sessionId) }));

  app.get("/api/sessions/:sessionId/messages", async (req) => ({ messages: await agentManager.messages((req.params as any).sessionId) }));

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
