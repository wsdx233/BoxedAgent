import type { AgentSessionNotice, BoxRecord } from "../core/types.js";
import { readPiSessionActiveMessages } from "./session-tree.js";
import { findSessionMessageById, truncateSessionMessages } from "./message-truncation.js";

export async function readPiSessionMessages(box: BoxRecord, sessionFile?: string, options: { expandedMessageIds?: Iterable<string>; notices?: AgentSessionNotice[] } = {}): Promise<unknown[]> {
  const messages = await readPiSessionActiveMessages(box, sessionFile);
  return truncateSessionMessages(mergeSessionNotices(messages, options.notices), options);
}

export async function readPiSessionMessage(box: BoxRecord, sessionFile: string | undefined, messageId: string, notices?: AgentSessionNotice[]): Promise<unknown | undefined> {
  const messages = mergeSessionNotices(await readPiSessionActiveMessages(box, sessionFile), notices);
  return findSessionMessageById(messages, messageId);
}

export function mergeSessionNotices(messages: unknown[], notices: AgentSessionNotice[] = []): unknown[] {
  const noticeMessages = notices.map(noticeToMessage).filter((message): message is Record<string, unknown> => Boolean(message));
  if (!noticeMessages.length) return messages;

  const sortedNotices = [...noticeMessages].sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp));
  const out: unknown[] = [];
  let noticeIndex = 0;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = withSourceIndex(messages[messageIndex], messageIndex);
    const messageTime = messageTimestampMs(message);
    while (noticeIndex < sortedNotices.length && messageTime > 0 && timestampMs(sortedNotices[noticeIndex].timestamp) <= messageTime) {
      out.push(sortedNotices[noticeIndex++]);
    }
    out.push(message);
  }
  while (noticeIndex < sortedNotices.length) out.push(sortedNotices[noticeIndex++]);
  return out;
}

function withSourceIndex(message: unknown, sourceIndex: number): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  return { ...(message as Record<string, unknown>), __boxedagentSourceIndex: sourceIndex };
}

function noticeToMessage(notice: AgentSessionNotice): Record<string, unknown> | undefined {
  if (!notice.message.trim()) return undefined;
  return {
    id: `boxedagent_notice_${notice.id}`,
    role: "system",
    content: notice.message,
    timestamp: timestampMs(notice.timestamp) || Date.now(),
    __boxedagentNotice: {
      id: notice.id,
      kind: notice.kind,
      title: notice.title,
      notifyType: notice.notifyType
    }
  };
}

function messageTimestampMs(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const record = message as Record<string, any>;
  return timestampMs(record.timestamp ?? record.createdAt ?? record.created_at ?? record.message?.timestamp);
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
