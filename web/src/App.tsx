import { useEffect, useState } from "react";
import { ChatPane } from "./components/ChatPane";
import { CreateBoxModal } from "./components/CreateBoxModal";
import { RightPanel } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { api, wsUrl } from "./lib/api";
import { useAppStore } from "./state/app";

export function App() {
  const [showCreate, setShowCreate] = useState(false);
  const [health, setHealth] = useState<string>("checking");
  const [activity, setActivity] = useState<string>("");
  const { boxes, sessions, activeBoxId, activeSessionId, setBoxes, setSessions, setActiveSession } = useAppStore();

  async function refresh() {
    const [b, s] = await Promise.all([api.listBoxes(), api.listSessions()]);
    setBoxes(b.boxes);
    setSessions(s.sessions);
  }

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (!activeBoxId) return;
    const ws = new WebSocket(wsUrl(`/ws/boxes/${activeBoxId}/events`));
    ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.type === "sessions_changed" || msg.type === "box_updated") void refresh(); };
    return () => ws.close();
  }, [activeBoxId]);

  useEffect(() => {
    if (!activeBoxId) return;
    const belongs = sessions.some((s) => s.id === activeSessionId && s.boxId === activeBoxId);
    if (!belongs) setActiveSession(sessions.find((s) => s.boxId === activeBoxId)?.id);
  }, [activeBoxId, sessions, activeSessionId]);

  const activeBox = boxes.find((b) => b.id === activeBoxId);

  return <>
    <div className="app">
      <Sidebar onNewBox={() => setShowCreate(true)} />
      <ChatPane boxId={activeBoxId} sessionId={activeSessionId} />
      <RightPanel box={activeBox} onRefresh={refresh} />
    </div>
    <div className="app-status small">Docker: {health} {activeBox ? ` · ${activeBox.name}` : ""}{activity ? ` · ${activity}` : ""}</div>
    {showCreate && <CreateBoxModal onClose={() => setShowCreate(false)} onCreated={refresh} />}
  </>;
}
