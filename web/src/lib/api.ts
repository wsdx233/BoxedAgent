import type { AgentSessionRecord, BoxPortMapping, BoxRecord, FileEntry, ImageProfileRecord, PiBoxConfig, PiExtensionRecord, PiExtensionScope, PiLoadedResources, PiModel, PiSlashCommand, SessionStats, SessionTree, ThinkingLevel } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(url, { ...init, headers, credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  authStatus: () => request<{ enabled: boolean; authenticated: boolean }>("/api/auth/status"),
  login: (token: string) => request<{ ok: boolean; enabled?: boolean; error?: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ token }) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  health: () => request<{ ok: boolean; docker: string; image?: unknown }>("/api/health"),
  imageStatus: (image: string) => request<{ image: string; available: boolean; source: string; error?: string }>(`/api/images/status?image=${encodeURIComponent(image)}`),
  ensureImage: (image: string) => request<{ image: string; available: boolean; source: string; error?: string }>("/api/images/ensure", { method: "POST", body: JSON.stringify({ image }) }),
  listImageProfiles: () => request<{ profiles: ImageProfileRecord[]; advancedOptionsAllowed: boolean }>("/api/image-profiles"),
  getImageProfile: (id: string) => request<ImageProfileRecord>(`/api/image-profiles/${id}`),
  createImageProfile: (body: Omit<Partial<ImageProfileRecord>, "id" | "createdAt" | "updatedAt"> & { name: string; image: string; dockerfile: string }) => request<ImageProfileRecord>("/api/image-profiles", { method: "POST", body: JSON.stringify(body) }),
  updateImageProfile: (id: string, body: Partial<ImageProfileRecord>) => request<ImageProfileRecord>(`/api/image-profiles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteImageProfile: (id: string) => request<{ ok: boolean }>(`/api/image-profiles/${id}`, { method: "DELETE" }),
  duplicateImageProfile: (id: string, body?: { name?: string; image?: string }) => request<ImageProfileRecord>(`/api/image-profiles/${id}/duplicate`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  buildImageProfile: (id: string) => request<{ profile: ImageProfileRecord; image: { image: string; available: boolean; source: string; error?: string } }>(`/api/image-profiles/${id}/build`, { method: "POST" }),
  ensureImageProfile: (id: string) => request<{ profile: ImageProfileRecord; image: { image: string; available: boolean; source: string; error?: string } }>(`/api/image-profiles/${id}/ensure`, { method: "POST" }),
  listBoxes: () => request<{ boxes: BoxRecord[] }>("/api/boxes"),
  createBox: (body: Partial<BoxRecord> & { name: string; autostart?: boolean; buildImage?: boolean }) => request<BoxRecord>("/api/boxes", { method: "POST", body: JSON.stringify(body) }),
  updateBox: (id: string, body: Partial<BoxRecord>) => request<BoxRecord>(`/api/boxes/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  duplicateBox: (id: string, body?: { name?: string; description?: string; autostart?: boolean }) => request<BoxRecord>(`/api/boxes/${id}/duplicate`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  cloneBox: (id: string, body: { name: string; description?: string; autostart?: boolean }) => request<BoxRecord>(`/api/boxes/${id}/clone`, { method: "POST", body: JSON.stringify(body) }),
  startBox: (id: string) => request<BoxRecord>(`/api/boxes/${id}/start`, { method: "POST" }),
  stopBox: (id: string) => request<BoxRecord>(`/api/boxes/${id}/stop`, { method: "POST" }),
  deleteBox: (id: string) => request<{ ok: boolean }>(`/api/boxes/${id}?force=true`, { method: "DELETE" }),
  listPortMappings: (boxId: string) => request<{ mappings: BoxPortMapping[] }>(`/api/boxes/${boxId}/ports`),
  createPortMapping: (boxId: string, body: { name?: string; port: number; protocol?: "http" | "https"; slug: string; openPath?: string }) => request<{ mapping: BoxPortMapping; url: string; box: BoxRecord }>(`/api/boxes/${boxId}/ports`, { method: "POST", body: JSON.stringify(body) }),
  updatePortMapping: (boxId: string, mappingId: string, body: Partial<Pick<BoxPortMapping, "name" | "port" | "protocol" | "slug">>) => request<{ mapping: BoxPortMapping; url: string; box: BoxRecord }>(`/api/boxes/${boxId}/ports/${mappingId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deletePortMapping: (boxId: string, mappingId: string) => request<{ ok: boolean; box: BoxRecord }>(`/api/boxes/${boxId}/ports/${mappingId}`, { method: "DELETE" }),
  portProxyUrl: (slug: string, openPath?: string) => `${backendOrigin()}/ports/${encodeURIComponent(slug)}${openPath || "/"}`,

  boxModels: (boxId: string) => request<{ models: PiModel[] }>(`/api/boxes/${boxId}/models`),
  getPiConfig: (boxId: string) => request<{ pi: PiBoxConfig; env: Record<string, string>; materialized: { piCodingAgentDir: string; settings: Record<string, unknown> } }>(`/api/boxes/${boxId}/pi-config`),
  updatePiConfig: (boxId: string, body: PiBoxConfig & { settingsJsonText?: string; modelsJsonText?: string; env?: Record<string, string> }) => request<{ pi: PiBoxConfig; env: Record<string, string>; materialized: { piCodingAgentDir: string; settings: Record<string, unknown> } }>(`/api/boxes/${boxId}/pi-config`, { method: "PUT", body: JSON.stringify(body) }),
  listPiExtensions: (boxId: string, cwd = "/workspace") => request<{ extensions: PiExtensionRecord[] }>(`/api/boxes/${boxId}/pi-extensions?cwd=${encodeURIComponent(cwd)}`),
  installPiExtension: (boxId: string, body: { source: string; name?: string; scope: PiExtensionScope; cwd?: string; overwrite?: boolean }) => request<{ ok: boolean; extension: PiExtensionRecord; message: string }>(`/api/boxes/${boxId}/pi-extensions/install`, { method: "POST", body: JSON.stringify(body) }),
  uploadPiExtension: async (boxId: string, body: { file: File; name?: string; scope: PiExtensionScope; cwd?: string; overwrite?: boolean }) => {
    const form = new FormData();
    form.append("file", body.file);
    const params = new URLSearchParams({ scope: body.scope, cwd: body.cwd ?? "/workspace", overwrite: String(Boolean(body.overwrite)) });
    if (body.name) params.set("name", body.name);
    return request<{ ok: boolean; extension: PiExtensionRecord; message: string }>(`/api/boxes/${boxId}/pi-extensions/upload?${params.toString()}`, { method: "POST", body: form });
  },
  deletePiExtension: (boxId: string, scope: PiExtensionScope, name: string, cwd = "/workspace") => request<{ ok: boolean; message: string }>(`/api/boxes/${boxId}/pi-extensions/${scope}/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" }),
  migratePiExtensions: (boxId: string, body: { targetBoxIds: string[]; names?: string[]; sourceScope: PiExtensionScope; targetScope: PiExtensionScope; sourceCwd?: string; targetCwd?: string; overwrite?: boolean }) => request<{ ok: boolean; migrated: Array<{ targetBoxId: string; extensions: PiExtensionRecord[] }>; message: string }>(`/api/boxes/${boxId}/pi-extensions/migrate`, { method: "POST", body: JSON.stringify(body) }),
  piInstallPackage: (boxId: string, body: { source: string; scope: PiExtensionScope; cwd?: string }) => request<{ ok: boolean; stdout: string; stderr: string; message: string }>(`/api/boxes/${boxId}/pi-extensions/pi-install`, { method: "POST", body: JSON.stringify(body) }),
  piRemovePackage: (boxId: string, body: { source: string; scope: PiExtensionScope; cwd?: string }) => request<{ ok: boolean; stdout: string; stderr: string; message: string }>(`/api/boxes/${boxId}/pi-extensions/pi-remove`, { method: "POST", body: JSON.stringify(body) }),

  getCurrentSession: () => request<{ sessionId?: string; activeSessionId?: string; boxId?: string; session?: AgentSessionRecord }>("/api/current-session"),
  setCurrentSession: (sessionId?: string) => request<{ ok: boolean; sessionId?: string; activeSessionId?: string; boxId?: string; session?: AgentSessionRecord }>("/api/current-session", { method: sessionId ? "PUT" : "DELETE", body: sessionId ? JSON.stringify({ sessionId }) : undefined }),
  listSessions: (boxId?: string) => request<{ sessions: AgentSessionRecord[] }>(`/api/sessions${boxId ? `?boxId=${encodeURIComponent(boxId)}` : ""}`),
  createSession: (body: { boxId: string; name?: string; cwd?: string; provider?: string; model?: string; thinkingLevel?: ThinkingLevel; autostart?: boolean }) => request<AgentSessionRecord>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  startSession: (id: string) => request<AgentSessionRecord>(`/api/sessions/${id}/start`, { method: "POST" }),
  stopSession: (id: string) => request<AgentSessionRecord>(`/api/sessions/${id}/stop`, { method: "POST" }),
  reloadSession: (id: string) => request<{ session: AgentSessionRecord }>(`/api/sessions/${id}/reload`, { method: "POST" }),
  updateSession: (id: string, body: Partial<Pick<AgentSessionRecord, "name" | "cwd" | "model" | "provider" | "thinkingLevel">>) => request<AgentSessionRecord>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  abortSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}/abort`, { method: "POST" }),
  duplicateSession: (id: string, body?: { name?: string; autostart?: boolean }) => request<{ session: AgentSessionRecord }>(`/api/sessions/${id}/duplicate`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  cloneSession: (id: string, body?: { name?: string }) => request<{ session: AgentSessionRecord; cancelled?: boolean }>(`/api/sessions/${id}/clone`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  sessionTree: (id: string) => request<{ tree: SessionTree }>(`/api/sessions/${id}/tree`),
  navigateSessionTree: (id: string, body: { targetId: string }) => request<{ session: AgentSessionRecord; editorText?: string; activeId: string | null }>(`/api/sessions/${id}/tree/navigate`, { method: "POST", body: JSON.stringify(body) }),
  forkMessages: (id: string) => request<{ messages: Array<{ entryId: string; text: string }> }>(`/api/sessions/${id}/fork-messages`),
  forkSession: (id: string, body: { entryId: string; name?: string; useRuntime?: boolean }) => request<{ session: AgentSessionRecord; text?: string; cancelled?: boolean }>(`/api/sessions/${id}/fork`, { method: "POST", body: JSON.stringify(body) }),
  forkMessage: (id: string, body: { messageIndex: number; name?: string }) => request<{ session: AgentSessionRecord; text?: string; cancelled?: boolean }>(`/api/sessions/${id}/fork-message`, { method: "POST", body: JSON.stringify(body) }),
  prompt: (id: string, body: { message: string; streamingBehavior?: "steer" | "followUp"; images?: Array<{ type: "image"; data: string; mimeType: string }> }) => request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify(body) }),
  messages: (id: string, options?: { expand?: string[] }) => request<{ messages: any[] }>(`/api/sessions/${id}/messages${options?.expand?.length ? `?expand=${encodeURIComponent(options.expand.join(","))}` : ""}`),
  message: (id: string, messageId: string) => request<{ message: any }>(`/api/sessions/${id}/messages/${encodeURIComponent(messageId)}`),
  sessionState: (id: string) => request<{ state: any }>(`/api/sessions/${id}/state`),
  sessionStats: (id: string) => request<{ stats: SessionStats | null }>(`/api/sessions/${id}/stats`),
  sessionResources: (id: string) => request<{ resources: PiLoadedResources }>(`/api/sessions/${id}/resources`),
  sessionModels: (id: string) => request<{ models: PiModel[] }>(`/api/sessions/${id}/models`),
  sessionCommands: (id: string) => request<{ commands: PiSlashCommand[] }>(`/api/sessions/${id}/commands`),
  setSessionModel: (id: string, body: { provider: string; modelId: string }) => request<{ session: AgentSessionRecord; model?: PiModel | null }>(`/api/sessions/${id}/model`, { method: "PATCH", body: JSON.stringify(body) }),
  setSessionThinking: (id: string, level: ThinkingLevel) => request<{ session: AgentSessionRecord; state?: any }>(`/api/sessions/${id}/thinking`, { method: "PATCH", body: JSON.stringify({ level }) }),
  setAutoCompaction: (id: string, enabled: boolean) => request<{ session: AgentSessionRecord; state?: any }>(`/api/sessions/${id}/auto-compaction`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  compactSession: (id: string, body?: { customInstructions?: string }) => request<{ ok: boolean; result?: unknown }>(`/api/sessions/${id}/compact`, { method: "POST", body: JSON.stringify(body ?? {}) }),

  listFiles: (boxId: string, p: string) => request<{ entries: FileEntry[] }>(`/api/boxes/${boxId}/files?path=${encodeURIComponent(p)}`),
  mkdir: (boxId: string, p: string) => request<{ ok: boolean }>(`/api/boxes/${boxId}/files/mkdir`, { method: "POST", body: JSON.stringify({ path: p }) }),
  copyFile: (boxId: string, source: string, target: string) => request<{ ok: boolean }>(`/api/boxes/${boxId}/files/copy`, { method: "POST", body: JSON.stringify({ source, target }) }),
  moveFile: (boxId: string, source: string, target: string) => request<{ ok: boolean }>(`/api/boxes/${boxId}/files/move`, { method: "POST", body: JSON.stringify({ source, target }) }),
  deleteFile: (boxId: string, p: string) => request<{ ok: boolean }>(`/api/boxes/${boxId}/files?path=${encodeURIComponent(p)}`, { method: "DELETE" }),
  uploadFile: async (boxId: string, p: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ ok: boolean }>(`/api/boxes/${boxId}/files/upload?path=${encodeURIComponent(p)}`, { method: "POST", body: form });
  },
  downloadUrl: (boxId: string, p: string, options?: { inline?: boolean }) => `/api/boxes/${boxId}/files/download?path=${encodeURIComponent(p)}${options?.inline ? "&inline=1" : ""}`,
  codeServerUrl: (boxId: string) => `${backendOrigin()}/codeserver/${boxId}/`
};

function backendOrigin() {
  const configured = (import.meta as any).env?.VITE_BACKEND_ORIGIN as string | undefined;
  if (configured) return configured.replace(/\/$/, "");
  if ((import.meta as any).env?.DEV && location.port === "5173") return `${location.protocol}//${location.hostname}:8080`;
  return "";
}

export function wsUrl(path: string) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}

export function closeWebSocketQuietly(ws: WebSocket | null | undefined) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.addEventListener("open", () => ws.close(), { once: true });
      ws.addEventListener("error", () => undefined, { once: true });
      return;
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close();
  } catch {
    // Ignore cleanup races during React StrictMode remounts / rapid session switches.
  }
}
