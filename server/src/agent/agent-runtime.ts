import { StringDecoder } from "node:string_decoder";
import { PassThrough } from "node:stream";
import type { Exec } from "dockerode";
import fs from "fs-extra";
import type { BoxRecord, AgentSessionRecord, AgentSessionStatus, PiModel, PiSlashCommand, SessionStats, ThinkingLevel } from "../core/types.js";
import { dockerService } from "../docker/docker-service.js";
import { store } from "../core/store.js";
import { wsHub } from "../ws/hub.js";
import { conflict } from "../core/errors.js";
import { hostPathForContainerWorkspacePath, materializeBoxPiConfig, piRuntimeEnv } from "./pi-config.js";
import { attachMessageMeta, findSessionMessageById, truncateSessionMessages } from "./message-truncation.js";
import { buildPiRuntimeArgs } from "./pi-args.js";
import { collectPiLoadedResources } from "./pi-resources.js";
import { ensureCompatiblePiCli } from "./pi-version.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface PromptPayload {
  message: string;
  streamingBehavior?: "steer" | "followUp";
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface AgentStateSnapshot {
  model?: PiModel | null;
  thinkingLevel?: ThinkingLevel;
  autoCompactionEnabled?: boolean;
  [key: string]: unknown;
}

export class AgentRuntime {
  private exec?: Exec;
  private stream?: NodeJS.ReadWriteStream;
  private pending = new Map<string, PendingRequest>();
  private seq = 0;
  private stdoutBuffer = "";
  private decoder = new StringDecoder("utf8");
  private recentStderr = "";
  private stopped = false;
  private workRequested = false;
  private liveStatus?: AgentSessionStatus;
  private extensionCommandIdleTimer?: NodeJS.Timeout;

  constructor(public record: AgentSessionRecord, private box: BoxRecord) {}

  rebind(record: AgentSessionRecord, box: BoxRecord): void {
    this.record = record;
    this.box = box;
    this.liveStatus = undefined;
  }

  isActive(): boolean {
    return Boolean(this.stream && !this.stopped);
  }

  async start(resourceReason: "startup" | "reload" = "startup"): Promise<void> {
    if (this.stream && !this.stopped) return;
    this.syncRecordFromStore();
    this.stopped = false;
    this.recentStderr = "";
    const initialStatus: AgentSessionStatus = this.workRequested ? "working" : "starting";
    await store.patchSession(this.record.id, { status: initialStatus, error: undefined });
    this.publishStatus(initialStatus);

    try {
      const startingBox = await store.patchBox(this.box.id, { status: "starting", error: undefined });
      await materializeBoxPiConfig(startingBox);
      const started = await dockerService.start(startingBox);
      this.box = await store.patchBox(this.box.id, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString(), error: undefined });
      await ensureCompatiblePiCli(this.box).catch((error) => {
        wsHub.publishSession(this.record.id, { type: "agent_warning", warning: `failed to auto-upgrade pi in Box: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      });

      const args = buildPiRuntimeArgs(this.record, this.box, { mode: "rpc" });
      const cwd = normalizeSessionCwd(this.record.cwd);
      await dockerService.assertDirectory(this.box, cwdToWorkspaceRel(cwd));
      this.exec = await dockerService.createInteractiveExec(this.box, args, { cwd, tty: false, env: piRuntimeEnv(this.box) });
      const stream = await this.exec.start({ hijack: true, stdin: true });
      this.stream = stream as NodeJS.ReadWriteStream;

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      dockerService.docker.modem.demuxStream(stream, stdout, stderr);
      stdout.on("data", (chunk) => this.handleStdout(chunk));
      stderr.on("data", (chunk) => this.handleStderr(chunk));
      stream.on("error", (error) => this.fail(error));
      stream.on("close", () => this.onClose());
      stream.on("end", () => this.onClose());

      const readyStatus: AgentSessionStatus = this.workRequested ? "working" : "running";
      await store.patchSession(this.record.id, { status: readyStatus, lastActiveAt: new Date().toISOString() });
      this.publishStatus(readyStatus);
      await this.refreshLoadedResources(resourceReason).catch((error) => {
        wsHub.publishSession(this.record.id, { type: "agent_warning", warning: error instanceof Error ? error.message : String(error) });
      });
      await this.refreshSessionState().catch((error) => {
        wsHub.publishSession(this.record.id, { type: "agent_warning", warning: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await store.patchSession(this.record.id, { status: "error", error: text });
      this.publishStatus("error", text);
      throw error;
    }
  }

  async prompt(payload: PromptPayload) {
    this.workRequested = true;
    await store.patchSession(this.record.id, { status: "working", lastActiveAt: new Date().toISOString() });
    this.publishStatus("working");
    await this.start();
    await store.patchSession(this.record.id, { status: "working", lastActiveAt: new Date().toISOString() });
    this.publishStatus("working");
    const extensionCommandPrompt = await this.isExtensionCommandPrompt(payload).catch(() => false);
    try {
      const result = await this.send({ type: "prompt", ...payload });
      if (extensionCommandPrompt) this.scheduleExtensionCommandIdleCheck();
      return result;
    } catch (error) {
      this.workRequested = false;
      await store.patchSession(this.record.id, { status: "running", lastActiveAt: new Date().toISOString() }).catch(() => undefined);
      this.publishStatus("running");
      throw error;
    }
  }

  async steer(message: string) {
    await this.start();
    return this.send({ type: "steer", message });
  }

  async followUp(message: string) {
    await this.start();
    return this.send({ type: "follow_up", message });
  }

  async abort() {
    return this.send({ type: "abort" }, 5_000);
  }

  async state(): Promise<AgentStateSnapshot> {
    await this.start();
    return this.send({ type: "get_state" }) as Promise<AgentStateSnapshot>;
  }

  async messages(options: { expandedMessageIds?: Iterable<string> } = {}): Promise<unknown[]> {
    await this.start();
    const data = await this.send({ type: "get_messages" }) as any;
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    return truncateSessionMessages(messages, options);
  }

  async message(messageId: string): Promise<unknown | undefined> {
    await this.start();
    const data = await this.send({ type: "get_messages" }) as any;
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const message = findSessionMessageById(messages, messageId);
    return message === undefined ? undefined : attachMessageMeta(message, messageId);
  }

  async forkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    await this.start();
    const data = await this.send({ type: "get_fork_messages" }, 30_000) as any;
    return Array.isArray(data?.messages) ? data.messages : [];
  }

  async fork(entryId: string): Promise<{ result: { text?: string; cancelled?: boolean }; state: AgentStateSnapshot }> {
    await this.start();
    const result = await this.send({ type: "fork", entryId }, 120_000) as { text?: string; cancelled?: boolean };
    const state = await this.send({ type: "get_state" }, 30_000) as AgentStateSnapshot;
    return { result, state };
  }

  async clone(): Promise<{ result: { cancelled?: boolean }; state: AgentStateSnapshot }> {
    await this.start();
    const result = await this.send({ type: "clone" }, 120_000) as { cancelled?: boolean };
    const state = await this.send({ type: "get_state" }, 30_000) as AgentStateSnapshot;
    return { result, state };
  }

  async availableModels(): Promise<PiModel[]> {
    await this.start();
    const data = await this.send({ type: "get_available_models" }, 30_000) as any;
    return Array.isArray(data?.models) ? data.models : [];
  }

  async commands(): Promise<PiSlashCommand[]> {
    await this.start();
    const data = await this.send({ type: "get_commands" }, 30_000) as any;
    return normalizePiSlashCommands(data);
  }

  async stats(): Promise<SessionStats> {
    await this.start();
    const stats = await this.send({ type: "get_session_stats" }, 30_000) as SessionStats;
    return { ...stats, loadedResources: this.record.loadedResources };
  }

  async loadedResources() {
    await this.start();
    return this.refreshLoadedResources("manual");
  }

  async setModel(provider: string, modelId: string): Promise<PiModel | null> {
    await this.start();
    const model = await this.send({ type: "set_model", provider, modelId }, 30_000) as PiModel | null;
    await store.patchSession(this.record.id, {
      provider: modelProvider(model) ?? provider,
      model: model?.id ?? modelId,
      lastActiveAt: new Date().toISOString()
    });
    return model;
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<AgentStateSnapshot> {
    await this.start();
    await this.send({ type: "set_thinking_level", level }, 30_000);
    await store.patchSession(this.record.id, { thinkingLevel: level, lastActiveAt: new Date().toISOString() });
    return this.state() as Promise<AgentStateSnapshot>;
  }

  async setAutoCompaction(enabled: boolean): Promise<AgentStateSnapshot> {
    await this.start();
    await this.send({ type: "set_auto_compaction", enabled }, 30_000);
    await store.patchSession(this.record.id, { autoCompactionEnabled: enabled, lastActiveAt: new Date().toISOString() });
    return this.state() as Promise<AgentStateSnapshot>;
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.workRequested = true;
    await store.patchSession(this.record.id, { status: "working", lastActiveAt: new Date().toISOString() });
    this.publishStatus("working");
    await this.start();
    await store.patchSession(this.record.id, { status: "working", lastActiveAt: new Date().toISOString() });
    this.publishStatus("working");
    const command: Record<string, unknown> = { type: "compact" };
    if (customInstructions?.trim()) command.customInstructions = customInstructions.trim();
    try {
      return await this.send(command, 600_000);
    } catch (error) {
      this.workRequested = false;
      await store.patchSession(this.record.id, { status: "running", lastActiveAt: new Date().toISOString() }).catch(() => undefined);
      this.publishStatus("running");
      throw error;
    }
  }

  async stop() {
    this.stopped = true;
    this.workRequested = false;
    if (this.extensionCommandIdleTimer) {
      clearTimeout(this.extensionCommandIdleTimer);
      this.extensionCommandIdleTimer = undefined;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("agent stopped"));
    }
    this.pending.clear();
    (this.stream as any)?.destroy?.();
    this.stream = undefined;
    await store.patchSession(this.record.id, { status: "stopped" });
    this.publishStatus("stopped");
  }

  private async refreshLoadedResources(reason: "startup" | "reload" | "manual") {
    const resources = await collectPiLoadedResources(this.box, this.record.cwd, { reason });
    this.record = await store.patchSession(this.record.id, { loadedResources: resources, cwd: resources.cwd, lastActiveAt: new Date().toISOString() });
    wsHub.publishSession(this.record.id, { type: "loaded_resources", resources });
    wsHub.publishBox(this.box.id, { type: "sessions_changed" });
    return resources;
  }

  private async refreshSessionState() {
    const state = await this.send({ type: "get_state" }, 30_000) as any;
    const nextSessionFile = await this.sessionFilePatchValue(state?.sessionFile);
    const patch: Partial<AgentSessionRecord> = {
      provider: modelProvider(state?.model) ?? this.record.provider,
      model: state?.model?.id ?? this.record.model,
      thinkingLevel: state?.thinkingLevel ?? this.record.thinkingLevel,
      autoCompactionEnabled: typeof state?.autoCompactionEnabled === "boolean" ? state.autoCompactionEnabled : this.record.autoCompactionEnabled,
      cwd: normalizeSessionCwd(this.record.cwd),
      lastActiveAt: new Date().toISOString()
    };
    if (nextSessionFile) patch.sessionFile = nextSessionFile;
    if (state?.sessionName) patch.name = state.sessionName;
    this.record = await store.patchSession(this.record.id, patch);
  }

  private syncRecordFromStore() {
    this.record = store.getSession(this.record.id);
    this.box = store.getBox(this.record.boxId);
  }

  private async sessionFilePatchValue(value: unknown): Promise<string | undefined> {
    const nextSessionFile = typeof value === "string" ? value.trim() : "";
    if (!nextSessionFile) return undefined;
    const currentSessionFile = this.record.sessionFile?.trim();
    if (!currentSessionFile) return nextSessionFile;
    if (normalizeSessionFile(nextSessionFile) === normalizeSessionFile(currentSessionFile)) return nextSessionFile;

    const [currentExists, nextExists] = await Promise.all([
      this.sessionFileExists(currentSessionFile),
      this.sessionFileExists(nextSessionFile)
    ]);
    if (nextExists || !currentExists) return nextSessionFile;

    wsHub.publishSession(this.record.id, {
      type: "agent_warning",
      warning: `pi returned a new session file that does not exist yet (${nextSessionFile}); keeping existing history file (${currentSessionFile}).`
    });
    return undefined;
  }

  private async sessionFileExists(containerPath: string): Promise<boolean> {
    const hostPath = hostPathForContainerWorkspacePath(this.box, containerPath);
    return Boolean(hostPath && await fs.pathExists(hostPath));
  }

  private send(command: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
    if (!this.stream || this.stopped) throw conflict("agent runtime is not running");
    const id = `req_${++this.seq}`;
    const payload = { id, ...command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeRpcLine(id, payload, timer, reject);
    });
  }

  private writeRpcLine(id: string, payload: Record<string, unknown>, timer: NodeJS.Timeout, reject: (reason?: unknown) => void) {
    const line = `${JSON.stringify(payload)}\n`;
    setImmediate(() => {
      if (!this.stream || this.stopped) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(conflict("agent runtime is not running"));
        return;
      }
      const writable = this.stream.write(line, "utf8", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
      if (!writable) this.stream.once("drain", () => undefined);
    });
  }

  private handleStderr(chunk: Buffer) {
    const text = chunk.toString("utf8");
    if (text) {
      this.recentStderr = tailText(`${this.recentStderr}${text}`, 12_000);
      wsHub.publishSession(this.record.id, { type: "agent_stderr", data: text });
    }
  }

  private handleStdout(chunk: Buffer) {
    this.stdoutBuffer += this.decoder.write(chunk);
    while (true) {
      const idx = this.stdoutBuffer.indexOf("\n");
      if (idx < 0) break;
      let line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      wsHub.publishSession(this.record.id, { type: "agent_raw", line });
      return;
    }

    if (message.type === "extension_ui_request") {
      this.handleExtensionUiRequest(message);
      return;
    }

    if (message.type === "response" && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data ?? message);
      else pending.reject(new Error(message.error ?? "RPC command failed"));
      return;
    }

    const eventStatus = sessionStatusForAgentEvent(message);
    if (eventStatus === "working") this.workRequested = true;
    if (eventStatus === "running") this.workRequested = false;
    void store.patchSession(this.record.id, { lastActiveAt: new Date().toISOString(), status: eventStatus ?? (this.workRequested ? "working" : "running") }).catch(() => undefined);
    if (eventStatus) this.publishStatus(eventStatus);
    setImmediate(() => wsHub.publishSession(this.record.id, { type: "agent_event", event: message }));
  }

  private async isExtensionCommandPrompt(payload: PromptPayload): Promise<boolean> {
    if (payload.images?.length) return false;
    const commandName = slashCommandNameFromPrompt(payload.message);
    if (!commandName) return false;
    const commands = await this.commands();
    return commands.some((command) => command.source === "extension" && command.name === commandName);
  }

  private scheduleExtensionCommandIdleCheck() {
    if (this.extensionCommandIdleTimer) clearTimeout(this.extensionCommandIdleTimer);
    this.extensionCommandIdleTimer = setTimeout(() => {
      this.extensionCommandIdleTimer = undefined;
      void this.refreshIdleStatusAfterExtensionCommand();
    }, 300);
  }

  private async refreshIdleStatusAfterExtensionCommand() {
    if (!this.stream || this.stopped) return;
    try {
      const state = await this.send({ type: "get_state" }, 5_000) as any;
      const pendingCount = Number(state?.pendingMessageCount ?? 0);
      if (state?.isStreaming || state?.isCompacting || pendingCount > 0) return;
      this.workRequested = false;
      await store.patchSession(this.record.id, { status: "running", lastActiveAt: new Date().toISOString() });
      this.publishStatus("running");
    } catch {
      // Older pi builds or session replacement during an extension command may reject get_state.
    }
  }

  private handleExtensionUiRequest(message: any) {
    if (message.method === "notify") {
      wsHub.publishSession(this.record.id, { type: "extension_ui", request: message });
      const text = typeof message.message === "string" ? message.message : "";
      if (text) wsHub.publishSession(this.record.id, { type: "agent_event", event: { type: "extension_notify", notifyType: message.notifyType ?? "info", message: text } });
      return;
    }
    wsHub.publishSession(this.record.id, { type: "extension_ui", request: message });
    if (message.method === "setStatus" || message.method === "setWidget" || message.method === "setTitle" || message.method === "set_editor_text") return;
    const response = { type: "extension_ui_response", id: message.id, cancelled: true };
    this.stream?.write(`${JSON.stringify(response)}\n`, "utf8");
  }

  private fail(error: unknown) {
    this.workRequested = false;
    const base = error instanceof Error ? error.message : String(error);
    const stderr = this.recentStderr.trim();
    const text = stderr ? `${base}\nstderr:\n${stderr}` : base;
    void store.patchSession(this.record.id, { status: "error", error: text });
    this.publishStatus("error", text);
  }

  private onClose() {
    if (this.stopped) return;
    this.stopped = true;
    this.workRequested = false;
    if (this.extensionCommandIdleTimer) {
      clearTimeout(this.extensionCommandIdleTimer);
      this.extensionCommandIdleTimer = undefined;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("agent process exited"));
    }
    this.pending.clear();
    this.stream = undefined;
    const stderr = this.recentStderr.trim();
    const error = stderr ? `agent process exited\nstderr:\n${stderr}` : "agent process exited";
    void store.patchSession(this.record.id, { status: "error", error }).catch(() => undefined);
    this.publishStatus("error", error);
  }

  private publishStatus(status: AgentSessionStatus, error?: string) {
    if (this.liveStatus === status && !error) return;
    this.liveStatus = status;
    wsHub.publishSession(this.record.id, { type: "session_status", status, error });
    wsHub.publishBox(this.box.id, { type: "sessions_changed" });
  }
}

function normalizePiSlashCommands(data: any): PiSlashCommand[] {
  const commands = Array.isArray(data?.commands) ? data.commands : [];
  return commands.flatMap((item: any): PiSlashCommand[] => {
    if (!item || typeof item !== "object") return [];
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const source = typeof item.source === "string" ? item.source : "";
    if (!name || (source !== "extension" && source !== "prompt" && source !== "skill")) return [];
    const description = typeof item.description === "string" && item.description.trim() ? item.description.trim() : undefined;
    const sourceInfo = item.sourceInfo && typeof item.sourceInfo === "object" && !Array.isArray(item.sourceInfo) ? item.sourceInfo as Record<string, unknown> : undefined;
    return [{ name, source, ...(description ? { description } : {}), ...(sourceInfo ? { sourceInfo } : {}) }];
  });
}

function slashCommandNameFromPrompt(message: string): string | undefined {
  const text = message.trimEnd();
  if (!text.startsWith("/")) return undefined;
  const name = text.slice(1).split(/\s+/, 1)[0]?.trim();
  return name || undefined;
}

function sessionStatusForAgentEvent(message: any): AgentSessionStatus | undefined {
  switch (message?.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "compaction_start":
    case "auto_retry_start":
      return "working";
    case "agent_end":
    case "turn_end":
    case "compaction_end":
    case "auto_retry_end":
      return "running";
    default:
      return undefined;
  }
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function modelProvider(model: PiModel | null | undefined): string | undefined {
  const provider = model?.provider ?? model?.providerId ?? model?.providerName;
  return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
}

function normalizeSessionCwd(cwd?: string): string {
  const value = cwd?.trim() || "/workspace";
  if (value === "/workspace" || value.startsWith("/workspace/")) return value.replace(/\/+$/, "") || "/workspace";
  return "/workspace";
}

function normalizeSessionFile(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function cwdToWorkspaceRel(cwd?: string): string {
  const normalized = normalizeSessionCwd(cwd);
  if (normalized === "/workspace") return ".";
  return normalized.slice("/workspace/".length) || ".";
}
