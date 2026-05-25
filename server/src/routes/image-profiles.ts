import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { badRequest } from "../core/errors.js";
import { store } from "../core/store.js";
import { dockerService } from "../docker/docker-service.js";
import { wsHub } from "../ws/hub.js";

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

const StartupSchema = z.object({
  workingDir: z.string().optional(),
  user: z.string().optional(),
  startupScript: z.string().optional(),
  env: z.record(z.string()).optional(),
  extraHosts: z.array(z.string()).optional(),
  shmSizeMb: z.number().int().positive().optional(),
  gpu: z.object({
    enabled: z.boolean(),
    count: z.union([z.literal("all"), z.number().int().positive()]).optional(),
    deviceIds: z.array(z.string()).optional()
  }).optional(),
  devices: z.array(z.object({
    pathOnHost: z.string().min(1),
    pathInContainer: z.string().optional(),
    cgroupPermissions: z.string().optional()
  })).optional(),
  privileged: z.boolean().optional(),
  capAdd: z.array(z.string()).optional(),
  mounts: z.array(z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    readonly: z.boolean().optional()
  })).optional(),
  exposedPorts: z.array(z.number().int().min(1).max(65535)).optional()
});

const BuildContextFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().default(""),
  mode: z.number().int().min(0).max(0o777).optional()
});

const BuildConfigSchema = z.object({
  buildArgs: z.record(z.string()).optional(),
  platform: z.string().optional(),
  target: z.string().optional(),
  noCache: z.boolean().optional(),
  pull: z.boolean().optional(),
  contextFiles: z.array(BuildContextFileSchema).optional()
});

const BoxDefaultsSchema = z.object({
  env: z.record(z.string()).optional(),
  labels: z.record(z.string()).optional(),
  memoryMb: z.number().int().min(128).optional(),
  cpus: z.number().positive().optional(),
  enableCodeServer: z.boolean().optional(),
  codeServerPassword: z.string().optional(),
  pi: PiConfigSchema.optional(),
  startup: StartupSchema.optional()
});

const ImageProfileBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  image: z.string().min(1),
  baseImage: z.string().optional(),
  dockerfile: z.string().min(1),
  build: BuildConfigSchema.optional(),
  boxDefaults: BoxDefaultsSchema.optional(),
  status: z.enum(["draft", "building", "ready", "error"]).optional()
});

const PatchImageProfile = ImageProfileBody.partial();

export async function registerImageProfileRoutes(app: FastifyInstance) {
  app.get("/api/image-profiles", async () => ({ profiles: store.listImageProfiles(), advancedOptionsAllowed: env.BOXEDAGENT_ALLOW_ADVANCED_CONTAINER_OPTIONS }));

  app.get("/api/image-profiles/:profileId", async (req) => store.getImageProfile((req.params as any).profileId));

  app.post("/api/image-profiles", async (req, reply) => {
    const body = ImageProfileBody.parse(req.body ?? {});
    const now = new Date().toISOString();
    const profile = await store.upsertImageProfile({
      id: store.newImageProfileId(),
      name: body.name,
      description: body.description ?? "",
      image: body.image,
      baseImage: body.baseImage,
      dockerfile: body.dockerfile,
      build: body.build ?? {},
      boxDefaults: body.boxDefaults ?? {},
      status: body.status ?? "draft",
      createdAt: now,
      updatedAt: now
    });
    wsHub.publishGlobal({ type: "image_profiles_changed" });
    reply.code(201);
    return profile;
  });

  app.patch("/api/image-profiles/:profileId", async (req) => {
    const profileId = (req.params as any).profileId as string;
    const body = PatchImageProfile.parse(req.body ?? {});
    const profile = await store.patchImageProfile(profileId, { ...body, status: body.status ?? "draft", error: undefined });
    wsHub.publishGlobal({ type: "image_profiles_changed" });
    return profile;
  });

  app.delete("/api/image-profiles/:profileId", async (req) => {
    const profileId = (req.params as any).profileId as string;
    await store.deleteImageProfile(profileId);
    wsHub.publishGlobal({ type: "image_profiles_changed" });
    return { ok: true };
  });

  app.post("/api/image-profiles/:profileId/duplicate", async (req, reply) => {
    const profileId = (req.params as any).profileId as string;
    const body = z.object({ name: z.string().min(1).max(80).optional(), image: z.string().optional() }).parse(req.body ?? {});
    const source = store.getImageProfile(profileId);
    const now = new Date().toISOString();
    const profile = await store.upsertImageProfile({
      ...cloneJson(source),
      id: store.newImageProfileId(),
      name: body.name?.trim() || duplicateName(source.name),
      image: body.image?.trim() || duplicateImageTag(source.image),
      status: "draft",
      error: undefined,
      lastBuiltAt: undefined,
      createdAt: now,
      updatedAt: now
    });
    wsHub.publishGlobal({ type: "image_profiles_changed" });
    reply.code(201);
    return profile;
  });

  app.post("/api/image-profiles/:profileId/build", async (req) => buildProfile((req.params as any).profileId));

  app.post("/api/image-profiles/:profileId/ensure", async (req) => {
    const profile = store.getImageProfile((req.params as any).profileId);
    const status = await dockerService.imageStatus(profile.image);
    if (status.available) {
      await store.patchImageProfile(profile.id, { status: "ready", error: undefined });
      wsHub.publishGlobal({ type: "image_profiles_changed" });
      return { profile: store.getImageProfile(profile.id), image: status };
    }
    return buildProfile(profile.id);
  });
}

async function buildProfile(profileId: string) {
  const profile = store.getImageProfile(profileId);
  if (!profile.dockerfile.trim()) throw badRequest("Dockerfile is empty");
  await store.patchImageProfile(profileId, { status: "building", error: undefined });
  wsHub.publishGlobal({ type: "image_profiles_changed" });
  try {
    const image = await dockerService.buildImageProfile(profile);
    const next = await store.patchImageProfile(profileId, { status: "ready", error: undefined, lastBuiltAt: new Date().toISOString() });
    wsHub.publishGlobal({ type: "image_profiles_changed" });
    return { profile: next, image };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.patchImageProfile(profileId, { status: "error", error: message });
    wsHub.publishGlobal({ type: "image_profiles_changed" });
    throw error;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function duplicateName(name: string): string {
  const suffix = " copy";
  const base = name.trim() || "Image Profile";
  return `${base.slice(0, 80 - suffix.length)}${suffix}`;
}

function duplicateImageTag(image: string): string {
  const match = /^(.+?)(?::([^/:]+))?$/.exec(image.trim());
  if (!match) return `${image}-copy`;
  const repo = match[1];
  const tag = match[2] ?? "latest";
  return `${repo}-copy:${tag}`;
}
