import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Download, Folder, File, Trash2, Upload, RefreshCw, FolderPlus, Loader2, Plus } from "lucide-react";
import { api } from "../lib/api";
import type { FileEntry } from "../lib/types";

export function FileBrowser({ boxId }: { boxId?: string }) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [showNewDir, setShowNewDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creatingDir, setCreatingDir] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const parent = useMemo(() => path === "." || path === "" ? "." : path.split("/").slice(0, -1).join("/") || ".", [path]);

  async function load() {
    if (!boxId) return;
    setLoading(true); setError(undefined);
    try { setEntries((await api.listFiles(boxId, path)).entries); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [boxId, path]);

  async function createDirectory() {
    if (!boxId) return;
    const name = newDirName.trim();
    if (!name) return;
    if (name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.includes("..")) {
      setError("目录名不能包含 /、\\ 或 ..");
      return;
    }
    const nextPath = path === "." ? name : `${path}/${name}`;
    setCreatingDir(true);
    setError(undefined);
    try {
      await api.mkdir(boxId, nextPath);
      setNewDirName("");
      setShowNewDir(false);
      setPath(nextPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingDir(false);
    }
  }

  async function uploadFiles(input: Iterable<File> | FileList | null | undefined) {
    if (!boxId) return;
    const files = [...(input ?? [])].filter((file) => file.size >= 0);
    if (!files.length) return;
    setUploading(true);
    setError(undefined);
    try {
      for (const file of files) await api.uploadFile(boxId, path, file);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
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
    void uploadFiles(event.dataTransfer.files);
  }

  if (!boxId) return <div className="panel small">请选择 Box</div>;

  return <div className={`panel file-browser-panel ${dragActive ? "drag-active" : ""}`} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
    {dragActive && <div className="drop-overlay file-drop-overlay"><Upload size={28} /><strong>拖放文件到这里上传</strong><span>目标目录：{path === "." ? "/workspace" : `/workspace/${path}`}</span></div>}
    <div className="toolbar">
      <button type="button" className="icon-button compact-icon" title="上级" onClick={() => setPath(parent)}><ArrowUp size={15} /></button>
      <button type="button" className="icon-button compact-icon" title="刷新" onClick={load}><RefreshCw size={15} /></button>
      <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}><Upload size={15} /> {uploading ? "上传中…" : "上传"}</button>
      <input ref={fileInputRef} type="file" hidden multiple onChange={async (e) => { const files = e.currentTarget.files; e.currentTarget.value = ""; await uploadFiles(files); }} />
      <button type="button" onClick={() => { setShowNewDir(true); setNewDirName(""); }}><FolderPlus size={15} /> 新建目录</button>
    </div>
    {showNewDir && <div className="dir-create-row file-create-row">
      <FolderPlus size={15} />
      <input autoFocus value={newDirName} onChange={(e) => setNewDirName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createDirectory(); } if (e.key === "Escape") { setShowNewDir(false); setNewDirName(""); } }} placeholder="新建目录名" />
      <button type="button" className="button-tonal compact" disabled={creatingDir || !newDirName.trim()} onClick={createDirectory}>{creatingDir ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 确认</button>
      <button type="button" className="button-tonal compact" onClick={() => { setShowNewDir(false); setNewDirName(""); }}>取消</button>
    </div>}
    <input value={path} onChange={(e) => setPath(e.target.value || ".")} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} />
    {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}
    {(loading || uploading) && <p className="small">{uploading ? "上传中..." : "加载中..."}</p>}
    {entries.map((entry) => <div className="file-row" key={entry.path}>
      <button style={{ textAlign: "left", background: "transparent", border: 0 }} onClick={() => entry.type === "directory" && setPath(entry.path)}>
        {entry.type === "directory" ? <Folder size={15} /> : <File size={15} />} {entry.name}
      </button>
      <span className="small">{entry.type === "file" ? formatSize(entry.size) : entry.type}</span>
      <span className="row">
        {entry.type === "file" && <a href={api.downloadUrl(boxId, entry.path)} title="下载"><Download size={15} /></a>}
        <button title="删除" onClick={async () => { if (confirm(`删除 ${entry.path}?`)) { await api.deleteFile(boxId, entry.path); await load(); } }}><Trash2 size={14} /></button>
      </span>
    </div>)}
  </div>;
}

function hasDraggedFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
