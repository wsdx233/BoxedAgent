import type { AgentSessionKind, AgentSessionRecord, BoxRecord, PiModel, PiSlashCommand, SessionStats, ThinkingLevel } from "../core/types.js";
import { store } from "../core/store.js";
import { AgentRuntime, type PromptPayload } from "./agent-runtime.js";
import { TuiRuntime } from "./tui-runtime.js";
import { createPiSessionId, isThinkingLevel, normalizeCustomPiArgs } from "./pi-args.js";
import { wsHub } from "../ws/hub.js";
import { readPiSessionMessage, readPiSessionMessages } from "./session-reader.js";
import { findVisibleEntryIdForActiveMessageIndex, forkPiSessionFromEntry, getPiSessionTree, navigatePiSessionTree } from "./session-tree.js";
import { conflict } from "../core/errors.js";
import { getPiLoadedResourcesForSession } from "./pi-resources.js";

export class AgentManager {
  private runtimes = new Map<string, AgentRuntime>();
  private tuiRuntimes = new Map<string, TuiRuntime>();

  async createSession(input: { boxId: string; name?: string; provider?: string; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string; kind?: AgentSessionKind; launchArgs?: string[] }): Promise<AgentSessionRecord> {
    const box = store.getBox(input.boxId);
    const now = new Date().toISOString();
    const kind: AgentSessionKind = input.kind === "tui" ? "tui" : "chat";
    const session: AgentSessionRecord = {
      id: store.newSessionId(),
      boxId: box.id,
      name: input.name || `${kind === "tui" ? "TUI Session" : "Session"} ${new Date().toLocaleString()}`,
      kind,
      status: "idle",
      cwd: normalizeSessionCwd(input.cwd),
      provider: input.provider || box.pi.defaultProvider,
      model: input.model || box.pi.defaultModel,
      thinkingLevel: input.thinkingLevel || box.pi.defaultThinkingLevel,
      piSessionId: kind === "tui" ? createPiSessionId() : undefined,
      launchArgs: normalizeCustomPiArgs(input.launchArgs),
      createdAt: now,
      updatedAt: now
    };
    const saved = await store.upsertSession(session);
    wsHub.publishBox(box.id, { type: "sessions_changed" });
    return saved;
  }

  async start(id: string, options: { resourceReason?: "startup" | "reload" } = {}): Promise<AgentSessionRecord> {
    const session = store.getSession(id);
    if (session.kind === "tui") {
      const runtime = await this.tuiRuntime(session.id);
      await runtime.start();
      return store.getSession(id);
    }
    const runtime = await this.runtime(session.id);
    await runtime.start(options.resourceReason ?? "startup");
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
    if (session.kind === "tui") {
      const tuiRuntime = this.tuiRuntimes.get(id);
      if (tuiRuntime) {
        await tuiRuntime.stop();
        this.tuiRuntimes.delete(id);
      }
      const reloaded = await this.start(id);
      wsHub.publishBox(session.boxId, { type: "sessions_changed" });
      return reloaded;
    }
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(id);
    }
    const reloaded = await this.start(id, { resourceReason: "reload" });
    wsHub.publishBox(session.boxId, { type: "sessions_changed" });
    return reloaded;
  }

  async duplicateSession(id: string, input: { name?: string; autostart?: boolean } = {}): Promise<AgentSessionRecord> {
    const source = store.getSession(id);
    const now = new Date().toISOString();
    const kind = source.kind === "tui" ? "tui" : "chat";
    const session: AgentSessionRecord = {
      id: store.newSessionId(),
      boxId: source.boxId,
      name: input.name?.trim() || `${source.name} 复刻`,
      kind,
      status: "idle",
      cwd: normalizeSessionCwd(source.cwd),
      provider: source.provider,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
      autoCompactionEnabled: source.autoCompactionEnabled,
      piSessionId: kind === "tui" ? createPiSessionId() : undefined,
      launchArgs: [...(source.launchArgs ?? [])],
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

  async forkSession(id: string, input: { entryId: string; name?: string; useRuntime?: boolean }): Promise<{ session: AgentSessionRecord; text?: string; cancelled?: boolean }> {
    const source = store.getSession(id);
    const box = store.getBox(source.boxId);
    if (input.useRuntime !== false) {
      const runtime = await this.runtime(id);
      const { result, state } = await runtime.fork(input.entryId);
      if (result.cancelled) return { session: source, text: result.text, cancelled: true };
      const saved = await this.createReboundSessionAfterRuntimeSwitch(source, box, runtime, state, input.name?.trim() || `${source.name} fork`);
      return { session: saved, text: result.text, cancelled: false };
    }
    const forked = await forkPiSessionFromEntry(box, source.sessionFile, input.entryId);
    const saved = await this.createSessionFromForkedFile(source, forked.sessionFile, input.name?.trim() || `${source.name} fork`);
    return { session: saved, text: forked.text, cancelled: false };
  }

  async forkSessionFromMessageIndex(id: string, input: { messageIndex: number; name?: string }): Promise<{ session: AgentSessionRecord; text?: string; cancelled?: boolean }> {
    const source = store.getSession(id);
    const box = store.getBox(source.boxId);
    const entryId = await findVisibleEntryIdForActiveMessageIndex(box, source.sessionFile, input.messageIndex);
    if (!entryId) throw conflict("Cannot find a persisted session entry for this message. Please wait until the response is saved, then try again.");
    return this.forkSession(id, { entryId, name: input.name, useRuntime: false });
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
    const session = store.getSession(id);
    if (session.kind === "tui") {
      const tuiRuntime = this.tuiRuntimes.get(id);
      if (tuiRuntime) {
        await tuiRuntime.stop();
        this.tuiRuntimes.delete(id);
      } else {
        await store.patchSession(id, { status: "stopped" });
      }
      return;
    }
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(id);
    } else {
      await store.patchSession(id, { status: "stopped" });
    }
  }

  async state(id: string) {
    const session = store.getSession(id);
    if (session.kind === "tui") return { ...session, isStreaming: false, pendingMessageCount: 0 };
    const runtime = this.runtimes.get(id);
    if (!runtime?.isActive()) return { ...session, isStreaming: false, pendingMessageCount: 0 };
    return runtime.state();
  }

  async availableModels(id: string): Promise<PiModel[]> {
    const runtime = await this.runtime(id);
    return runtime.availableModels();
  }

  async commands(id: string): Promise<PiSlashCommand[]> {
    const runtime = await this.runtime(id);
    return runtime.commands();
  }

  async stats(id: string): Promise<SessionStats | null> {
    const runtime = await this.runtime(id);
    return runtime.stats();
  }

  async loadedResources(id: string) {
    const runtime = this.runtimes.get(id);
    if (runtime?.isActive()) return runtime.loadedResources();
    return getPiLoadedResourcesForSession(id, { reason: "manual" });
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
      return readPiSessionMessages(box, session.sessionFile, { ...options, notices: session.notices });
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
    return readPiSessionMessage(box, session.sessionFile, messageId, session.notices);
  }

  async delete(id: string) {
    await this.stop(id).catch(() => undefined);
    const session = store.getSession(id);
    await store.deleteSession(id);
    wsHub.publishBox(session.boxId, { type: "sessions_changed" });
  }

  async attachTui(id: string, options: { cols?: number; rows?: number } = {}) {
    const runtime = await this.tuiRuntime(id);
    return runtime.attach(options);
  }

  writeTui(id: string, data: string): void {
    const runtime = this.tuiRuntimes.get(id);
    if (!runtime?.isActive()) throw conflict("TUI runtime is not running");
    runtime.write(data);
  }

  async resizeTui(id: string, cols: number, rows: number): Promise<void> {
    const runtime = this.tuiRuntimes.get(id);
    if (!runtime?.isActive()) return;
    await runtime.resize(cols, rows);
  }

  onTuiData(id: string, listener: (chunk: Buffer) => void): () => void {
    const runtime = this.tuiRuntimes.get(id);
    if (!runtime) return () => undefined;
    runtime.on("data", listener);
    return () => runtime.off("data", listener);
  }

  async stopAll() {
    await Promise.all([
      ...[...this.runtimes.values()].map((r) => r.stop().catch(() => undefined)),
      ...[...this.tuiRuntimes.values()].map((r) => r.stop().catch(() => undefined))
    ]);
    this.runtimes.clear();
    this.tuiRuntimes.clear();
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
      kind: "chat",
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

  private async createSessionFromForkedFile(source: AgentSessionRecord, sessionFile: string, name: string): Promise<AgentSessionRecord> {
    const now = new Date().toISOString();
    const session: AgentSessionRecord = {
      id: store.newSessionId(),
      boxId: source.boxId,
      name,
      kind: "chat",
      status: "idle",
      cwd: normalizeSessionCwd(source.cwd),
      provider: source.provider,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
      autoCompactionEnabled: source.autoCompactionEnabled,
      sessionFile,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now
    };
    const saved = await store.upsertSession(session);
    wsHub.publishBox(source.boxId, { type: "sessions_changed" });
    return saved;
  }

  private async runtime(id: string): Promise<AgentRuntime> {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const session = store.getSession(id);
    if (session.kind === "tui") throw conflict("TUI sessions do not expose the chat RPC API");
    const box = store.getBox(session.boxId);
    const runtime = new AgentRuntime(session, box);
    this.runtimes.set(id, runtime);
    return runtime;
  }

  private async tuiRuntime(id: string): Promise<TuiRuntime> {
    const existing = this.tuiRuntimes.get(id);
    if (existing) return existing;
    const session = store.getSession(id);
    if (session.kind !== "tui") throw conflict("session is not a TUI session");
    const box = store.getBox(session.boxId);
    const runtime = new TuiRuntime(session, box);
    this.tuiRuntimes.set(id, runtime);
    return runtime;
  }
}

function normalizeSessionCwd(cwd?: string): string {
  const value = cwd?.trim() || "/workspace";
  if (value === "/workspace" || value.startsWith("/workspace/")) return value.replace(/\/+$/, "") || "/workspace";
  return "/workspace";
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
