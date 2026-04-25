import { type FormEvent, useEffect, useState } from "react";
import { ChatPane } from "./components/ChatPane";
import { CreateBoxModal } from "./components/CreateBoxModal";
import { RightPanel } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { api, wsUrl } from "./lib/api";
import { useAppStore } from "./state/app";
import { LogOut, ShieldCheck } from "lucide-react";

export function App() {
  const [showCreate, setShowCreate] = useState(false);
  const [health, setHealth] = useState<string>("checking");
  const [activity, setActivity] = useState<string>("");
  const [auth, setAuth] = useState<{ loading: boolean; enabled: boolean; authenticated: boolean }>({ loading: true, enabled: false, authenticated: false });
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
    return () => { ws.close(); clearInterval(timer); };
  }, [auth.loading, auth.enabled, auth.authenticated]);

  useEffect(() => {
    if (auth.loading || (auth.enabled && !auth.authenticated) || !activeBoxId) return;
    const ws = new WebSocket(wsUrl(`/ws/boxes/${activeBoxId}/events`));
    ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.type === "sessions_changed" || msg.type === "box_updated") void refresh(); };
    return () => ws.close();
  }, [activeBoxId, auth.loading, auth.enabled, auth.authenticated]);

  useEffect(() => {
    if (!activeBoxId) return;
    const belongs = sessions.some((s) => s.id === activeSessionId && s.boxId === activeBoxId);
    if (!belongs) setActiveSession(sessions.find((s) => s.boxId === activeBoxId)?.id);
  }, [activeBoxId, sessions, activeSessionId]);

  const activeBox = boxes.find((b) => b.id === activeBoxId);

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
    <div className="app">
      <Sidebar onNewBox={() => setShowCreate(true)} />
      <ChatPane boxId={activeBoxId} sessionId={activeSessionId} />
      <RightPanel box={activeBox} onRefresh={refresh} />
    </div>
    <div className="app-status small">Docker: {health} {activeBox ? ` · ${activeBox.name}` : ""}{activity ? ` · ${activity}` : ""}</div>
    {auth.enabled && <button type="button" className="auth-logout" onClick={logout}><LogOut size={14} /> 退出</button>}
    {showCreate && <CreateBoxModal onClose={() => setShowCreate(false)} onCreated={refresh} />}
  </>;
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
