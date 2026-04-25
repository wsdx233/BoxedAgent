import path from "node:path";
import fs from "fs-extra";
import type { BoxRecord, PiBoxConfig } from "../core/types.js";

export const PI_AGENT_DIR_IN_CONTAINER = "/workspace/.boxedagent/pi-agent";
export const PI_PROJECT_DIR_IN_CONTAINER = "/workspace/.pi";

export function piRuntimeEnv(_box: BoxRecord): string[] {
  return [
    `PI_CODING_AGENT_DIR=${PI_AGENT_DIR_IN_CONTAINER}`,
    "PI_SKIP_VERSION_CHECK=1",
    "PI_TELEMETRY=0"
  ];
}

export function mergePiSettings(pi: PiBoxConfig): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    quietStartup: true,
    enableInstallTelemetry: false,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 },
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    ...(pi.settingsJson ?? {})
  };
  if (pi.defaultProvider) settings.defaultProvider = pi.defaultProvider;
  if (pi.defaultModel) settings.defaultModel = pi.defaultModel;
  if (pi.defaultThinkingLevel) settings.defaultThinkingLevel = pi.defaultThinkingLevel;
  if (pi.enabledModels?.length) settings.enabledModels = pi.enabledModels;
  settings.sessionDir = "/workspace/.pi-sessions";
  return settings;
}

export async function materializeBoxPiConfig(box: BoxRecord): Promise<void> {
  const pi = box.pi ?? {};
  const agentDir = path.join(box.workspacePath, ".boxedagent", "pi-agent");
  const projectPiDir = path.join(box.workspacePath, ".pi");
  await fs.ensureDir(agentDir);
  await fs.ensureDir(projectPiDir);
  await fs.ensureDir(path.join(box.workspacePath, ".pi-sessions"));

  await fs.writeJson(path.join(agentDir, "settings.json"), mergePiSettings(pi), { spaces: 2 });

  if (pi.modelsJson && Object.keys(pi.modelsJson).length > 0) {
    await fs.writeJson(path.join(agentDir, "models.json"), pi.modelsJson, { spaces: 2 });
  } else {
    await fs.remove(path.join(agentDir, "models.json"));
  }

  await writeOrRemove(path.join(agentDir, "AGENTS.md"), pi.agentsMd);
  await writeOrRemove(path.join(projectPiDir, "SYSTEM.md"), pi.systemPrompt);
  await writeOrRemove(path.join(projectPiDir, "APPEND_SYSTEM.md"), pi.appendSystemPrompt);
}

async function writeOrRemove(file: string, content?: string) {
  if (content && content.trim().length > 0) {
    await fs.ensureDir(path.dirname(file));
    await fs.writeFile(file, content, "utf8");
  } else {
    await fs.remove(file);
  }
}

export function hostPathForContainerWorkspacePath(box: BoxRecord, containerPath?: string): string | undefined {
  if (!containerPath) return undefined;
  if (!containerPath.startsWith("/workspace")) return undefined;
  const rel = containerPath.slice("/workspace".length).replace(/^\/+/, "");
  return path.join(box.workspacePath, rel);
}
