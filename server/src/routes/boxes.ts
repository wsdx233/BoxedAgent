import type { FastifyInstance } from "fastify";
import fs from "fs-extra";
import path from "node:path";
import { z } from "zod";
import { store } from "../core/store.js";
import { defaultBoxSpec, dockerService } from "../docker/docker-service.js";
import { paths } from "../config/env.js";
import type { BoxRecord } from "../core/types.js";
import { wsHub } from "../ws/hub.js";
import { listAvailableModelsForBox } from "../agent/model-probe.js";

const PiConfigSchema = z.object({
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultThinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  enabledModels: z.array(z.string()).optional(),
  settingsJson: z.record(z.unknown()).optional(),
  modelsJson: z.record(z.unknown()).optional(),
  systemPrompt: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  agentsMd: z.string().optional(),
  extraArgs: z.array(z.string()).optional()
});

const CreateBox = z.object({
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  image: z.string().optional(),
  env: z.record(z.string()).optional(),
  labels: z.record(z.string()).optional(),
  memoryMb: z.number().int().min(128).optional(),
  cpus: z.number().positive().optional(),
  enableCodeServer: z.boolean().optional(),
  codeServerPassword: z.string().optional(),
  pi: PiConfigSchema.optional(),
  autostart: z.boolean().default(true)
});

const PatchBox = CreateBox.partial().omit({ autostart: true }).extend({ workspacePath: z.string().optional() });

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function duplicateBoxName(name: string): string {
  const suffix = "-copy";
  const base = name.trim() || "box";
  return `${base.slice(0, 80 - suffix.length)}${suffix}`;
}

export async function registerBoxRoutes(app: FastifyInstance) {
  app.get("/api/boxes", async () => ({ boxes: store.listBoxes() }));

  app.get("/api/images/status", async (req) => {
    const query = z.object({ image: z.string().min(1) }).parse(req.query ?? {});
    return dockerService.imageStatus(query.image);
  });

  app.post("/api/images/ensure", async (req) => {
    const body = z.object({ image: z.string().min(1) }).parse(req.body ?? {});
    return dockerService.ensureImage(body.image);
  });

  app.get("/api/boxes/:boxId/models", async (req) => {
    const box = store.getBox((req.params as any).boxId);
    return { models: await listAvailableModelsForBox(box) };
  });

  app.get("/api/boxes/:boxId", async (req) => store.getBox((req.params as any).boxId));

  app.post("/api/boxes", async (req, reply) => {
    const body = CreateBox.parse(req.body);
    const id = store.newBoxId();
    const now = new Date().toISOString();
    const inheritedEnv = Object.fromEntries(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY"].flatMap((k) => process.env[k] ? [[k, process.env[k]!]] : []));
    const spec = defaultBoxSpec({ ...body, env: { ...inheritedEnv, ...(body.env ?? {}) }, workspacePath: path.join(paths.workspacesDir, id) });
    let box: BoxRecord = { id, ...spec, status: "creating", createdAt: now, updatedAt: now };
    box = await store.upsertBox(box);
    wsHub.publishGlobal({ type: "boxes_changed" });
    try {
      const containerId = await dockerService.createContainer(box);
      box = await store.patchBox(id, { containerId, status: "stopped" });
      if (body.autostart) {
        const started = await dockerService.start(box);
        box = await store.patchBox(id, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString() });
      }
      wsHub.publishGlobal({ type: "boxes_changed" });
      reply.code(201);
      return box;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.patchBox(id, { status: "error", error: message });
      throw error;
    }
  });

  app.patch("/api/boxes/:boxId", async (req) => {
    const boxId = (req.params as any).boxId as string;
    const body = PatchBox.parse(req.body);
    const current = store.getBox(boxId);
    const next = await store.patchBox(boxId, {
      ...body,
      env: body.env ? { ...current.env, ...body.env } : current.env,
      labels: body.labels ? { ...current.labels, ...body.labels } : current.labels,
      pi: body.pi ? { ...current.pi, ...body.pi } : current.pi
    });
    wsHub.publishGlobal({ type: "boxes_changed" });
    wsHub.publishBox(boxId, { type: "box_updated", box: next });
    return next;
  });

  app.post("/api/boxes/:boxId/start", async (req) => {
    const boxId = (req.params as any).boxId as string;
    const box = store.getBox(boxId);
    const starting = await store.patchBox(boxId, { status: "starting", error: undefined });
    wsHub.publishGlobal({ type: "boxes_changed" });
    wsHub.publishBox(boxId, { type: "box_updated", box: starting });
    const started = await dockerService.start(starting);
    const next = await store.patchBox(boxId, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString(), error: undefined });
    wsHub.publishGlobal({ type: "boxes_changed" });
    wsHub.publishBox(boxId, { type: "box_updated", box: next });
    return next;
  });

  app.post("/api/boxes/:boxId/stop", async (req) => {
    const boxId = (req.params as any).boxId as string;
    const box = store.getBox(boxId);
    await dockerService.stop(box);
    const next = await store.patchBox(boxId, { status: "stopped" });
    wsHub.publishGlobal({ type: "boxes_changed" });
    wsHub.publishBox(boxId, { type: "box_updated", box: next });
    return next;
  });

  app.post("/api/boxes/:boxId/duplicate", async (req, reply) => {
    const boxId = (req.params as any).boxId as string;
    const body = z.object({ name: z.string().min(1).max(80).optional(), description: z.string().optional(), autostart: z.boolean().default(true) }).parse(req.body ?? {});
    const source = store.getBox(boxId);
    const id = store.newBoxId();
    const now = new Date().toISOString();
    let duplicate: BoxRecord = {
      ...cloneJson(source),
      id,
      name: body.name?.trim() || duplicateBoxName(source.name),
      description: body.description ?? source.description,
      workspacePath: path.join(paths.workspacesDir, id),
      containerId: undefined,
      status: "creating",
      createdAt: now,
      updatedAt: now,
      lastActiveAt: undefined,
      error: undefined
    };
    duplicate = await store.upsertBox(duplicate);
    wsHub.publishGlobal({ type: "boxes_changed" });
    try {
      const containerId = await dockerService.createContainer(duplicate);
      duplicate = await store.patchBox(id, { containerId, status: "stopped" });
      if (body.autostart) {
        const started = await dockerService.start(duplicate);
        duplicate = await store.patchBox(id, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString() });
      }
      wsHub.publishGlobal({ type: "boxes_changed" });
      reply.code(201);
      return duplicate;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.patchBox(id, { status: "error", error: message });
      wsHub.publishGlobal({ type: "boxes_changed" });
      throw error;
    }
  });

  app.post("/api/boxes/:boxId/clone", async (req, reply) => {
    const boxId = (req.params as any).boxId as string;
    const body = z.object({ name: z.string().min(1).max(80), description: z.string().optional(), autostart: z.boolean().default(true) }).parse(req.body ?? {});
    const source = store.getBox(boxId);
    const id = store.newBoxId();
    let image = `boxedagent/clone-${id}:latest`;
    const workspacePath = path.join(paths.workspacesDir, id);
    await fs.copy(source.workspacePath, workspacePath, { overwrite: true, errorOnExist: false });
    const committed = await dockerService.cloneContainerToImage(source, image);
    if (!committed) image = source.image;
    const now = new Date().toISOString();
    let clone: BoxRecord = {
      ...source,
      id,
      name: body.name,
      description: body.description ?? `Clone of ${source.name}`,
      image,
      workspacePath,
      containerId: undefined,
      status: "creating",
      createdAt: now,
      updatedAt: now,
      lastActiveAt: undefined,
      error: undefined
    };
    clone = await store.upsertBox(clone);
    const containerId = await dockerService.createContainer(clone);
    clone = await store.patchBox(id, { containerId, status: "stopped" });
    if (body.autostart) {
      const started = await dockerService.start(clone);
      clone = await store.patchBox(id, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString() });
    }
    wsHub.publishGlobal({ type: "boxes_changed" });
    reply.code(201);
    return clone;
  });

  app.delete("/api/boxes/:boxId", async (req) => {
    const boxId = (req.params as any).boxId as string;
    const query = z.object({ force: z.coerce.boolean().default(false), deleteWorkspace: z.coerce.boolean().default(false) }).parse(req.query ?? {});
    const box = store.getBox(boxId);
    await dockerService.remove(box, query.force).catch((e) => { if (!query.force) throw e; });
    if (query.deleteWorkspace) await fs.remove(box.workspacePath);
    await store.deleteSessionsForBox(boxId);
    const next = await store.patchBox(boxId, { status: "deleted", containerId: undefined });
    wsHub.publishGlobal({ type: "boxes_changed" });
    wsHub.publishBox(boxId, { type: "sessions_changed" });
    return { ok: true, box: next };
  });
}
