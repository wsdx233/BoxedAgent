export type BoxStatus = "creating" | "starting" | "running" | "stopped" | "paused" | "error" | "deleted";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiExtensionScope = "box" | "workspace";

export interface PiExtensionRecord {
  name: string;
  scope: PiExtensionScope;
  path: string;
  type: "file" | "directory" | "package" | "path";
  entrypoint?: string;
  source?: string;
  size: number;
  modifiedAt: string;
}

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

export interface ContainerGpuConfig {
  enabled: boolean;
  count?: number | "all";
  deviceIds?: string[];
}

export interface ContainerDeviceMapping {
  pathOnHost: string;
  pathInContainer?: string;
  cgroupPermissions?: string;
}

export interface ContainerBindMount {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface ContainerStartupConfig {
  workingDir?: string;
  user?: string;
  startupScript?: string;
  env?: Record<string, string>;
  extraHosts?: string[];
  shmSizeMb?: number;
  gpu?: ContainerGpuConfig;
  devices?: ContainerDeviceMapping[];
  privileged?: boolean;
  capAdd?: string[];
  mounts?: ContainerBindMount[];
  exposedPorts?: number[];
}

export interface BoxRecord {
  id: string;
  name: string;
  description?: string;
  image: string;
  imageProfileId?: string;
  workspacePath: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  memoryMb?: number;
  cpus?: number;
  enableCodeServer: boolean;
  codeServerPassword?: string;
  portMappings: BoxPortMapping[];
  pi: PiBoxConfig;
  startup: ContainerStartupConfig;
  containerId?: string;
  status: BoxStatus;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  error?: string;
}

export interface ImageBuildContextFile {
  path: string;
  content: string;
  mode?: number;
}

export interface ImageBuildConfig {
  buildArgs?: Record<string, string>;
  platform?: string;
  target?: string;
  noCache?: boolean;
  pull?: boolean;
  contextFiles?: ImageBuildContextFile[];
}

export type ImageProfileStatus = "draft" | "building" | "ready" | "error";

export interface ImageProfileRecord {
  id: string;
  name: string;
  description?: string;
  image: string;
  baseImage?: string;
  dockerfile: string;
  build: ImageBuildConfig;
  boxDefaults: {
    env?: Record<string, string>;
    labels?: Record<string, string>;
    memoryMb?: number;
    cpus?: number;
    enableCodeServer?: boolean;
    codeServerPassword?: string;
    pi?: PiBoxConfig;
    startup?: ContainerStartupConfig;
  };
  status: ImageProfileStatus;
  error?: string;
  lastBuiltAt?: string;
  createdAt: string;
  updatedAt: string;
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

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  depth: number;
  type: string;
  role?: string;
  text: string;
  timestamp?: string;
  label?: string;
  active: boolean;
  inActivePath: boolean;
}

export interface SessionTree {
  nodes: SessionTreeNode[];
  activeId: string | null;
  activePathIds: string[];
  entryCount: number;
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
  loadedResources?: PiLoadedResources;
  [key: string]: unknown;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
}

export type ChatMessageRole = "user" | "assistant" | "tool" | "system";
export type ChatToolStatus = "pending" | "running" | "done" | "error";

export interface ToolResultMeta {
  truncated?: boolean;
  totalLines?: number;
  shownLines?: number;
  omittedLines?: number;
  totalBytes?: number;
  shownBytes?: number;
  label?: string;
}

export type ChatAttachment =
  | { kind: "image"; name: string; mimeType: string; data: string; path?: string; size?: number }
  | { kind: "file"; name: string; path: string; size?: number; mimeType?: string };

export interface ChatMessageTruncationPath {
  path: string;
  totalChars: number;
  shownChars: number;
  omittedChars: number;
}

export interface ChatMessageTransportMeta {
  messageId: string;
  truncated: boolean;
  totalChars?: number;
  shownChars?: number;
  omittedChars?: number;
  paths?: ChatMessageTruncationPath[];
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  text: string;
  sourceIndex?: number;
  timestamp: number;
  attachments?: ChatAttachment[];
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: string;
  toolResultMeta?: ToolResultMeta;
  toolStatus?: ChatToolStatus;
  transport?: ChatMessageTransportMeta;
}
