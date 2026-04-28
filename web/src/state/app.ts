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
  updateLastAssistant: (sessionId: string, delta: string) => void;
  updateLastAssistantThinking: (sessionId: string, delta: string) => void;
  upsertToolMessage: (sessionId: string, toolCallId: string, patch: Partial<ChatMessage>) => void;
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
  updateLastAssistant: (sessionId, delta) => set((s) => {
    const list = [...(s.messagesBySession[sessionId] ?? [])];
    const last = list[list.length - 1];
    if (last?.role === "assistant") list[list.length - 1] = { ...last, text: last.text + delta };
    else list.push({ id: newId(), role: "assistant", text: delta, timestamp: Date.now() });
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: list } };
  }),
  updateLastAssistantThinking: (sessionId, delta) => set((s) => {
    const list = [...(s.messagesBySession[sessionId] ?? [])];
    const last = list[list.length - 1];
    if (last?.role === "assistant") list[list.length - 1] = { ...last, thinking: `${last.thinking ?? ""}${delta}` };
    else list.push({ id: newId(), role: "assistant", text: "", thinking: delta, timestamp: Date.now() });
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: list } };
  }),
  upsertToolMessage: (sessionId, toolCallId, patch) => set((s) => {
    const list = [...(s.messagesBySession[sessionId] ?? [])];
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<ChatMessage>;
    const idx = list.findIndex((m) => m.role === "tool" && m.toolCallId === toolCallId);
    if (idx >= 0) list[idx] = { ...list[idx], ...cleanPatch, timestamp: Date.now() };
    else list.push({ id: newId(), role: "tool", text: "", toolCallId, timestamp: Date.now(), ...cleanPatch });
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: list } };
  }),
  setSessionMessages: (sessionId, messages) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: messages } })),
  setComposerDraft: (sessionId, draft) => set((s) => {
    const drafts = { ...s.composerDrafts };
    if (draft === undefined) delete drafts[sessionId];
    else drafts[sessionId] = draft;
    return { composerDrafts: drafts };
  }),
  clearMessages: (sessionId) => set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: [] } }))
}));
