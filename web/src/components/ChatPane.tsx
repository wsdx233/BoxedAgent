import { FormEvent, memo, type Dispatch, type DragEvent, type ElementType, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction, type TouchEvent as ReactTouchEvent, type WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Archive, Bot, Brain, CheckCircle2, ChevronDown, CircleAlert, Copy, ExternalLink, Eye, FilePenLine, FilePlus2, FileSearch, FolderTree, GitFork, ImageIcon, Loader2, Maximize2, Paperclip, RefreshCw, Search, Send, Sparkles, Square, Terminal, Wrench, X } from "lucide-react";
import SiApachemaven from "@icons-pack/react-simple-icons/icons/SiApachemaven.mjs";
import SiAstro from "@icons-pack/react-simple-icons/icons/SiAstro.mjs";
import SiC from "@icons-pack/react-simple-icons/icons/SiC.mjs";
import SiCmake from "@icons-pack/react-simple-icons/icons/SiCmake.mjs";
import SiCplusplus from "@icons-pack/react-simple-icons/icons/SiCplusplus.mjs";
import SiCss from "@icons-pack/react-simple-icons/icons/SiCss.mjs";
import SiDart from "@icons-pack/react-simple-icons/icons/SiDart.mjs";
import SiDocker from "@icons-pack/react-simple-icons/icons/SiDocker.mjs";
import SiDotenv from "@icons-pack/react-simple-icons/icons/SiDotenv.mjs";
import SiDotnet from "@icons-pack/react-simple-icons/icons/SiDotnet.mjs";
import SiElixir from "@icons-pack/react-simple-icons/icons/SiElixir.mjs";
import SiFishshell from "@icons-pack/react-simple-icons/icons/SiFishshell.mjs";
import SiGit from "@icons-pack/react-simple-icons/icons/SiGit.mjs";
import SiGnubash from "@icons-pack/react-simple-icons/icons/SiGnubash.mjs";
import SiGo from "@icons-pack/react-simple-icons/icons/SiGo.mjs";
import SiGradle from "@icons-pack/react-simple-icons/icons/SiGradle.mjs";
import SiGraphql from "@icons-pack/react-simple-icons/icons/SiGraphql.mjs";
import SiHtml5 from "@icons-pack/react-simple-icons/icons/SiHtml5.mjs";
import SiJavascript from "@icons-pack/react-simple-icons/icons/SiJavascript.mjs";
import SiJson from "@icons-pack/react-simple-icons/icons/SiJson.mjs";
import SiKotlin from "@icons-pack/react-simple-icons/icons/SiKotlin.mjs";
import SiLua from "@icons-pack/react-simple-icons/icons/SiLua.mjs";
import SiMake from "@icons-pack/react-simple-icons/icons/SiMake.mjs";
import SiMarkdown from "@icons-pack/react-simple-icons/icons/SiMarkdown.mjs";
import SiNodedotjs from "@icons-pack/react-simple-icons/icons/SiNodedotjs.mjs";
import SiNpm from "@icons-pack/react-simple-icons/icons/SiNpm.mjs";
import SiOpenjdk from "@icons-pack/react-simple-icons/icons/SiOpenjdk.mjs";
import SiPhp from "@icons-pack/react-simple-icons/icons/SiPhp.mjs";
import SiPostgresql from "@icons-pack/react-simple-icons/icons/SiPostgresql.mjs";
import SiPython from "@icons-pack/react-simple-icons/icons/SiPython.mjs";
import SiR from "@icons-pack/react-simple-icons/icons/SiR.mjs";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiRuby from "@icons-pack/react-simple-icons/icons/SiRuby.mjs";
import SiRust from "@icons-pack/react-simple-icons/icons/SiRust.mjs";
import SiScala from "@icons-pack/react-simple-icons/icons/SiScala.mjs";
import SiShell from "@icons-pack/react-simple-icons/icons/SiShell.mjs";
import SiSqlite from "@icons-pack/react-simple-icons/icons/SiSqlite.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiSwift from "@icons-pack/react-simple-icons/icons/SiSwift.mjs";
import SiToml from "@icons-pack/react-simple-icons/icons/SiToml.mjs";
import SiTypescript from "@icons-pack/react-simple-icons/icons/SiTypescript.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import SiYaml from "@icons-pack/react-simple-icons/icons/SiYaml.mjs";
import { api, closeWebSocketQuietly, wsUrl } from "../lib/api";
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from "../lib/composer-events";
import { newId } from "../lib/id";
import type { AgentSessionRecord, ChatAttachment, ChatMessage, PiLoadedResources, PiModel, PiSlashCommand, SessionStats, ThinkingLevel, ToolResultMeta } from "../lib/types";
import { useAppStore } from "../state/app";

interface QueueState {
  steering: string[];
  followUp: string[];
}

type ToolPatch = { toolCallId: string; patch: Partial<ChatMessage> };

interface StreamBufferState {
  sessionId?: string;
  text: string;
  thinking: string;
  toolPatches: ToolPatch[];
  frame?: number;
  timeout?: number;
}

interface RuntimeOutputBufferState {
  sessionId?: string;
  chunks: Array<{ source: "stderr" | "raw"; text: string }>;
  frame?: number;
  timeout?: number;
}

type SendMode = "normal" | "steer" | "followUp";
type MenuKey = "send" | "thinking" | "model" | "compact";
type SlashCommandSource = "builtin" | "extension";

interface SlashCommandSuggestion {
  name: string;
  description?: string;
  source: SlashCommandSource;
  path?: string;
}

interface SlashCompletionTrigger {
  start: number;
  end: number;
  query: string;
}

const WEB_SLASH_COMMANDS: SlashCommandSuggestion[] = [
  { name: "reload", source: "builtin", description: "Reload 当前 pi session：重新加载 extensions / skills / prompts / themes / context。" }
];

const SEND_MODES: Array<{ value: SendMode; label: string; description: string }> = [
  { value: "normal", label: "立即发送", description: "马上发送给当前 agent turn" },
  { value: "steer", label: "Steer 队列", description: "当前 turn 期间注入 steering message" },
  { value: "followUp", label: "Follow-up 队列", description: "agent 完成后继续追问" }
];

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string; description: string }> = [
  { value: "off", label: "Off", description: "关闭扩展思考" },
  { value: "minimal", label: "Minimal", description: "最少推理，响应更快" },
  { value: "low", label: "Low", description: "低强度思考" },
  { value: "medium", label: "Medium", description: "默认平衡" },
  { value: "high", label: "High", description: "更强推理" },
  { value: "xhigh", label: "XHigh", description: "超高推理，需模型支持" }
];

const ATTACHMENT_UPLOAD_DIR = ".upload";
const ATTACHMENT_UPLOAD_ABS_DIR = "/workspace/.upload";
const PROGRESS_NODE_HIDE_DISTANCE = 0.045;

export function ChatPane({ boxId, sessionId }: { boxId?: string; sessionId?: string }) {
  const {
    sessions,
    messagesBySession,
    appendMessage,
    appendAssistantDelta,
    upsertToolMessages,
    setSessionMessages,
    setComposerDraft,
    setSessions,
    setActiveSession,
    clearMessages
  } = useAppStore();
  const [text, setText] = useState("");
  const [sendMode, setSendMode] = useState<SendMode>("normal");
  const [slashCommands, setSlashCommands] = useState<SlashCommandSuggestion[]>(WEB_SLASH_COMMANDS);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [slashCommandsError, setSlashCommandsError] = useState<string>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashDismissedKey, setSlashDismissedKey] = useState<string>();
  const [composerSelection, setComposerSelection] = useState({ start: 0, end: 0 });
  const [openMenu, setOpenMenu] = useState<MenuKey>();
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [autoCompact, setAutoCompact] = useState(true);
  const [models, setModels] = useState<PiModel[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [modelLoading, setModelLoading] = useState(false);
  const [currentModel, setCurrentModel] = useState<{ provider?: string; model?: string }>({});
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [images, setImages] = useState<Array<{ type: "image"; data: string; mimeType: string; name: string; path?: string; size?: number }>>([]);
  const [fileAttachments, setFileAttachments] = useState<Array<{ kind: "file"; name: string; path: string; size?: number; mimeType?: string }>>([]);
  const [queue, setQueue] = useState<QueueState>({ steering: [], followUp: [] });
  const [turnActive, setTurnActive] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [scrollProgress, setScrollProgress] = useState(1);
  const [progressNodes, setProgressNodes] = useState<Array<{ id: string; label: string; text: string; position: number }>>([]);
  const [dragActive, setDragActive] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [expandingMessageIds, setExpandingMessageIds] = useState<Set<string>>(() => new Set());
  const [fullscreenMessage, setFullscreenMessage] = useState<ChatMessage>();
  const [forkingMessageId, setForkingMessageId] = useState<string>();
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const slashCommandsSessionRef = useRef<string>();
  const expectingTurnRef = useRef(false);
  const dragDepthRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const autoScrollLockUntilRef = useRef(0);
  const pinnedScrollRafRef = useRef<number>();
  const pinnedScrollTimeoutRef = useRef<number>();
  const streamBufferRef = useRef<StreamBufferState>({ text: "", thinking: "", toolPatches: [] });
  const runtimeOutputBufferRef = useRef<RuntimeOutputBufferState>({ chunks: [] });
  const runtimeNoticeKeysRef = useRef<Set<string>>(new Set());
  const session = sessions.find((s) => s.id === sessionId);
  const messages = sessionId ? messagesBySession[sessionId] ?? [] : [];
  const canSend = text.trim().length > 0 || images.length > 0 || fileAttachments.length > 0;
  const cwd = session?.cwd || "/workspace";
  const runtimeSubtitle = [currentModel.provider, currentModel.model, `thinking ${thinkingLevel}`, `compact ${autoCompact ? "auto" : "manual"}`].filter(Boolean).join(" · ");
  const isWorking = turnActive || session?.status === "working";
  const activityStatus = isWorking ? "working" : session?.status === "running" ? "running" : undefined;
  const slashCompletion = useMemo(() => detectSlashCompletion(text, composerSelection.start, composerSelection.end), [text, composerSelection.start, composerSelection.end]);
  const slashDismissKey = slashCompletion ? slashKeyForCompletion(slashCompletion) : undefined;
  const slashSuggestions = useMemo(() => slashCompletion ? filterSlashCommands(slashCommands, slashCompletion.query) : [], [slashCommands, slashCompletion?.query, slashCompletion?.start, slashCompletion?.end]);
  const activeSlashIndex = slashSuggestions.length ? Math.min(slashActiveIndex, slashSuggestions.length - 1) : 0;
  const slashAutocompleteActive = Boolean(slashCompletion && slashDismissKey !== slashDismissedKey);
  const slashPaletteOpen = Boolean(slashAutocompleteActive && (slashSuggestions.length > 0 || slashCommandsLoading || slashCommandsError));

  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const filtered = query
      ? models.filter((model) => `${modelProvider(model) ?? ""} ${model.id} ${model.name ?? ""}`.toLowerCase().includes(query))
      : models;
    return filtered.slice(0, 180);
  }, [models, modelSearch]);
  const renderedMessages = useMemo(() => messages.map((m, idx) => {
    const isLatest = idx === messages.length - 1;
    return <div key={m.id} id={messageDomId(m.id)} className="message-anchor-wrap"><MemoMessageBubble message={m} isLatest={isLatest} isStreaming={turnActive && isLatest} boxId={boxId} isExpanding={Boolean(m.transport?.messageId && expandingMessageIds.has(m.transport.messageId))} isForking={forkingMessageId === m.id} onExpand={expandMessage} onFork={forkAssistantMessage} onFullscreen={setFullscreenMessage} /></div>;
  }), [messages, boxId, expandingMessageIds, forkingMessageId, turnActive]);
  const userProgressKey = messages.filter((m) => m.role === "user").map((m) => `${m.id}:${m.text.length}:${m.attachments?.length ?? 0}`).join("|");
  const userProgressNodes = useMemo(() => messages.filter((m) => m.role === "user").map((m, idx) => ({ id: m.id, label: `#${idx + 1}`, text: m.text || attachmentSummary(m.attachments ?? []) })), [userProgressKey]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    schedulePinnedScroll();
  }, [messages.length, messages.at(-1)?.text, messages.at(-1)?.thinking, messages.at(-1)?.toolResult, isNearBottom]);

  useEffect(() => () => cancelPinnedScroll(), []);

  useEffect(() => {
    let raf = 0;
    let timeout: number | undefined;
    const update = () => {
      const scroller = messagesRef.current;
      if (!scroller) return;
      const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      setProgressNodes(userProgressNodes.map((node, idx) => {
        const el = document.getElementById(messageDomId(node.id));
        const fallback = userProgressNodes.length <= 1 ? 0 : idx / (userProgressNodes.length - 1);
        if (!el) return { ...node, position: fallback };
        const targetScrollTop = Math.min(maxScroll, Math.max(0, el.offsetTop - 28));
        return { ...node, position: targetScrollTop / maxScroll };
      }));
      const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const nearBottom = remaining < 180;
      if (remaining < 8) {
        stickToBottomRef.current = true;
        autoScrollLockUntilRef.current = 0;
      }
      setIsNearBottom(nearBottom);
      setScrollProgress(Math.min(1, Math.max(0, scroller.scrollTop / maxScroll)));
    };
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(update);
    };
    const scheduleAfterResize = () => {
      if (stickToBottomRef.current) schedulePinnedScroll();
      schedule();
    };
    schedule();
    timeout = window.setTimeout(update, 260);
    const scroller = messagesRef.current;
    const content = messagesContentRef.current;
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleAfterResize) : undefined;
    if (scroller) resizeObserver?.observe(scroller);
    if (content) resizeObserver?.observe(content);
    window.addEventListener("resize", scheduleAfterResize);
    return () => {
      window.cancelAnimationFrame(raf);
      if (timeout !== undefined) window.clearTimeout(timeout);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleAfterResize);
    };
  }, [userProgressNodes, messages.length, messages.at(-1)?.text, messages.at(-1)?.toolResult]);

  useEffect(() => {
    setOpenMenu(undefined);
    setModelSearch("");
    setModels([]);
    setStats(null);
    setSendMode("normal");
    resetSlashCommands();
    setSlashActiveIndex(0);
    setSlashDismissedKey(undefined);
    stickToBottomRef.current = true;
    if (!sessionId) return;
    const draft = useAppStore.getState().composerDrafts[sessionId];
    if (draft !== undefined) {
      setText(draft);
      setComposerDraft(sessionId, undefined);
    }
  }, [sessionId, setComposerDraft]);

  useEffect(() => {
    if (!sessionId || !slashAutocompleteActive) return;
    if (slashCommandsSessionRef.current === sessionId || slashCommandsLoading) return;
    let cancelled = false;
    setSlashCommandsLoading(true);
    setSlashCommandsError(undefined);
    api.sessionCommands(sessionId).then((res) => {
      if (cancelled) return;
      slashCommandsSessionRef.current = sessionId;
      setSlashCommands(mergeExtensionSlashCommands(res.commands ?? []));
    }).catch((err) => {
      if (cancelled) return;
      slashCommandsSessionRef.current = sessionId;
      setSlashCommands(WEB_SLASH_COMMANDS);
      setSlashCommandsError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setSlashCommandsLoading(false);
    });
    return () => { cancelled = true; };
  }, [sessionId, slashAutocompleteActive]);

  useEffect(() => {
    setSlashActiveIndex(0);
  }, [slashCompletion?.query, slashSuggestions.length]);

  useEffect(() => {
    if (!slashPaletteOpen || slashSuggestions.length === 0) return;
    const item = slashListRef.current?.querySelector(`[data-slash-index="${activeSlashIndex}"]`) as HTMLElement | null;
    item?.scrollIntoView({ block: "nearest" });
  }, [slashPaletteOpen, activeSlashIndex, slashSuggestions.length]);

  useEffect(() => {
    setThinkingLevel(session?.thinkingLevel ?? "medium");
    setAutoCompact(session?.autoCompactionEnabled ?? true);
    setCurrentModel({ provider: session?.provider, model: session?.model });
  }, [session?.provider, session?.model, session?.thinkingLevel, session?.autoCompactionEnabled]);

  useEffect(() => {
    if (!sessionId || !session?.loadedResources) return;
    const current = useAppStore.getState().messagesBySession[sessionId] ?? [];
    if (current.length > 0) return;
    appendLoadedResourcesNotice(sessionId, session.loadedResources);
  }, [sessionId, session?.loadedResources?.generatedAt]);

  useEffect(() => {
    if (!sessionId) return;
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<ComposerInsertDetail>).detail;
      if (detail?.sessionId !== sessionId || !detail.text) return;
      setText((current) => current ? `${current}${/\s$/.test(current) || /^\s/.test(detail.text) ? "" : " "}${detail.text}` : detail.text);
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
  }, [sessionId]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setOpenMenu(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenu]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setQueue({ steering: [], followUp: [] });
    setExpandingMessageIds(new Set());
    setFullscreenMessage(undefined);
    setForkingMessageId(undefined);
    expectingTurnRef.current = false;
    setTurnActive(false);
    const ws = new WebSocket(wsUrl(`/ws/sessions/${sessionId}/events`));
    ws.onerror = () => {
      if (!cancelled) appendRuntimeNotice(sessionId, "Session websocket 连接失败", "无法接收 pi runtime 事件，请检查后端日志或刷新页面重试。");
    };
    ws.onclose = (event) => {
      if (!cancelled && event.code !== 1000) appendRuntimeNotice(sessionId, "Session websocket 已断开", `code=${event.code}${event.reason ? ` reason=${event.reason}` : ""}`);
    };
    ws.onmessage = (event) => {
      if (cancelled) return;
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        appendRuntimeNotice(sessionId, "Session event 解析失败", `${err instanceof Error ? err.message : String(err)}\n\n${String(event.data ?? "")}`);
        return;
      }
      if (msg.type === "session_status") {
        if (msg.status === "working") {
          expectingTurnRef.current = true;
          setTurnActive(true);
        }
        if (msg.status === "running") {
          if (!expectingTurnRef.current) setTurnActive(false);
        }
        if (msg.status === "stopped" || msg.status === "error") {
          expectingTurnRef.current = false;
          setTurnActive(false);
        }
        if (typeof msg.status === "string") {
          const localStatus = expectingTurnRef.current && (msg.status === "starting" || msg.status === "running") ? "working" : msg.status;
          patchSessionLocal({ status: localStatus as any, error: msg.error });
          if (msg.status === "error" && msg.error) appendRuntimeNotice(sessionId, "pi runtime 错误", msg.error);
        }
      }
      if (msg.type === "agent_stderr") {
        enqueueRuntimeOutput(sessionId, "stderr", String(msg.data ?? ""));
        return;
      }
      if (msg.type === "agent_raw") {
        enqueueRuntimeOutput(sessionId, "raw", String(msg.line ?? ""));
        return;
      }
      if (msg.type === "agent_warning") {
        appendRuntimeNotice(sessionId, "pi warning", msg.warning ?? msg.message ?? msg);
        return;
      }
      if (msg.type === "loaded_resources") {
        const resources = msg.resources as PiLoadedResources;
        patchSessionLocal({ loadedResources: resources, cwd: resources.cwd });
        resetSlashCommands();
        appendLoadedResourcesNotice(sessionId, resources);
        return;
      }
      if (msg.type === "extension_ui") {
        handleExtensionUiMessage(sessionId, msg.request);
        return;
      }
      if (msg.type === "error") {
        appendRuntimeNotice(sessionId, "Session websocket 错误", msg.error ?? msg.message ?? msg);
        return;
      }
      if (msg.type !== "agent_event") return;
      const e = msg.event;
      const eventError = agentEventErrorText(e);
      if (eventError) appendRuntimeNotice(sessionId, "pi event 错误", eventError);
      if (e.type === "agent_start" || e.type === "turn_start" || e.type === "message_start") {
        expectingTurnRef.current = true;
        setTurnActive(true);
      }
      if (e.type === "agent_end" || e.type === "turn_end" || e.type === "message_end") {
        flushStreamBuffer();
        expectingTurnRef.current = false;
        setTurnActive(false);
        void refreshSessionStats(sessionId);
      }
      if (e.type === "message_update") {
        const delta = e.assistantMessageEvent;
        if (delta?.type === "start" || delta?.type === "text_start" || delta?.type === "thinking_start" || delta?.type === "toolcall_start") {
          expectingTurnRef.current = true;
          setTurnActive(true);
        }
        if (delta?.type === "text_delta") enqueueAssistantDelta(sessionId, { text: String(delta.delta ?? "") });
        if (delta?.type === "thinking_delta") enqueueAssistantDelta(sessionId, { thinking: String(delta.delta ?? "") });
        if (delta?.type === "toolcall_start" || delta?.type === "toolcall_delta" || delta?.type === "toolcall_end") {
          const tool = toolCallFromDelta(delta);
          const toolCallId = tool.id ?? String(delta.id ?? `${delta.contentIndex ?? "tool"}`);
          const patch: Partial<ChatMessage> = { toolCallId, toolName: tool.name ?? "tool", toolStatus: "pending" };
          if (tool.args !== undefined) patch.toolArgs = tool.args;
          enqueueToolPatch(sessionId, toolCallId, patch);
        }
        if (delta?.type === "done" || delta?.type === "error") {
          if (delta?.type === "error") appendRuntimeNotice(sessionId, "pi message_update 错误", agentEventErrorText(delta) || delta);
          flushStreamBuffer();
          expectingTurnRef.current = false;
          setTurnActive(false);
          void refreshSessionStats(sessionId);
        }
      }
      if (e.type === "tool_execution_start") {
        expectingTurnRef.current = true;
        setTurnActive(true);
        const patch: Partial<ChatMessage> = { toolName: e.toolName, toolStatus: "running" };
        if (e.args !== undefined) patch.toolArgs = e.args;
        enqueueToolPatch(sessionId, e.toolCallId ?? `${e.toolName}-${Date.now()}`, patch);
      }
      if (e.type === "tool_execution_update") {
        const patch: Partial<ChatMessage> = { toolName: e.toolName, toolResult: resultToText(e.partialResult), toolResultMeta: toolResultMeta(e.partialResult), toolStatus: "running" };
        if (e.args !== undefined) patch.toolArgs = e.args;
        enqueueToolPatch(sessionId, e.toolCallId ?? `${e.toolName}-${Date.now()}`, patch);
      }
      if (e.type === "tool_execution_end") {
        const patch: Partial<ChatMessage> = { toolName: e.toolName, toolResult: resultToText(e.result), toolResultMeta: toolResultMeta(e.result), toolStatus: e.isError ? "error" : "done" };
        if (e.args !== undefined) patch.toolArgs = e.args;
        enqueueToolPatch(sessionId, e.toolCallId ?? `${e.toolName}-${Date.now()}`, patch);
      }
      if (e.type === "queue_update") {
        setQueue({ steering: e.steering ?? [], followUp: e.followUp ?? [] });
      }
      if (e.type === "compaction_start") {
        expectingTurnRef.current = true;
        setTurnActive(true);
        appendMessage(sessionId, { id: newId(), role: "system", text: `正在压缩上下文：${e.reason ?? "manual"}`, timestamp: Date.now() });
      }
      if (e.type === "compaction_end") {
        flushStreamBuffer();
        expectingTurnRef.current = false;
        setTurnActive(false);
        appendMessage(sessionId, { id: newId(), role: "system", text: e.aborted ? "上下文压缩已取消" : `上下文压缩完成${e.willRetry ? "，将自动重试" : ""}${e.errorMessage ? `：${e.errorMessage}` : ""}`, timestamp: Date.now() });
        void refreshSessionStats(sessionId);
      }
    };
    setMessagesLoading(true);
    void api.messages(sessionId).then(async (res) => {
      await yieldToBrowser();
      const normalized = await normalizePiMessagesAsync(res.messages, () => cancelled);
      if (!cancelled) {
        setSessionMessages(sessionId, normalized);
        if (normalized.length === 0) {
          const resources = useAppStore.getState().sessions.find((item) => item.id === sessionId)?.loadedResources;
          if (resources) window.setTimeout(() => appendLoadedResourcesNotice(sessionId, resources), 0);
        }
      }
    }).catch((err) => {
      if (!cancelled) appendRuntimeNotice(sessionId, "加载 pi 历史消息失败", err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setMessagesLoading(false);
    });
    void refreshSessionStats(sessionId);
    return () => { cancelled = true; flushStreamBuffer(); flushRuntimeOutputBuffer(); closeWebSocketQuietly(ws); };
  }, [sessionId, appendMessage, setSessionMessages, appendAssistantDelta, upsertToolMessages]);

  function resetSlashCommands() {
    slashCommandsSessionRef.current = undefined;
    setSlashCommands(WEB_SLASH_COMMANDS);
    setSlashCommandsError(undefined);
    setSlashCommandsLoading(false);
  }

  function updateComposerSelection(el = textareaRef.current) {
    if (!el) return;
    const next = { start: el.selectionStart, end: el.selectionEnd };
    setComposerSelection((prev) => prev.start === next.start && prev.end === next.end ? prev : next);
  }

  function currentSlashCompletion() {
    const el = textareaRef.current;
    return el ? detectSlashCompletion(text, el.selectionStart, el.selectionEnd) : slashCompletion;
  }

  function applySlashCompletion(command: SlashCommandSuggestion) {
    const trigger = currentSlashCompletion();
    if (!trigger) return;
    const nextText = `${text.slice(0, trigger.start)}/${command.name} ${text.slice(trigger.end)}`;
    const cursor = trigger.start + command.name.length + 2;
    setText(nextText);
    setSlashDismissedKey(undefined);
    setComposerSelection({ start: cursor, end: cursor });
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
      updateComposerSelection(textarea);
    });
  }

  function isKnownExtensionCommandText(value: string): boolean {
    const name = slashCommandNameFromText(value);
    return Boolean(name && slashCommands.some((command) => command.source === "extension" && command.name === name));
  }

  function handleComposerKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const trigger = currentSlashCompletion();
    const key = trigger ? slashKeyForCompletion(trigger) : undefined;
    const paletteAvailable = Boolean(trigger && key !== slashDismissedKey);
    const items = trigger ? filterSlashCommands(slashCommands, trigger.query) : [];
    const selectedIndex = items.length ? Math.min(slashActiveIndex, items.length - 1) : 0;
    if (paletteAvailable && (items.length > 0 || slashCommandsLoading || slashCommandsError)) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActiveIndex((idx) => items.length ? (Math.min(idx, items.length - 1) + 1) % items.length : 0);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActiveIndex((idx) => items.length ? (Math.min(idx, items.length - 1) - 1 + items.length) % items.length : 0);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (items[selectedIndex]) applySlashCompletion(items[selectedIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        const selected = items[selectedIndex];
        const isExactCommand = Boolean(selected && trigger && selected.name.toLowerCase() === trigger.query.toLowerCase());
        if (!isExactCommand) {
          e.preventDefault();
          if (selected) applySlashCompletion(selected);
          return;
        }
      }
      if (e.key === "Escape" && key) {
        e.preventDefault();
        setSlashDismissedKey(key);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isWorking && canSend && !isKnownExtensionCommandText(text.trimEnd())) setOpenMenu("send");
      else void submit(undefined, "normal");
    }
  }

  async function settleExtensionCommandPrompt(targetSessionId: string) {
    window.setTimeout(async () => {
      if (targetSessionId !== useAppStore.getState().activeSessionId) return;
      try {
        const { state } = await api.sessionState(targetSessionId);
        if (targetSessionId !== useAppStore.getState().activeSessionId) return;
        const pendingCount = Number(state?.pendingMessageCount ?? 0);
        applyRuntimeState(state);
        if (!state?.isStreaming && !state?.isCompacting && pendingCount <= 0) {
          expectingTurnRef.current = false;
          setTurnActive(false);
          patchSessionLocal({ id: targetSessionId, status: "running" as AgentSessionRecord["status"] });
        }
      } catch {
        // The backend also performs an idle reconciliation for extension commands.
      }
    }, 420);
  }

  async function submit(e?: FormEvent, modeOverride?: SendMode) {
    e?.preventDefault();
    if (!sessionId || !boxId || !canSend) return;
    const message = text.trimEnd();
    if (message.trim() === "/reload" && images.length === 0 && fileAttachments.length === 0) {
      try {
        appendMessage(sessionId, { id: newId(), role: "user", text: message, timestamp: Date.now() });
        setText("");
        const res = await api.reloadSession(sessionId);
        patchSessionLocal(res.session);
        resetSlashCommands();
        if (res.session.loadedResources) appendLoadedResourcesNotice(sessionId, res.session.loadedResources);
        else appendMessage(sessionId, { id: newId(), role: "system", text: "已 reload 当前 pi session：extensions / skills / prompts / themes 已重新加载。", timestamp: Date.now() });
        void syncRuntimeState();
      } catch (err) {
        appendMessage(sessionId, { id: newId(), role: "system", text: `Reload 失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
      }
      return;
    }
    const attachments: ChatAttachment[] = [
      ...images.map((img) => ({ kind: "image" as const, name: img.name, mimeType: img.mimeType, data: img.data, path: img.path, size: img.size })),
      ...fileAttachments
    ];
    const displayMessage = message || attachmentSummary(attachments);
    let expanded: ExpandedFileRefs;
    try {
      expanded = await expandFileReferencesForPrompt(boxId, cwd, displayMessage);
    } catch (err) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `读取 @文件引用失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
      return;
    }
    const isExtensionCommandMessage = images.length === 0 && fileAttachments.length === 0 && isKnownExtensionCommandText(message);
    const activeAtSubmit = isWorking;
    const modeToUse = activeAtSubmit ? (isExtensionCommandMessage ? "normal" : (modeOverride ?? sendMode)) : "normal";
    const extraImages = images
      .filter((img) => !img.path || !expanded.referencedPaths.has(img.path))
      .map(({ name: _name, path: _path, size: _size, ...img }) => img);
    const payload: any = { message: expanded.message, images: [...expanded.images, ...extraImages] };
    if (modeToUse !== "normal") payload.streamingBehavior = modeToUse;
    try {
      if (activeAtSubmit && modeToUse === "normal" && !isExtensionCommandMessage) {
        await api.abortSession(sessionId);
        expectingTurnRef.current = false;
        setTurnActive(false);
        patchSessionLocal({ status: "running" as AgentSessionRecord["status"] });
      }
      appendMessage(sessionId, { id: newId(), role: "user", text: displayMessage, attachments, timestamp: Date.now() });
      setText("");
      setImages([]);
      setFileAttachments([]);
      expectingTurnRef.current = true;
      setTurnActive(true);
      patchSessionLocal({ status: "working" as AgentSessionRecord["status"] });
      try {
        await api.prompt(sessionId, payload);
        if (isExtensionCommandMessage) void settleExtensionCommandPrompt(sessionId);
      } catch (err) {
        if (modeToUse === "normal" && isAlreadyProcessingError(err)) {
          await api.abortSession(sessionId);
          await api.prompt(sessionId, payload);
          if (isExtensionCommandMessage) void settleExtensionCommandPrompt(sessionId);
        } else {
          throw err;
        }
      }
    } catch (err) {
      expectingTurnRef.current = false;
      setTurnActive(false);
      appendMessage(sessionId, { id: newId(), role: "system", text: `发送失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  async function runCompact(customInstructions?: string) {
    if (!sessionId) return;
    appendMessage(sessionId, { id: newId(), role: "system", text: customInstructions ? `已触发手动上下文压缩。自定义要求：${customInstructions}` : "已触发手动上下文压缩。", timestamp: Date.now() });
    setText("");
    setImages([]);
    setFileAttachments([]);
    expectingTurnRef.current = true;
    setTurnActive(true);
    patchSessionLocal({ status: "working" as AgentSessionRecord["status"] });
    try { await api.compactSession(sessionId, { customInstructions }); }
    catch (err) {
      expectingTurnRef.current = false;
      setTurnActive(false);
      appendMessage(sessionId, { id: newId(), role: "system", text: `压缩失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  function updateScrollFollowState(el: HTMLDivElement) {
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = remaining < 180;
    const isAutoScrolling = stickToBottomRef.current && performance.now() < autoScrollLockUntilRef.current;
    if (remaining < 8) {
      stickToBottomRef.current = true;
      autoScrollLockUntilRef.current = 0;
    } else if (remaining > 24 && !isAutoScrolling) stickToBottomRef.current = false;
    setIsNearBottom(nearBottom);
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    setScrollProgress(Math.min(1, Math.max(0, el.scrollTop / maxScroll)));
  }

  function handleScroll() {
    const el = messagesRef.current;
    if (!el) return;
    updateScrollFollowState(el);
  }

  function cancelPinnedScroll() {
    if (pinnedScrollRafRef.current !== undefined) {
      window.cancelAnimationFrame(pinnedScrollRafRef.current);
      pinnedScrollRafRef.current = undefined;
    }
    if (pinnedScrollTimeoutRef.current !== undefined) {
      window.clearTimeout(pinnedScrollTimeoutRef.current);
      pinnedScrollTimeoutRef.current = undefined;
    }
  }

  function detachFromBottom() {
    stickToBottomRef.current = false;
    autoScrollLockUntilRef.current = 0;
    cancelPinnedScroll();
  }

  function handleMessagesWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.deltaY < 0) detachFromBottom();
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = "auto") {
    const el = messagesRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    autoScrollLockUntilRef.current = Math.max(autoScrollLockUntilRef.current, performance.now() + (behavior === "smooth" ? 700 : 260));
    if (behavior === "smooth") el.scrollTo({ top: el.scrollHeight, behavior });
    else {
      const previousScrollBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = "auto";
      el.scrollTop = el.scrollHeight;
      if (previousScrollBehavior) el.style.scrollBehavior = previousScrollBehavior;
      else el.style.removeProperty("scroll-behavior");
    }
    setIsNearBottom(true);
    setScrollProgress(1);
  }

  function schedulePinnedScroll() {
    stickToBottomRef.current = true;
    cancelPinnedScroll();
    scrollMessagesToBottom("auto");
    pinnedScrollRafRef.current = window.requestAnimationFrame(() => {
      pinnedScrollRafRef.current = undefined;
      if (stickToBottomRef.current) scrollMessagesToBottom("auto");
    });
    pinnedScrollTimeoutRef.current = window.setTimeout(() => {
      pinnedScrollTimeoutRef.current = undefined;
      if (stickToBottomRef.current) scrollMessagesToBottom("auto");
    }, 120);
  }

  function scrollToMessage(id: string) {
    detachFromBottom();
    const el = document.getElementById(messageDomId(id));
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function scrollToBottom() {
    schedulePinnedScroll();
  }

  function scrollToProgress(nextProgress: number) {
    const el = messagesRef.current;
    if (!el) return;
    const progress = clamp01(nextProgress);
    if (progress > 0.995) stickToBottomRef.current = true;
    else detachFromBottom();
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    el.scrollTop = progress * maxScroll;
    handleScroll();
  }

  async function expandMessage(messageId: string) {
    if (!sessionId || expandingMessageIds.has(messageId)) return;
    setExpandingMessageIds((prev) => new Set(prev).add(messageId));
    try {
      const res = await api.message(sessionId, messageId);
      await yieldToBrowser();
      const normalized = await normalizePiMessagesAsync([res.message], () => false);
      const replacement = normalized[0];
      if (!replacement) return;
      const current = useAppStore.getState().messagesBySession[sessionId] ?? [];
      setSessionMessages(sessionId, replaceExpandedMessage(current, messageId, normalized));
    } catch (err) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `展开完整消息失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    } finally {
      setExpandingMessageIds((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }
  }

  function enqueueAssistantDelta(targetSessionId: string, delta: { text?: string; thinking?: string }) {
    const buffer = prepareStreamBuffer(targetSessionId);
    buffer.text += delta.text ?? "";
    buffer.thinking += delta.thinking ?? "";
    scheduleStreamBufferFlush();
  }

  function enqueueToolPatch(targetSessionId: string, toolCallId: string, patch: Partial<ChatMessage>) {
    const buffer = prepareStreamBuffer(targetSessionId);
    buffer.toolPatches.push({ toolCallId, patch });
    scheduleStreamBufferFlush();
  }

  function prepareStreamBuffer(targetSessionId: string): StreamBufferState {
    const buffer = streamBufferRef.current;
    if (buffer.sessionId && buffer.sessionId !== targetSessionId) flushStreamBuffer();
    buffer.sessionId = targetSessionId;
    return buffer;
  }

  function scheduleStreamBufferFlush() {
    const buffer = streamBufferRef.current;
    if (buffer.frame !== undefined || buffer.timeout !== undefined) return;
    buffer.frame = window.requestAnimationFrame(() => flushStreamBuffer());
    buffer.timeout = window.setTimeout(() => flushStreamBuffer(), 80);
  }

  function flushStreamBuffer() {
    const buffer = streamBufferRef.current;
    if (buffer.frame !== undefined) {
      window.cancelAnimationFrame(buffer.frame);
      buffer.frame = undefined;
    }
    if (buffer.timeout !== undefined) {
      window.clearTimeout(buffer.timeout);
      buffer.timeout = undefined;
    }
    const targetSessionId = buffer.sessionId;
    if (!targetSessionId) return;
    const text = buffer.text;
    const thinking = buffer.thinking;
    const toolPatches = buffer.toolPatches;
    buffer.text = "";
    buffer.thinking = "";
    buffer.toolPatches = [];
    if (text || thinking) appendAssistantDelta(targetSessionId, { text, thinking });
    if (toolPatches.length) upsertToolMessages(targetSessionId, coalesceToolPatches(toolPatches));
  }

  function enqueueRuntimeOutput(targetSessionId: string, source: "stderr" | "raw", text: string) {
    if (!text) return;
    const buffer = runtimeOutputBufferRef.current;
    if (buffer.sessionId && buffer.sessionId !== targetSessionId) flushRuntimeOutputBuffer();
    buffer.sessionId = targetSessionId;
    buffer.chunks.push({ source, text });
    if (buffer.frame !== undefined || buffer.timeout !== undefined) return;
    buffer.frame = window.requestAnimationFrame(() => flushRuntimeOutputBuffer());
    buffer.timeout = window.setTimeout(() => flushRuntimeOutputBuffer(), 160);
  }

  function flushRuntimeOutputBuffer() {
    const buffer = runtimeOutputBufferRef.current;
    if (buffer.frame !== undefined) {
      window.cancelAnimationFrame(buffer.frame);
      buffer.frame = undefined;
    }
    if (buffer.timeout !== undefined) {
      window.clearTimeout(buffer.timeout);
      buffer.timeout = undefined;
    }
    const targetSessionId = buffer.sessionId;
    if (!targetSessionId || !buffer.chunks.length) return;
    const groups: Array<{ source: "stderr" | "raw"; text: string }> = [];
    for (const chunk of buffer.chunks) {
      const last = groups[groups.length - 1];
      if (last?.source === chunk.source) last.text += chunk.source === "raw" ? `\n${chunk.text}` : chunk.text;
      else groups.push({ ...chunk });
    }
    buffer.chunks = [];
    for (const group of groups) {
      appendRuntimeNotice(targetSessionId, group.source === "stderr" ? "pi stderr" : "pi raw output", group.text, { dedupe: false });
    }
  }

  function appendRuntimeNotice(targetSessionId: string, title: string, detail?: unknown, options?: { dedupe?: boolean }) {
    const body = runtimeNoticeText(title, detail);
    const key = `${targetSessionId}:${body}`;
    if (options?.dedupe !== false) {
      const seen = runtimeNoticeKeysRef.current;
      if (seen.has(key)) return;
      if (seen.size > 400) seen.clear();
      seen.add(key);
    }
    appendMessage(targetSessionId, { id: newId(), role: "system", text: body, timestamp: Date.now() });
  }

  function appendLoadedResourcesNotice(targetSessionId: string, resources: PiLoadedResources) {
    const body = formatLoadedResources(resources);
    const key = `${targetSessionId}:resources:${resources.reason ?? "startup"}:${resources.cwd}:${resources.generatedAt}`;
    const seen = runtimeNoticeKeysRef.current;
    if (seen.has(key)) return;
    const current = useAppStore.getState().messagesBySession[targetSessionId] ?? [];
    if (current.some((message) => message.role === "system" && message.text === body)) return;
    if (seen.size > 400) seen.clear();
    seen.add(key);
    appendMessage(targetSessionId, { id: newId(), role: "system", text: body, timestamp: Date.now() });
  }

  function handleExtensionUiMessage(targetSessionId: string, request: any) {
    if (!request || typeof request !== "object") return;
    if (request.method === "set_editor_text" && typeof request.text === "string") {
      setText(request.text);
      return;
    }
    if (request.method === "notify") appendRuntimeNotice(targetSessionId, `extension ${request.notifyType ?? "info"}`, request.message);
  }

  function patchSessionLocal(patch: Partial<AgentSessionRecord>) {
    const id = patch.id ?? sessionId;
    if (!id) return;
    const current = useAppStore.getState().sessions;
    setSessions(current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function applyRuntimeState(state: any) {
    if (!state) return;
    const model = state.model as PiModel | null | undefined;
    const provider = modelProvider(model);
    if (model?.id) setCurrentModel({ provider, model: model.id });
    if (isThinkingLevel(state.thinkingLevel)) setThinkingLevel(state.thinkingLevel);
    if (typeof state.autoCompactionEnabled === "boolean") setAutoCompact(state.autoCompactionEnabled);
    patchSessionLocal({
      provider: provider ?? currentModel.provider,
      model: model?.id ?? currentModel.model,
      thinkingLevel: isThinkingLevel(state.thinkingLevel) ? state.thinkingLevel : thinkingLevel,
      autoCompactionEnabled: typeof state.autoCompactionEnabled === "boolean" ? state.autoCompactionEnabled : autoCompact,
      cwd
    });
  }

  async function syncRuntimeState() {
    if (!sessionId) return;
    try {
      const { state } = await api.sessionState(sessionId);
      applyRuntimeState(state);
    } catch {
      // State requires a running RPC runtime. Keep the locally known session fields if it fails.
    }
    void refreshSessionStats(sessionId);
  }

  async function forkAssistantMessage(message: ChatMessage) {
    if (!sessionId || message.role !== "assistant" || forkingMessageId) return;
    setForkingMessageId(message.id);
    try {
      const sourceIndex = await resolveAssistantForkSourceIndex(message);
      if (sourceIndex === undefined) throw new Error("这条回复尚未写入历史，暂时不能分支。请等待回复完成后再试。");
      const res = await api.forkMessage(sessionId, { messageIndex: sourceIndex, name: forkSessionName(session?.name ?? "Session") });
      if (res.cancelled) return;
      setSessions((await api.listSessions()).sessions);
      clearMessages(res.session.id);
      setActiveSession(res.session.id);
      if (res.text) setComposerDraft(res.session.id, res.text);
    } catch (err) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `Fork 失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    } finally {
      setForkingMessageId(undefined);
    }
  }

  async function resolveAssistantForkSourceIndex(message: ChatMessage): Promise<number | undefined> {
    if (!sessionId) return undefined;
    try {
      const res = await api.messages(sessionId);
      const normalized = await normalizePiMessagesAsync(res.messages, () => false);
      const assistantMessages = normalized.filter((item) => item.role === "assistant" && item.sourceIndex !== undefined);
      const exact = assistantMessages.filter((item) => item.text === message.text && (!message.thinking || item.thinking === message.thinking)).at(-1);
      if (exact?.sourceIndex !== undefined) return exact.sourceIndex;
      const sameIndex = message.sourceIndex === undefined ? undefined : assistantMessages.find((item) => item.sourceIndex === message.sourceIndex);
      if (sameIndex?.sourceIndex !== undefined) return sameIndex.sourceIndex;
    } catch {
      // Fall back to the local index assigned while rendering the current conversation.
    }
    return message.sourceIndex;
  }

  async function refreshSessionStats(id = sessionId) {
    if (!id) return;
    try {
      const res = await api.sessionStats(id);
      if (id === useAppStore.getState().activeSessionId) {
        setStats(res.stats ?? null);
        if (res.stats?.loadedResources) patchSessionLocal({ id, loadedResources: res.stats.loadedResources, cwd: res.stats.loadedResources.cwd });
      }
    } catch {
      if (id === useAppStore.getState().activeSessionId) setStats(null);
    }
  }

  async function ensureModels(force = false) {
    if (!sessionId || modelLoading || (!force && models.length > 0)) return;
    setModelLoading(true);
    try {
      const [stateResult, modelResult] = await Promise.allSettled([api.sessionState(sessionId), api.sessionModels(sessionId)]);
      if (stateResult.status === "fulfilled") applyRuntimeState(stateResult.value.state);
      if (modelResult.status === "fulfilled") setModels(modelResult.value.models ?? []);
      if (modelResult.status === "rejected") throw modelResult.reason;
    } catch (err) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `加载模型列表失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    } finally {
      setModelLoading(false);
    }
  }

  function toggleMenu(menu: MenuKey) {
    const opening = openMenu !== menu;
    setOpenMenu(opening ? menu : undefined);
    if (!opening) return;
    if (menu === "model") void ensureModels();
    if (menu === "thinking" || menu === "compact") void syncRuntimeState();
  }

  function chooseSendMode(next: SendMode) {
    setSendMode(next);
    setOpenMenu(undefined);
    if (canSend) void submit(undefined, next);
  }

  async function chooseThinking(next: ThinkingLevel) {
    if (!sessionId) return;
    setThinkingLevel(next);
    setOpenMenu(undefined);
    try {
      const res = await api.setSessionThinking(sessionId, next);
      patchSessionLocal(res.session);
      applyRuntimeState(res.state);
    } catch (err) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `切换 thinking 失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  async function chooseModel(model: PiModel) {
    if (!sessionId) return;
    const provider = modelProvider(model);
    if (!provider) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `模型 ${model.id} 缺少 provider，无法切换。`, timestamp: Date.now() });
      return;
    }
    setCurrentModel({ provider, model: model.id });
    setOpenMenu(undefined);
    try {
      const res = await api.setSessionModel(sessionId, { provider, modelId: model.id });
      patchSessionLocal(res.session);
      if (res.model?.id) setCurrentModel({ provider: modelProvider(res.model) ?? provider, model: res.model.id });
    } catch (err) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `切换模型失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  async function setAutoCompactMode(enabled: boolean) {
    if (!sessionId || autoCompact === enabled) return;
    const previous = autoCompact;
    setAutoCompact(enabled);
    try {
      const res = await api.setAutoCompaction(sessionId, enabled);
      patchSessionLocal(res.session);
      applyRuntimeState(res.state);
    } catch (err) {
      setAutoCompact(previous);
      appendMessage(sessionId, { id: newId(), role: "system", text: `切换 compact 模式失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  async function abortTurn() {
    if (!sessionId) return;
    setOpenMenu(undefined);
    try {
      await api.abortSession(sessionId);
      expectingTurnRef.current = false;
      setTurnActive(false);
      patchSessionLocal({ status: "running" as AgentSessionRecord["status"] });
      void refreshSessionStats(sessionId);
    } catch (err) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `中止失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  async function handleAttachmentFiles(input: Iterable<File> | FileList | null | undefined) {
    const files = [...(input ?? [])].filter((file) => file.size >= 0);
    if (!files.length) return;
    if (!boxId) {
      if (sessionId) appendMessage(sessionId, { id: newId(), role: "system", text: "上传附件失败：请先选择 Box。", timestamp: Date.now() });
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const otherFiles = files.filter((file) => !file.type.startsWith("image/"));
    setUploadingFiles(true);
    try {
      const uploaded = await uploadFilesToAttachmentDir(boxId, files);
      if (imageFiles.length) {
        const converted = await filesToImages(imageFiles, uploaded);
        setImages((prev) => [...prev, ...converted]);
      }
      if (otherFiles.length) {
        setFileAttachments((prev) => [...prev, ...otherFiles.map((file) => ({ kind: "file" as const, name: file.name, path: uploaded.get(file)?.path ?? uploadedPathForName(file.name), size: file.size, mimeType: file.type || undefined }))]);
      }
      const refs = files.map((file) => fileRef(uploaded.get(file)?.path ?? uploadedPathForName(file.name))).join(" ");
      setText((t) => `${t}${t && !/\s$/.test(t) ? " " : ""}${refs}`);
    } catch (err) {
      if (sessionId) appendMessage(sessionId, { id: newId(), role: "system", text: `上传附件失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    } finally {
      setUploadingFiles(false);
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    void handleAttachmentFiles(event.dataTransfer.files);
  }

  if (!boxId) return <EmptyChat title="选择或创建 Box" subtitle="每个 Box 都是独立 Docker 沙箱，包含自己的 pi 配置、文件系统和 code-server。" />;
  if (!sessionId) return <EmptyChat title="选择或创建 Session" subtitle="Session 负责和 Box 内的 pi RPC agent 对话；可以为同一个 Box 并行开多个会话。" />;

  return <div className={`chat surface-tonal ${dragActive ? "drag-active" : ""}`} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
    {dragActive && <div className="drop-overlay"><Paperclip size={28} /><strong>拖放文件到这里</strong><span>附件会上传到 /workspace/.upload，并以 @file 方式发送</span></div>}
    <div className="chat-topbar">
      <div className="chat-title-block">
        <div className="chat-title"><Sparkles size={18} /> {session?.name ?? "Session"}</div>
        <div className="chat-subtitle">{runtimeSubtitle}</div>
        <div className="runtime-strip">
          <span className="runtime-chip cwd-chip">{cwd}</span>
          <span className="runtime-chip context-chip">{formatStats(stats, autoCompact)}</span>
        </div>
      </div>
      <div className={`chat-topbar-state ${activityStatus ?? ""}`} title={activityStatus === "working" ? "模型正在工作" : activityStatus === "running" ? "Agent runtime 已连接" : "空闲"}>{activityStatus && <><span className="live-dot" /> <span>{activityStatus === "working" ? "working" : "running"}</span></>}</div>
    </div>

    {session?.error && <div className="chat-error-banner"><CircleAlert size={15} /><span>{session.error}</span></div>}

    <ChatProgressRail progress={scrollProgress} nodes={progressNodes} showBottomButton={!isNearBottom} onProgressChange={scrollToProgress} onJumpToMessage={scrollToMessage} onJumpBottom={scrollToBottom} />

    <div className="messages" ref={messagesRef} onScroll={handleScroll} onWheelCapture={handleMessagesWheel}>
      <div className="messages-content" ref={messagesContentRef}>
        {messagesLoading && <div className="session-loading-card"><Loader2 size={18} className="spin" /><strong>正在加载 Session…</strong><span>历史消息会在后台恢复，界面仍可操作。</span></div>}
        {!messagesLoading && messages.length === 0 && <div className="welcome-card">
          <div className="welcome-orb"><Sparkles size={24} /></div>
          <h2>准备好开始了吗？</h2>
          <p>像 Claude 一样自然地描述任务。BoxedAgent 会把上下文、文件和工具调用整合到这个 Box 内的 pi agent。</p>
          <div className="prompt-suggestions">
            <button type="button" onClick={() => setText("请快速了解这个 workspace 的结构，并给我一个简短总结。")}>总结 workspace</button>
            <button type="button" onClick={() => setText("请运行必要检查，找出当前项目最值得改进的地方。")}>检查项目</button>
            <button type="button" onClick={() => setText("请帮我实现一个小改动，并说明测试方式。")}>实现改动</button>
          </div>
        </div>}
        {renderedMessages}
        {turnActive && <div className="assistant-thinking"><Loader2 size={14} className="spin" /> pi 正在处理…</div>}
        <div ref={bottomRef} />
      </div>
    </div>

    <form className="composer" ref={composerRef} onSubmit={(e) => submit(e)}>
      {(queue.steering.length > 0 || queue.followUp.length > 0) && <div className="queue-strip">
        {queue.steering.map((item, i) => <span key={`s-${i}`} className="queue-chip">Steer · {item}</span>)}
        {queue.followUp.map((item, i) => <span key={`f-${i}`} className="queue-chip">Follow-up · {item}</span>)}
      </div>}
      <ComposerAttachmentStrip boxId={boxId} images={images} fileAttachments={fileAttachments} uploadingFiles={uploadingFiles} setImages={setImages} setFileAttachments={setFileAttachments} />
      {slashPaletteOpen && <SlashCommandPalette commands={slashSuggestions} activeIndex={activeSlashIndex} loading={slashCommandsLoading} error={slashCommandsError} listRef={slashListRef} onActiveIndexChange={setSlashActiveIndex} onChoose={applySlashCompletion} />}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => { setText(e.target.value); updateComposerSelection(e.currentTarget); }}
        onSelect={(e) => updateComposerSelection(e.currentTarget)}
        onClick={(e) => updateComposerSelection(e.currentTarget)}
        onKeyUp={(e) => updateComposerSelection(e.currentTarget)}
        placeholder="Message BoxedAgent…"
        onKeyDown={handleComposerKeyDown}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <button type="button" className="icon-button" title="附件" onClick={() => fileInputRef.current?.click()}><Paperclip size={18} /></button>
          <div className="control-menu-anchor">
            <ControlMenuButton active={openMenu === "thinking"} onClick={() => toggleMenu("thinking")} icon={<Brain size={16} />} label={`Thinking ${thinkingLevel}`} />
            {openMenu === "thinking" && <MenuPanel className="thinking-menu">
              <MenuTitle icon={<Brain size={15} />} title="思考强度" subtitle="和 pi TUI /settings 中的 thinking level 一致" />
              {THINKING_LEVELS.map((item) => <MenuItem key={item.value} selected={thinkingLevel === item.value} onClick={() => chooseThinking(item.value)} title={item.label} description={item.description} />)}
            </MenuPanel>}
          </div>
          <div className="control-menu-anchor">
            <ControlMenuButton active={openMenu === "model"} onClick={() => toggleMenu("model")} icon={<Bot size={16} />} label={currentModel.model ?? "模型"} />
            {openMenu === "model" && <MenuPanel className="model-menu">
              <MenuTitle icon={<Bot size={15} />} title="模型" subtitle="来自 pi RPC get_available_models，等价于 TUI /models 列表" action={<button type="button" className="icon-button compact-icon" title="刷新模型" onClick={() => ensureModels(true)}><RefreshCw size={13} /></button>} />
              <input className="menu-search" value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="搜索 provider / model…" />
              {modelLoading && <div className="menu-loading"><Loader2 size={14} className="spin" /> 正在加载模型…</div>}
              {!modelLoading && visibleModels.length === 0 && <div className="empty-menu">没有可显示的模型</div>}
              <div className="model-list">
                {visibleModels.map((model) => {
                  const provider = modelProvider(model);
                  const selected = provider === currentModel.provider && model.id === currentModel.model;
                  return <button type="button" key={`${provider ?? "unknown"}/${model.id}`} className={`model-option ${selected ? "selected" : ""}`} onClick={() => chooseModel(model)}>
                    <span className="model-option-main"><span>{model.name || model.id}</span>{model.reasoning && <span className="mini-badge">reasoning</span>}</span>
                    <span className="model-option-sub">{provider ?? "unknown"} · {model.id}{model.contextWindow ? ` · ${formatTokens(model.contextWindow)} ctx` : ""}</span>
                  </button>;
                })}
              </div>
              {models.length > visibleModels.length && <div className="small">仅显示前 {visibleModels.length} 个匹配结果，请搜索缩小范围。</div>}
            </MenuPanel>}
          </div>
          <div className="control-menu-anchor">
            <ControlMenuButton active={openMenu === "compact"} onClick={() => toggleMenu("compact")} icon={<Archive size={16} />} label={autoCompact ? "Compact 自动" : "Compact 手动"} />
            {openMenu === "compact" && <MenuPanel className="compact-menu">
              <MenuTitle icon={<Archive size={15} />} title="Compact" subtitle="自动模式会在上下文接近上限时压缩；手动模式可通过下方项目立即触发" />
              <MenuItem selected={autoCompact} onClick={() => setAutoCompactMode(true)} title="自动 Compact" description={autoCompact ? "已开启：上下文接近上限时自动压缩" : "点击开启自动压缩"} />
              <MenuItem selected={!autoCompact} onClick={() => setAutoCompactMode(false)} title="手动 Compact" description="关闭自动压缩，只在你点击立即执行时压缩" />
              <div className="menu-divider" />
              <MenuItem onClick={() => { setOpenMenu(undefined); void runCompact(text.trim() || undefined); }} title="立即执行 Compact" description="如果输入框有内容，会作为本次压缩的自定义要求" />
            </MenuPanel>}
          </div>
          <input ref={fileInputRef} hidden type="file" multiple onChange={async (e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            await handleAttachmentFiles(files);
          }} />
        </div>

        <div className="send-cluster">
          <span className="send-mode-label">{isWorking ? (canSend ? (isKnownExtensionCommandText(text.trimEnd()) ? "执行指令" : "选择发送方式") : "停止生成") : "发送"}</span>
          <div className="send-menu-anchor">
            {isWorking && !canSend ? <button type="button" className="send-fab stop-fab" title="中止当前任务" onClick={abortTurn}><Square size={19} /></button> : <>
              <button type="button" className={`send-fab ${canSend ? "" : "idle"}`} title={isWorking && !isKnownExtensionCommandText(text.trimEnd()) ? "选择发送方式" : "发送"} onClick={() => { if (isWorking && !isKnownExtensionCommandText(text.trimEnd())) toggleMenu("send"); else void submit(undefined, "normal"); }}><Send size={20} /></button>
              {openMenu === "send" && isWorking && <MenuPanel className="send-menu">
                <MenuTitle icon={<Send size={15} />} title="发送方式" subtitle="当前 agent 正在处理：立即发送会先中断当前 turn；Steer / Follow-up 会加入队列。" />
                {SEND_MODES.map((item) => <MenuItem key={item.value} selected={sendMode === item.value} onClick={() => chooseSendMode(item.value)} title={item.label} description={item.value === "normal" ? "中断当前 turn，然后立即发送这条消息" : item.description} />)}
              </MenuPanel>}
            </>}
          </div>
        </div>
      </div>
    </form>
    {fullscreenMessage && <MessageFullscreenDialog message={fullscreenMessage} onClose={() => setFullscreenMessage(undefined)} />}
  </div>;
}

function SlashCommandPalette({ commands, activeIndex, loading, error, listRef, onActiveIndexChange, onChoose }: {
  commands: SlashCommandSuggestion[];
  activeIndex: number;
  loading: boolean;
  error?: string;
  listRef: { current: HTMLDivElement | null };
  onActiveIndexChange: (index: number) => void;
  onChoose: (command: SlashCommandSuggestion) => void;
}) {
  return <div className="slash-command-palette" role="listbox" aria-label="可用 slash commands" onMouseDown={(event) => event.preventDefault()}>
    <div className="slash-command-head">
      <Terminal size={15} />
      <div><strong>可用指令</strong><small>↑/↓ 选择，Tab 或 Enter 补全</small></div>
      {loading && <Loader2 size={14} className="spin" />}
    </div>
    <div className="slash-command-list" ref={listRef}>
      {commands.map((command, idx) => <button
        type="button"
        key={`${command.source}:${command.name}`}
        data-slash-index={idx}
        role="option"
        aria-selected={idx === activeIndex}
        className={`slash-command-item ${idx === activeIndex ? "active" : ""}`}
        onMouseEnter={() => onActiveIndexChange(idx)}
        onMouseDown={(event) => { event.preventDefault(); onChoose(command); }}
      >
        <span className="slash-command-name">/{command.name}</span>
        <span className={`slash-command-source ${command.source}`}>{command.source === "builtin" ? "web" : "extension"}</span>
        {command.description && <span className="slash-command-description">{command.description}</span>}
        {!command.description && command.path && <span className="slash-command-description">{command.path}</span>}
      </button>)}
      {commands.length === 0 && !loading && <div className="slash-command-empty">没有匹配的 extension 指令。</div>}
    </div>
    {error && <div className="slash-command-error">插件指令加载失败，仅显示 /reload：{error}</div>}
  </div>;
}

function detectSlashCompletion(value: string, selectionStart: number, selectionEnd: number): SlashCompletionTrigger | null {
  if (selectionStart !== selectionEnd) return null;
  const beforeCursor = value.slice(0, selectionStart);
  const match = beforeCursor.match(/^\/([^\s/]*)$/);
  if (!match) return null;
  return { start: 0, end: selectionStart, query: match[1] ?? "" };
}

function slashKeyForCompletion(trigger: SlashCompletionTrigger): string {
  return `${trigger.start}:${trigger.end}:${trigger.query}`;
}

function filterSlashCommands(commands: SlashCommandSuggestion[], query: string): SlashCommandSuggestion[] {
  const normalized = query.trim().toLowerCase();
  return commands
    .map((command, index) => ({ command, index, score: slashCommandMatchScore(command.name, normalized) }))
    .filter((item) => item.score < Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || slashSourceOrder(a.command.source) - slashSourceOrder(b.command.source) || a.index - b.index)
    .slice(0, 30)
    .map((item) => item.command);
}

function slashCommandMatchScore(name: string, query: string): number {
  if (!query) return 0;
  const lower = name.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1;
  if (lower.includes(query)) return 2;
  return Number.POSITIVE_INFINITY;
}

function slashSourceOrder(source: SlashCommandSource): number {
  return source === "builtin" ? 0 : 1;
}

function mergeExtensionSlashCommands(commands: PiSlashCommand[]): SlashCommandSuggestion[] {
  const seen = new Set(WEB_SLASH_COMMANDS.map((command) => command.name.toLowerCase()));
  const extensionCommands: SlashCommandSuggestion[] = [];
  for (const command of commands) {
    if (command.source !== "extension") continue;
    const name = command.name.trim();
    if (!name || name === "reload" || name.includes("/") || /\s/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extensionCommands.push({ name, source: "extension", description: command.description, path: slashCommandSourcePath(command) });
  }
  return [...WEB_SLASH_COMMANDS, ...extensionCommands];
}

function slashCommandSourcePath(command: PiSlashCommand): string | undefined {
  const value = command.sourceInfo?.path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slashCommandNameFromText(value: string): string | undefined {
  const text = value.trimEnd();
  if (!text.startsWith("/")) return undefined;
  const name = text.slice(1).split(/\s+/, 1)[0]?.trim();
  return name || undefined;
}

function formatLoadedResources(resources: PiLoadedResources): string {
  const title = resources.reason === "reload" ? "已 reload 当前 pi session" : resources.reason === "manual" ? "当前 pi session 已加载资源" : "pi session 已启动并加载资源";
  const lines = [`${title}（cwd: ${resources.cwd}）`];
  addResourceLine(lines, "Context", resources.contextFiles.map((item) => item.path));
  addResourceLine(lines, "Packages", resources.packages.map((item) => item.source || item.path || item.name));
  addResourceLine(lines, "Extensions", resources.extensions.map((item) => item.name || item.path));
  addResourceLine(lines, "Skills", resources.skills.map((item) => item.name));
  addResourceLine(lines, "Prompts", resources.prompts.map((item) => item.name));
  addResourceLine(lines, "Themes", resources.themes.map((item) => item.name));
  if (resources.diagnostics.length) lines.push(`Warnings: ${previewList(resources.diagnostics, 4)}`);
  if (lines.length === 1) lines.push("未发现 AGENTS.md / packages / extensions / skills / prompts / themes。");
  return lines.join("\n");
}

function addResourceLine(lines: string[], label: string, values: string[]) {
  const clean = values.map((value) => value.trim()).filter(Boolean);
  if (clean.length) lines.push(`${label}: ${previewList(clean, 8)}`);
}

function previewList(values: string[], max: number): string {
  const unique = Array.from(new Set(values));
  const shown = unique.slice(0, max).join(", ");
  const remaining = unique.length - max;
  return remaining > 0 ? `${shown} … +${remaining}` : shown;
}

function runtimeNoticeText(title: string, detail?: unknown): string {
  const detailText = runtimeDetailText(detail).trim();
  if (!detailText) return `**${title}**`;
  return `**${title}**\n\n\`\`\`text\n${detailText.replace(/```/g, "`\u200b``")}\n\`\`\``;
}

function runtimeDetailText(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return detail;
  if (detail instanceof Error) return detail.stack || detail.message;
  return safeJson(detail);
}

function agentEventErrorText(event: any): string {
  if (!event || typeof event !== "object") return "";
  const isErrorEvent = event.type === "error" || event.type === "agent_error" || event.type === "turn_error" || event.type === "message_error";
  const isAssistantError = event.assistantMessageEvent?.type === "error";
  const candidates = [
    event.error,
    event.errorMessage,
    event.exception,
    event.data?.error,
    event.data?.errorMessage,
    event.result?.error,
    event.result?.errorMessage,
    event.assistantMessageEvent?.error,
    event.assistantMessageEvent?.errorMessage,
    ...(isErrorEvent ? [event.message, event.reason] : []),
    ...(isAssistantError ? [event.assistantMessageEvent?.message, event.assistantMessageEvent?.reason] : [])
  ];
  const explicit = candidates.map(runtimeDetailText).find((text) => text.trim());
  if (explicit) return explicit;
  if (isErrorEvent) return safeJson(event);
  if (isAssistantError) return safeJson(event.assistantMessageEvent);
  return "";
}

function coalesceToolPatches(items: ToolPatch[]): ToolPatch[] {
  const byId = new Map<string, Partial<ChatMessage>>();
  for (const item of items) byId.set(item.toolCallId, { ...(byId.get(item.toolCallId) ?? {}), ...item.patch });
  return Array.from(byId, ([toolCallId, patch]) => ({ toolCallId, patch }));
}

function ControlMenuButton({ icon, label, active, onClick }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return <button type="button" className={`control-chip ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span><ChevronDown size={14} /></button>;
}

function MenuPanel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`md-menu ${className ?? ""}`}>{children}</div>;
}

function MenuTitle({ icon, title, subtitle, action }: { icon: ReactNode; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="menu-title">
    <div className="menu-title-icon">{icon}</div>
    <div><strong>{title}</strong>{subtitle && <p>{subtitle}</p>}</div>
    {action && <div className="menu-title-action">{action}</div>}
  </div>;
}

function MenuItem({ title, description, selected, disabled, onClick }: { title: string; description?: string; selected?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={`menu-item ${selected ? "selected" : ""}`} disabled={disabled} onClick={onClick}>
    <span className="menu-item-check">{selected ? <CheckCircle2 size={16} /> : <span />}</span>
    <span><strong>{title}</strong>{description && <small>{description}</small>}</span>
  </button>;
}

function EmptyChat({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="chat empty-chat surface-tonal">
    <div className="welcome-card elevated"><div className="welcome-orb"><Sparkles size={26} /></div><h2>{title}</h2><p>{subtitle}</p></div>
  </div>;
}

function MessageBubble({ message, isLatest, isStreaming, boxId, isExpanding, isForking, onExpand, onFork, onFullscreen }: { message: ChatMessage; isLatest: boolean; isStreaming?: boolean; boxId?: string; isExpanding?: boolean; isForking?: boolean; onExpand?: (messageId: string) => void; onFork?: (message: ChatMessage) => void; onFullscreen?: (message: ChatMessage) => void }) {
  const truncation = message.transport?.truncated ? message.transport : undefined;
  if (message.role === "tool") return <ToolCard message={message} isLatest={isLatest} isExpanding={isExpanding} onExpand={onExpand} />;
  if (message.role === "system") return <div className="system-line"><CircleAlert size={14} /> <MarkdownText text={message.text} />{truncation && <TruncationNotice meta={truncation} loading={isExpanding} onExpand={onExpand} />}</div>;
  return <article className={`message-row ${message.role}`}>
    <div className={`message ${message.role}`}>
      {message.thinking && <ThinkingBlock text={message.thinking} autoOpen={isLatest} />}
      {message.text ? message.role === "user" ? <UserMessageText text={message.text} /> : <MarkdownText text={message.text} streaming={isStreaming} /> : message.thinking ? null : <span className="muted">…</span>}
      {message.attachments?.length ? <AttachmentGallery attachments={message.attachments} boxId={boxId} /> : null}
      {truncation && <TruncationNotice meta={truncation} loading={isExpanding} onExpand={onExpand} />}
      {message.role === "assistant" && message.text.trim() && <AssistantMessageActions message={message} isForking={isForking} isStreaming={isStreaming} onFork={onFork} onFullscreen={onFullscreen} />}
    </div>
  </article>;
}

const MemoMessageBubble = memo(MessageBubble);

function AssistantMessageActions({ message, isForking, isStreaming, onFork, onFullscreen }: { message: ChatMessage; isForking?: boolean; isStreaming?: boolean; onFork?: (message: ChatMessage) => void; onFullscreen?: (message: ChatMessage) => void }) {
  const forkDisabled = isForking || isStreaming;
  const forkTitle = isStreaming ? "回复完成后可创建分支" : "从这条回复创建分支";
  return <div className="assistant-message-actions" aria-label="Assistant 回复操作">
    <CopyIconButton text={message.text} title="复制 Markdown" />
    <button type="button" className="message-action-icon" title={forkTitle} disabled={forkDisabled} onClick={() => onFork?.(message)}>{isForking ? <Loader2 size={15} className="spin" /> : <GitFork size={15} />}</button>
    <button type="button" className="message-action-icon" title="放大显示" onClick={() => onFullscreen?.(message)}><Maximize2 size={15} /></button>
  </div>;
}

function MessageFullscreenDialog({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(<div className="modal-backdrop message-fullscreen-backdrop" onMouseDown={onClose}>
    <div className="modal message-fullscreen-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="message-fullscreen-head">
        <div><strong>Assistant 回复</strong><small>Markdown 放大预览</small></div>
        <div className="message-fullscreen-actions"><CopyButton text={message.text} /><button type="button" className="icon-button compact-icon" title="关闭" onClick={onClose}><X size={15} /></button></div>
      </div>
      <div className="message-fullscreen-body">
        {message.thinking && <ThinkingBlock text={message.thinking} autoOpen={false} />}
        {message.text ? <MarkdownText text={message.text} /> : <span className="muted">…</span>}
      </div>
    </div>
  </div>, document.body);
}

function TruncationNotice({ meta, loading, onExpand }: { meta: NonNullable<ChatMessage["transport"]>; loading?: boolean; onExpand?: (messageId: string) => void }) {
  if (!meta.truncated) return null;
  return <div className="truncation-notice">
    <span>已截断长消息{meta.omittedChars ? `，省略 ${formatNumber(meta.omittedChars)} 字符` : ""}</span>
    <button type="button" className="button-tonal compact" disabled={loading} onClick={() => onExpand?.(meta.messageId)}>{loading ? <Loader2 size={13} className="spin" /> : <Eye size={13} />} 展开完整消息</button>
  </div>;
}

function ChatProgressRail({ progress, nodes, showBottomButton, onProgressChange, onJumpToMessage, onJumpBottom }: {
  progress: number;
  nodes: Array<{ id: string; label: string; text: string; position: number }>;
  showBottomButton: boolean;
  onProgressChange: (progress: number) => void;
  onJumpToMessage: (id: string) => void;
  onJumpBottom: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  function progressFromClientY(clientY: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return progress;
    return clamp01((clientY - rect.top) / rect.height);
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add("dragging-progress");
    onProgressChange(progressFromClientY(event.clientY));
    const onMove = (move: PointerEvent) => {
      move.preventDefault();
      onProgressChange(progressFromClientY(move.clientY));
    };
    const stop = () => {
      document.body.classList.remove("dragging-progress");
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
  }

  function beginTouchDrag(event: ReactTouchEvent<HTMLElement>) {
    const touch = event.touches[0];
    if (!touch) return;
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.add("dragging-progress");
    onProgressChange(progressFromClientY(touch.clientY));
    const onMove = (move: TouchEvent) => {
      const nextTouch = move.touches[0] ?? move.changedTouches[0];
      if (!nextTouch) return;
      move.preventDefault();
      onProgressChange(progressFromClientY(nextTouch.clientY));
    };
    const stop = () => {
      document.body.classList.remove("dragging-progress");
      document.removeEventListener("touchmove", onMove, true);
      document.removeEventListener("touchend", stop, true);
      document.removeEventListener("touchcancel", stop, true);
    };
    document.addEventListener("touchmove", onMove, { capture: true, passive: false });
    document.addEventListener("touchend", stop, true);
    document.addEventListener("touchcancel", stop, true);
  }

  function nudge(delta: number) {
    onProgressChange(clamp01(progress + delta));
  }

  return <div className="chat-progress-rail" aria-label="聊天进度">
    <div ref={trackRef} className="chat-progress-track" title={`阅读进度 ${Math.round(progress * 100)}%`} onPointerDown={beginDrag} onTouchStart={beginTouchDrag}>
      <span className="chat-progress-fill" style={{ height: `${Math.round(progress * 100)}%` }} />
      {nodes.map((node) => {
        const position = clamp01(node.position);
        const nearThumb = Math.abs(position - progress) < PROGRESS_NODE_HIDE_DISTANCE;
        return <button
          type="button"
          key={node.id}
          className={`chat-progress-node ${nearThumb ? "near-thumb" : ""}`}
          style={{ top: `${Math.round(position * 100)}%` }}
          title={node.text}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onJumpToMessage(node.id)}
        >
          <span className="progress-label">{node.label}</span>
          <span className="progress-text">{previewText(node.text, 60)}</span>
        </button>;
      })}
      <span
        className="chat-progress-thumb"
        role="slider"
        tabIndex={0}
        aria-label="聊天滚动位置"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        style={{ top: `${Math.round(progress * 100)}%` }}
        onPointerDown={beginDrag}
        onTouchStart={beginTouchDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); nudge(-0.06); }
          if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); nudge(0.06); }
          if (event.key === "Home") { event.preventDefault(); onProgressChange(0); }
          if (event.key === "End") { event.preventDefault(); onProgressChange(1); }
        }}
      />
    </div>
    <button type="button" className={`jump-bottom-button ${showBottomButton ? "visible" : ""}`} title="跳转到底部" onClick={onJumpBottom}><span className="progress-label">底</span><span className="progress-text">到底部</span></button>
  </div>;
}

function UserMessageText({ text }: { text: string }) {
  const parts = splitFileRefs(text);
  return <div className="user-message-text">{parts.map((part, idx) => {
    if (part.kind === "newline") return <br key={idx} />;
    if (part.kind === "fileRef") return <span key={idx} className="file-ref-token" title={part.path}>@{part.path}</span>;
    return <span key={idx}>{part.text}</span>;
  })}</div>;
}

const ComposerAttachmentStrip = memo(function ComposerAttachmentStrip({ boxId, images, fileAttachments, uploadingFiles, setImages, setFileAttachments }: {
  boxId?: string;
  images: Array<{ type: "image"; data: string; mimeType: string; name: string; path?: string; size?: number }>;
  fileAttachments: Array<{ kind: "file"; name: string; path: string; size?: number; mimeType?: string }>;
  uploadingFiles: boolean;
  setImages: Dispatch<SetStateAction<Array<{ type: "image"; data: string; mimeType: string; name: string; path?: string; size?: number }>>>;
  setFileAttachments: Dispatch<SetStateAction<Array<{ kind: "file"; name: string; path: string; size?: number; mimeType?: string }>>>;
}) {
  const [preview, setPreview] = useState<ChatAttachment>();
  if (images.length === 0 && fileAttachments.length === 0 && !uploadingFiles) return null;
  return <div className="attachment-strip">
    {images.map((img, idx) => {
      const attachment: ChatAttachment = { kind: "image", name: img.name, mimeType: img.mimeType, data: img.data, path: img.path, size: img.size };
      return <span className="attachment-pill" key={`${img.name}-${idx}`}>
        <button type="button" className="attachment-chip-button image-chip" title={img.path ? `预览图片 · ${img.path}` : "预览图片"} onClick={() => setPreview(attachment)}><ImageIcon size={15} /><span>{img.name}</span>{img.path && <small>@</small>}</button>
        <button type="button" className="attachment-remove-button" title="移除附件" onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}><X size={12} /></button>
      </span>;
    })}
    {fileAttachments.map((file, idx) => <span className="attachment-pill" key={`${file.path}-${idx}`}>
      <button type="button" className="file-chip attachment-chip-button" title="查看附件" onClick={() => setPreview(file)}><Paperclip size={14} /><span>{file.name}</span><small>{file.size ? formatBytes(file.size) : file.path}</small></button>
      <button type="button" className="attachment-remove-button" title="移除附件" onClick={() => setFileAttachments((prev) => prev.filter((_, i) => i !== idx))}><X size={12} /></button>
    </span>)}
    {uploadingFiles && <span className="queue-chip"><Loader2 size={13} className="spin" /> 正在处理附件…</span>}
    {preview && <AttachmentPreviewDialog attachment={preview} boxId={boxId} onClose={() => setPreview(undefined)} />}
  </div>;
});

function AttachmentGallery({ attachments, boxId }: { attachments: ChatAttachment[]; boxId?: string }) {
  const [preview, setPreview] = useState<ChatAttachment>();
  return <div className="message-attachments">
    <div className="message-attachment-list">
      {attachments.map((attachment, idx) => attachment.kind === "image"
        ? <button key={`${attachment.name}-${idx}`} type="button" className="message-image-link" onClick={() => setPreview(attachment)} title={attachment.path ? `${attachment.name} · ${attachment.path}` : attachment.name}>
          <ImageIcon size={22} />
          <span>{attachment.name}{attachment.path ? ` · ${attachment.path}` : ""}</span>
        </button>
        : <button type="button" className="message-file-card" key={`${attachment.path}-${idx}`} title={attachment.path} onClick={() => setPreview(attachment)}>
          <Paperclip size={15} />
          <div><strong>{attachment.name}</strong><small>{attachment.path}{attachment.size ? ` · ${formatBytes(attachment.size)}` : ""}</small></div>
        </button>)}
    </div>
    {preview && <AttachmentPreviewDialog attachment={preview} boxId={boxId} onClose={() => setPreview(undefined)} />}
  </div>;
}

function AttachmentPreviewDialog({ attachment, boxId, onClose }: { attachment: ChatAttachment; boxId?: string; onClose: () => void }) {
  const imageSrc = attachment.kind === "image" ? attachmentImageSrc(attachment, boxId) : undefined;
  const download = attachment.path && boxId ? api.downloadUrl(boxId, workspaceRelPath(attachment.path)) : undefined;
  return <div className="modal-backdrop attachment-preview-backdrop" onMouseDown={onClose}>
    <div className="modal attachment-preview-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="attachment-preview-head">
        <div className="attachment-preview-title">{attachment.kind === "image" ? <ImageIcon size={18} /> : <Paperclip size={18} />}<div><strong>{attachment.name}</strong><small>{attachment.path ?? attachment.mimeType ?? "附件"}{attachment.size ? ` · ${formatBytes(attachment.size)}` : ""}</small></div></div>
        <button type="button" className="icon-button compact-icon" title="关闭" onClick={onClose}><X size={15} /></button>
      </div>
      {attachment.kind === "image" ? <div className="attachment-image-preview">
        {imageSrc ? <img src={imageSrc} alt={attachment.name} loading="lazy" /> : <div className="attachment-preview-empty"><ImageIcon size={32} /><span>没有可预览的图片数据</span></div>}
      </div> : <div className="attachment-preview-empty"><Paperclip size={32} /><span>文件附件不会在聊天中内联加载。</span></div>}
      <div className="attachment-preview-actions">
        {download && <a className="button-tonal compact" href={download} target="_blank" rel="noreferrer"><ExternalLink size={14} /> 打开 / 下载</a>}
      </div>
    </div>
  </div>;
}

function ThinkingBlock({ text, autoOpen }: { text: string; autoOpen: boolean }) {
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => setOpen(autoOpen), [autoOpen]);
  return <details className="thinking-block" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary><Brain size={14} /> 思考过程 <ChevronDown size={14} /></summary>
    <MarkdownText text={text} />
  </details>;
}

function ToolCard({ message, isLatest, isExpanding, onExpand }: { message: ChatMessage; isLatest: boolean; isExpanding?: boolean; onExpand?: (messageId: string) => void }) {
  const status = message.toolStatus ?? "pending";
  const kind = toolKindForName(message.toolName);
  const autoOpen = isLatest || status === "running";
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => setOpen(autoOpen), [autoOpen, message.id]);
  return <details className={`tool-card ${status}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>
      <span className={`tool-icon tool-icon-${kind}`} aria-hidden="true">{toolIcon(kind)}</span>
      <span className="tool-name">{toolLabel(kind, message.toolName)}</span>
      <span className="tool-overview">{toolOverview(message)}</span>
      <span className={`tool-status ${status}`} title={`状态：${toolStatusLabel(status)}`} aria-label={`工具调用${toolStatusLabel(status)}`}><span className="tool-status-dot" /></span>
    </summary>
    <ToolPreview message={message} />
    {message.transport?.truncated && <TruncationNotice meta={message.transport} loading={isExpanding} onExpand={onExpand} />}
  </details>;
}

type ToolKind = "read" | "edit" | "write" | "bash" | "ls" | "grep" | "find" | "unknown";

function toolKindForName(name?: string): ToolKind {
  const raw = String(name ?? "").trim().toLowerCase();
  const last = raw.split(/[./:]/).filter(Boolean).pop() ?? raw;
  const keys = [raw, last].map((value) => value.replace(/[\s_-]/g, ""));
  const has = (...values: string[]) => keys.some((key) => values.includes(key));
  if (has("read", "readfile", "fileread", "view")) return "read";
  if (has("edit", "editfile", "fileedit", "replace", "strreplace")) return "edit";
  if (has("write", "writefile", "filewrite", "create", "createfile")) return "write";
  if (has("bash", "shell", "terminal", "runcommand", "exec", "execute")) return "bash";
  if (has("ls", "list", "listdir", "listdirectory")) return "ls";
  if (has("grep", "rg", "ripgrep", "search", "searchtext")) return "grep";
  if (has("find", "findfile", "findfiles", "glob")) return "find";
  return "unknown";
}

function toolIcon(kind: ToolKind): ReactNode {
  if (kind === "read") return <Eye size={15} />;
  if (kind === "edit") return <FilePenLine size={15} />;
  if (kind === "write") return <FilePlus2 size={15} />;
  if (kind === "bash") return <Terminal size={15} />;
  if (kind === "ls") return <FolderTree size={15} />;
  if (kind === "grep") return <Search size={15} />;
  if (kind === "find") return <FileSearch size={15} />;
  return <Wrench size={15} />;
}

function toolLabel(kind: ToolKind, name?: string): string {
  if (kind === "read") return "读取文件";
  if (kind === "edit") return "编辑文件";
  if (kind === "write") return "写入文件";
  if (kind === "bash") return "执行命令";
  if (kind === "ls") return "列出目录";
  if (kind === "grep") return "搜索文本";
  if (kind === "find") return "查找文件";
  return name || "tool";
}

function toolStatusLabel(status: string): string {
  if (status === "running") return "运行中";
  if (status === "error") return "失败";
  if (status === "done") return "完成";
  return "准备";
}

function toolOverview(message: ChatMessage): ReactNode {
  const kind = toolKindForName(message.toolName);
  const args = asRecord(message.toolArgs);
  const result = message.toolResult ?? "";
  const meta = enrichToolMeta(message.toolResultMeta ?? toolResultMeta(result), result);
  const path = toolPathFromArgs(args);

  if (kind === "edit") {
    const edits = editDiffInputs(args, path);
    const stats = editChangeStats(edits);
    const paths = uniqueStrings([path, ...edits.map((edit) => edit.path)]);
    const firstPath = paths[0] || path;
    return <>
      {paths.length > 0 && <span className="tool-file-count">{paths.length} files</span>}
      {edits.length > 0 ? <ToolChangeStats added={stats.added} removed={stats.removed} /> : <span className="tool-muted">{previewText(result) || "等待 diff"}</span>}
      {firstPath && <ToolFileRef path={firstPath} />}
      {paths.length > 1 && <span className="tool-extra-count">+{paths.length - 1}</span>}
      {!paths.length && !edits.length && !result && <span className="tool-muted">点击查看详情</span>}
    </>;
  }

  if (kind === "read") {
    const lineSummary = readLineSummary(args, result, meta);
    return <>
      {path ? <ToolFileRef path={path} /> : <span className="tool-muted">file</span>}
      {lineSummary && <span className="tool-line-range">{lineSummary}</span>}
    </>;
  }

  if (kind === "write") {
    const content = stringValue(args.content ?? args.newText ?? args.new_text ?? args.replacement ?? args.text ?? args.value);
    const added = content ? splitTextLines(content).length : (meta?.shownLines ?? 0);
    return <>
      {added > 0 && <ToolChangeStats added={added} removed={0} />}
      {path ? <ToolFileRef path={path} /> : <span className="tool-muted">{previewText(result) || "file"}</span>}
    </>;
  }

  if (kind === "bash") {
    const command = bashCommand(message.toolArgs);
    return command ? <code className="tool-inline-code">$ {previewText(command, 180)}</code> : <span className="tool-muted">{previewText(message.toolArgs ?? result) || "shell"}</span>;
  }

  if (kind === "ls") {
    return <>{path ? <ToolFileRef path={path} /> : <span className="tool-muted">当前目录</span>}</>;
  }

  if (kind === "grep" || kind === "find") {
    const query = stringValue(args.pattern ?? args.query ?? args.regex ?? args.name ?? args.value);
    return <>
      {query && <code className="tool-inline-code">{previewText(query, 80)}</code>}
      {path && <ToolFileRef path={path} />}
      {!query && !path && <span className="tool-muted">{previewText(message.toolArgs ?? result) || "点击查看详情"}</span>}
    </>;
  }

  return compactText([path ? fileNameFromPath(path) : "", previewText(message.toolArgs), previewText(result)]);
}

function ToolChangeStats({ added, removed }: { added?: number; removed?: number }) {
  const add = Math.max(0, Math.floor(added ?? 0));
  const del = Math.max(0, Math.floor(removed ?? 0));
  if (!add && !del) return <span className="tool-muted">无行变更</span>;
  return <span className="tool-change-group">
    {add > 0 && <span className="tool-change add">+{add}</span>}
    {del > 0 && <span className="tool-change del">-{del}</span>}
  </span>;
}

function ToolFileRef({ path }: { path: string }) {
  const name = fileNameFromPath(path);
  const badge = fileBadgeForPath(path);
  return <span className="tool-file-ref" title={`${badge.title} · ${path}`}>
    <ToolLanguageBadge badge={badge} />
    <span className="tool-file-name">{name}</span>
  </span>;
}

function ToolPathCode({ path, fallback = "file" }: { path?: string; fallback?: string }) {
  const label = path ? fileNameFromPath(path) : fallback;
  const badge = fileBadgeForPath(path || label);
  return <span className="tool-path-pill" title={path || label}>
    <ToolLanguageBadge badge={badge} />
    <code>{label}</code>
  </span>;
}

type FileBadge = { label: string; className: string; title: string; icon?: ElementType };

function ToolLanguageBadge({ badge }: { badge: FileBadge }) {
  const Icon = badge.icon;
  return <span className={`tool-file-badge ${Icon ? "has-icon" : ""} ${badge.className}`} title={badge.title} aria-label={badge.title}>
    {Icon ? <Icon size={14} color="currentColor" title={badge.title} /> : badge.label}
  </span>;
}

function bashCommand(toolArgs: unknown): string {
  const args = asRecord(toolArgs);
  const direct = stringValue(args.command ?? args.cmd ?? args.script ?? args.value);
  if (direct) return direct;
  if (typeof toolArgs === "string") return toolArgs;
  return "";
}

function ToolPreview({ message }: { message: ChatMessage }) {
  const kind = toolKindForName(message.toolName);
  const args = asRecord(message.toolArgs);
  const result = message.toolResult ?? "";
  const meta = enrichToolMeta(message.toolResultMeta ?? toolResultMeta(result), result);
  const path = toolPathFromArgs(args);

  if (kind === "write") {
    const content = stringValue(args.content ?? args.newText ?? args.new_text ?? args.replacement ?? args.text ?? args.value);
    const diffLines = content ? buildWriteDiff(content, path) : [];
    return <div className="tool-preview">
      <div className="tool-preview-head"><span>写入 diff</span><ToolPathCode path={path} /></div>
      {diffLines.length > 0 ? <DiffPreview lines={diffLines} /> : result ? <CodePreview text={result} meta={meta} /> : <div className="empty-menu">没有可显示的写入内容</div>}
      {result && content && <details className="tool-mini-details"><summary>工具结果</summary><CodePreview text={result} meta={meta} maxLines={10} /></details>}
    </div>;
  }

  if (kind === "edit") {
    const edits = editDiffInputs(args, path);
    const diffLines = buildEditDiffLines(edits, path);
    return <div className="tool-preview">
      <div className="tool-preview-head"><span>编辑 diff</span><ToolPathCode path={path || edits[0]?.path} />{edits.length > 1 && <span className="small">{edits.length} blocks</span>}</div>
      {diffLines.length > 0 ? <DiffPreview lines={diffLines} /> : result ? <CodePreview text={result} meta={meta} /> : <div className="empty-menu">没有可显示的编辑内容</div>}
      {result && diffLines.length > 0 && <details className="tool-mini-details"><summary>工具结果</summary><CodePreview text={result} meta={meta} maxLines={10} /></details>}
    </div>;
  }

  if (kind === "read") {
    const lineSummary = readLineSummary(args, result, meta);
    const display = result || (message.toolArgs !== undefined ? safeJson(message.toolArgs) : "");
    return <div className="tool-preview">
      <div className="tool-preview-head"><span>读取</span><ToolPathCode path={path} />{lineSummary && <span className="small">{lineSummary}</span>}</div>
      {display && <CodePreview text={display} meta={meta} />}
    </div>;
  }

  if (kind === "bash") {
    const command = bashCommand(message.toolArgs);
    return <div className="tool-preview">
      {command && <><div className="tool-preview-head"><span>模型执行的命令</span></div><CommandPreview command={command} /></>}
      {result && <><div className="tool-preview-head"><span>输出预览</span></div><CodePreview text={result} meta={meta} /></>}
    </div>;
  }

  return <div className="tool-preview">
    {message.toolArgs !== undefined && <><div className="tool-preview-head"><span>参数</span></div><CodePreview text={safeJson(message.toolArgs)} maxLines={10} /></>}
    {result && <><div className="tool-preview-head"><span>输出预览</span></div><CodePreview text={result} meta={meta} /></>}
  </div>;
}

type EditDiffInput = { oldText: string; newText: string; path?: string };

function editDiffInputs(args: Record<string, any>, fallbackPath?: string): EditDiffInput[] {
  const out: EditDiffInput[] = [];
  const push = (value: unknown) => {
    const record = asRecord(value);
    const oldText = stringValue(record.oldText ?? record.old_text ?? record.old ?? record.original ?? record.before);
    const newText = stringValue(record.newText ?? record.new_text ?? record.replacement ?? record.replace ?? record.new ?? record.after ?? record.text ?? record.value);
    const path = toolPathFromArgs(record) || fallbackPath;
    if (oldText || newText) out.push({ oldText, newText, path });
  };
  for (const key of ["edits", "changes", "replacements"]) {
    const value = args[key];
    if (Array.isArray(value)) value.forEach(push);
  }
  push(args);
  return out.filter((edit, idx, list) => list.findIndex((item) => item.oldText === edit.oldText && item.newText === edit.newText && item.path === edit.path) === idx);
}

function toolPathFromArgs(args: Record<string, any>): string {
  return stringValue(args.path ?? args.file ?? args.filename ?? args.filePath ?? args.file_path ?? args.directory ?? args.dir ?? args.cwd);
}

function uniqueStrings(values: Array<string | undefined | null | false>): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function editChangeStats(edits: EditDiffInput[]): { added: number; removed: number } {
  return edits.reduce((stats, edit) => {
    const changed = changedLineCounts(edit.oldText, edit.newText);
    stats.added += changed.added;
    stats.removed += changed.removed;
    return stats;
  }, { added: 0, removed: 0 });
}

function changedLineCounts(oldText: string, newText: string): { added: number; removed: number } {
  if (!oldText && !newText) return { added: 0, removed: 0 };
  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);
  if (!oldLines.length) return { added: newLines.length, removed: 0 };
  if (!newLines.length) return { added: 0, removed: oldLines.length };
  if (oldLines.length * newLines.length > 90_000) return { added: newLines.length, removed: oldLines.length };
  let prev = new Uint32Array(newLines.length + 1);
  let curr = new Uint32Array(newLines.length + 1);
  for (let i = 1; i <= oldLines.length; i++) {
    for (let j = 1; j <= newLines.length; j++) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const common = prev[newLines.length] ?? 0;
  return { added: newLines.length - common, removed: oldLines.length - common };
}

function readLineSummary(args: Record<string, any>, result: string, meta?: ToolResultMeta): string {
  const start = numericValue(args.offset ?? args.start ?? args.startLine ?? args.start_line ?? args.line ?? args.from);
  const limit = numericValue(args.limit ?? args.lines ?? args.lineCount ?? args.line_count ?? args.count);
  if (start !== undefined && limit !== undefined) return `第 ${start}-${Math.max(start, start + limit - 1)} 行`;
  if (start !== undefined) return `第 ${start} 行起`;
  if (limit !== undefined) return `前 ${limit} 行`;
  const shown = meta?.shownLines ?? (result ? lineCount(result) : undefined);
  if (shown && shown > 0) return shown === 1 ? "第 1 行" : `第 1-${shown} 行`;
  return "";
}

function numericValue(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(/,/g, "")) : NaN;
  return Number.isFinite(num) ? Math.max(1, Math.floor(num)) : undefined;
}

function fileNameFromPath(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.split("/").filter(Boolean).pop() || normalized || "file";
}

function fileExtension(name: string): string {
  const baseName = fileNameFromPath(name).toLowerCase();
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return "";
  return baseName.slice(dotIndex + 1);
}

const LANGUAGE_BADGES: Record<string, FileBadge> = {
  js: badge("JS", "lang-js", "JavaScript", SiJavascript),
  mjs: badge("JS", "lang-js", "JavaScript module", SiJavascript),
  cjs: badge("JS", "lang-js", "CommonJS", SiJavascript),
  jsx: badge("JSX", "lang-react", "React JSX", SiReact),
  ts: badge("TS", "lang-ts", "TypeScript", SiTypescript),
  mts: badge("TS", "lang-ts", "TypeScript module", SiTypescript),
  cts: badge("TS", "lang-ts", "TypeScript CommonJS", SiTypescript),
  tsx: badge("TSX", "lang-react", "React TSX", SiReact),
  py: badge("PY", "lang-py", "Python", SiPython),
  pyw: badge("PY", "lang-py", "Python", SiPython),
  ipynb: badge("NB", "lang-py", "Jupyter Notebook", SiPython),
  kt: badge("KT", "lang-kt", "Kotlin", SiKotlin),
  kts: badge("KTS", "lang-kt", "Kotlin Script", SiKotlin),
  java: badge("JAVA", "lang-java", "Java", SiOpenjdk),
  go: badge("GO", "lang-go", "Go", SiGo),
  rs: badge("RS", "lang-rs", "Rust", SiRust),
  rb: badge("RB", "lang-rb", "Ruby", SiRuby),
  php: badge("PHP", "lang-php", "PHP", SiPhp),
  cs: badge("C#", "lang-cs", "C#", SiDotnet),
  swift: badge("SW", "lang-swift", "Swift", SiSwift),
  dart: badge("DART", "lang-dart", "Dart", SiDart),
  scala: badge("SC", "lang-scala", "Scala", SiScala),
  groovy: badge("GRV", "lang-gradle", "Groovy", SiGradle),
  c: badge("C", "lang-c", "C", SiC),
  h: badge("H", "lang-c", "C/C++ Header", SiC),
  cc: badge("C++", "lang-cpp", "C++", SiCplusplus),
  cpp: badge("C++", "lang-cpp", "C++", SiCplusplus),
  cxx: badge("C++", "lang-cpp", "C++", SiCplusplus),
  hpp: badge("H++", "lang-cpp", "C++ Header", SiCplusplus),
  html: badge("HTML", "lang-html", "HTML", SiHtml5),
  htm: badge("HTML", "lang-html", "HTML", SiHtml5),
  css: badge("CSS", "lang-css", "CSS", SiCss),
  scss: badge("SCSS", "lang-css", "SCSS", SiCss),
  sass: badge("SASS", "lang-css", "Sass", SiCss),
  less: badge("LESS", "lang-css", "Less", SiCss),
  vue: badge("VUE", "lang-vue", "Vue", SiVuedotjs),
  svelte: badge("SV", "lang-svelte", "Svelte", SiSvelte),
  astro: badge("AST", "lang-astro", "Astro", SiAstro),
  json: badge("JSON", "lang-json", "JSON", SiJson),
  jsonc: badge("JSON", "lang-json", "JSONC", SiJson),
  yml: badge("YML", "lang-yaml", "YAML", SiYaml),
  yaml: badge("YAML", "lang-yaml", "YAML", SiYaml),
  toml: badge("TOML", "lang-toml", "TOML", SiToml),
  xml: badge("XML", "lang-xml", "XML"),
  md: badge("MD", "lang-md", "Markdown", SiMarkdown),
  mdx: badge("MDX", "lang-md", "MDX", SiMarkdown),
  sql: badge("SQL", "lang-sql", "SQL", SiPostgresql),
  sqlite: badge("SQL", "lang-sql", "SQLite", SiSqlite),
  sqlite3: badge("SQL", "lang-sql", "SQLite", SiSqlite),
  db: badge("DB", "lang-sql", "Database", SiSqlite),
  gql: badge("GQL", "lang-gql", "GraphQL", SiGraphql),
  graphql: badge("GQL", "lang-gql", "GraphQL", SiGraphql),
  proto: badge("PB", "lang-proto", "Protocol Buffers"),
  sh: badge("SH", "lang-shell", "Shell", SiGnubash),
  bash: badge("SH", "lang-shell", "Bash", SiGnubash),
  zsh: badge("ZSH", "lang-shell", "Zsh", SiShell),
  fish: badge("FSH", "lang-shell", "Fish", SiFishshell),
  ps1: badge("PS1", "lang-ps", "PowerShell", SiShell),
  bat: badge("BAT", "lang-bat", "Batch", SiShell),
  cmd: badge("CMD", "lang-bat", "Command Script", SiShell),
  lua: badge("LUA", "lang-lua", "Lua", SiLua),
  r: badge("R", "lang-r", "R", SiR),
  ex: badge("EX", "lang-elixir", "Elixir", SiElixir),
  exs: badge("EXS", "lang-elixir", "Elixir Script", SiElixir),
  txt: badge("TXT", "lang-text", "Text"),
  log: badge("LOG", "lang-text", "Log"),
};

function fileBadgeForPath(path: string): FileBadge {
  const name = fileNameFromPath(path).toLowerCase();
  const special = specialFileBadge(name);
  if (special) return special;
  const ext = fileExtension(name);
  const known = ext ? LANGUAGE_BADGES[ext] : undefined;
  if (known) return known;
  if (ext) return badge(ext.slice(0, 4).toUpperCase(), "lang-generic", `.${ext}`);
  return badge("FILE", "lang-generic", "文件");
}

function specialFileBadge(name: string): FileBadge | undefined {
  if (name === "dockerfile" || name.endsWith(".dockerfile") || ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].includes(name)) return badge("DK", "lang-docker", "Docker", SiDocker);
  if (name === "makefile") return badge("MK", "lang-make", "Makefile", SiMake);
  if (name === "cmakelists.txt") return badge("CMake", "lang-cmake", "CMake", SiCmake);
  if (name.startsWith(".env")) return badge("ENV", "lang-env", "Environment", SiDotenv);
  if (name.startsWith(".git")) return badge("GIT", "lang-git", "Git config", SiGit);
  if (["package.json", "package-lock.json", "pnpm-lock.yaml", "pnpm-lock.yml", "yarn.lock"].includes(name)) return badge("NPM", "lang-node", "Node package", name === "package.json" ? SiNpm : SiNodedotjs);
  if (name.startsWith("tsconfig") && name.endsWith(".json")) return badge("TS", "lang-ts", "TypeScript config", SiTypescript);
  if (name === "go.mod" || name === "go.sum") return badge("GO", "lang-go", "Go module", SiGo);
  if (name === "cargo.toml" || name === "cargo.lock" || name === "rust-toolchain") return badge("RS", "lang-rs", "Rust package", SiRust);
  if (["requirements.txt", "pyproject.toml", "poetry.lock", "pdm.lock"].includes(name)) return badge("PY", "lang-py", "Python package", SiPython);
  if (name === "pom.xml") return badge("MVN", "lang-java", "Maven", SiApachemaven);
  if (name.endsWith(".gradle") || name.endsWith(".gradle.kts") || name === "gradlew") return badge("GRAD", "lang-gradle", "Gradle", SiGradle);
  return undefined;
}

function badge(label: string, className: string, title: string, icon?: ElementType): FileBadge {
  return { label, className, title, icon };
}

function buildEditDiffLines(edits: EditDiffInput[], fallbackPath?: string): DiffLine[] {
  return edits.flatMap((edit, idx) => {
    const filePath = edit.path || fallbackPath || "file";
    const lines = edit.oldText ? buildUnifiedDiff(edit.oldText, edit.newText, filePath) : buildWriteDiff(edit.newText, filePath);
    return idx === 0 ? lines : [{ type: "meta" as const, text: "" }, ...lines];
  });
}

function DiffPreview({ lines, maxLines = 240 }: { lines: DiffLine[]; maxLines?: number }) {
  const clipped = lines.length > maxLines;
  const visible = clipped ? lines.slice(0, maxLines) : lines;
  const text = lines.map((line) => line.type === "add" ? `+${line.text}` : line.type === "del" ? `-${line.text}` : line.type === "meta" ? line.text : ` ${line.text}`).join("\n");
  return <div className="diff-preview-shell">
    <div className="code-preview-toolbar"><span>Unified diff</span><CopyButton text={text} /></div>
    <div className="diff-preview" role="region" aria-label="diff preview">
      {visible.map((line, idx) => <div key={idx} className={`diff-line ${line.type}`}><span className="diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "meta" ? "" : " "}</span><span className="diff-text">{line.text || " "}</span></div>)}
      {clipped && <div className="diff-line meta"><span className="diff-sign" /><span className="diff-text">… 还有 {lines.length - maxLines} 行 diff 未展开，共 {lines.length} 行</span></div>}
    </div>
  </div>;
}

function CommandPreview({ command }: { command: string }) {
  return <div className="code-preview-shell command-preview-shell">
    <div className="code-preview-toolbar"><span>$ command</span><CopyButton text={command} /></div>
    <pre className="code-preview command-preview">{command}</pre>
  </div>;
}

function CodePreview({ text, maxLines = 18, meta }: { text: string; maxLines?: number; meta?: ToolResultMeta }) {
  const lines = text.split("\n");
  const clipped = lines.length > maxLines;
  const shown = clipped ? lines.slice(0, maxLines).join("\n") : text;
  const enriched = enrichToolMeta(meta, text);
  const suffix = codePreviewSuffix(enriched, lines.length, maxLines, clipped);
  return <div className="code-preview-shell">
    <div className="code-preview-toolbar"><CopyButton text={text} /></div>
    <pre className="code-preview">{shown}{suffix ? `\n${suffix}` : ""}</pre>
  </div>;
}

function codePreviewSuffix(meta: ToolResultMeta | undefined, actualLines: number, maxLines: number, clipped: boolean): string {
  const parts: string[] = [];
  if (clipped) parts.push(`本地折叠 ${actualLines - maxLines} 行，共 ${actualLines} 行`);
  if (meta) {
    const shown = clipped ? maxLines : meta.shownLines;
    if (meta.totalLines && shown && meta.totalLines !== shown) parts.push(`工具结果显示 ${shown}/${meta.totalLines} 行`);
    else if (!clipped && meta.totalLines && meta.truncated) parts.push(`工具结果共 ${meta.totalLines} 行`);
    if (meta.omittedLines) parts.push(`省略 ${meta.omittedLines} 行`);
    if (meta.totalBytes) parts.push(`${formatBytes(meta.shownBytes ?? meta.totalBytes)}${meta.shownBytes && meta.shownBytes !== meta.totalBytes ? `/${formatBytes(meta.totalBytes)}` : ""}`);
    if (meta.truncated) parts.push("已截断");
    if (meta.label) parts.push(meta.label);
  }
  return parts.length ? `… ${Array.from(new Set(parts)).join("；")}` : "";
}

function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const useFastPath = streaming && text.length > 1800;
  if (useFastPath) return <div className="markdown-body streaming-markdown"><PlainStreamingText text={text} /></div>;
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: MarkdownPre }}>{text}</ReactMarkdown></div>;
}

function PlainStreamingText({ text }: { text: string }) {
  return <>{text}</>;
}

function MarkdownPre({ children, node: _node, ...props }: any) {
  const codeText = extractText(children).replace(/\n$/, "");
  const lang = languageFromCodeNode(children);
  return <div className="markdown-code-block">
    <div className="markdown-code-toolbar"><span>{lang || "code"}</span><CopyButton text={codeText} /></div>
    <pre {...props}>{children}</pre>
  </div>;
}

function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopyToClipboard(text);
  return <button type="button" className="copy-button" onClick={copy}><Copy size={13} /> {copied ? "已复制" : "复制"}</button>;
}

function CopyIconButton({ text, title }: { text: string; title: string }) {
  const { copied, copy } = useCopyToClipboard(text);
  return <button type="button" className="message-action-icon" title={copied ? "已复制" : title} onClick={copy}><Copy size={15} /></button>;
}

function useCopyToClipboard(text: string) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  }
  return { copied, copy };
}

function hasDraggedFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void, options?: { timeout: number }) => number);
    if (idle) idle(() => resolve(), { timeout: 180 });
    else window.setTimeout(resolve, 0);
  });
}

async function filesToImages(files: Iterable<File> | null, uploaded?: Map<File, { path: string }>) {
  if (!files) return [];
  return Promise.all([...files].map(async (file) => {
    const dataUrl = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
    const data = dataUrl.split(",")[1] ?? "";
    return { type: "image" as const, data, mimeType: file.type || "image/png", name: file.name, path: uploaded?.get(file)?.path, size: file.size };
  }));
}

async function normalizePiMessagesAsync(messages: any[], isCancelled: () => boolean): Promise<ChatMessage[]> {
  const toolCalls = new Map<string, { tool: Partial<ChatMessage>; outIndex?: number }>();
  const out: ChatMessage[] = [];
  for (let idx = 0; idx < messages.length; idx++) {
    if (isCancelled()) break;
    if (idx > 0 && idx % 20 === 0) await yieldToBrowser();
    const m = messages[idx];
    const transport = transportMeta(m);
    const timestamp = m.timestamp ?? Date.now();
    const sourceIndex = idx;
    if (m.role === "user") {
      const imageAttachments = attachmentsFromContent(m.content);
      const expanded = extractInlineFileBlocks(contentToText(m.content) || m.message || "");
      const attachments = [...imageAttachments, ...expanded.attachments];
      out.push({ id: `${idx}-${timestamp}`, role: "user", text: expanded.text || attachmentSummary(attachments), attachments, timestamp, transport, sourceIndex });
      continue;
    }
    if (m.role === "assistant") {
      const { text, thinking, tools } = contentParts(m.content);
      const summary = m.summary ? `[summary]\n${m.summary}` : "";
      const errorText = piMessageErrorText(m);
      if (text || thinking || summary) out.push({ id: `${idx}-${timestamp}-assistant`, role: "assistant", text: text || summary, thinking, timestamp, transport, sourceIndex });
      if (errorText) out.push({ id: `${idx}-${timestamp}-assistant-error`, role: "system", text: runtimeNoticeText("pi 响应错误", errorText), timestamp, transport });
      tools.forEach((tool, toolIdx) => {
        const toolMessage: ChatMessage = { id: `${idx}-${timestamp}-tool-${toolIdx}`, role: "tool", text: "", timestamp, transport, sourceIndex, ...tool };
        out.push(toolMessage);
        if (tool.toolCallId) toolCalls.set(String(tool.toolCallId), { tool, outIndex: out.length - 1 });
      });
      continue;
    }
    const callId = String(m.tool_call_id ?? m.toolCallId ?? m.id ?? `${idx}-${timestamp}`);
    const priorEntry = toolCalls.get(callId);
    const prior = priorEntry?.tool ?? {};
    const toolMessage: ChatMessage = {
      id: `${idx}-${timestamp}`,
      role: "tool",
      text: "",
      toolCallId: callId,
      toolName: m.name ?? m.toolName ?? prior.toolName ?? "tool",
      toolArgs: m.args ?? m.arguments ?? prior.toolArgs,
      toolStatus: m.isError ? "error" : "done",
      toolResult: contentToText(m.content) || resultToText(m.result) || JSON.stringify(m),
      toolResultMeta: toolResultMeta(m.result ?? m.content),
      timestamp,
      transport,
      sourceIndex
    };
    if (priorEntry?.outIndex !== undefined) {
      out[priorEntry.outIndex] = { ...out[priorEntry.outIndex], ...toolMessage, id: out[priorEntry.outIndex].id, transport: transport ?? out[priorEntry.outIndex].transport };
      continue;
    }
    out.push(toolMessage);
  }
  return out;
}

function piMessageErrorText(message: any): string {
  const error = runtimeDetailText(message?.errorMessage ?? message?.error ?? message?.exception).trim();
  const stopReason = String(message?.stopReason ?? "").trim();
  if (!error && stopReason !== "error") return "";
  const meta = [
    stopReason ? `stopReason: ${stopReason}` : "",
    message?.provider || message?.model ? `model: ${[message?.provider, message?.model].filter(Boolean).join("/")}` : "",
    message?.responseId ? `responseId: ${message.responseId}` : ""
  ].filter(Boolean).join("\n");
  return [error || "未知错误", meta].filter(Boolean).join("\n");
}

function transportMeta(message: any): ChatMessage["transport"] | undefined {
  const meta = message?.__boxedagent;
  return meta && typeof meta.messageId === "string" ? meta : undefined;
}

function replaceExpandedMessage(current: ChatMessage[], messageId: string, expanded: ChatMessage[]): ChatMessage[] {
  const start = current.findIndex((item) => item.transport?.messageId === messageId);
  if (start < 0) return current;
  let end = start + 1;
  while (end < current.length && current[end].transport?.messageId === messageId) end++;
  const sourceIndex = current[start].sourceIndex;
  return [
    ...current.slice(0, start),
    ...expanded.map((item, idx) => ({ ...item, id: idx === 0 ? current[start].id : `${current[start].id}-expanded-${idx}`, sourceIndex: item.sourceIndex ?? sourceIndex, transport: { ...(item.transport ?? { messageId, truncated: false }), truncated: false } })),
    ...current.slice(end)
  ];
}

function contentParts(content: any): { text: string; thinking: string; tools: Partial<ChatMessage>[] } {
  if (typeof content === "string") return { text: content, thinking: "", tools: [] };
  if (!Array.isArray(content)) return { text: content ? JSON.stringify(content, null, 2) : "", thinking: "", tools: [] };
  const text: string[] = [];
  const thinking: string[] = [];
  const tools: Partial<ChatMessage>[] = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === "string") text.push(part);
    else if (isImageContentPart(part)) continue;
    else if (part.type === "thinking" || part.thinking) thinking.push(String(part.thinking ?? part.text ?? ""));
    else if (isToolContentPart(part)) tools.push({
      toolCallId: part.id ?? part.toolCallId ?? part.tool_call_id,
      toolName: part.name ?? part.toolName ?? "tool",
      toolArgs: part.args ?? part.arguments ?? part.input,
      toolStatus: "pending"
    });
    else if (part.type === "text" || part.text) text.push(String(part.text ?? ""));
  }
  return { text: text.filter(Boolean).join("\n\n"), thinking: thinking.filter(Boolean).join("\n\n"), tools };
}

function attachmentsFromContent(content: any): ChatAttachment[] {
  if (!Array.isArray(content)) return [];
  const out: ChatAttachment[] = [];
  content.forEach((part, idx) => {
    if (!isImageContentPart(part)) return;
    const data = String(part.data ?? part.imageData ?? part.source?.data ?? "");
    const mimeType = String(part.mimeType ?? part.mediaType ?? part.source?.media_type ?? "image/png");
    if (!data) return;
    out.push({ kind: "image", name: part.name ?? `image-${idx + 1}`, mimeType, data: data.replace(/^data:[^,]+,/, "") });
  });
  return out;
}

function extractInlineFileBlocks(text: string): { text: string; attachments: ChatAttachment[] } {
  const attachments: ChatAttachment[] = [];
  const stripped = text.replace(/<file\s+name=["']([^"']+)["']>[\s\S]*?<\/file>\n?/g, (_all, filePath: string) => {
    const path = String(filePath);
    attachments.push({ kind: "file", name: path.split("/").filter(Boolean).pop() ?? path, path });
    return "";
  }).trimStart();
  return { text: stripped, attachments };
}

function isImageContentPart(part: any): boolean {
  const type = String(part?.type ?? "").toLowerCase();
  return type === "image" || type === "image_url" || type === "input_image" || Boolean(part?.imageData || part?.mimeType?.startsWith?.("image/") || part?.source?.type === "base64");
}

function contentToText(content: any): string {
  const parts = contentParts(content);
  return [parts.thinking ? `思考：\n${parts.thinking}` : "", parts.text].filter(Boolean).join("\n\n");
}

function resultToText(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) return result.content.map((item: any) => item?.text ?? item?.content ?? JSON.stringify(item)).join("\n");
  if (result.text) return String(result.text);
  return safeJson(result);
}

type DiffLine = { type: "add" | "del" | "ctx" | "meta"; text: string };

function toolResultMeta(result: any): ToolResultMeta | undefined {
  if (result === undefined || result === null) return undefined;
  const records = collectRecords(result);
  const text = typeof result === "string" ? result : resultToText(result);
  const meta: ToolResultMeta = {};
  const totalLines = numericMeta(records, ["totalLines", "total_lines", "lineCount", "line_count", "totalLineCount", "total_line_count", "linesTotal"]);
  const shownLines = numericMeta(records, ["shownLines", "shown_lines", "displayedLines", "displayed_lines", "returnedLines", "returned_lines", "visibleLines", "visible_lines", "outputLines", "output_lines"]);
  const omittedLines = numericMeta(records, ["omittedLines", "omitted_lines", "truncatedLines", "truncated_lines", "remainingLines", "remaining_lines"]);
  const totalBytes = numericMeta(records, ["totalBytes", "total_bytes", "byteLength", "byte_length", "size", "totalSize", "total_size"]);
  const shownBytes = numericMeta(records, ["shownBytes", "shown_bytes", "displayedBytes", "displayed_bytes", "returnedBytes", "returned_bytes", "outputBytes", "output_bytes"]);
  const explicitTruncated = booleanMeta(records, ["truncated", "isTruncated", "is_truncated", "wasTruncated", "was_truncated"]);
  const omittedMatch = text.match(/(?:omitted|省略)\s*([0-9,]+)\s*(?:more\s*)?(?:lines?|行)/i);
  const totalMatch = text.match(/(?:total|共)\s*([0-9,]+)\s*(?:lines?|行)/i);
  if (totalLines) meta.totalLines = totalLines;
  if (shownLines) meta.shownLines = shownLines;
  if (omittedLines) meta.omittedLines = omittedLines;
  if (totalBytes) meta.totalBytes = totalBytes;
  if (shownBytes) meta.shownBytes = shownBytes;
  if (!meta.omittedLines && omittedMatch) meta.omittedLines = Number(omittedMatch[1].replace(/,/g, ""));
  if (!meta.totalLines && totalMatch) meta.totalLines = Number(totalMatch[1].replace(/,/g, ""));
  if (explicitTruncated !== undefined) meta.truncated = explicitTruncated;
  else if (/\b(truncated|omitted)\b|截断|省略/.test(text)) meta.truncated = true;
  if (meta.omittedLines && !meta.truncated) meta.truncated = true;
  return Object.keys(meta).length ? meta : undefined;
}

function enrichToolMeta(meta: ToolResultMeta | undefined, text: string): ToolResultMeta | undefined {
  const lines = text ? lineCount(text) : 0;
  if (!meta && !lines) return undefined;
  const next: ToolResultMeta = { ...(meta ?? {}) };
  if (lines && !next.shownLines) next.shownLines = lines;
  if (lines && !next.totalLines && !next.truncated) next.totalLines = lines;
  if (next.omittedLines && next.shownLines && !next.totalLines) next.totalLines = next.shownLines + next.omittedLines;
  if (!next.omittedLines && next.totalLines && next.shownLines && next.totalLines > next.shownLines) next.omittedLines = next.totalLines - next.shownLines;
  return next;
}

function collectRecords(value: unknown, out: Record<string, any>[] = [], depth = 0): Record<string, any>[] {
  if (!value || depth > 3) return out;
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item) => collectRecords(item, out, depth + 1));
    return out;
  }
  if (typeof value === "object") {
    const record = value as Record<string, any>;
    out.push(record);
    for (const key of ["metadata", "meta", "stats", "summary", "details", "truncation", "content"]) collectRecords(record[key], out, depth + 1);
  }
  return out;
}

function numericMeta(records: Record<string, any>[], keys: string[]): number | undefined {
  for (const record of records) for (const key of keys) {
    const value = record[key];
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/,/g, "")) : NaN;
    if (Number.isFinite(numberValue) && numberValue > 0) return numberValue;
  }
  return undefined;
}

function booleanMeta(records: Record<string, any>[], keys: string[]): boolean | undefined {
  for (const record of records) for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  }
  return undefined;
}

function buildWriteDiff(content: string, filePath?: string): DiffLine[] {
  const lines = splitTextLines(content);
  return [
    { type: "meta", text: `+++ ${filePath || "file"}` },
    { type: "meta", text: `@@ -0,0 +1,${lines.length} @@` },
    ...lines.map((line) => ({ type: "add" as const, text: line }))
  ];
}

function buildUnifiedDiff(oldText: string, newText: string, filePath?: string): DiffLine[] {
  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);
  const header: DiffLine[] = [
    { type: "meta", text: `--- ${filePath || "file"}` },
    { type: "meta", text: `+++ ${filePath || "file"}` },
    { type: "meta", text: `@@ -1,${oldLines.length} +1,${newLines.length} @@` }
  ];
  if (oldLines.length * newLines.length > 90_000) {
    return [...header, ...oldLines.map((line) => ({ type: "del" as const, text: line })), ...newLines.map((line) => ({ type: "add" as const, text: line }))];
  }
  const dp = Array.from({ length: oldLines.length + 1 }, () => new Uint16Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const body: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      body.push({ type: "ctx", text: oldLines[i] });
      i++; j++;
    } else if (j >= newLines.length || (i < oldLines.length && dp[i + 1][j] >= dp[i][j + 1])) {
      body.push({ type: "del", text: oldLines[i] });
      i++;
    } else {
      body.push({ type: "add", text: newLines[j] });
      j++;
    }
  }
  return [...header, ...body];
}

function splitTextLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

function extractText(node: any): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node.props?.children !== undefined) return extractText(node.props.children);
  return "";
}

function languageFromCodeNode(children: any): string {
  const node = Array.isArray(children) ? children[0] : children;
  const className = String(node?.props?.className ?? "");
  return className.match(/language-([^\s]+)/)?.[1] ?? "";
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function messageDomId(id: string): string {
  return `chat-message-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function asRecord(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value };
    } catch {
      return { value };
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : { value };
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return safeJson(value);
}

function previewText(value: unknown, max = 90): string {
  const text = stringValue(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function uploadFilesToAttachmentDir(boxId: string, files: File[]): Promise<Map<File, { path: string }>> {
  const uploaded = new Map<File, { path: string }>();
  for (const file of files) {
    await api.uploadFile(boxId, ATTACHMENT_UPLOAD_DIR, file);
    uploaded.set(file, { path: uploadedPathForName(file.name) });
  }
  return uploaded;
}

function forkSessionName(name: string): string {
  const base = name.trim() || "Session";
  const match = /^(.*?)(\d+)$/.exec(base);
  if (match) {
    const [, prefix, digits] = match;
    const next = (BigInt(digits) + 1n).toString();
    return `${prefix}${next.padStart(digits.length, "0")}`;
  }
  const suffix = " fork";
  return `${base.slice(0, 80 - suffix.length)}${suffix}`;
}

function uploadedPathForName(name: string) {
  return `${ATTACHMENT_UPLOAD_ABS_DIR}/${name}`;
}

function fileRef(path: string) {
  return /\s/.test(path) ? `@"${path.replace(/(["\\])/g, "\\$1")}"` : `@${path}`;
}

type ParsedFileRef = { raw: string; path: string; start: number; end: number };
type ExpandedFileRefs = { message: string; images: Array<{ type: "image"; data: string; mimeType: string }>; referencedPaths: Set<string> };

async function expandFileReferencesForPrompt(boxId: string, cwd: string, message: string): Promise<ExpandedFileRefs> {
  const refs = parseFileRefs(message);
  if (!refs.length) return { message, images: [], referencedPaths: new Set() };
  const attempted = new Set<string>();
  const attached = new Set<string>();
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  let fileText = "";
  for (const ref of refs) {
    let resolved: { absPath: string; relPath: string };
    try {
      resolved = resolveWorkspaceReference(ref.path, cwd);
    } catch {
      continue;
    }
    if (attempted.has(resolved.absPath)) continue;
    attempted.add(resolved.absPath);
    try {
      const file = await fetchWorkspaceFile(boxId, resolved);
      attached.add(resolved.absPath);
      if (file.isImage) {
        images.push({ type: "image", data: file.data, mimeType: file.mimeType });
        fileText += `<file name="${resolved.absPath}"></file>\n`;
      } else {
        fileText += `<file name="${resolved.absPath}">\n${file.text}\n</file>\n`;
      }
    } catch {
      // Match CLI-like convenience without making normal @ tokens (e.g. npm scoped
      // packages such as @playwright/mcp@latest) fail the prompt. Missing or
      // unreadable refs are left as plain user text and are not attached.
    }
  }
  return { message: fileText ? `${fileText}${message}` : message, images, referencedPaths: attached };
}

function parseFileRefs(text: string): ParsedFileRef[] {
  const refs: ParsedFileRef[] = [];
  const re = /(\s)@(?:("((?:\\.|[^"\\])+)"|'([^']+)'|([^\s]+)))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const prefix = match[1] ?? "";
    const tokenStart = match.index + prefix.length;
    const quoted = match[3] ? unescapeQuotedRef(match[3]) : match[4] ?? "";
    const isQuoted = Boolean(quoted);
    let rawPath = quoted || match[5] || "";
    let end = re.lastIndex;
    if (!isQuoted) {
      const stripped = rawPath.replace(/[),.;:!?，。；：！？]+$/g, "");
      end -= rawPath.length - stripped.length;
      rawPath = stripped;
    }
    rawPath = rawPath.trim();
    if (!rawPath || rawPath.startsWith("@")) continue;
    if (!isQuoted && rawPath.includes("@")) continue;
    refs.push({ raw: text.slice(tokenStart, end), path: rawPath, start: tokenStart, end });
  }
  return refs;
}

function unescapeQuotedRef(value: string) {
  return value.replace(/\\(["\\])/g, "$1");
}

function splitFileRefs(text: string): Array<{ kind: "text"; text: string } | { kind: "newline" } | { kind: "fileRef"; path: string }> {
  const out: Array<{ kind: "text"; text: string } | { kind: "newline" } | { kind: "fileRef"; path: string }> = [];
  const refs = parseFileRefs(text);
  let last = 0;
  const pushText = (value: string) => {
    const chunks = value.split("\n");
    chunks.forEach((chunk, idx) => {
      if (idx > 0) out.push({ kind: "newline" });
      if (chunk) out.push({ kind: "text", text: chunk });
    });
  };
  for (const ref of refs) {
    if (ref.start > last) pushText(text.slice(last, ref.start));
    out.push({ kind: "fileRef", path: ref.path });
    last = ref.end;
  }
  if (last < text.length) pushText(text.slice(last));
  return out;
}

function resolveWorkspaceReference(input: string, cwd: string): { absPath: string; relPath: string } {
  const base = normalizeWorkspacePath(cwd || "/workspace");
  const raw = input.trim();
  const absPath = raw.startsWith("/") ? normalizeWorkspacePath(raw) : normalizeWorkspacePath(`${base}/${raw}`);
  if (absPath !== "/workspace" && !absPath.startsWith("/workspace/")) throw new Error(`文件路径必须位于 /workspace 内：${input}`);
  return { absPath, relPath: absPath === "/workspace" ? "." : absPath.slice("/workspace/".length) };
}

function normalizeWorkspacePath(value: string): string {
  const parts: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`.replace(/\/$/, "") || "/workspace";
}

async function fetchWorkspaceFile(boxId: string, file: { absPath: string; relPath: string }): Promise<{ isImage: true; data: string; mimeType: string } | { isImage: false; text: string; mimeType: string }> {
  const res = await fetch(api.downloadUrl(boxId, file.relPath), { credentials: "include" });
  if (!res.ok) throw new Error(`${file.absPath}: ${res.status} ${res.statusText}`);
  const mimeType = (res.headers.get("content-type") || guessMimeType(file.absPath) || "text/plain").split(";")[0].trim();
  if (mimeType.startsWith("image/") || isImagePath(file.absPath)) {
    return { isImage: true, data: arrayBufferToBase64(await res.arrayBuffer()), mimeType: mimeType.startsWith("image/") ? mimeType : guessMimeType(file.absPath) || "image/png" };
  }
  return { isImage: false, text: await res.text(), mimeType };
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

function isImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

function guessMimeType(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  return undefined;
}

function isAlreadyProcessingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Agent is already processing|already processing|streamingBehavior/i.test(message);
}

function compactText(parts: Array<string | undefined | null | false>): string {
  const text = parts.map((part) => String(part ?? "").trim()).filter(Boolean).join(" · ");
  return text || "点击查看详情";
}

function attachmentSummary(attachments: ChatAttachment[]) {
  const imageCount = attachments.filter((item) => item.kind === "image").length;
  const fileCount = attachments.filter((item) => item.kind === "file").length;
  return [imageCount ? `${imageCount} 张图片` : "", fileCount ? `${fileCount} 个文件` : ""].filter(Boolean).join("，") || "[附件]";
}

function lineCount(text: string) {
  if (!text) return 0;
  return text.split("\n").length;
}

function isToolContentPart(part: any): boolean {
  const type = String(part?.type ?? "").toLowerCase();
  if (type === "thinking") return false;
  return Boolean(type === "toolcall" || type === "tool_call" || type === "tool-call" || type === "tool_use" || type === "tooluse" || ((part?.name || part?.toolName) && (part?.args !== undefined || part?.arguments !== undefined || part?.input !== undefined)));
}

function toolCallFromDelta(delta: any): { id?: string; name?: string; args?: unknown } {
  const candidate = findToolCall(delta?.toolCall) ?? findToolCall(delta?.tool_call) ?? findToolCall(delta?.content) ?? findToolCall(delta?.partial) ?? findToolCall(delta?.message, delta?.contentIndex);
  if (candidate) return candidate;
  return { id: delta?.toolCallId ? String(delta.toolCallId) : undefined, name: delta?.toolName, args: undefined };
}

function findToolCall(value: any, contentIndex?: number): { id?: string; name?: string; args?: unknown } | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const indexed = typeof contentIndex === "number" ? value[contentIndex] : undefined;
    return findToolCall(indexed) ?? value.map((item) => findToolCall(item)).find(Boolean);
  }
  if (value.content) return findToolCall(value.content, contentIndex);
  if (!isToolContentPart(value)) return undefined;
  return {
    id: value.id ?? value.toolCallId ?? value.tool_call_id,
    name: value.name ?? value.toolName,
    args: value.args ?? value.arguments ?? value.input
  };
}

function formatStats(stats: SessionStats | null, autoCompact: boolean): string {
  if (!stats?.tokens && !stats?.contextUsage) return `context — (${autoCompact ? "auto" : "manual"})`;
  const tokens = stats.tokens ?? {};
  const context = stats.contextUsage;
  const input = formatTokens(tokens.input ?? 0);
  const output = formatTokens(tokens.output ?? 0);
  const read = formatTokens(tokens.cacheRead ?? 0);
  const cost = typeof stats.cost === "number" ? `$${stats.cost.toFixed(3)}` : "$0.000";
  const percent = typeof context?.percent === "number" ? `${context.percent.toFixed(1)}%` : "—%";
  const window = context?.contextWindow ? formatTokens(context.contextWindow) : "ctx";
  return `↑${input} ↓${output} R${read} ${cost} ${percent}/${window} (${autoCompact ? "auto" : "manual"})`;
}

function modelProvider(model: PiModel | null | undefined): string | undefined {
  const provider = model?.provider ?? model?.providerId ?? model?.providerName;
  return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${value}B`;
}

function formatNumber(value: number) {
  return Math.max(0, Math.floor(value)).toLocaleString();
}

function attachmentImageSrc(attachment: Extract<ChatAttachment, { kind: "image" }>, boxId?: string): string | undefined {
  if (attachment.path && boxId) return api.downloadUrl(boxId, workspaceRelPath(attachment.path));
  if (attachment.data) return `data:${attachment.mimeType};base64,${attachment.data}`;
  return undefined;
}

function workspaceRelPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/workspace") return ".";
  if (normalized.startsWith("/workspace/")) return normalized.slice("/workspace/".length);
  return normalized.replace(/^\/+/, "") || ".";
}
