import fs from "fs-extra";
import { hostPathForContainerWorkspacePath } from "./pi-config.js";
import type { BoxRecord } from "../core/types.js";

export async function readPiSessionMessages(box: BoxRecord, sessionFile?: string): Promise<unknown[]> {
  const hostPath = hostPathForContainerWorkspacePath(box, sessionFile);
  if (!hostPath || !(await fs.pathExists(hostPath))) return [];
  const text = await fs.readFile(hostPath, "utf8");
  const messages: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "message" && entry.message) messages.push(entry.message);
    if (entry.type === "custom_message" && entry.display !== false) {
      messages.push({ role: "custom", customType: entry.customType, content: entry.content, timestamp: Date.parse(entry.timestamp) || Date.now() });
    }
    if (entry.type === "compaction" && entry.summary) {
      messages.push({ role: "compactionSummary", summary: entry.summary, timestamp: Date.parse(entry.timestamp) || Date.now() });
    }
  }
  return messages;
}
