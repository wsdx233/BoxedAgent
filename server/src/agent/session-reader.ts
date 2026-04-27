import type { BoxRecord } from "../core/types.js";
import { readPiSessionActiveMessages } from "./session-tree.js";

export async function readPiSessionMessages(box: BoxRecord, sessionFile?: string): Promise<unknown[]> {
  return readPiSessionActiveMessages(box, sessionFile);
}
