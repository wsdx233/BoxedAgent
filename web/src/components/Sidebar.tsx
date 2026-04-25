import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Boxes, Copy, Edit3, MoreVertical, Play, Plus, Square, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useAppStore } from "../state/app";
import type { AgentSessionRecord, BoxRecord } from "../lib/types";
import { CreateSessionModal } from "./CreateSessionModal";

type ContextTarget = { kind: "box"; id: string; x: number; y: number } | { kind: "session"; id: string; x: number; y: number };

export function Sidebar({ onNewBox }: { onNewBox: () => void }) {
  const { boxes, sessions, activeBoxId, activeSessionId, setActiveBox, setActiveSession, setBoxes, setSessions } = useAppStore();
  const [showCreateSession, setShowCreateSession] = useState(false);
  const [menu, setMenu] = useState<ContextTarget>();
  const [renameTarget, setRenameTarget] = useState<{ kind: "box" | "session"; id: string; name: string }>();
  const activeBox = boxes.find((box) => box.id === activeBoxId);
  const menuBox = menu?.kind === "box" ? boxes.find((box) => box.id === menu.id) : undefined;
  const menuSession = menu?.kind === "session" ? sessions.find((session) => session.id === menu.id) : undefined;
  const boxSessions = sessions.filter((s) => s.boxId === activeBoxId);

  async function refresh() {
    setBoxes((await api.listBoxes()).boxes);
    setSessions((await api.listSessions()).sessions);
  }

  function openBoxMenu(event: MouseEvent, box: BoxRecord) {
    event.preventDefault();
    event.stopPropagation();
    setActiveBox(box.id);
    setMenu({ kind: "box", id: box.id, x: event.clientX, y: event.clientY });
  }

  function openSessionMenu(event: MouseEvent, session: AgentSessionRecord) {
    event.preventDefault();
    event.stopPropagation();
    setActiveSession(session.id);
    setMenu({ kind: "session", id: session.id, x: event.clientX, y: event.clientY });
  }

  async function applyRename(target: { kind: "box" | "session"; id: string; name: string }, name: string) {
    const next = name.trim();
    if (!next || next === target.name) return;
    if (target.kind === "box") await api.updateBox(target.id, { name: next });
    else await api.updateSession(target.id, { name: next });
    await refresh();
  }

  const boxMenuItems = menuBox ? [
    { label: "重命名", icon: <Edit3 size={14} />, onClick: () => setRenameTarget({ kind: "box", id: menuBox.id, name: menuBox.name }) },
    menuBox.status === "running"
      ? { label: "停止", icon: <Square size={14} />, onClick: async () => { await api.stopBox(menuBox.id); await refresh(); } }
      : { label: "启动", icon: <Play size={14} />, onClick: async () => { await api.startBox(menuBox.id); await refresh(); } },
    { label: "克隆", icon: <Copy size={14} />, onClick: async () => { const name = prompt("克隆名称", `${menuBox.name}-clone`)?.trim(); if (name) { await api.cloneBox(menuBox.id, { name }); await refresh(); } } },
    { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: async () => { if (confirm(`删除 Box ${menuBox.name}?`)) { await api.deleteBox(menuBox.id); await refresh(); } } }
  ] : [];

  const sessionMenuItems = menuSession ? [
    { label: "重命名", icon: <Edit3 size={14} />, onClick: () => setRenameTarget({ kind: "session", id: menuSession.id, name: menuSession.name }) },
    menuSession.status === "running" || menuSession.status === "working"
      ? { label: "停止", icon: <Square size={14} />, onClick: async () => { await api.stopSession(menuSession.id); await refresh(); } }
      : { label: "启动", icon: <Play size={14} />, onClick: async () => { await api.startSession(menuSession.id); await refresh(); } },
    { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: async () => { if (confirm(`删除 Session ${menuSession.name}?`)) { await api.deleteSession(menuSession.id); await refresh(); } } }
  ] : [];

  return <aside className="sidebar">
    <div className="header"><div className="logo"><Boxes size={18} /> BoxedAgent</div><button className="primary" onClick={onNewBox}><Plus size={15} /></button></div>
    <div className="list">
      <div className="row space"><strong>Boxes</strong><button onClick={refresh}>刷新</button></div>
      {boxes.map((box) => <BoxItem key={box.id} box={box} active={box.id === activeBoxId} onSelect={() => setActiveBox(box.id)} onContextMenu={(event) => openBoxMenu(event, box)} onMenu={(event) => openBoxMenu(event, box)} />)}
      <hr style={{ borderColor: "var(--border)" }} />
      <div className="row space"><strong>Sessions</strong><button disabled={!activeBoxId} onClick={() => setShowCreateSession(true)}><Plus size={15} /></button></div>
      {boxSessions.map((session) => <SessionItem key={session.id} session={session} active={session.id === activeSessionId} onSelect={() => setActiveSession(session.id)} onContextMenu={(event) => openSessionMenu(event, session)} onMenu={(event) => openSessionMenu(event, session)} />)}
    </div>
    {showCreateSession && activeBox && <CreateSessionModal box={activeBox} onClose={() => setShowCreateSession(false)} onCreated={async (id) => { setActiveSession(id); await refresh(); }} />}
    {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} items={menu.kind === "box" ? boxMenuItems : sessionMenuItems} />, document.body)}
    {renameTarget && <RenameDialog target={renameTarget} onClose={() => setRenameTarget(undefined)} onSubmit={async (name) => { await applyRename(renameTarget, name); setRenameTarget(undefined); }} />}
  </aside>;
}

function BoxItem({ box, active, onSelect, onContextMenu, onMenu }: { box: BoxRecord; active: boolean; onSelect: () => void; onContextMenu: (event: MouseEvent) => void; onMenu: (event: MouseEvent) => void }) {
  return <div className={`card sidebar-card ${active ? "active" : ""}`} onClick={onSelect} onContextMenu={onContextMenu}>
    <div className="card-main-row">
      <strong>{box.name}</strong>
      <div className="card-meta-actions">
        <StatusIndicator status={box.status} />
        <button className="card-menu-button" title="操作" onClick={onMenu} onContextMenu={onMenu}><MoreVertical size={16} /></button>
      </div>
    </div>
    <div className="small">{box.image}</div>
    {box.error && <div className="small" style={{ color: "var(--red)" }}>{box.error}</div>}
  </div>;
}

function SessionItem({ session, active, onSelect, onContextMenu, onMenu }: { session: AgentSessionRecord; active: boolean; onSelect: () => void; onContextMenu: (event: MouseEvent) => void; onMenu: (event: MouseEvent) => void }) {
  return <div className={`card sidebar-card ${active ? "active" : ""}`} onClick={onSelect} onContextMenu={onContextMenu}>
    <div className="card-main-row">
      <strong>{session.name}</strong>
      <div className="card-meta-actions">
        <StatusIndicator status={session.status} />
        <button className="card-menu-button" title="操作" onClick={onMenu} onContextMenu={onMenu}><MoreVertical size={16} /></button>
      </div>
    </div>
    <div className="small">{session.model || "默认模型"}</div>
    <div className="small">{session.cwd || "/workspace"}</div>
    {session.error && <div className="small" style={{ color: "var(--red)" }}>{session.error}</div>}
  </div>;
}

function StatusIndicator({ status }: { status: string }) {
  if (status === "running" || status === "working" || status === "stopped") return <span className={`status-dot ${status}`} title={status} aria-label={status} />;
  return <span className={`status ${status}`}>{status}</span>;
}

function RenameDialog({ target, onClose, onSubmit }: { target: { kind: "box" | "session"; name: string }; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(target.name);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try { await onSubmit(name); }
    finally { setSaving(false); }
  }

  return createPortal(<div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal rename-modal" onMouseDown={(event) => event.stopPropagation()}>
      <h2>重命名 {target.kind === "box" ? "Box" : "Session"}</h2>
      <form className="form" onSubmit={submit}>
        <label>名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="row space">
          <button type="button" onClick={onClose}>取消</button>
          <button className="primary" disabled={saving || !name.trim()}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </div>
  </div>, document.body);
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: Array<{ label: string; icon: ReactNode; danger?: boolean; onClick: () => void | Promise<void> }>; onClose: () => void }) {
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const width = 190;
    const height = Math.max(48, items.length * 42 + 12);
    setPos({ x: Math.min(x, window.innerWidth - width - 10), y: Math.min(y, window.innerHeight - height - 10) });
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [x, y, items.length, onClose]);

  return <div className="context-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()}>
    {items.map((item) => <button key={item.label} className={item.danger ? "danger" : ""} onClick={async () => { onClose(); await item.onClick(); }}>
      {item.icon}<span>{item.label}</span>
    </button>)}
  </div>;
}
