import fs from "fs-extra";
import { randomUUID } from "node:crypto";
import { paths } from "../config/env.js";
import type { AgentSessionRecord, BoxPortMapping, BoxRecord, PersistedState, PiBoxConfig } from "./types.js";
import { notFound } from "./errors.js";

const INITIAL_STATE: PersistedState = { version: 1, boxes: [], sessions: [] };

class Mutex {
  private queue = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class Store {
  private state: PersistedState = INITIAL_STATE;
  private mutex = new Mutex();

  async load() {
    if (!(await fs.pathExists(paths.stateFile))) {
      await this.persist(INITIAL_STATE);
      return;
    }
    const state = await fs.readJson(paths.stateFile) as PersistedState;
    this.state = {
      ...INITIAL_STATE,
      ...state,
      boxes: (state.boxes ?? []).map((box) => normalizeBox(box as BoxRecord)),
      sessions: (state.sessions ?? []).map((session) => normalizeSession(session as AgentSessionRecord))
    };
  }

  snapshot(): PersistedState {
    return JSON.parse(JSON.stringify(this.state)) as PersistedState;
  }

  listBoxes(): BoxRecord[] {
    return [...this.state.boxes].filter((b) => b.status !== "deleted").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getBox(id: string): BoxRecord {
    const box = this.state.boxes.find((b) => b.id === id && b.status !== "deleted");
    if (!box) throw notFound("box");
    return cloneBox(box);
  }

  async upsertBox(box: BoxRecord): Promise<BoxRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.boxes.findIndex((b) => b.id === box.id);
      const next = normalizeBox({ ...box, updatedAt: new Date().toISOString() });
      if (idx >= 0) this.state.boxes[idx] = next;
      else this.state.boxes.push(next);
      await this.persist(this.state);
      return next;
    });
  }

  async patchBox(id: string, patch: Partial<BoxRecord>): Promise<BoxRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.boxes.findIndex((b) => b.id === id);
      if (idx < 0) throw notFound("box");
      const next = normalizeBox({ ...this.state.boxes[idx], ...patch, updatedAt: new Date().toISOString() });
      this.state.boxes[idx] = next;
      await this.persist(this.state);
      return next;
    });
  }

  listSessions(boxId?: string): AgentSessionRecord[] {
    const activeBoxIds = new Set(this.state.boxes.filter((b) => b.status !== "deleted").map((b) => b.id));
    return [...this.state.sessions]
      .filter((s) => activeBoxIds.has(s.boxId))
      .filter((s) => !boxId || s.boxId === boxId)
      .sort((a, b) => {
        const ar = a.status === "working" || a.status === "running" || a.status === "starting" ? 1 : 0;
        const br = b.status === "working" || b.status === "running" || b.status === "starting" ? 1 : 0;
        if (ar !== br) return br - ar;
        return (b.lastActiveAt ?? b.updatedAt).localeCompare(a.lastActiveAt ?? a.updatedAt);
      });
  }

  getSession(id: string): AgentSessionRecord {
    const session = this.state.sessions.find((s) => s.id === id);
    if (!session) throw notFound("session");
    return { ...session };
  }

  async upsertSession(session: AgentSessionRecord): Promise<AgentSessionRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.sessions.findIndex((s) => s.id === session.id);
      const next = normalizeSession({ ...session, updatedAt: new Date().toISOString() });
      if (idx >= 0) this.state.sessions[idx] = next;
      else this.state.sessions.push(next);
      await this.persist(this.state);
      return next;
    });
  }

  async patchSession(id: string, patch: Partial<AgentSessionRecord>): Promise<AgentSessionRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.sessions.findIndex((s) => s.id === id);
      if (idx < 0) throw notFound("session");
      const next = normalizeSession({ ...this.state.sessions[idx], ...patch, updatedAt: new Date().toISOString() });
      this.state.sessions[idx] = next;
      await this.persist(this.state);
      return next;
    });
  }

  async deleteSession(id: string): Promise<void> {
    return this.mutex.run(async () => {
      this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
      await this.persist(this.state);
    });
  }

  async deleteSessionsForBox(boxId: string): Promise<void> {
    return this.mutex.run(async () => {
      this.state.sessions = this.state.sessions.filter((s) => s.boxId !== boxId);
      await this.persist(this.state);
    });
  }

  async pruneOrphanSessions(): Promise<number> {
    return this.mutex.run(async () => {
      const activeBoxIds = new Set(this.state.boxes.filter((b) => b.status !== "deleted").map((b) => b.id));
      const before = this.state.sessions.length;
      this.state.sessions = this.state.sessions.filter((s) => activeBoxIds.has(s.boxId));
      const removed = before - this.state.sessions.length;
      if (removed > 0) await this.persist(this.state);
      return removed;
    });
  }

  newBoxId() { return `box_${randomUUID()}`; }
  newSessionId() { return `ses_${randomUUID()}`; }

  private async persist(state: PersistedState) {
    await fs.ensureDir(paths.dataDir);
    const tmp = `${paths.stateFile}.${process.pid}.tmp`;
    await fs.writeJson(tmp, state, { spaces: 2 });
    await fs.rename(tmp, paths.stateFile);
    this.state = JSON.parse(JSON.stringify(state)) as PersistedState;
  }
}

function normalizePiConfig(pi?: PiBoxConfig): PiBoxConfig {
  return {
    defaultProvider: pi?.defaultProvider,
    defaultModel: pi?.defaultModel,
    defaultThinkingLevel: pi?.defaultThinkingLevel ?? "medium",
    enabledModels: pi?.enabledModels ?? [],
    settingsJson: pi?.settingsJson ?? {},
    modelsJson: pi?.modelsJson ?? {},
    systemPrompt: pi?.systemPrompt ?? "",
    appendSystemPrompt: pi?.appendSystemPrompt ?? "",
    agentsMd: pi?.agentsMd ?? "",
    extraArgs: pi?.extraArgs ?? []
  };
}

function normalizeBox(box: BoxRecord): BoxRecord {
  return {
    ...box,
    env: box.env ?? {},
    labels: box.labels ?? {},
    portMappings: (box.portMappings ?? []).map((mapping) => normalizePortMapping(mapping)),
    pi: normalizePiConfig(box.pi)
  };
}

function normalizePortMapping(mapping: BoxPortMapping): BoxPortMapping {
  const now = new Date().toISOString();
  return {
    id: mapping.id,
    name: mapping.name || `${(mapping.protocol ?? "http").toUpperCase()} ${mapping.port}`,
    port: mapping.port,
    protocol: mapping.protocol === "https" ? "https" : "http",
    slug: mapping.slug,
    openPath: normalizeMappingOpenPath(mapping.openPath),
    createdAt: mapping.createdAt ?? now,
    updatedAt: mapping.updatedAt ?? mapping.createdAt ?? now
  };
}

function normalizeMappingOpenPath(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") return undefined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeSession(session: AgentSessionRecord): AgentSessionRecord {
  return {
    ...session,
    cwd: normalizeSessionCwd(session.cwd),
    autoCompactionEnabled: session.autoCompactionEnabled ?? true
  };
}

function normalizeSessionCwd(cwd?: string): string {
  const value = cwd?.trim() || "/workspace";
  if (value === "/workspace" || value.startsWith("/workspace/")) return value.replace(/\/+$|^$/g, "") || "/workspace";
  return "/workspace";
}

function cloneBox(box: BoxRecord): BoxRecord {
  const normalized = normalizeBox(box);
  return JSON.parse(JSON.stringify(normalized)) as BoxRecord;
}

export const store = new Store();
