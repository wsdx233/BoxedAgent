import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Boxes, Copy, Edit3, GitBranch, GitFork, MoreVertical, Play, Plus, RefreshCw, Square, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useAppStore } from "../state/app";
import type { AgentSessionRecord, BoxRecord, SessionTreeNode } from "../lib/types";
import { CreateSessionModal } from "./CreateSessionModal";

type ContextTarget = { kind: "box"; id: string; x: number; y: number } | { kind: "session"; id: string; x: number; y: number };

export function Sidebar({ onNewBox, onSessionSelected }: { onNewBox: () => void; onSessionSelected?: () => void }) {
  const { boxes, sessions, activeBoxId, activeSessionId, setActiveBox, setActiveSession, setBoxes, setSessions, setComposerDraft, clearMessages } = useAppStore();
  const [showCreateSession, setShowCreateSession] = useState(false);
  const [menu, setMenu] = useState<ContextTarget>();
  const [renameTarget, setRenameTarget] = useState<{ kind: "box" | "session"; id: string; name: string }>();
  const [forkTarget, setForkTarget] = useState<AgentSessionRecord>();
  const [treeTarget, setTreeTarget] = useState<AgentSessionRecord>();
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
    setMenu({ kind: "box", id: box.id, x: event.clientX, y: event.clientY });
  }

  function openSessionMenu(event: MouseEvent, session: AgentSessionRecord) {
    event.preventDefault();
    event.stopPropagation();
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
    { label: "复刻配置", icon: <Copy size={14} />, onClick: async () => { const name = prompt("复刻名称", duplicateBoxName(menuBox.name))?.trim(); if (name) { const box = await api.duplicateBox(menuBox.id, { name }); await refresh(); setActiveBox(box.id); } } },
    { label: "克隆", icon: <Copy size={14} />, onClick: async () => { const name = prompt("克隆名称", cloneBoxName(menuBox.name))?.trim(); if (name) { await api.cloneBox(menuBox.id, { name }); await refresh(); } } },
    { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: async () => { if (confirm(`删除 Box ${menuBox.name}?`)) { await api.deleteBox(menuBox.id); await refresh(); } } }
  ] : [];

  const sessionMenuItems = menuSession ? [
    { label: "重命名", icon: <Edit3 size={14} />, onClick: () => setRenameTarget({ kind: "session", id: menuSession.id, name: menuSession.name }) },
    { label: "Tree", icon: <GitBranch size={14} />, onClick: () => setTreeTarget(menuSession) },
    { label: "Fork", icon: <GitFork size={14} />, onClick: () => setForkTarget(menuSession) },
    { label: "Clone", icon: <Copy size={14} />, onClick: async () => { const res = await api.cloneSession(menuSession.id, { name: cloneSessionName(menuSession.name) }); if (!res.cancelled) { await refresh(); setActiveSession(res.session.id); onSessionSelected?.(); } } },
    { label: "复刻空配置", icon: <Copy size={14} />, onClick: async () => { const res = await api.duplicateSession(menuSession.id, { name: duplicateSessionName(menuSession.name) }); await refresh(); setActiveSession(res.session.id); onSessionSelected?.(); } },
    menuSession.status === "running" || menuSession.status === "working"
      ? { label: "停止", icon: <Square size={14} />, onClick: async () => { await api.stopSession(menuSession.id); await refresh(); } }
      : { label: "启动", icon: <Play size={14} />, onClick: async () => { await api.startSession(menuSession.id); await refresh(); } },
    { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: async () => { if (confirm(`删除 Session ${menuSession.name}?\n\n只会删除 BoxedAgent 中的这个 Session 记录，不会删除其它 Session 的对话文件。`)) { const deletingId = menuSession.id; await api.deleteSession(deletingId); clearMessages(deletingId); await refresh(); } } }
  ] : [];

  return <aside className="sidebar">
    <div className="header"><div className="logo"><Boxes size={18} /> BoxedAgent</div><button className="primary" onClick={onNewBox}><Plus size={15} /></button></div>
    <div className="sidebar-sections">
      <section className="sidebar-section boxes-section">
        <div className="sidebar-section-head"><strong>Boxes</strong><button className="icon-button compact-icon" title="刷新" onClick={refresh}><RefreshCw size={15} /></button></div>
        <div className="sidebar-scroll">
          {boxes.map((box) => <BoxItem key={box.id} box={box} active={box.id === activeBoxId} onSelect={() => setActiveBox(box.id)} onContextMenu={(event) => openBoxMenu(event, box)} onMenu={(event) => openBoxMenu(event, box)} />)}
        </div>
      </section>
      <section className="sidebar-section sessions-section">
        <div className="sidebar-section-head"><strong>Sessions</strong><button className="icon-button compact-icon" title="新建 Session" disabled={!activeBoxId} onClick={() => setShowCreateSession(true)}><Plus size={15} /></button></div>
        <div className="sidebar-scroll">
          {boxSessions.map((session) => <SessionItem key={session.id} session={session} active={session.id === activeSessionId} onSelect={() => { setActiveSession(session.id); onSessionSelected?.(); }} onContextMenu={(event) => openSessionMenu(event, session)} onMenu={(event) => openSessionMenu(event, session)} />)}
        </div>
      </section>
    </div>
    {showCreateSession && activeBox && <CreateSessionModal box={activeBox} onClose={() => setShowCreateSession(false)} onCreated={async (id) => { await refresh(); setActiveSession(id); onSessionSelected?.(); }} />}
    {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} items={menu.kind === "box" ? boxMenuItems : sessionMenuItems} />, document.body)}
    {renameTarget && <RenameDialog target={renameTarget} onClose={() => setRenameTarget(undefined)} onSubmit={async (name) => { await applyRename(renameTarget, name); setRenameTarget(undefined); }} />}
    {forkTarget && <ForkDialog session={forkTarget} onClose={() => setForkTarget(undefined)} onForked={async (forked, draft) => { await refresh(); if (draft) setComposerDraft(forked.id, draft); setActiveSession(forked.id); onSessionSelected?.(); setForkTarget(undefined); }} />}
    {treeTarget && <TreeDialog session={treeTarget} onClose={() => setTreeTarget(undefined)} onNavigated={async (draft) => { await refresh(); if (draft !== undefined) setComposerDraft(treeTarget.id, draft); setActiveSession(undefined); window.setTimeout(() => { setActiveSession(treeTarget.id); onSessionSelected?.(); }, 0); setTreeTarget(undefined); }} />}
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
    <div className="small session-meta-line"><span>{session.model || "默认模型"}</span><span>·</span><span>{session.cwd || "/workspace"}</span></div>
    {session.error && <div className="small" style={{ color: "var(--red)" }}>{session.error}</div>}
  </div>;
}

function StatusIndicator({ status }: { status: string }) {
  if (status === "running" || status === "working" || status === "stopped") return <span className={`status-dot ${status}`} title={status} aria-label={status} />;
  return <span className={`status ${status}`}>{status}</span>;
}

function duplicateBoxName(name: string): string {
  return operationName(name, (baseName) => {
    const suffix = "-copy";
    const base = baseName || "box";
    return `${base.slice(0, 80 - suffix.length)}${suffix}`;
  });
}

function cloneBoxName(name: string): string {
  return operationName(name, (baseName) => `${baseName || "box"}-clone`);
}

function duplicateSessionName(name: string): string {
  return operationName(name, (baseName) => `${baseName} 复刻`);
}

function cloneSessionName(name: string): string {
  return operationName(name, (baseName) => `${baseName} clone`);
}

function forkSessionName(name: string): string {
  return operationName(name, (baseName) => `${baseName} fork`);
}

function operationName(name: string, fallback: (baseName: string) => string): string {
  const base = name.trim();
  return incrementTrailingNumber(base) ?? fallback(base);
}

function incrementTrailingNumber(name: string): string | undefined {
  const match = /^(.*?)(\d+)$/.exec(name);
  if (!match) return undefined;
  const [, prefix, digits] = match;
  const next = (BigInt(digits) + 1n).toString();
  return `${prefix}${next.padStart(digits.length, "0")}`;
}

function previewText(value: string, max = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function TreeDialog({ session, onClose, onNavigated }: { session: AgentSessionRecord; onClose: () => void; onNavigated: (draft?: string) => Promise<void> }) {
  const [nodes, setNodes] = useState<SessionTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [navigatingId, setNavigatingId] = useState<string>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    api.sessionTree(session.id).then((res) => {
      if (!cancelled) setNodes(res.tree.nodes ?? []);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [session.id]);

  const filtered = query.trim()
    ? nodes.filter((node) => `${node.text} ${node.label ?? ""} ${node.type} ${node.role ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    : nodes;

  async function navigate(node: SessionTreeNode) {
    setNavigatingId(node.id);
    setError(undefined);
    try {
      const res = await api.navigateSessionTree(session.id, { targetId: node.id });
      await onNavigated(res.editorText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNavigatingId(undefined);
    }
  }

  return createPortal(<div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal fork-modal tree-modal" onMouseDown={(event) => event.stopPropagation()}>
      <h2>Session Tree</h2>
      <p className="small">按 pi /tree 方式切换当前 Session 的活动分支。选择用户消息会把原消息放回输入框，其他节点会直接从该处继续。</p>
      <input className="menu-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 tree 节点…" />
      {loading && <div className="menu-loading"><RefreshCw size={14} className="spin" /> 正在读取 Session tree…</div>}
      {error && <div className="notice error">{error}</div>}
      {!loading && nodes.length === 0 && <div className="empty-menu">当前 Session 还没有可导航的历史。</div>}
      <div className="tree-message-list">
        {filtered.map((node) => <button type="button" key={node.id} className={`tree-message-item ${node.active ? "active" : ""} ${node.inActivePath ? "in-path" : ""}`} disabled={Boolean(navigatingId)} onClick={() => navigate(node)}>
          <span className="tree-indent" style={{ width: Math.min(160, node.depth * 18) }} />
          <span className={`tree-node-role ${node.role ?? node.type}`}>{treeNodeRoleLabel(node)}</span>
          <span className="tree-node-text">{node.label && <em>[{node.label}] </em>}{previewText(node.text, 180)}</span>
          {node.active && <span className="mini-badge">active</span>}
          {navigatingId === node.id && <RefreshCw size={13} className="spin" />}
        </button>)}
      </div>
      <div className="row space"><span className="small">{filtered.length} / {nodes.length} nodes · {session.name}</span><button type="button" onClick={onClose}>关闭</button></div>
    </div>
  </div>, document.body);
}

function treeNodeRoleLabel(node: SessionTreeNode): string {
  if (node.role === "user") return "USER";
  if (node.role === "assistant") return "AI";
  if (node.role === "toolResult") return "TOOL";
  if (node.type === "compaction") return "CMP";
  if (node.type === "branch_summary") return "SUM";
  if (node.type === "model_change") return "MODEL";
  if (node.type === "thinking_level_change") return "THINK";
  return node.type.slice(0, 6).toUpperCase();
}

function ForkDialog({ session, onClose, onForked }: { session: AgentSessionRecord; onClose: () => void; onForked: (session: AgentSessionRecord, draft?: string) => Promise<void> }) {
  const [messages, setMessages] = useState<Array<{ entryId: string; text: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [forkingId, setForkingId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    api.forkMessages(session.id).then((res) => {
      if (!cancelled) setMessages(res.messages ?? []);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [session.id]);

  async function fork(entryId: string) {
    setForkingId(entryId);
    setError(undefined);
    try {
      const res = await api.forkSession(session.id, { entryId, name: forkSessionName(session.name) });
      if (!res.cancelled) await onForked(res.session, res.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setForkingId(undefined);
    }
  }

  return createPortal(<div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal fork-modal" onMouseDown={(event) => event.stopPropagation()}>
      <h2>Fork Session</h2>
      <p className="small">选择一个用户消息，按 pi TUI 的 /fork 方式从该消息之前分叉，并把该消息内容放入新 Session 输入框。</p>
      {loading && <div className="menu-loading"><RefreshCw size={14} className="spin" /> 正在读取可 fork 的消息…</div>}
      {error && <div className="notice error">{error}</div>}
      {!loading && messages.length === 0 && <div className="empty-menu">当前 Session 还没有可 fork 的用户消息。</div>}
      <div className="fork-message-list">
        {messages.map((message, index) => <button type="button" key={message.entryId} className="fork-message-item" disabled={Boolean(forkingId)} onClick={() => fork(message.entryId)}>
          <span className="fork-message-index">#{index + 1}</span>
          <span>{previewText(message.text, 180)}</span>
          {forkingId === message.entryId && <RefreshCw size={13} className="spin" />}
        </button>)}
      </div>
      <div className="row space"><span className="small">源 Session：{session.name}</span><button type="button" onClick={onClose}>关闭</button></div>
    </div>
  </div>, document.body);
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
