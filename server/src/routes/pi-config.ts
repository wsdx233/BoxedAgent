import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../core/store.js";
import { badRequest } from "../core/errors.js";
import type { PiBoxConfig, ThinkingLevel } from "../core/types.js";
import { materializeBoxPiConfig, mergePiSettings, PI_AGENT_DIR_IN_CONTAINER } from "../agent/pi-config.js";
import { wsHub } from "../ws/hub.js";

const Thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const Body = z.object({
  defaultProvider: z.string().optional().nullable(),
  defaultModel: z.string().optional().nullable(),
  defaultThinkingLevel: Thinking.optional().nullable(),
  enabledModels: z.array(z.string()).optional().nullable(),
  settingsJson: z.unknown().optional(),
  modelsJson: z.unknown().optional(),
  settingsJsonText: z.string().optional(),
  modelsJsonText: z.string().optional(),
  systemPrompt: z.string().optional().nullable(),
  appendSystemPrompt: z.string().optional().nullable(),
  agentsMd: z.string().optional().nullable(),
  extraArgs: z.array(z.string()).optional().nullable(),
  env: z.record(z.string()).optional()
});

export async function registerPiConfigRoutes(app: FastifyInstance) {
  app.get("/api/boxes/:boxId/pi-config", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const box = store.getBox(boxId);
    return {
      pi: box.pi,
      env: box.env,
      materialized: {
        piCodingAgentDir: PI_AGENT_DIR_IN_CONTAINER,
        settings: mergePiSettings(box.pi)
      }
    };
  });

  app.put("/api/boxes/:boxId/pi-config", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const body = Body.parse(req.body ?? {});
    const box = store.getBox(boxId);
    const nextPi: PiBoxConfig = {
      ...box.pi,
      defaultProvider: clean(body.defaultProvider),
      defaultModel: clean(body.defaultModel),
      defaultThinkingLevel: (body.defaultThinkingLevel ?? box.pi.defaultThinkingLevel ?? "medium") as ThinkingLevel,
      enabledModels: body.enabledModels ?? box.pi.enabledModels ?? [],
      settingsJson: parseObject(body.settingsJsonText, body.settingsJson, "settingsJson"),
      modelsJson: parseObject(body.modelsJsonText, body.modelsJson, "modelsJson"),
      systemPrompt: body.systemPrompt ?? "",
      appendSystemPrompt: body.appendSystemPrompt ?? "",
      agentsMd: body.agentsMd ?? "",
      extraArgs: body.extraArgs ?? []
    };
    const next = await store.patchBox(boxId, { pi: nextPi, env: body.env ? { ...box.env, ...body.env } : box.env });
    await materializeBoxPiConfig(next);
    wsHub.publishBox(boxId, { type: "box_updated", box: next });
    wsHub.publishGlobal({ type: "boxes_changed" });
    return { pi: next.pi, env: next.env, materialized: { piCodingAgentDir: PI_AGENT_DIR_IN_CONTAINER, settings: mergePiSettings(next.pi) } };
  });
}

function clean(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseObject(text: string | undefined, value: unknown, field: string): Record<string, unknown> {
  const raw = text !== undefined ? parseJson(text, field) : value;
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw badRequest(`${field} must be a JSON object`);
  return raw as Record<string, unknown>;
}

function parseJson(text: string, field: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw badRequest(`${field} is not valid JSON`, error instanceof Error ? error.message : String(error));
  }
}
