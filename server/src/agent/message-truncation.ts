import crypto from "node:crypto";

export interface MessageTruncationPath {
  path: string;
  totalChars: number;
  shownChars: number;
  omittedChars: number;
}

export interface MessageTransportMeta {
  messageId: string;
  truncated: boolean;
  totalChars?: number;
  shownChars?: number;
  omittedChars?: number;
  paths?: MessageTruncationPath[];
}

export interface MessageTruncationOptions {
  maxStringChars?: number;
  tailChars?: number;
  expandedMessageIds?: Iterable<string>;
}

const DEFAULT_MAX_STRING_CHARS = numberFromEnv("SESSION_MESSAGE_MAX_CHARS", 24_000);
const DEFAULT_TAIL_CHARS = numberFromEnv("SESSION_MESSAGE_TAIL_CHARS", 1_500);
const MAX_TRUNCATION_PATHS = 80;
const BOXED_META_KEY = "__boxedagent";

export function sessionMessageId(message: unknown, index: number): string {
  const record = isRecord(message) ? message : {};
  const sourceIndex = typeof record.__boxedagentSourceIndex === "number" && Number.isFinite(record.__boxedagentSourceIndex) ? record.__boxedagentSourceIndex : index;
  const explicit = firstString(record.id, record.messageId, record.message_id, record.tool_call_id, record.toolCallId);
  const timestamp = firstString(record.timestamp, record.createdAt, record.created_at);
  const role = firstString(record.role, isRecord(record.message) ? record.message.role : undefined);
  const type = firstString(record.type, isRecord(record.message) ? record.message.type : undefined);
  return `msg_${sourceIndex}_${shortHash([String(sourceIndex), explicit, timestamp, role, type].filter(Boolean).join("|"))}`;
}

export function truncateSessionMessages(messages: unknown[], options: MessageTruncationOptions = {}): unknown[] {
  const expanded = new Set(options.expandedMessageIds ?? []);
  return messages.map((message, index) => {
    const messageId = sessionMessageId(message, index);
    if (expanded.has(messageId)) return attachMeta(message, { messageId, truncated: false });
    const paths: MessageTruncationPath[] = [];
    const truncated = truncateValue(message, "$", paths, options, new WeakSet<object>());
    return attachMeta(truncated.value, buildMeta(messageId, paths));
  });
}

export function findSessionMessageById(messages: unknown[], messageId: string): unknown | undefined {
  return messages.find((message, index) => sessionMessageId(message, index) === messageId);
}

export function attachMessageMeta(message: unknown, messageId: string): unknown {
  return attachMeta(message, { messageId, truncated: false });
}

export function truncateTransportPayload(payload: unknown, maxStringChars = numberFromEnv("WS_MAX_STRING_CHARS", 48_000)): unknown {
  const paths: MessageTruncationPath[] = [];
  const truncated = truncateValue(payload, "$", paths, { maxStringChars, tailChars: Math.min(1_500, Math.floor(maxStringChars / 10)) }, new WeakSet<object>());
  if (!paths.length || !isRecord(truncated.value)) return truncated.value;
  return { ...truncated.value, __boxedagentTransport: buildMeta("transport", paths) };
}

function buildMeta(messageId: string, paths: MessageTruncationPath[]): MessageTransportMeta {
  const totalChars = paths.reduce((sum, path) => sum + path.totalChars, 0);
  const shownChars = paths.reduce((sum, path) => sum + path.shownChars, 0);
  return {
    messageId,
    truncated: paths.length > 0,
    totalChars: totalChars || undefined,
    shownChars: shownChars || undefined,
    omittedChars: totalChars && shownChars ? totalChars - shownChars : undefined,
    paths: paths.length ? paths : undefined
  };
}

function truncateValue(value: unknown, path: string, paths: MessageTruncationPath[], options: MessageTruncationOptions, seen: WeakSet<object>): { value: unknown; changed: boolean } {
  if (typeof value === "string") return truncateString(value, path, paths, options);
  if (!value || typeof value !== "object") return { value, changed: false };
  if (seen.has(value)) return { value: "[Circular]", changed: true };
  seen.add(value);

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const out = truncateValue(item, `${path}[${index}]`, paths, options, seen);
      changed ||= out.changed;
      return out.value;
    });
    seen.delete(value);
    return changed ? { value: next, changed } : { value, changed: false };
  }

  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === BOXED_META_KEY) continue;
    if (key === "__boxedagentSourceIndex") {
      next[key] = item;
      continue;
    }
    const out = truncateValue(item, `${path}.${escapePathKey(key)}`, paths, options, seen);
    changed ||= out.changed;
    next[key] = out.value;
  }
  seen.delete(value);
  return changed ? { value: next, changed } : { value, changed: false };
}

function truncateString(value: string, path: string, paths: MessageTruncationPath[], options: MessageTruncationOptions): { value: string; changed: boolean } {
  const maxStringChars = Math.max(1_000, Math.floor(options.maxStringChars ?? DEFAULT_MAX_STRING_CHARS));
  if (value.length <= maxStringChars) return { value, changed: false };
  const tailChars = Math.max(0, Math.min(Math.floor(options.tailChars ?? DEFAULT_TAIL_CHARS), Math.floor(maxStringChars / 3)));
  const headChars = Math.max(1, maxStringChars - tailChars);
  const omittedChars = Math.max(0, value.length - headChars - tailChars);
  const marker = `\n\n… [BoxedAgent 已截断 ${formatNumber(omittedChars)} 个字符；点击“展开完整消息”查看全部内容] …\n\n`;
  const nextValue = `${value.slice(0, headChars)}${marker}${tailChars ? value.slice(-tailChars) : ""}`;
  if (paths.length < MAX_TRUNCATION_PATHS) {
    paths.push({ path, totalChars: value.length, shownChars: value.length - omittedChars, omittedChars });
  }
  return { value: nextValue, changed: true };
}

function attachMeta(message: unknown, meta: MessageTransportMeta): unknown {
  if (isRecord(message)) return { ...message, [BOXED_META_KEY]: meta };
  return { role: "system", content: String(message ?? ""), [BOXED_META_KEY]: meta };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function shortHash(value: string): string {
  return crypto.createHash("sha1").update(value || "empty").digest("base64url").slice(0, 10);
}

function escapePathKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[`BOXEDAGENT_${name}`] ?? process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatNumber(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}
