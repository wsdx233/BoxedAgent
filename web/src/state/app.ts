import { create } from "zustand";
import { newId } from "../lib/id";
import { readActiveSessionCookie } from "../lib/selection-cookie";
import type { AgentSessionRecord, BoxRecord, ChatMessage } from "../lib/types";

interface AppState {
  boxes: BoxRecord[];
  sessions: AgentSessionRecord[];
  activeBoxId?: string;
  activeSessionId?: string;
  messagesBySession: Record<string, ChatMessage[]>;
  composerDrafts: Record<string, string>;
  setBoxes: (boxes: BoxRecord[]) => void;
  setSessions: (sessions: AgentSessionRecord[]) => void;
  setActiveBox: (id?: string) => void;
  setActiveSession: (id?: string) => void;
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  appendAssistantDelta: (sessionId: string, delta: { text?: string; thinking?: string }) => void;
  updateLastAssistant: (sessionId: string, delta: string) => void;
  updateLastAssistantThinking: (sessionId: string, delta: string) => void;
  upsertToolMessage: (sessionId: string, toolCallId: string, patch: Partial<ChatMessage>) => void;
  upsertToolMessages: (sessionId: string, items: Array<{ toolCallId: string; patch: Partial<ChatMessage> }>) => void;
  setSessionMessages: (sessionId: string, messages: ChatMessage[]) => void;
  setComposerDraft: (sessionId: string, draft?: string) => void;
  clearMessages: (sessionId: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  boxes: [],
  sessions: [],
  activeSessionId: readActiveSessionCookie(),
  messagesBySession: {},
  composerDrafts: {},
  setBoxes: (boxes) => set((s) => {
    const activeBoxId = s.activeBoxId && boxes.some((b) => b.id === s.activeBoxId) ? s.activeBoxId : boxes[0]?.id;
    const activeSession = s.activeSessionId ? s.sessions.find((session) => session.id === s.activeSessionId) : undefined;
    const activeSessionId = activeSession && activeSession.boxId !== activeBoxId ? undefined : s.activeSessionId;
    return { boxes, activeBoxId, activeSessionId };
  }),
  setSessions: (sessions) => set((s) => {
    const selectedSession = s.activeSessionId ? sessions.find((session) => session.id === s.activeSessionId) : undefined;
    if (selectedSession) return { sessions, activeBoxId: selectedSession.boxId, activeSessionId: selectedSession.id };
    const fallback = sessions.find((session) => !s.activeBoxId || session.boxId === s.activeBoxId);
    return { sessions, activeSessionId: fallback?.id, activeBoxId: s.activeBoxId ?? fallback?.boxId };
  }),
  setActiveBox: (id) => set({ activeBoxId: id, activeSessionId: undefined }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  appendMessage: (sessionId, msg) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: [...(s.messagesBySession[sessionId] ?? []), msg] } })),
  appendAssistantDelta: (sessionId, delta) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: appendAssistantDeltaToList(s.messagesBySession[sessionId] ?? [], delta) } })),
  updateLastAssistant: (sessionId, delta) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: appendAssistantDeltaToList(s.messagesBySession[sessionId] ?? [], { text: delta }) } })),
  updateLastAssistantThinking: (sessionId, delta) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: appendAssistantDeltaToList(s.messagesBySession[sessionId] ?? [], { thinking: delta }) } })),
  upsertToolMessage: (sessionId, toolCallId, patch) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: upsertToolPatchesIntoList(s.messagesBySession[sessionId] ?? [], [{ toolCallId, patch }]) } })),
  upsertToolMessages: (sessionId, items) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: upsertToolPatchesIntoList(s.messagesBySession[sessionId] ?? [], items) } })),
  setSessionMessages: (sessionId, messages) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: messages } })),
  setComposerDraft: (sessionId, draft) => set((s) => {
    const drafts = { ...s.composerDrafts };
    if (draft === undefined) delete drafts[sessionId];
    else drafts[sessionId] = draft;
    return { composerDrafts: drafts };
  }),
  clearMessages: (sessionId) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: [] } }))
}));

function appendAssistantDeltaToList(list: ChatMessage[], delta: { text?: string; thinking?: string }): ChatMessage[] {
  const next = [...list];
  const last = next[next.length - 1];
  if (last?.role === "assistant") {
    next[next.length - 1] = {
      ...last,
      text: `${last.text}${delta.text ?? ""}`,
      thinking: delta.thinking === undefined ? last.thinking : `${last.thinking ?? ""}${delta.thinking}`
    };
  } else {
    next.push({ id: newId(), role: "assistant", text: delta.text ?? "", thinking: delta.thinking, timestamp: Date.now() });
  }
  return next;
}

function upsertToolPatchesIntoList(list: ChatMessage[], items: Array<{ toolCallId: string; patch: Partial<ChatMessage> }>): ChatMessage[] {
  if (!items.length) return list;
  const next = [...list];
  const indexById = new Map<string, number>();
  next.forEach((message, index) => {
    if (message.role === "tool" && message.toolCallId) indexById.set(message.toolCallId, index);
  });
  const now = Date.now();
  for (const item of items) {
    const cleanPatch = Object.fromEntries(Object.entries(item.patch).filter(([, value]) => value !== undefined)) as Partial<ChatMessage>;
    const idx = indexById.get(item.toolCallId);
    if (idx !== undefined) next[idx] = { ...next[idx], ...cleanPatch, timestamp: now };
    else {
      indexById.set(item.toolCallId, next.length);
      next.push({ id: newId(), role: "tool", text: "", toolCallId: item.toolCallId, timestamp: now, ...cleanPatch });
    }
  }
  return next;
}
