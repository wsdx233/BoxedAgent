export type BoxStatus = "creating" | "starting" | "running" | "stopped" | "paused" | "error" | "deleted";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PiBoxConfig {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  enabledModels?: string[];
  settingsJson?: Record<string, unknown>;
  modelsJson?: Record<string, unknown>;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  agentsMd?: string;
  extraArgs?: string[];
}

export interface BoxPortMapping {
  id: string;
  name: string;
  port: number;
  protocol: "http" | "https";
  slug: string;
  openPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoxSpec {
  name: string;
  description?: string;
  image: string;
  workspacePath: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  memoryMb?: number;
  cpus?: number;
  enableCodeServer: boolean;
  codeServerPassword?: string;
  portMappings: BoxPortMapping[];
  pi: PiBoxConfig;
}

export interface BoxRecord extends BoxSpec {
  id: string;
  containerId?: string;
  status: BoxStatus;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  error?: string;
}

export type AgentSessionStatus = "idle" | "starting" | "running" | "working" | "stopped" | "error";

export interface AgentSessionRecord {
  id: string;
  boxId: string;
  name: string;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  thinkingLevel?: ThinkingLevel;
  autoCompactionEnabled?: boolean;
  sessionFile?: string;
  error?: string;
  loadedResources?: PiLoadedResources;
}

export interface PiModel {
  id: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export type PiResourceScope = "box" | "workspace" | "package" | "path";
export type PiResourceKind = "context" | "package" | "extension" | "skill" | "prompt" | "theme";

export interface PiLoadedResourceItem {
  name: string;
  path: string;
  scope: PiResourceScope;
  kind: PiResourceKind;
  type?: string;
  source?: string;
  description?: string;
  entrypoint?: string;
  size?: number;
}

export interface PiLoadedResources {
  cwd: string;
  reason?: "startup" | "reload" | "manual";
  generatedAt: string;
  contextFiles: PiLoadedResourceItem[];
  packages: PiLoadedResourceItem[];
  extensions: PiLoadedResourceItem[];
  skills: PiLoadedResourceItem[];
  prompts: PiLoadedResourceItem[];
  themes: PiLoadedResourceItem[];
  diagnostics: string[];
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number;
    percent?: number | null;
  };
  [key: string]: unknown;
}

export interface PersistedState {
  version: 1;
  boxes: BoxRecord[];
  sessions: AgentSessionRecord[];
}

export interface ApiErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}
