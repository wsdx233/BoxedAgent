import { useEffect, useMemo, useState } from "react";
import { Download, Folder, File, Trash2, Upload, RefreshCw, FolderPlus, Loader2, Plus } from "lucide-react";
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

  if (!boxId) return <div className="panel small">请选择 Box</div>;

  return <div className="panel">
    <div className="toolbar">
      <button onClick={() => setPath(parent)}>上级</button>
      <button onClick={load}><RefreshCw size={15} /></button>
      <label style={{ display: "inline-flex" }}><button><Upload size={15} /> 上传</button><input type="file" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) { await api.uploadFile(boxId, path, f); await load(); } }} /></label>
      <button onClick={() => { setShowNewDir(true); setNewDirName(""); }}><FolderPlus size={15} /> 新建目录</button>
    </div>
    {showNewDir && <div className="dir-create-row file-create-row">
      <FolderPlus size={15} />
      <input autoFocus value={newDirName} onChange={(e) => setNewDirName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createDirectory(); } if (e.key === "Escape") { setShowNewDir(false); setNewDirName(""); } }} placeholder="新建目录名" />
      <button type="button" className="button-tonal compact" disabled={creatingDir || !newDirName.trim()} onClick={createDirectory}>{creatingDir ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 确认</button>
      <button type="button" className="button-tonal compact" onClick={() => { setShowNewDir(false); setNewDirName(""); }}>取消</button>
    </div>}
    <input value={path} onChange={(e) => setPath(e.target.value || ".")} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} />
    {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}
    {loading && <p className="small">加载中...</p>}
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

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
