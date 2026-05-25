import crypto from "node:crypto";
import fs from "fs-extra";
import { hostPathForContainerWorkspacePath } from "./pi-config.js";
import type { BoxRecord } from "../core/types.js";

const TREE_LEAF_MARKER = "boxedagent.tree_leaf";

export interface PiSessionTreeNode {
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

export interface PiSessionTree {
  nodes: PiSessionTreeNode[];
  activeId: string | null;
  activePathIds: string[];
  entryCount: number;
}

type SessionEntry = Record<string, any> & { type: string; id?: string; parentId?: string | null; timestamp?: string };

export async function readPiSessionActiveMessages(box: BoxRecord, sessionFile?: string): Promise<unknown[]> {
  const entries = await readSessionEntries(box, sessionFile);
  const path = activePath(entries);
  return path.flatMap(entryToMessages);
}

export async function findVisibleEntryIdForActiveMessageIndex(box: BoxRecord, sessionFile: string | undefined, messageIndex: number): Promise<string | undefined> {
  if (!Number.isInteger(messageIndex) || messageIndex < 0) return undefined;
  const entries = await readSessionEntries(box, sessionFile);
  const visibleMessages = activePath(entries).filter((entry) => entryToMessages(entry).length > 0);
  return visibleMessages[messageIndex]?.id ? String(visibleMessages[messageIndex].id) : undefined;
}

export async function getPiSessionTree(box: BoxRecord, sessionFile?: string): Promise<PiSessionTree> {
  const entries = await readSessionEntries(box, sessionFile);
  const visibleEntries = visibleTreeEntries(entries);
  const labels = labelsByTarget(entries);
  const rawPath = activePath(entries);
  const activePathIds = rawPath.filter((entry) => isVisibleTreeEntry(entry)).map((entry) => String(entry.id));
  const activeId = activePathIds.at(-1) ?? null;
  const activePathSet = new Set(activePathIds);
  const children = new Map<string | null, SessionEntry[]>();

  for (const entry of visibleEntries) {
    const parentId = visibleParentId(entry.parentId ?? null, entries);
    const list = children.get(parentId) ?? [];
    list.push(entry);
    children.set(parentId, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? ""));
  }

  const nodes: PiSessionTreeNode[] = [];
  const visit = (entry: SessionEntry, depth: number) => {
    const id = String(entry.id);
    nodes.push({
      id,
      parentId: visibleParentId(entry.parentId ?? null, entries),
      depth,
      type: entry.type,
      role: entryRole(entry),
      text: entryDisplayText(entry),
      timestamp: entry.timestamp,
      label: labels.get(id),
      active: id === activeId,
      inActivePath: activePathSet.has(id)
    });
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);

  return { nodes, activeId, activePathIds, entryCount: visibleEntries.length };
}

export async function forkPiSessionFromEntry(box: BoxRecord, sessionFile: string | undefined, targetId: string): Promise<{ sessionFile: string; text?: string }> {
  const hostPath = sessionHostPath(box, sessionFile);
  if (!hostPath || !(await fs.pathExists(hostPath))) throw new Error("当前 Session 还没有可 fork 的 pi session 文件。");
  const sep = hostPath.lastIndexOf("/");
  if (sep <= 0) throw new Error("当前 Session 文件路径无效，无法 fork。");
  const entries = await readSessionEntries(box, sessionFile);
  const target = entries.find((entry) => entry.id === targetId);
  if (!target) throw new Error("目标节点不存在或已不可用。");

  const targetLeafId = target.type === "message" && target.message?.role === "user" ? target.parentId ?? null : targetId;
  const path = targetLeafId ? branchEntries(entries, targetLeafId) : [];
  if (targetLeafId && path.length === 0) throw new Error("目标节点不在当前 Session 历史中。");

  const timestamp = new Date().toISOString();
  const sessionId = generateSessionId();
  const dir = hostPath.substring(0, sep);
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const nextHostPath = `${dir}/${fileTimestamp}_${sessionId}.jsonl`;
  const containerFile = containerPathForHostSessionFile(box, nextHostPath, sessionFile);
  const pathWithoutLabels = path.filter((entry) => entry.type !== "label");
  const usedIds = new Set(pathWithoutLabels.map((entry) => String(entry.id)));
  let labelParentId = pathWithoutLabels.at(-1)?.id ?? null;
  const labelEntries = entries
    .filter((entry) => entry.type === "label" && entry.targetId && usedIds.has(String(entry.targetId)))
    .map((entry) => {
      const id = generateEntryIdFromSet(usedIds);
      usedIds.add(id);
      const labelEntry = { ...entry, id, parentId: labelParentId };
      labelParentId = id;
      return labelEntry;
    });
  const sourceHeader = entries.find((entry) => entry.type === "session");
  const header = { type: "session", version: 3, id: sessionId, timestamp, cwd: sourceHeader?.cwd || "/workspace", parentSession: sessionFile };
  const lines = [header, ...pathWithoutLabels, ...labelEntries].map((entry) => JSON.stringify(entry)).join("\n");
  await fs.ensureDir(dir);
  await fs.writeFile(nextHostPath, `${lines}\n`, "utf8");
  return { sessionFile: containerFile, text: target.type === "message" && target.message?.role === "user" ? userMessageText(target.message) : undefined };
}

export async function navigatePiSessionTree(box: BoxRecord, sessionFile: string | undefined, targetId: string): Promise<{ editorText?: string; activeId: string | null }> {
  const hostPath = sessionHostPath(box, sessionFile);
  if (!hostPath || !(await fs.pathExists(hostPath))) throw new Error("当前 Session 还没有可导航的 pi session 文件。");
  const entries = await readSessionEntries(box, sessionFile);
  const target = entries.find((entry) => entry.id === targetId);
  if (!target) throw new Error("目标节点不存在或已不可用。");

  const isUser = target.type === "message" && target.message?.role === "user";
  const nextLeafParentId = isUser ? visibleParentId(target.parentId ?? null, entries) : targetId;
  const editorText = isUser ? userMessageText(target.message) : undefined;
  const marker: SessionEntry = {
    type: "custom",
    customType: TREE_LEAF_MARKER,
    id: generateEntryId(entries),
    parentId: nextLeafParentId,
    timestamp: new Date().toISOString(),
    data: { targetId, selectedType: target.type, selectedRole: target.message?.role }
  };
  await fs.appendFile(hostPath, `${JSON.stringify(marker)}\n`, "utf8");
  return { editorText, activeId: nextLeafParentId };
}

async function readSessionEntries(box: BoxRecord, sessionFile?: string): Promise<SessionEntry[]> {
  const hostPath = sessionHostPath(box, sessionFile);
  if (!hostPath || !(await fs.pathExists(hostPath))) return [];
  const text = await fs.readFile(hostPath, "utf8");
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* ignore malformed lines */ }
  }
  return entries;
}

function sessionHostPath(box: BoxRecord, sessionFile?: string): string | undefined {
  return hostPathForContainerWorkspacePath(box, sessionFile);
}

function activePath(entries: SessionEntry[]): SessionEntry[] {
  const byId = entryMap(entries);
  const leaf = [...entries].reverse().find((entry) => entry.type !== "session" && entry.id);
  const out: SessionEntry[] = [];
  let current = leaf;
  const seen = new Set<string>();
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id);
    if (isVisibleContextEntry(current)) out.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return out;
}

function visibleTreeEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter(isVisibleTreeEntry);
}

function isVisibleTreeEntry(entry: SessionEntry): boolean {
  if (!entry.id || entry.type === "session") return false;
  if (isTreeMarker(entry)) return false;
  if (entry.type === "label" || entry.type === "custom" || entry.type === "session_info") return false;
  return true;
}

function isVisibleContextEntry(entry: SessionEntry): boolean {
  if (!entry.id || entry.type === "session") return false;
  if (isTreeMarker(entry)) return false;
  if (entry.type === "label" || entry.type === "custom" || entry.type === "session_info") return false;
  return true;
}

function isTreeMarker(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === TREE_LEAF_MARKER;
}

function visibleParentId(parentId: string | null, entries: SessionEntry[]): string | null {
  const byId = entryMap(entries);
  let current = parentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) return current;
    if (isVisibleTreeEntry(parent)) return current;
    current = parent.parentId ?? null;
  }
  return null;
}

function entryMap(entries: SessionEntry[]): Map<string, SessionEntry> {
  return new Map(entries.filter((entry) => entry.id).map((entry) => [String(entry.id), entry]));
}

function branchEntries(entries: SessionEntry[], leafId: string): SessionEntry[] {
  const byId = entryMap(entries);
  const out: SessionEntry[] = [];
  let current = byId.get(leafId);
  const seen = new Set<string>();
  while (current?.id && !seen.has(String(current.id))) {
    seen.add(String(current.id));
    if (current.type !== "session") out.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return out;
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function containerPathForHostSessionFile(box: BoxRecord, hostPath: string, fallbackSessionFile?: string): string {
  const root = box.workspacePath.replace(/\/+$|\\+$/g, "");
  if (root && hostPath === root) return "/workspace";
  if (root && hostPath.startsWith(`${root}/`)) return `/workspace/${hostPath.slice(root.length + 1)}`;
  const fallback = fallbackSessionFile?.trim();
  if (fallback?.includes("/")) return `${fallback.slice(0, fallback.lastIndexOf("/"))}/${hostPath.split("/").pop()}`;
  return `/workspace/.pi-sessions/${hostPath.split("/").pop()}`;
}

function labelsByTarget(entries: SessionEntry[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label" || !entry.targetId) continue;
    if (entry.label) labels.set(String(entry.targetId), String(entry.label));
    else labels.delete(String(entry.targetId));
  }
  return labels;
}

function entryToMessages(entry: SessionEntry): unknown[] {
  if (entry.type === "message" && entry.message) return [entry.message];
  if (entry.type === "custom_message" && entry.display !== false) {
    return [{ role: "custom", customType: entry.customType, content: entry.content, timestamp: Date.parse(entry.timestamp ?? "") || Date.now() }];
  }
  if (entry.type === "compaction" && entry.summary) {
    return [{ role: "compactionSummary", summary: entry.summary, timestamp: Date.parse(entry.timestamp ?? "") || Date.now() }];
  }
  return [];
}

function entryRole(entry: SessionEntry): string | undefined {
  if (entry.type === "message") return entry.message?.role;
  if (entry.type === "custom_message") return "custom";
  return undefined;
}

function entryDisplayText(entry: SessionEntry): string {
  if (entry.type === "message") return messageDisplayText(entry.message);
  if (entry.type === "compaction") return `[compaction: ${Math.round((Number(entry.tokensBefore) || 0) / 1000)}k tokens] ${entry.summary ?? ""}`;
  if (entry.type === "branch_summary") return `[branch summary] ${entry.summary ?? ""}`;
  if (entry.type === "custom_message") return `[${entry.customType ?? "custom"}] ${contentText(entry.content)}`;
  if (entry.type === "model_change") return `[model] ${[entry.provider, entry.modelId].filter(Boolean).join("/")}`;
  if (entry.type === "thinking_level_change") return `[thinking] ${entry.thinkingLevel ?? ""}`;
  return `[${entry.type}]`;
}

function messageDisplayText(message: any): string {
  const role = message?.role ?? "message";
  if (role === "user") return `user: ${userMessageText(message)}`;
  if (role === "assistant") return `assistant: ${assistantText(message) || (message?.errorMessage ? `error: ${message.errorMessage}` : "(no text)")}`;
  if (role === "toolResult") return `[${message.toolName ?? "tool"}] ${contentText(message.content)}`;
  if (role === "bashExecution") return `[bash] ${message.command ?? ""}`;
  if (role === "compactionSummary") return `[compaction] ${message.summary ?? ""}`;
  if (role === "branchSummary") return `[branch summary] ${message.summary ?? ""}`;
  return `${role}: ${contentText(message?.content)}`;
}

function userMessageText(message: any): string {
  return contentText(message?.content ?? message?.message ?? "");
}

function assistantText(message: any): string {
  if (!Array.isArray(message?.content)) return contentText(message?.content);
  return message.content.filter((part: any) => part?.type === "text" || part?.text).map((part: any) => String(part.text ?? "")).join(" ").trim();
}

function contentText(content: any): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" || part?.text) return String(part.text ?? "");
    if (part?.type === "image") return "[image]";
    if (part?.type === "thinking") return "[thinking]";
    if (part?.type === "toolCall") return `[tool: ${part.name ?? "tool"}]`;
    return "";
  }).filter(Boolean).join(" ").trim();
  return JSON.stringify(content);
}

function generateEntryId(entries: SessionEntry[]): string {
  return generateEntryIdFromSet(new Set(entries.map((entry) => entry.id).filter((id): id is string => Boolean(id))));
}

function generateEntryIdFromSet(existing: Set<string>): string {
  let id = crypto.randomBytes(4).toString("hex");
  while (existing.has(id)) id = crypto.randomBytes(4).toString("hex");
  return id;
}
