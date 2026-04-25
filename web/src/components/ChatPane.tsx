import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Archive, Bot, Brain, CheckCircle2, ChevronDown, CircleAlert, Loader2, Paperclip, Send, Sparkles, Square, Wrench } from "lucide-react";
import { api, wsUrl } from "../lib/api";
import { newId } from "../lib/id";
import type { AgentSessionRecord, ChatMessage, PiModel, SessionStats, ThinkingLevel } from "../lib/types";
import { useAppStore } from "../state/app";

interface QueueState {
  steering: string[];
  followUp: string[];
}

type SendMode = "normal" | "steer" | "followUp";
type MenuKey = "send" | "thinking" | "model" | "compact";

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

export function ChatPane({ boxId, sessionId }: { boxId?: string; sessionId?: string }) {
  const {
    sessions,
    messagesBySession,
    appendMessage,
    updateLastAssistant,
    updateLastAssistantThinking,
    upsertToolMessage,
    clearMessages,
    setSessions
  } = useAppStore();
  const [text, setText] = useState("");
  const [sendMode, setSendMode] = useState<SendMode>("normal");
  const [openMenu, setOpenMenu] = useState<MenuKey>();
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [autoCompact, setAutoCompact] = useState(true);
  const [models, setModels] = useState<PiModel[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [modelLoading, setModelLoading] = useState(false);
  const [currentModel, setCurrentModel] = useState<{ provider?: string; model?: string }>({});
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [images, setImages] = useState<Array<{ type: "image"; data: string; mimeType: string; name: string }>>([]);
  const [queue, setQueue] = useState<QueueState>({ steering: [], followUp: [] });
  const [turnActive, setTurnActive] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const session = sessions.find((s) => s.id === sessionId);
  const messages = sessionId ? messagesBySession[sessionId] ?? [] : [];
  const canSend = text.trim().length > 0 || images.length > 0;
  const cwd = session?.cwd || "/workspace";
  const runtimeSubtitle = [currentModel.provider, currentModel.model, `thinking ${thinkingLevel}`, `compact ${autoCompact ? "auto" : "manual"}`].filter(Boolean).join(" · ");
  const activityStatus = turnActive || session?.status === "working" ? "working" : session?.status === "running" ? "running" : undefined;

  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const filtered = query
      ? models.filter((model) => `${modelProvider(model) ?? ""} ${model.id} ${model.name ?? ""}`.toLowerCase().includes(query))
      : models;
    return filtered.slice(0, 180);
  }, [models, modelSearch]);

  useEffect(() => {
    if (isNearBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, messages.at(-1)?.text, messages.at(-1)?.thinking, messages.at(-1)?.toolResult, isNearBottom]);

  useEffect(() => {
    setOpenMenu(undefined);
    setModelSearch("");
    setModels([]);
    setStats(null);
    setSendMode("normal");
  }, [sessionId]);

  useEffect(() => {
    setThinkingLevel(session?.thinkingLevel ?? "medium");
    setAutoCompact(session?.autoCompactionEnabled ?? true);
    setCurrentModel({ provider: session?.provider, model: session?.model });
  }, [session?.provider, session?.model, session?.thinkingLevel, session?.autoCompactionEnabled]);

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
    setQueue({ steering: [], followUp: [] });
    setTurnActive(false);
    const ws = new WebSocket(wsUrl(`/ws/sessions/${sessionId}/events`));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "session_status") {
        if (msg.status === "working") setTurnActive(true);
        if (msg.status === "running" || msg.status === "stopped" || msg.status === "error") setTurnActive(false);
        if (typeof msg.status === "string") patchSessionLocal({ status: msg.status as any, error: msg.error });
      }
      if (msg.type !== "agent_event") return;
      const e = msg.event;
      if (e.type === "agent_start" || e.type === "turn_start" || e.type === "message_start") setTurnActive(true);
      if (e.type === "agent_end" || e.type === "turn_end" || e.type === "message_end") {
        setTurnActive(false);
        void refreshSessionStats(sessionId);
      }
      if (e.type === "message_update") {
        const delta = e.assistantMessageEvent;
        if (delta?.type === "start" || delta?.type === "text_start" || delta?.type === "thinking_start" || delta?.type === "toolcall_start") setTurnActive(true);
        if (delta?.type === "text_delta") updateLastAssistant(sessionId, String(delta.delta ?? ""));
        if (delta?.type === "thinking_delta") updateLastAssistantThinking(sessionId, String(delta.delta ?? ""));
        if (delta?.type === "toolcall_start") {
          const tool = toolCallFromDelta(delta);
          const toolCallId = tool.id ?? String(delta.id ?? `${delta.contentIndex ?? "tool"}`);
          upsertToolMessage(sessionId, toolCallId, { toolCallId, toolName: tool.name ?? "tool", toolArgs: tool.args, toolStatus: "pending" });
        }
        if (delta?.type === "toolcall_delta") {
          const tool = toolCallFromDelta(delta);
          const toolCallId = tool.id ?? String(delta.id ?? `${delta.contentIndex ?? "tool"}`);
          const patch: Partial<ChatMessage> = { toolCallId, toolName: tool.name ?? "tool", toolStatus: "pending" };
          if (tool.args !== undefined) patch.toolArgs = tool.args;
          upsertToolMessage(sessionId, toolCallId, patch);
        }
        if (delta?.type === "toolcall_end") {
          const tool = toolCallFromDelta(delta);
          const toolCallId = tool.id ?? String(delta.id ?? `${delta.contentIndex ?? "tool"}`);
          upsertToolMessage(sessionId, toolCallId, { toolCallId, toolName: tool.name ?? "tool", toolArgs: tool.args, toolStatus: "pending" });
        }
        if (delta?.type === "done" || delta?.type === "error") {
          setTurnActive(false);
          void refreshSessionStats(sessionId);
        }
      }
      if (e.type === "tool_execution_start") {
        setTurnActive(true);
        upsertToolMessage(sessionId, e.toolCallId ?? `${e.toolName}-${Date.now()}`, { toolName: e.toolName, toolArgs: e.args, toolStatus: "running" });
      }
      if (e.type === "tool_execution_update") {
        upsertToolMessage(sessionId, e.toolCallId ?? `${e.toolName}-${Date.now()}`, { toolName: e.toolName, toolArgs: e.args, toolResult: resultToText(e.partialResult), toolStatus: "running" });
      }
      if (e.type === "tool_execution_end") {
        upsertToolMessage(sessionId, e.toolCallId ?? `${e.toolName}-${Date.now()}`, { toolName: e.toolName, toolArgs: e.args, toolResult: resultToText(e.result), toolStatus: e.isError ? "error" : "done" });
      }
      if (e.type === "queue_update") {
        setQueue({ steering: e.steering ?? [], followUp: e.followUp ?? [] });
      }
      if (e.type === "compaction_start") {
        setTurnActive(true);
        appendMessage(sessionId, { id: newId(), role: "system", text: `正在压缩上下文：${e.reason ?? "manual"}`, timestamp: Date.now() });
      }
      if (e.type === "compaction_end") {
        setTurnActive(false);
        appendMessage(sessionId, { id: newId(), role: "system", text: e.aborted ? "上下文压缩已取消" : `上下文压缩完成${e.willRetry ? "，将自动重试" : ""}${e.errorMessage ? `：${e.errorMessage}` : ""}`, timestamp: Date.now() });
        void refreshSessionStats(sessionId);
      }
    };
    void api.messages(sessionId).then((res) => {
      clearMessages(sessionId);
      for (const m of normalizePiMessages(res.messages)) appendMessage(sessionId, m);
    }).catch(() => undefined);
    void refreshSessionStats(sessionId);
    return () => ws.close();
  }, [sessionId, appendMessage, clearMessages, updateLastAssistant, updateLastAssistantThinking, upsertToolMessage]);

  async function submit(e?: FormEvent, modeOverride?: SendMode) {
    e?.preventDefault();
    if (!sessionId || !canSend) return;
    const message = text.trimEnd();
    appendMessage(sessionId, { id: newId(), role: "user", text: message || `[${images.length} 张图片]`, timestamp: Date.now() });
    setText("");
    setTurnActive(true);
    const modeToUse = modeOverride ?? sendMode;
    const payload: any = { message, images: images.map(({ name: _name, ...img }) => img) };
    if (modeToUse !== "normal") payload.streamingBehavior = modeToUse;
    setImages([]);
    try { await api.prompt(sessionId, payload); }
    catch (err) {
      setTurnActive(false);
      appendMessage(sessionId, { id: newId(), role: "system", text: `发送失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  async function runCompact(customInstructions?: string) {
    if (!sessionId) return;
    appendMessage(sessionId, { id: newId(), role: "system", text: customInstructions ? `已触发手动上下文压缩。自定义要求：${customInstructions}` : "已触发手动上下文压缩。", timestamp: Date.now() });
    setText("");
    setImages([]);
    setTurnActive(true);
    try { await api.compactSession(sessionId, { customInstructions }); }
    catch (err) {
      setTurnActive(false);
      appendMessage(sessionId, { id: newId(), role: "system", text: `压缩失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  function handleScroll() {
    const el = messagesRef.current;
    if (!el) return;
    setIsNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 180);
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

  async function refreshSessionStats(id = sessionId) {
    if (!id) return;
    try {
      const res = await api.sessionStats(id);
      if (id === useAppStore.getState().activeSessionId) setStats(res.stats ?? null);
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
      setTurnActive(false);
      void refreshSessionStats(sessionId);
    } catch (err) {
      appendMessage(sessionId, { id: newId(), role: "system", text: `中止失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    }
  }

  if (!boxId) return <EmptyChat title="选择或创建 Box" subtitle="每个 Box 都是独立 Docker 沙箱，包含自己的 pi 配置、文件系统和 code-server。" />;
  if (!sessionId) return <EmptyChat title="选择或创建 Session" subtitle="Session 负责和 Box 内的 pi RPC agent 对话；可以为同一个 Box 并行开多个会话。" />;

  return <div className="chat surface-tonal">
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

    <div className="messages" ref={messagesRef} onScroll={handleScroll}>
      {messages.length === 0 && <div className="welcome-card">
        <div className="welcome-orb"><Sparkles size={24} /></div>
        <h2>准备好开始了吗？</h2>
        <p>像 Claude 一样自然地描述任务。BoxedAgent 会把上下文、文件和工具调用整合到这个 Box 内的 pi agent。</p>
        <div className="prompt-suggestions">
          <button type="button" onClick={() => setText("请快速了解这个 workspace 的结构，并给我一个简短总结。")}>总结 workspace</button>
          <button type="button" onClick={() => setText("请运行必要检查，找出当前项目最值得改进的地方。")}>检查项目</button>
          <button type="button" onClick={() => setText("请帮我实现一个小改动，并说明测试方式。")}>实现改动</button>
        </div>
      </div>}
      {messages.map((m, idx) => <MessageBubble key={m.id} message={m} isLatest={idx === messages.length - 1} />)}
      {turnActive && <div className="assistant-thinking"><Loader2 size={14} className="spin" /> pi 正在处理…</div>}
      <div ref={bottomRef} />
    </div>

    <form className="composer" ref={composerRef} onSubmit={(e) => submit(e)}>
      {(queue.steering.length > 0 || queue.followUp.length > 0) && <div className="queue-strip">
        {queue.steering.map((item, i) => <span key={`s-${i}`} className="queue-chip">Steer · {item}</span>)}
        {queue.followUp.map((item, i) => <span key={`f-${i}`} className="queue-chip">Follow-up · {item}</span>)}
      </div>}
      {images.length > 0 && <div className="attachment-strip">
        {images.map((img) => <div className="image-chip" key={img.name}><img src={`data:${img.mimeType};base64,${img.data}`} alt="" /><span>{img.name}</span></div>)}
      </div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Message BoxedAgent…"
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
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
              <MenuTitle icon={<Bot size={15} />} title="模型" subtitle="来自 pi RPC get_available_models，等价于 TUI /models 列表" action={<button type="button" className="button-tonal compact" onClick={() => ensureModels(true)}>刷新</button>} />
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
            const files = [...(e.target.files ?? [])];
            e.currentTarget.value = "";
            const imageFiles = files.filter((f) => f.type.startsWith("image/"));
            const otherFiles = files.filter((f) => !f.type.startsWith("image/"));
            if (imageFiles.length) {
              const converted = await filesToImages(imageFiles);
              setImages((prev) => [...prev, ...converted]);
            }
            if (boxId && otherFiles.length) {
              for (const file of otherFiles) await api.uploadFile(boxId, ".", file);
              setText((t) => `${t}${t ? "\n" : ""}我已上传文件到 /workspace：${otherFiles.map((f) => f.name).join(", ")}，请根据需要读取。`);
            }
          }} />
        </div>

        <div className="send-cluster">
          <span className="send-mode-label">{turnActive ? "停止生成" : SEND_MODES.find((item) => item.value === sendMode)?.label}</span>
          <div className="send-menu-anchor">
            {turnActive ? <button type="button" className="send-fab stop-fab" title="中止当前任务" onClick={abortTurn}><Square size={19} /></button> : <>
              <button type="button" className={`send-fab ${canSend ? "" : "idle"}`} title="发送 / 队列" onClick={() => toggleMenu("send")}><Send size={20} /></button>
              {openMenu === "send" && <MenuPanel className="send-menu">
                <MenuTitle icon={<Send size={15} />} title="发送方式" subtitle="选择后立即发送；Enter 使用当前方式" />
                {SEND_MODES.map((item) => <MenuItem key={item.value} selected={sendMode === item.value} onClick={() => chooseSendMode(item.value)} title={item.label} description={item.description} />)}
              </MenuPanel>}
            </>}
          </div>
        </div>
      </div>
    </form>
  </div>;
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

function MessageBubble({ message, isLatest }: { message: ChatMessage; isLatest: boolean }) {
  if (message.role === "tool") return <ToolCard message={message} isLatest={isLatest} />;
  if (message.role === "system") return <div className="system-line"><CircleAlert size={14} /> <MarkdownText text={message.text} /></div>;
  return <article className={`message-row ${message.role}`}>
    {message.role === "assistant" && <div className="avatar assistant-avatar"><Sparkles size={16} /></div>}
    <div className={`message ${message.role}`}>
      {message.thinking && <ThinkingBlock text={message.thinking} autoOpen={isLatest} />}
      {message.text ? <MarkdownText text={message.text} /> : message.thinking ? null : <span className="muted">…</span>}
    </div>
  </article>;
}

function ThinkingBlock({ text, autoOpen }: { text: string; autoOpen: boolean }) {
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => setOpen(autoOpen), [autoOpen]);
  return <details className="thinking-block" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary><Brain size={14} /> 思考过程 <ChevronDown size={14} /></summary>
    <MarkdownText text={text} />
  </details>;
}

function ToolCard({ message, isLatest }: { message: ChatMessage; isLatest: boolean }) {
  const status = message.toolStatus ?? "pending";
  const autoOpen = isLatest || status === "running";
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => setOpen(autoOpen), [autoOpen, message.id]);
  return <details className={`tool-card ${status}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>
      <span className="tool-icon">{status === "running" ? <Loader2 size={14} className="spin" /> : status === "error" ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}</span>
      <span className="tool-name"><Wrench size={14} /> {message.toolName ?? "tool"}</span>
      <span className="tool-overview">{toolOverview(message)}</span>
      <span className="tool-status">{status === "running" ? "运行中" : status === "error" ? "失败" : status === "done" ? "完成" : "准备"}</span>
    </summary>
    <ToolPreview message={message} />
  </details>;
}

function toolOverview(message: ChatMessage): string {
  const name = (message.toolName ?? "tool").toLowerCase();
  const args = asRecord(message.toolArgs);
  const result = message.toolResult ?? "";
  const path = stringValue(args.path ?? args.file ?? args.filename);
  if (name === "write") return compactText(["写入", path, previewText(args.content ?? result)]);
  if (name === "edit") return compactText(["编辑", path, previewText(args.newText ?? args.new_text ?? args.replacement ?? result)]);
  if (name === "read") return compactText(["读取", path, args.limit ? `limit ${String(args.limit)}` : previewText(result)]);
  if (name === "bash" || name === "shell") return compactText([previewText(args.command ?? args.cmd ?? message.toolArgs)]);
  return compactText([path, previewText(result || message.toolArgs)]);
}

function ToolPreview({ message }: { message: ChatMessage }) {
  const name = (message.toolName ?? "tool").toLowerCase();
  const args = asRecord(message.toolArgs);
  const result = message.toolResult ?? "";
  const path = stringValue(args.path ?? args.file ?? args.filename);

  if (name === "write" || name === "edit") {
    const content = stringValue(args.content ?? args.newText ?? args.new_text ?? args.replacement ?? result);
    return <div className="tool-preview">
      <div className="tool-preview-head"><span>{name === "write" ? "写入" : "编辑"}</span><code>{path || "file"}</code><span className="small">{lineCount(content)} lines</span></div>
      {content && <CodePreview text={content} />}
      {name === "edit" && stringValue(args.oldText ?? args.old_text) && <details className="tool-mini-details"><summary>原片段</summary><CodePreview text={stringValue(args.oldText ?? args.old_text)} /></details>}
    </div>;
  }

  if (name === "read") {
    const limit = args.limit ? ` · limit ${String(args.limit)}` : "";
    return <div className="tool-preview">
      <div className="tool-preview-head"><span>读取</span><code>{path || "file"}</code><span className="small">{limit}</span></div>
      {result ? <CodePreview text={result} /> : message.toolArgs !== undefined && <CodePreview text={safeJson(message.toolArgs)} />}
    </div>;
  }

  if (name === "bash" || name === "shell") {
    const command = stringValue(args.command ?? args.cmd ?? message.toolArgs);
    return <div className="tool-preview">
      {command && <><div className="tool-preview-head"><span>命令</span></div><CodePreview text={command} maxLines={8} /></>}
      {result && <><div className="tool-preview-head"><span>输出预览</span><span className="small">{lineCount(result)} lines</span></div><CodePreview text={result} /></>}
    </div>;
  }

  return <div className="tool-preview">
    {message.toolArgs !== undefined && <><div className="tool-preview-head"><span>参数</span></div><CodePreview text={safeJson(message.toolArgs)} maxLines={10} /></>}
    {result && <><div className="tool-preview-head"><span>输出预览</span><span className="small">{lineCount(result)} lines</span></div><CodePreview text={result} /></>}
  </div>;
}

function CodePreview({ text, maxLines = 18 }: { text: string; maxLines?: number }) {
  const lines = text.split("\n");
  const clipped = lines.length > maxLines;
  const shown = clipped ? lines.slice(0, maxLines).join("\n") : text;
  return <pre className="code-preview">{shown}{clipped ? `\n… ${lines.length - maxLines} more lines` : ""}</pre>;
}

function MarkdownText({ text }: { text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
}

async function filesToImages(files: Iterable<File> | null) {
  if (!files) return [];
  return Promise.all([...files].map(async (file) => {
    const dataUrl = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
    const data = dataUrl.split(",")[1] ?? "";
    return { type: "image" as const, data, mimeType: file.type || "image/png", name: file.name };
  }));
}

function normalizePiMessages(messages: any[]): ChatMessage[] {
  const toolCalls = new Map<string, Partial<ChatMessage>>();
  const out: ChatMessage[] = [];
  messages.forEach((m, idx) => {
    const timestamp = m.timestamp ?? Date.now();
    if (m.role === "user") {
      out.push({ id: `${idx}-${timestamp}`, role: "user", text: contentToText(m.content) || m.message || "", timestamp });
      return;
    }
    if (m.role === "assistant") {
      const { text, thinking, tools } = contentParts(m.content);
      const summary = m.summary ? `[summary]\n${m.summary}` : "";
      if (text || thinking || summary) out.push({ id: `${idx}-${timestamp}-assistant`, role: "assistant", text: text || summary, thinking, timestamp });
      tools.forEach((tool, toolIdx) => {
        if (tool.toolCallId) toolCalls.set(String(tool.toolCallId), tool);
        out.push({ id: `${idx}-${timestamp}-tool-${toolIdx}`, role: "tool", text: "", timestamp, ...tool });
      });
      return;
    }
    const callId = String(m.tool_call_id ?? m.toolCallId ?? m.id ?? `${idx}-${timestamp}`);
    const prior = toolCalls.get(callId) ?? {};
    out.push({
      id: `${idx}-${timestamp}`,
      role: "tool",
      text: "",
      toolCallId: callId,
      toolName: m.name ?? m.toolName ?? prior.toolName ?? "tool",
      toolArgs: m.args ?? m.arguments ?? prior.toolArgs,
      toolStatus: m.isError ? "error" : "done",
      toolResult: contentToText(m.content) || m.result || JSON.stringify(m),
      timestamp
    });
  });
  return out;
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

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
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

function compactText(parts: Array<string | undefined | null | false>): string {
  const text = parts.map((part) => String(part ?? "").trim()).filter(Boolean).join(" · ");
  return text || "点击查看详情";
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
