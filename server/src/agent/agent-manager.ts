import type { AgentSessionRecord, PiModel, SessionStats, ThinkingLevel } from "../core/types.js";
import { store } from "../core/store.js";
import { AgentRuntime, type PromptPayload } from "./agent-runtime.js";
import { wsHub } from "../ws/hub.js";
import { readPiSessionMessages } from "./session-reader.js";

export class AgentManager {
  private runtimes = new Map<string, AgentRuntime>();

  async createSession(input: { boxId: string; name?: string; provider?: string; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string }): Promise<AgentSessionRecord> {
    const box = store.getBox(input.boxId);
    const now = new Date().toISOString();
    const session: AgentSessionRecord = {
      id: store.newSessionId(),
      boxId: box.id,
      name: input.name || `Session ${new Date().toLocaleString()}`,
      status: "idle",
      cwd: normalizeSessionCwd(input.cwd),
      provider: input.provider || box.pi.defaultProvider,
      model: input.model || box.pi.defaultModel,
      thinkingLevel: input.thinkingLevel || box.pi.defaultThinkingLevel,
      createdAt: now,
      updatedAt: now
    };
    const saved = await store.upsertSession(session);
    wsHub.publishBox(box.id, { type: "sessions_changed" });
    return saved;
  }

  async start(id: string): Promise<AgentSessionRecord> {
    const session = store.getSession(id);
    const runtime = await this.runtime(session.id);
    await runtime.start();
    return store.getSession(id);
  }

  async prompt(id: string, payload: PromptPayload) {
    const runtime = await this.runtime(id);
    return runtime.prompt(payload);
  }

  async abort(id: string) {
    const runtime = this.runtimes.get(id);
    if (!runtime?.isActive()) return { ok: true, skipped: true };
    return runtime.abort();
  }

  async stop(id: string) {
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(id);
    } else {
      await store.patchSession(id, { status: "stopped" });
    }
  }

  async state(id: string) {
    const runtime = this.runtimes.get(id);
    if (!runtime?.isActive()) return { ...store.getSession(id), isStreaming: false, pendingMessageCount: 0 };
    return runtime.state();
  }

  async availableModels(id: string): Promise<PiModel[]> {
    const runtime = await this.runtime(id);
    return runtime.availableModels();
  }

  async stats(id: string): Promise<SessionStats | null> {
    const runtime = await this.runtime(id);
    return runtime.stats();
  }

  async setModel(id: string, provider: string, modelId: string) {
    const runtime = await this.runtime(id);
    const model = await runtime.setModel(provider, modelId);
    const session = store.getSession(id);
    wsHub.publishBox(session.boxId, { type: "sessions_changed" });
    return { session, model };
  }

  async setThinkingLevel(id: string, level: ThinkingLevel) {
    const runtime = await this.runtime(id);
    const state = await runtime.setThinkingLevel(level);
    const session = store.getSession(id);
    wsHub.publishBox(session.boxId, { type: "sessions_changed" });
    return { session, state };
  }

  async setAutoCompaction(id: string, enabled: boolean) {
    const runtime = await this.runtime(id);
    const state = await runtime.setAutoCompaction(enabled);
    const session = store.getSession(id);
    wsHub.publishBox(session.boxId, { type: "sessions_changed" });
    return { session, state };
  }

  async compact(id: string, customInstructions?: string) {
    const runtime = await this.runtime(id);
    return runtime.compact(customInstructions);
  }

  async messages(id: string): Promise<unknown[]> {
    const runtime = this.runtimes.get(id);
    if (runtime?.isActive()) return runtime.messages();
    let session: AgentSessionRecord;
    try {
      session = store.getSession(id);
    } catch (error) {
      if ((error as any)?.code === "NOT_FOUND") return [];
      throw error;
    }
    try {
      const box = store.getBox(session.boxId);
      return readPiSessionMessages(box, session.sessionFile);
    } catch (error) {
      if ((error as any)?.code === "NOT_FOUND") {
        await store.patchSession(id, { status: "error", error: "The Box for this session no longer exists" }).catch(() => undefined);
        return [];
      }
      throw error;
    }
  }

  async delete(id: string) {
    await this.stop(id).catch(() => undefined);
    const session = store.getSession(id);
    await store.deleteSession(id);
    wsHub.publishBox(session.boxId, { type: "sessions_changed" });
  }

  async stopAll() {
    await Promise.all([...this.runtimes.values()].map((r) => r.stop().catch(() => undefined)));
    this.runtimes.clear();
  }

  private async runtime(id: string): Promise<AgentRuntime> {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const session = store.getSession(id);
    const box = store.getBox(session.boxId);
    const runtime = new AgentRuntime(session, box);
    this.runtimes.set(id, runtime);
    return runtime;
  }
}

function normalizeSessionCwd(cwd?: string): string {
  const value = cwd?.trim() || "/workspace";
  if (value === "/workspace" || value.startsWith("/workspace/")) return value.replace(/\/+$/, "") || "/workspace";
  return "/workspace";
}

export const agentManager = new AgentManager();
