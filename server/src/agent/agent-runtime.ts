import { StringDecoder } from "node:string_decoder";
import { PassThrough } from "node:stream";
import type { Exec } from "dockerode";
import type { BoxRecord, AgentSessionRecord, AgentSessionStatus, PiModel, SessionStats, ThinkingLevel } from "../core/types.js";
import { dockerService } from "../docker/docker-service.js";
import { store } from "../core/store.js";
import { wsHub } from "../ws/hub.js";
import { conflict } from "../core/errors.js";
import { piRuntimeEnv } from "./pi-config.js";

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
  private stopped = false;
  private liveStatus?: AgentSessionStatus;

  constructor(public readonly record: AgentSessionRecord, private readonly box: BoxRecord) {}

  isActive(): boolean {
    return Boolean(this.stream && !this.stopped);
  }

  async start(): Promise<void> {
    if (this.stream && !this.stopped) return;
    this.stopped = false;
    await store.patchSession(this.record.id, { status: "starting", error: undefined });
    this.publishStatus("starting");

    try {
      const startingBox = await store.patchBox(this.box.id, { status: "starting", error: undefined });
      const started = await dockerService.start(startingBox);
      await store.patchBox(this.box.id, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString(), error: undefined });

      const args = ["pi", "--mode", "rpc"];
      if (this.record.sessionFile) args.push("--session", this.record.sessionFile);
      else args.push("--session-dir", "/workspace/.pi-sessions");
      const provider = this.record.provider ?? this.box.pi.defaultProvider;
      const model = this.record.model ?? this.box.pi.defaultModel;
      const thinkingLevel = this.record.thinkingLevel ?? this.box.pi.defaultThinkingLevel;
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);
      if (thinkingLevel) args.push("--thinking", thinkingLevel);
      if (this.box.pi.extraArgs?.length) args.push(...this.box.pi.extraArgs);

      this.exec = await dockerService.createInteractiveExec(this.box, args, { cwd: normalizeSessionCwd(this.record.cwd), tty: false, env: piRuntimeEnv(this.box) });
      const stream = await this.exec.start({ hijack: true, stdin: true });
      this.stream = stream as NodeJS.ReadWriteStream;

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      dockerService.docker.modem.demuxStream(stream, stdout, stderr);
      stdout.on("data", (chunk) => this.handleStdout(chunk));
      stderr.on("data", (chunk) => wsHub.publishSession(this.record.id, { type: "agent_stderr", data: chunk.toString("utf8") }));
      stream.on("error", (error) => this.fail(error));
      stream.on("close", () => this.onClose());
      stream.on("end", () => this.onClose());

      await store.patchSession(this.record.id, { status: "running", lastActiveAt: new Date().toISOString() });
      this.publishStatus("running");
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
    await this.start();
    return this.send({ type: "prompt", ...payload });
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

  async messages(): Promise<unknown[]> {
    await this.start();
    const data = await this.send({ type: "get_messages" }) as any;
    return Array.isArray(data?.messages) ? data.messages : [];
  }

  async availableModels(): Promise<PiModel[]> {
    await this.start();
    const data = await this.send({ type: "get_available_models" }, 30_000) as any;
    return Array.isArray(data?.models) ? data.models : [];
  }

  async stats(): Promise<SessionStats> {
    await this.start();
    return this.send({ type: "get_session_stats" }, 30_000) as Promise<SessionStats>;
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
    await this.start();
    const command: Record<string, unknown> = { type: "compact" };
    if (customInstructions?.trim()) command.customInstructions = customInstructions.trim();
    return this.send(command, 600_000);
  }

  async stop() {
    this.stopped = true;
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

  private async refreshSessionState() {
    const state = await this.send({ type: "get_state" }, 30_000) as any;
    await store.patchSession(this.record.id, {
      sessionFile: state?.sessionFile,
      provider: modelProvider(state?.model) ?? this.record.provider,
      model: state?.model?.id ?? this.record.model,
      thinkingLevel: state?.thinkingLevel ?? this.record.thinkingLevel,
      autoCompactionEnabled: typeof state?.autoCompactionEnabled === "boolean" ? state.autoCompactionEnabled : this.record.autoCompactionEnabled,
      cwd: normalizeSessionCwd(this.record.cwd),
      lastActiveAt: new Date().toISOString()
    });
    if (state?.sessionName) await store.patchSession(this.record.id, { name: state.sessionName });
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
      this.stream!.write(`${JSON.stringify(payload)}\n`, "utf8", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
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

    if (message.type === "response" && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data ?? message);
      else pending.reject(new Error(message.error ?? "RPC command failed"));
      return;
    }

    const eventStatus = sessionStatusForAgentEvent(message);
    void store.patchSession(this.record.id, { lastActiveAt: new Date().toISOString(), status: eventStatus ?? "running" }).catch(() => undefined);
    if (eventStatus) this.publishStatus(eventStatus);
    wsHub.publishSession(this.record.id, { type: "agent_event", event: message });
  }

  private fail(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    void store.patchSession(this.record.id, { status: "error", error: text });
    this.publishStatus("error", text);
  }

  private onClose() {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("agent process exited"));
    }
    this.pending.clear();
    this.stream = undefined;
    void store.patchSession(this.record.id, { status: "stopped" }).catch(() => undefined);
    this.publishStatus("stopped");
  }

  private publishStatus(status: AgentSessionStatus, error?: string) {
    if (this.liveStatus === status && !error) return;
    this.liveStatus = status;
    wsHub.publishSession(this.record.id, { type: "session_status", status, error });
    wsHub.publishBox(this.box.id, { type: "sessions_changed" });
  }
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

function modelProvider(model: PiModel | null | undefined): string | undefined {
  const provider = model?.provider ?? model?.providerId ?? model?.providerName;
  return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
}

function normalizeSessionCwd(cwd?: string): string {
  const value = cwd?.trim() || "/workspace";
  if (value === "/workspace" || value.startsWith("/workspace/")) return value.replace(/\/+$/, "") || "/workspace";
  return "/workspace";
}
