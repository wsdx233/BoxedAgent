import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Exec } from "dockerode";
import type { AgentSessionRecord, AgentSessionStatus, BoxRecord } from "../core/types.js";
import { conflict } from "../core/errors.js";
import { dockerService } from "../docker/docker-service.js";
import { store } from "../core/store.js";
import { wsHub } from "../ws/hub.js";
import { buildPiRuntimeArgs } from "./pi-args.js";
import { materializeBoxPiConfig, piRuntimeEnv } from "./pi-config.js";
import { ensureCompatiblePiCli } from "./pi-version.js";

const HISTORY_LIMIT_BYTES = 1_000_000;

export class TuiRuntime extends EventEmitter {
  private exec?: Exec;
  private stream?: NodeJS.ReadWriteStream;
  private history = Buffer.alloc(0);
  private stopped = false;
  private liveStatus?: AgentSessionStatus;

  constructor(public record: AgentSessionRecord, private box: BoxRecord) {
    super();
  }

  rebind(record: AgentSessionRecord, box: BoxRecord): void {
    this.record = record;
    this.box = box;
    this.liveStatus = undefined;
  }

  isActive(): boolean {
    return Boolean(this.stream && !this.stopped);
  }

  async start(options: { cols?: number; rows?: number } = {}): Promise<void> {
    if (this.stream && !this.stopped) return;
    this.syncRecordFromStore();
    if (this.record.kind !== "tui") throw conflict("session is not a TUI session");
    this.stopped = false;
    await store.patchSession(this.record.id, { status: "starting", error: undefined });
    this.publishStatus("starting");

    try {
      const startingBox = await store.patchBox(this.box.id, { status: "starting", error: undefined });
      await materializeBoxPiConfig(startingBox);
      const started = await dockerService.start(startingBox);
      this.box = await store.patchBox(this.box.id, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString(), error: undefined });
      await ensureCompatiblePiCli(this.box);

      const cwd = normalizeSessionCwd(this.record.cwd);
      await dockerService.assertDirectory(this.box, cwdToWorkspaceRel(cwd));
      const cols = clampInteger(options.cols, 20, 400, 120);
      const rows = clampInteger(options.rows, 8, 160, 32);
      const args = buildPiRuntimeArgs(this.record, this.box, { mode: "tui" });
      this.exec = await dockerService.createInteractiveExec(this.box, args, {
        cwd,
        env: [
          ...piRuntimeEnv(this.box, { stdioGuard: false }),
          "TERM=xterm-256color",
          "COLORTERM=truecolor",
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
          `COLUMNS=${cols}`,
          `LINES=${rows}`
        ],
        tty: true
      });
      const stream = await this.exec.start({ hijack: true, stdin: true }) as NodeJS.ReadWriteStream;
      this.stream = stream;
      await this.exec.resize({ h: rows, w: cols }).catch(() => undefined);

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const forward = (chunk: Buffer | string) => this.handleOutput(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      dockerService.docker.modem.demuxStream(stream, stdout, stderr);
      stdout.on("data", forward);
      stderr.on("data", forward);
      stream.on("error", (error) => this.fail(error));
      stream.on("close", () => this.onClose());
      stream.on("end", () => this.onClose());

      const now = new Date().toISOString();
      await store.patchSession(this.record.id, { status: "running", cwd, lastActiveAt: now });
      this.publishStatus("running");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await store.patchSession(this.record.id, { status: "error", error: text }).catch(() => undefined);
      this.publishStatus("error", text);
      throw error;
    }
  }

  async attach(options: { cols?: number; rows?: number } = {}): Promise<{ history: Buffer; cols: number; rows: number }> {
    const cols = clampInteger(options.cols, 20, 400, 120);
    const rows = clampInteger(options.rows, 8, 160, 32);
    await this.start({ cols, rows });
    await this.resize(cols, rows);
    return { history: Buffer.from(this.history), cols, rows };
  }

  write(data: string): void {
    if (!this.stream || this.stopped) throw conflict("TUI runtime is not running");
    this.stream.write(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    const width = clampInteger(cols, 20, 400, 120);
    const height = clampInteger(rows, 8, 160, 32);
    await this.exec?.resize({ h: height, w: width }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    (this.stream as any)?.destroy?.();
    this.stream = undefined;
    await store.patchSession(this.record.id, { status: "stopped" });
    this.publishStatus("stopped");
  }

  private handleOutput(chunk: Buffer) {
    this.appendHistory(chunk);
    this.emit("data", chunk);
    void store.patchSession(this.record.id, { status: "running", lastActiveAt: new Date().toISOString() }).catch(() => undefined);
  }

  private appendHistory(chunk: Buffer) {
    this.history = Buffer.concat([this.history, chunk]);
    if (this.history.length > HISTORY_LIMIT_BYTES) this.history = this.history.subarray(this.history.length - HISTORY_LIMIT_BYTES);
  }

  private fail(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    void store.patchSession(this.record.id, { status: "error", error: text }).catch(() => undefined);
    this.publishStatus("error", text);
  }

  private onClose() {
    if (this.stopped) return;
    this.stopped = true;
    this.stream = undefined;
    void store.patchSession(this.record.id, { status: "stopped", lastActiveAt: new Date().toISOString() }).catch(() => undefined);
    this.publishStatus("stopped");
    this.emit("close");
  }

  private publishStatus(status: AgentSessionStatus, error?: string) {
    if (this.liveStatus === status && !error) return;
    this.liveStatus = status;
    wsHub.publishSession(this.record.id, { type: "session_status", status, error });
    wsHub.publishBox(this.box.id, { type: "sessions_changed" });
  }

  private syncRecordFromStore() {
    this.record = store.getSession(this.record.id);
    this.box = store.getBox(this.record.boxId);
  }
}

function normalizeSessionCwd(cwd?: string): string {
  const value = cwd?.trim() || "/workspace";
  if (value === "/workspace" || value.startsWith("/workspace/")) return value.replace(/\/+$/, "") || "/workspace";
  return "/workspace";
}

function cwdToWorkspaceRel(cwd?: string): string {
  const normalized = normalizeSessionCwd(cwd);
  if (normalized === "/workspace") return ".";
  return normalized.slice("/workspace/".length) || ".";
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
