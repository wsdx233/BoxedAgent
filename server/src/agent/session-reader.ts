import type { BoxRecord } from "../core/types.js";
import { readPiSessionActiveMessages } from "./session-tree.js";
import { findSessionMessageById, truncateSessionMessages } from "./message-truncation.js";

export async function readPiSessionMessages(box: BoxRecord, sessionFile?: string, options: { expandedMessageIds?: Iterable<string> } = {}): Promise<unknown[]> {
  const messages = await readPiSessionActiveMessages(box, sessionFile);
  return truncateSessionMessages(messages, options);
}

export async function readPiSessionMessage(box: BoxRecord, sessionFile: string | undefined, messageId: string): Promise<unknown | undefined> {
  const messages = await readPiSessionActiveMessages(box, sessionFile);
  return findSessionMessageById(messages, messageId);
}
