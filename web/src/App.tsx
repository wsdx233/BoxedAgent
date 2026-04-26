import { type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useState } from "react";
import { ChatPane } from "./components/ChatPane";
import { CreateBoxModal } from "./components/CreateBoxModal";
import { RightPanel } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { api, closeWebSocketQuietly, wsUrl } from "./lib/api";
import { useAppStore } from "./state/app";
import { Boxes as BoxesIcon, LogOut, MessageSquare, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, ShieldCheck, Wrench } from "lucide-react";

type MobilePanel = "boxes" | "chat" | "tools";

export function App() {
  const [showCreate, setShowCreate] = useState(false);
  const [health, setHealth] = useState<string>("checking");
  const [activity, setActivity] = useState<string>("");
  const [auth, setAuth] = useState<{ loading: boolean; enabled: boolean; authenticated: boolean }>({ loading: true, enabled: false, authenticated: false });
  const [leftVisible, setLeftVisible] = useState(() => storedBoolean("boxedagent.leftVisible", true));
  const [rightVisible, setRightVisible] = useState(() => storedBoolean("boxedagent.rightVisible", true));
  const [leftWidth, setLeftWidth] = useState(() => storedNumber("boxedagent.leftWidth", 330));
  const [rightWidth, setRightWidth] = useState(() => storedNumber("boxedagent.rightWidth", 560));
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");
  const { boxes, sessions, activeBoxId, activeSessionId, setBoxes, setSessions, setActiveSession } = useAppStore();

  async function refresh() {
    const [b, s] = await Promise.all([api.listBoxes(), api.listSessions()]);
    setBoxes(b.boxes);
    setSessions(s.sessions);
  }

  useEffect(() => {
    api.authStatus().then((status) => setAuth({ loading: false, enabled: status.enabled, authenticated: status.authenticated })).catch(() => setAuth({ loading: false, enabled: true, authenticated: false }));
  }, []);

  useEffect(() => {
    if (auth.loading || (auth.enabled && !auth.authenticated)) return;
    api.health().then((h) => setHealth(h.docker)).catch((e) => setHealth(e.message));
    void refresh();
    const ws = new WebSocket(wsUrl("/ws/events"));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "boxes_changed") void refresh();
      if (msg.type === "image_ensure_start") setActivity(`${msg.action === "build" ? "构建" : "拉取"}镜像：${msg.image}`);
      if (msg.type === "image_progress" && msg.message) setActivity(msg.message.slice(0, 160));
      if (msg.type === "image_ensure_end") { setActivity(`镜像就绪：${msg.image}`); void refresh(); }
      if (msg.type === "image_ensure_error") setActivity(`镜像失败：${msg.error}`);
    };
    const timer = setInterval(refresh, 10_000);
    return () => { closeWebSocketQuietly(ws); clearInterval(timer); };
  }, [auth.loading, auth.enabled, auth.authenticated]);

  useEffect(() => {
    if (auth.loading || (auth.enabled && !auth.authenticated) || !activeBoxId) return;
    const ws = new WebSocket(wsUrl(`/ws/boxes/${activeBoxId}/events`));
    ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.type === "sessions_changed" || msg.type === "box_updated") void refresh(); };
    return () => closeWebSocketQuietly(ws);
  }, [activeBoxId, auth.loading, auth.enabled, auth.authenticated]);

  useEffect(() => {
    if (!activeBoxId) return;
    const belongs = sessions.some((s) => s.id === activeSessionId && s.boxId === activeBoxId);
    if (!belongs) setActiveSession(sessions.find((s) => s.boxId === activeBoxId)?.id);
  }, [activeBoxId, sessions, activeSessionId]);

  const activeBox = boxes.find((b) => b.id === activeBoxId);
  const appStyle = { "--left-width": `${leftWidth}px`, "--right-width": `${rightWidth}px` } as CSSProperties;
  const appClass = ["app", leftVisible ? "" : "left-hidden", rightVisible ? "" : "right-hidden", `mobile-panel-${mobilePanel}`].filter(Boolean).join(" ");

  useEffect(() => { storePreference("boxedagent.leftVisible", String(leftVisible)); }, [leftVisible]);
  useEffect(() => { storePreference("boxedagent.rightVisible", String(rightVisible)); }, [rightVisible]);
  useEffect(() => { storePreference("boxedagent.leftWidth", String(leftWidth)); }, [leftWidth]);
  useEffect(() => { storePreference("boxedagent.rightWidth", String(rightWidth)); }, [rightWidth]);

  function startResize(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    document.body.classList.add("resizing-layout");
    const onMove = (move: PointerEvent) => {
      const delta = move.clientX - startX;
      if (side === "left") setLeftWidth(clamp(startWidth + delta, 240, 560));
      else setRightWidth(clamp(startWidth - delta, 320, 860));
    };
    const stop = () => {
      document.body.classList.remove("resizing-layout");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  if (auth.loading) return <AuthShell title="正在检查访问权限…" />;
  if (auth.enabled && !auth.authenticated) return <AuthLogin onAuthed={() => setAuth({ loading: false, enabled: true, authenticated: true })} />;

  async function logout() {
    await api.logout().catch(() => undefined);
    setBoxes([]);
    setSessions([]);
    setActiveSession(undefined);
    setAuth({ loading: false, enabled: auth.enabled, authenticated: !auth.enabled });
  }

  return <>
    <div className={appClass} style={appStyle}>
      <Sidebar onNewBox={() => setShowCreate(true)} onSessionSelected={() => setMobilePanel("chat")} />
      <div className="app-resizer left" role="separator" aria-label="调整 Boxes 宽度" onPointerDown={(event) => startResize("left", event)} />
      <ChatPane boxId={activeBoxId} sessionId={activeSessionId} />
      <div className="app-resizer right" role="separator" aria-label="调整 Tools 宽度" onPointerDown={(event) => startResize("right", event)} />
      <RightPanel box={activeBox} onRefresh={refresh} />
    </div>
    <div className="layout-controls desktop-only">
      <button type="button" className="icon-button" title={leftVisible ? "隐藏 Boxes" : "显示 Boxes"} onClick={() => setLeftVisible((value) => !value)}>{leftVisible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
      <button type="button" className="icon-button" title={rightVisible ? "隐藏 Tools" : "显示 Tools"} onClick={() => setRightVisible((value) => !value)}>{rightVisible ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
    </div>
    <nav className="mobile-bottom-nav" aria-label="主面板切换">
      <button type="button" className={mobilePanel === "boxes" ? "active" : ""} onClick={() => setMobilePanel("boxes")}><BoxesIcon size={18} /><span>Boxes</span></button>
      <button type="button" className={mobilePanel === "chat" ? "active" : ""} onClick={() => setMobilePanel("chat")}><MessageSquare size={18} /><span>Chat</span></button>
      <button type="button" className={mobilePanel === "tools" ? "active" : ""} onClick={() => setMobilePanel("tools")}><Wrench size={18} /><span>Tools</span></button>
    </nav>
    {auth.enabled && <button type="button" className="auth-logout" onClick={logout}><LogOut size={14} /> 退出</button>}
    {showCreate && <CreateBoxModal onClose={() => setShowCreate(false)} onCreated={refresh} />}
  </>;
}

function storedNumber(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function storedBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch {
    // Ignore storage failures, e.g. strict privacy mode.
  }
  return fallback;
}

function storePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); }
  catch { /* ignore */ }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function AuthShell({ title }: { title: string }) {
  return <div className="auth-page">
    <div className="auth-card">
      <div className="auth-icon"><ShieldCheck size={26} /></div>
      <h1>{title}</h1>
    </div>
  </div>;
}

function AuthLogin({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(undefined);
    try {
      await api.login(token);
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return <div className="auth-page">
    <form className="auth-card" onSubmit={submit}>
      <div className="auth-icon"><ShieldCheck size={26} /></div>
      <h1>访问 BoxedAgent</h1>
      <p>请输入部署时配置的访问 Token。Token 只会发送到当前 BoxedAgent 服务，用于创建安全会话 Cookie。</p>
      <label>Token<input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="BOXEDAGENT_TOKEN" /></label>
      {error && <div className="notice error">{error}</div>}
      <button className="primary" disabled={loading || !token.trim()}>{loading ? "验证中…" : "进入"}</button>
    </form>
  </div>;
}
