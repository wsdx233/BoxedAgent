import type { AgentSessionRecord, BoxRecord, PiModel, SessionStats, ThinkingLevel } from "../core/types.js";
import { store } from "../core/store.js";
import { AgentRuntime, type PromptPayload } from "./agent-runtime.js";
import { wsHub } from "../ws/hub.js";
import { readPiSessionMessage, readPiSessionMessages } from "./session-reader.js";
import { getPiSessionTree, navigatePiSessionTree } from "./session-tree.js";
import { conflict } from "../core/errors.js";

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

  async reload(id: string): Promise<AgentSessionRecord> {
    const session = store.getSession(id);
    if (session.status === "working") throw conflict("Cannot reload session while agent is working");
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(id);
    }
    const reloaded = await this.start(id);
    wsHub.publishBox(session.boxId, { type: "sessions_changed" });
    return reloaded;
  }

  async duplicateSession(id: string, input: { name?: string; autostart?: boolean } = {}): Promise<AgentSessionRecord> {
    const source = store.getSession(id);
    const now = new Date().toISOString();
    const session: AgentSessionRecord = {
      id: store.newSessionId(),
      boxId: source.boxId,
      name: input.name?.trim() || `${source.name} 复刻`,
      status: "idle",
      cwd: normalizeSessionCwd(source.cwd),
      provider: source.provider,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
      autoCompactionEnabled: source.autoCompactionEnabled,
      createdAt: now,
      updatedAt: now
    };
    const saved = await store.upsertSession(session);
    if (input.autostart ?? true) await this.start(saved.id);
    wsHub.publishBox(source.boxId, { type: "sessions_changed" });
    return store.getSession(saved.id);
  }

  async forkMessages(id: string): Promise<Array<{ entryId: string; text: string }>> {
    const runtime = await this.runtime(id);
    return runtime.forkMessages();
  }

  async forkSession(id: string, input: { entryId: string; name?: string }): Promise<{ session: AgentSessionRecord; text?: string; cancelled?: boolean }> {
    const source = store.getSession(id);
    const box = store.getBox(source.boxId);
    const runtime = await this.runtime(id);
    const { result, state } = await runtime.fork(input.entryId);
    if (result.cancelled) return { session: source, text: result.text, cancelled: true };
    const saved = await this.createReboundSessionAfterRuntimeSwitch(source, box, runtime, state, input.name?.trim() || `${source.name} fork`);
    return { session: saved, text: result.text, cancelled: false };
  }

  async cloneSession(id: string, input: { name?: string } = {}): Promise<{ session: AgentSessionRecord; cancelled?: boolean }> {
    const source = store.getSession(id);
    if (source.status === "working") throw conflict("Cannot clone session while agent is working");
    const box = store.getBox(source.boxId);
    const runtime = await this.runtime(id);
    const { result, state } = await runtime.clone();
    if (result.cancelled) return { session: source, cancelled: true };
    const saved = await this.createReboundSessionAfterRuntimeSwitch(source, box, runtime, state, input.name?.trim() || `${source.name} clone`);
    return { session: saved, cancelled: false };
  }

  async sessionTree(id: string) {
    const session = store.getSession(id);
    const box = store.getBox(session.boxId);
    return getPiSessionTree(box, session.sessionFile);
  }

  async navigateTree(id: string, input: { targetId: string }): Promise<{ session: AgentSessionRecord; editorText?: string; activeId: string | null }> {
    const session = store.getSession(id);
    if (session.status === "working") throw conflict("Cannot navigate session tree while agent is working");
    const box = store.getBox(session.boxId);
    await this.stop(id).catch(() => undefined);
    const result = await navigatePiSessionTree(box, session.sessionFile, input.targetId);
    const updated = await store.patchSession(id, { status: "stopped", lastActiveAt: new Date().toISOString() });
    wsHub.publishBox(session.boxId, { type: "sessions_changed" });
    return { session: updated, editorText: result.editorText, activeId: result.activeId };
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

  async messages(id: string, options: { expandedMessageIds?: Iterable<string> } = {}): Promise<unknown[]> {
    const runtime = this.runtimes.get(id);
    if (runtime?.isActive()) return runtime.messages(options);
    let session: AgentSessionRecord;
    try {
      session = store.getSession(id);
    } catch (error) {
      if ((error as any)?.code === "NOT_FOUND") return [];
      throw error;
    }
    try {
      const box = store.getBox(session.boxId);
      return readPiSessionMessages(box, session.sessionFile, options);
    } catch (error) {
      if ((error as any)?.code === "NOT_FOUND") {
        await store.patchSession(id, { status: "error", error: "The Box for this session no longer exists" }).catch(() => undefined);
        return [];
      }
      throw error;
    }
  }

  async message(id: string, messageId: string): Promise<unknown | undefined> {
    const runtime = this.runtimes.get(id);
    if (runtime?.isActive()) return runtime.message(messageId);
    const session = store.getSession(id);
    const box = store.getBox(session.boxId);
    return readPiSessionMessage(box, session.sessionFile, messageId);
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

  private async createReboundSessionAfterRuntimeSwitch(source: AgentSessionRecord, box: BoxRecord, runtime: AgentRuntime, state: Record<string, unknown>, name: string): Promise<AgentSessionRecord> {
    try {
      return await this.createReboundSession(source, box, runtime, state, name);
    } catch (error) {
      await runtime.stop().catch(() => undefined);
      this.runtimes.delete(source.id);
      throw error;
    }
  }

  private async createReboundSession(source: AgentSessionRecord, box: BoxRecord, runtime: AgentRuntime, state: Record<string, unknown>, name: string): Promise<AgentSessionRecord> {
    const now = new Date().toISOString();
    const model = state.model as PiModel | null | undefined;
    const session: AgentSessionRecord = {
      id: store.newSessionId(),
      boxId: source.boxId,
      name,
      status: "running",
      cwd: normalizeSessionCwd(source.cwd),
      provider: modelProvider(model) ?? source.provider,
      model: model?.id ?? source.model,
      thinkingLevel: isThinkingLevel(state.thinkingLevel) ? state.thinkingLevel : source.thinkingLevel,
      autoCompactionEnabled: typeof state.autoCompactionEnabled === "boolean" ? state.autoCompactionEnabled : source.autoCompactionEnabled,
      sessionFile: reboundSessionFile(source, state),
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now
    };
    const saved = await store.upsertSession(session);
    await store.patchSession(source.id, { status: "stopped", lastActiveAt: now }).catch(() => undefined);
    this.runtimes.delete(source.id);
    runtime.rebind(saved, box);
    this.runtimes.set(saved.id, runtime);
    wsHub.publishBox(source.boxId, { type: "sessions_changed" });
    return store.getSession(saved.id);
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

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function modelProvider(model: PiModel | null | undefined): string | undefined {
  const provider = model?.provider ?? model?.providerId ?? model?.providerName;
  return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
}

function reboundSessionFile(source: AgentSessionRecord, state: Record<string, unknown>): string {
  const value = typeof state.sessionFile === "string" ? state.sessionFile.trim() : "";
  if (!value) throw conflict("Pi did not return a session file for the cloned/forked session; refusing to create a session that may share history with the source.");
  if (source.sessionFile && normalizeSessionFile(value) === normalizeSessionFile(source.sessionFile)) {
    throw conflict("Pi returned the source session file for the cloned/forked session; refusing to create a session that would share history with the source.");
  }
  return value;
}

function normalizeSessionFile(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export const agentManager = new AgentManager();
