import { FormEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Bot, CheckCircle2, CircleAlert, Folder, FolderOpen, FolderPlus, Loader2, Plus, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import type { BoxRecord, FileEntry, PiModel } from "../lib/types";

export function CreateSessionModal({ box, onClose, onCreated }: { box: BoxRecord; onClose: () => void; onCreated: (sessionId: string) => void }) {
  const [name, setName] = useState(`Session ${new Date().toLocaleString()}`);
  const [cwd, setCwd] = useState("/workspace");
  const [browsePath, setBrowsePath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [showNewDir, setShowNewDir] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);
  const [error, setError] = useState<string>();
  const [models, setModels] = useState<PiModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<{ provider?: string; modelId?: string }>({ provider: box.pi.defaultProvider, modelId: box.pi.defaultModel });
  const [creating, setCreating] = useState(false);
  const displayPath = browsePath === "." ? "/workspace" : `/workspace/${browsePath}`;
  const dirs = useMemo(() => entries.filter((entry) => entry.type === "directory"), [entries]);
  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const list = query ? models.filter((model) => `${modelProvider(model) ?? ""} ${model.id} ${model.name ?? ""}`.toLowerCase().includes(query)) : models;
    return list.slice(0, 120);
  }, [models, modelSearch]);

  useEffect(() => {
    let cancelled = false;
    setLoadingDirs(true);
    api.listFiles(box.id, browsePath).then((res) => {
      if (!cancelled) setEntries(res.entries);
    }).catch(() => {
      if (!cancelled) setEntries([]);
    }).finally(() => {
      if (!cancelled) setLoadingDirs(false);
    });
    return () => { cancelled = true; };
  }, [box.id, browsePath]);

  useEffect(() => {
    void loadModels();
  }, [box.id]);

  function setCwdAndBrowse(nextCwd: string) {
    setCwd(nextCwd);
    setBrowsePath(cwdToBrowsePath(nextCwd));
  }

  function enterDir(entry: FileEntry) {
    const next = entry.path || ".";
    setBrowsePath(next);
    setCwd(browsePathToCwd(next));
  }

  function up() {
    if (browsePath === ".") return;
    const parts = browsePath.split("/").filter(Boolean);
    parts.pop();
    const next = parts.length ? parts.join("/") : ".";
    setBrowsePath(next);
    setCwd(browsePathToCwd(next));
  }

  async function loadModels() {
    setLoadingModels(true);
    try {
      const res = await api.boxModels(box.id);
      setModels(res.models ?? []);
    } catch (err) {
      console.warn("failed to load box models", err);
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }

  async function createDirectory() {
    const name = newDirName.trim();
    if (!name) return;
    if (name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.includes("..")) {
      setError("目录名不能包含 /、\\ 或 ..");
      return;
    }
    const nextPath = browsePath === "." ? name : `${browsePath}/${name}`;
    setCreatingDir(true);
    setError(undefined);
    try {
      await api.mkdir(box.id, nextPath);
      setNewDirName("");
      setShowNewDir(false);
      setBrowsePath(nextPath);
      setCwd(browsePathToCwd(nextPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingDir(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const normalizedCwd = normalizeCwd(cwd);
    setCreating(true);
    setError(undefined);
    try {
      await api.listFiles(box.id, cwdToBrowsePath(normalizedCwd));
      const session = await api.createSession({ boxId: box.id, name: name.trim() || undefined, cwd: normalizedCwd, provider: selectedModel.provider, model: selectedModel.modelId, autostart: true });
      onCreated(session.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return createPortal(<div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal session-modal" onMouseDown={(e) => e.stopPropagation()}>
      <h2>新建 Session</h2>
      <p className="small">为 <strong>{box.name}</strong> 创建一个 pi session。工作目录会作为 agent 进程 cwd，工具调用默认也会从这里开始。</p>
      <form className="form" onSubmit={submit}>
        <label>Session 名称<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>工作目录<input value={cwd} onChange={(e) => setCwdAndBrowse(e.target.value)} onBlur={(e) => setCwdAndBrowse(normalizeCwd(e.target.value))} placeholder="/workspace 或 /workspace/subdir" /></label>
        <div className="dir-picker">
          <div className="dir-picker-head">
            <div className="row"><FolderOpen size={15} /> <strong>{displayPath}</strong></div>
            <div className="row">
              <button type="button" className="icon-button compact-icon" title="上级" disabled={browsePath === "."} onClick={up}><ArrowUp size={13} /></button>
              <button type="button" className="button-tonal compact" onClick={() => { setShowNewDir(true); setNewDirName(""); }}><FolderPlus size={13} /> 新建目录</button>
              <button type="button" className="button-tonal compact" onClick={() => setCwdAndBrowse(displayPath)}>选择此目录</button>
            </div>
          </div>
          {showNewDir && <div className="dir-create-row">
            <FolderPlus size={15} />
            <input autoFocus value={newDirName} onChange={(e) => setNewDirName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createDirectory(); } if (e.key === "Escape") { setShowNewDir(false); setNewDirName(""); } }} placeholder="新建目录名" />
            <button type="button" className="button-tonal compact" disabled={creatingDir || !newDirName.trim()} onClick={createDirectory}>{creatingDir ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 确认</button>
            <button type="button" className="button-tonal compact" onClick={() => { setShowNewDir(false); setNewDirName(""); }}>取消</button>
          </div>}
          <div className="dir-list">
            {loadingDirs && <div className="empty-menu">正在读取目录…</div>}
            {!loadingDirs && dirs.length === 0 && <div className="empty-menu">当前目录没有子目录</div>}
            {!loadingDirs && dirs.map((entry) => <button type="button" key={entry.path} className="dir-row" onClick={() => enterDir(entry)}>
              <Folder size={14} /> <span>{entry.name}</span>
            </button>)}
          </div>
        </div>
        <div className="session-model-picker">
          <div className="dir-picker-head">
            <div className="row"><Bot size={15} /> <strong>模型</strong><span className="small">{selectedModel.provider && selectedModel.modelId ? `${selectedModel.provider}/${selectedModel.modelId}` : "使用 Box 默认"}</span></div>
            <button type="button" className="icon-button compact-icon" title="刷新模型" onClick={loadModels} disabled={loadingModels}>{loadingModels ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}</button>
          </div>
          <input className="menu-search" value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="搜索 provider / model…" />
          <div className="model-list session-model-list">
            <button type="button" className={`model-option ${!selectedModel.modelId ? "selected" : ""}`} onClick={() => setSelectedModel({})}>
              <span className="model-option-main"><span>使用 Box 默认模型</span>{!selectedModel.modelId && <CheckCircle2 size={14} />}</span>
              <span className="model-option-sub">{box.pi.defaultProvider || "default"} · {box.pi.defaultModel || "default"}</span>
            </button>
            {loadingModels && <div className="menu-loading"><Loader2 size={14} className="spin" /> 正在加载模型…</div>}
            {!loadingModels && visibleModels.map((model) => {
              const provider = modelProvider(model);
              const selected = provider === selectedModel.provider && model.id === selectedModel.modelId;
              return <button type="button" key={`${provider ?? "unknown"}/${model.id}`} className={`model-option ${selected ? "selected" : ""}`} onClick={() => setSelectedModel({ provider, modelId: model.id })}>
                <span className="model-option-main"><span>{model.name || model.id}</span>{model.reasoning && <span className="mini-badge">reasoning</span>}{selected && <CheckCircle2 size={14} />}</span>
                <span className="model-option-sub">{provider ?? "unknown"} · {model.id}{model.contextWindow ? ` · ${formatTokens(model.contextWindow)} ctx` : ""}</span>
              </button>;
            })}
            {!loadingModels && models.length === 0 && <div className="empty-menu">未加载到模型；仍可使用 Box 默认模型。</div>}
          </div>
        </div>
        {error && <div className="notice error"><CircleAlert size={15} /> <span>{error}</span></div>}
        <div className="row space">
          <button type="button" onClick={onClose}>取消</button>
          <button className="primary" disabled={creating}><Plus size={15} /> {creating ? "创建中…" : "创建 Session"}</button>
        </div>
      </form>
    </div>
  </div>, document.body);
}

function normalizeCwd(value: string) {
  const trimmed = value.trim() || "/workspace";
  if (trimmed === "/workspace" || trimmed.startsWith("/workspace/")) return trimmed.replace(/\/+$/, "") || "/workspace";
  const rel = trimmed.replace(/^\/+/, "");
  if (!rel || rel === "." || rel.includes("..")) return "/workspace";
  return `/workspace/${rel}`.replace(/\/+$/, "");
}

function cwdToBrowsePath(value: string) {
  const normalized = normalizeCwd(value);
  if (normalized === "/workspace") return ".";
  return normalized.slice("/workspace/".length) || ".";
}

function browsePathToCwd(value: string) {
  if (!value || value === ".") return "/workspace";
  return `/workspace/${value}`.replace(/\/+$/, "");
}

function modelProvider(model: PiModel | null | undefined): string | undefined {
  const provider = model?.provider ?? model?.providerId ?? model?.providerName;
  return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
