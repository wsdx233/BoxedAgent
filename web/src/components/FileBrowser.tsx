import { type DragEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Check, Clipboard, ClipboardPaste, Copy, Download, File, Folder, FolderPlus, Link2, Loader2, MessageSquarePlus, MoreVertical, Pencil, RefreshCw, Scissors, Trash2, Upload, X } from "lucide-react";
import { api } from "../lib/api";
import { fileRefForWorkspacePath, insertIntoComposer, workspaceAbsPath } from "../lib/composer-events";
import type { FileEntry } from "../lib/types";
import { useAppStore } from "../state/app";

type ClipboardState = { mode: "copy" | "cut"; boxId: string; entry: FileEntry };
type FileMenuTarget = { x: number; y: number; entry?: FileEntry };
type FileMenuItem = { label: string; icon?: JSX.Element; onClick?: () => void | Promise<void>; disabled?: boolean; danger?: boolean; separator?: boolean };

export function FileBrowser({ boxId }: { boxId?: string }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showNewDir, setShowNewDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creatingDir, setCreatingDir] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [menu, setMenu] = useState<FileMenuTarget>();
  const [clipboard, setClipboard] = useState<ClipboardState>();
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const parent = useMemo(() => path === "." || path === "" ? "." : path.split("/").slice(0, -1).join("/") || ".", [path]);
  const breadcrumbs = useMemo(() => breadcrumbParts(path), [path]);

  async function load(targetPath = path) {
    if (!boxId) return;
    setLoading(true); setError(undefined);
    try {
      setEntries((await api.listFiles(boxId, targetPath)).entries);
      setSelectedPath(undefined);
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [boxId, path]);
  useEffect(() => { setClipboard(undefined); setSelectedPath(undefined); setMenu(undefined); }, [boxId]);

  async function createDirectory() {
    if (!boxId) return;
    const name = newDirName.trim();
    if (!name) return;
    if (!isSafeName(name)) {
      setError("目录名不能包含 /、\\ 或 ..");
      return;
    }
    const nextPath = joinPath(path, name);
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

  function openEntry(entry: FileEntry) {
    setSelectedPath(entry.path);
    if (entry.type === "directory") setPath(entry.path);
  }

  function openMenu(event: MouseEvent, entry?: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    if (entry) setSelectedPath(entry.path);
    setMenu({ x: event.clientX, y: event.clientY, entry });
  }

  function startRename(entry: FileEntry) {
    setMenu(undefined);
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
  }

  async function commitRename(entry: FileEntry) {
    if (!boxId || renamingPath !== entry.path) return;
    const name = renameValue.trim();
    if (!name || name === entry.name) { cancelRename(); return; }
    if (!isSafeName(name)) { setError("名称不能包含 /、\\ 或 .."); return; }
    const target = joinPath(dirname(entry.path), name);
    setBusy(true);
    setError(undefined);
    try {
      await api.moveFile(boxId, entry.path, target);
      cancelRename();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function cancelRename() {
    setRenamingPath(undefined);
    setRenameValue("");
  }

  async function deleteEntry(entry: FileEntry) {
    if (!boxId || !confirm(`删除 ${workspaceAbsPath(entry.path)}?`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteFile(boxId, entry.path);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pasteInto(targetDir: string) {
    if (!boxId || !clipboard || clipboard.boxId !== boxId) return;
    const normalizedTargetDir = normalizeRelPath(targetDir);
    const sourceDir = dirname(clipboard.entry.path);
    if (clipboard.mode === "cut" && normalizeRelPath(sourceDir) === normalizedTargetDir) {
      setClipboard(undefined);
      setMenu(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const targetEntries = (await api.listFiles(boxId, normalizedTargetDir)).entries;
      const targetName = uniqueName(clipboard.entry.name, new Set(targetEntries.map((entry) => entry.name)), clipboard.entry.type === "directory");
      const target = joinPath(normalizedTargetDir, targetName);
      if (clipboard.mode === "copy") await api.copyFile(boxId, clipboard.entry.path, target);
      else {
        await api.moveFile(boxId, clipboard.entry.path, target);
        setClipboard(undefined);
      }
      setMenu(undefined);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function duplicateEntry(entry: FileEntry) {
    if (!boxId) return;
    const targetDir = dirname(entry.path);
    setBusy(true);
    setError(undefined);
    try {
      const targetEntries = (await api.listFiles(boxId, targetDir)).entries;
      const targetName = uniqueName(entry.name, new Set(targetEntries.map((item) => item.name)), entry.type === "directory");
      await api.copyFile(boxId, entry.path, joinPath(targetDir, targetName));
      setMenu(undefined);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyAbsPath(entry?: FileEntry) {
    const absPath = workspaceAbsPath(entry?.path ?? path);
    await navigator.clipboard?.writeText(absPath).catch(() => undefined);
    setMenu(undefined);
  }

  function attachToChat(entry: FileEntry) {
    if (!activeSessionId) {
      setError("请先选择一个 Chat Session。 ");
      return;
    }
    insertIntoComposer(activeSessionId, ` ${fileRefForWorkspacePath(workspaceAbsPath(entry.path))}`);
    setMenu(undefined);
  }

  function downloadEntry(entry: FileEntry) {
    if (!boxId || entry.type !== "file") return;
    window.open(api.downloadUrl(boxId, entry.path), "_blank", "noopener,noreferrer");
    setMenu(undefined);
  }

  function menuItems(target?: FileEntry): FileMenuItem[] {
    const canPaste = Boolean(clipboard && clipboard.boxId === boxId);
    if (!target) return [
      { label: "上传文件…", icon: <Upload size={14} />, onClick: () => fileInputRef.current?.click() },
      { label: "新建文件夹", icon: <FolderPlus size={14} />, onClick: () => { setShowNewDir(true); setNewDirName(""); } },
      { label: "粘贴到当前目录", icon: <ClipboardPaste size={14} />, disabled: !canPaste, onClick: () => pasteInto(path) },
      { separator: true, label: "" },
      { label: "复制当前路径", icon: <Link2 size={14} />, onClick: () => copyAbsPath() },
      { label: "刷新", icon: <RefreshCw size={14} />, onClick: () => load() }
    ];
    const isDirectory = target.type === "directory";
    return [
      isDirectory
        ? { label: "打开", icon: <Folder size={14} />, onClick: () => setPath(target.path) }
        : { label: "下载", icon: <Download size={14} />, onClick: () => downloadEntry(target) },
      { label: "附加到聊天", icon: <MessageSquarePlus size={14} />, disabled: target.type !== "file" || !activeSessionId, onClick: () => attachToChat(target) },
      { label: "复制路径", icon: <Link2 size={14} />, onClick: () => copyAbsPath(target) },
      { separator: true, label: "" },
      { label: "重命名", icon: <Pencil size={14} />, onClick: () => startRename(target) },
      { label: "复制", icon: <Copy size={14} />, onClick: () => { setClipboard({ mode: "copy", boxId: boxId!, entry: target }); setMenu(undefined); } },
      { label: "剪切", icon: <Scissors size={14} />, onClick: () => { setClipboard({ mode: "cut", boxId: boxId!, entry: target }); setMenu(undefined); } },
      { label: "创建副本", icon: <Clipboard size={14} />, onClick: () => duplicateEntry(target) },
      { label: "粘贴到此文件夹", icon: <ClipboardPaste size={14} />, disabled: !isDirectory || !canPaste, onClick: () => pasteInto(target.path) },
      { separator: true, label: "" },
      { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => deleteEntry(target) }
    ];
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

  return <div className={`panel file-browser-panel vscode-file-browser ${dragActive ? "drag-active" : ""}`} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onContextMenu={(event) => openMenu(event)}>
    {dragActive && <div className="drop-overlay file-drop-overlay"><Upload size={28} /><strong>拖放文件到这里上传</strong><span>目标目录：{workspaceAbsPath(path)}</span></div>}
    <div className="file-explorer-head">
      <div className="file-breadcrumb" title={workspaceAbsPath(path)}>
        {breadcrumbs.map((part, index) => <button type="button" key={part.path} onClick={() => setPath(part.path)}>{index > 0 && <span>/</span>}{part.label}</button>)}
      </div>
      <div className="file-explorer-actions">
        <button type="button" className="file-action-icon" title="上级" disabled={path === "."} onClick={() => setPath(parent)}><ArrowUp size={14} /></button>
        <button type="button" className="file-action-icon" title="刷新" onClick={() => load()}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
        <button type="button" className="file-action-icon" title="上传" disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}</button>
        <button type="button" className="file-action-icon" title="新建文件夹" onClick={() => { setShowNewDir(true); setNewDirName(""); }}><FolderPlus size={14} /></button>
        <button type="button" className="file-action-icon" title="更多" onClick={(event) => openMenu(event)}><MoreVertical size={15} /></button>
      </div>
      <input ref={fileInputRef} type="file" hidden multiple onChange={async (e) => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; await uploadFiles(files); }} />
    </div>

    {clipboard && <div className="file-clipboard-bar"><span>{clipboard.mode === "cut" ? "剪切" : "复制"}：{workspaceAbsPath(clipboard.entry.path)}</span><button type="button" title="取消" onClick={() => setClipboard(undefined)}><X size={13} /></button></div>}

    {showNewDir && <div className="file-tree-row file-create-row-vscode" onClick={(event) => event.stopPropagation()}>
      <FolderPlus size={15} />
      <input autoFocus value={newDirName} onChange={(e) => setNewDirName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createDirectory(); } if (e.key === "Escape") { setShowNewDir(false); setNewDirName(""); } }} placeholder="新建文件夹" />
      <button type="button" title="确认" disabled={creatingDir || !newDirName.trim()} onClick={createDirectory}>{creatingDir ? <Loader2 size={13} className="spin" /> : <Check size={13} />}</button>
      <button type="button" title="取消" onClick={() => { setShowNewDir(false); setNewDirName(""); }}><X size={13} /></button>
    </div>}

    {error && <div className="file-error small">{error}</div>}
    {(loading || busy || uploading) && <div className="file-loading small"><Loader2 size={13} className="spin" /> {uploading ? "上传中…" : busy ? "处理中…" : "加载中…"}</div>}

    <div className="file-tree" onContextMenu={(event) => openMenu(event)}>
      {entries.map((entry) => {
        const selected = selectedPath === entry.path;
        const cut = clipboard?.mode === "cut" && clipboard.entry.path === entry.path && clipboard.boxId === boxId;
        const renaming = renamingPath === entry.path;
        return <div className={`file-tree-row ${selected ? "selected" : ""} ${cut ? "cut" : ""}`} key={entry.path} onClick={() => setSelectedPath(entry.path)} onDoubleClick={() => openEntry(entry)} onContextMenu={(event) => openMenu(event, entry)}>
          <div className="file-tree-name" title={workspaceAbsPath(entry.path)}>
            {entry.type === "directory" ? <Folder size={15} /> : <File size={15} />}
            {renaming ? <input autoFocus value={renameValue} onClick={(event) => event.stopPropagation()} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitRename(entry); } if (event.key === "Escape") cancelRename(); }} onBlur={() => void commitRename(entry)} /> : <span>{entry.name}</span>}
          </div>
          <span className="file-tree-meta">{entry.type === "file" ? formatSize(entry.size) : entry.type === "directory" ? "" : entry.type}</span>
          <button type="button" className="file-tree-menu" title="操作" onClick={(event) => openMenu(event, entry)}><MoreVertical size={15} /></button>
        </div>;
      })}
      {!loading && entries.length === 0 && <div className="file-empty small">当前目录为空</div>}
    </div>

    {menu && createPortal(<FileContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(undefined)} />, document.body)}
  </div>;
}

function FileContextMenu({ x, y, items, onClose }: { x: number; y: number; items: FileMenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, [onClose]);
  const style = clampMenuPosition(x, y, 220, Math.max(44, items.length * 38));
  return <div className="file-context-menu" style={style} onContextMenu={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()}>
    {items.map((item, index) => item.separator ? <div key={index} className="file-menu-separator" /> : <button type="button" key={index} className={item.danger ? "danger" : ""} disabled={item.disabled} onClick={async () => { await item.onClick?.(); onClose(); }}>
      <span>{item.icon}</span><strong>{item.label}</strong>
    </button>)}
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

function breadcrumbParts(path: string) {
  const normalized = normalizeRelPath(path);
  const parts = [{ label: "workspace", path: "." }];
  if (normalized === ".") return parts;
  const segments = normalized.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    parts.push({ label: segment, path: current });
  }
  return parts;
}

function joinPath(dir: string, name: string) {
  const normalizedDir = normalizeRelPath(dir);
  return normalizedDir === "." ? name : `${normalizedDir}/${name}`;
}

function dirname(relPath: string) {
  const normalized = normalizeRelPath(relPath);
  if (normalized === ".") return ".";
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

function normalizeRelPath(value: string) {
  const parts: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/") || ".";
}

function isSafeName(value: string) {
  return Boolean(value.trim()) && !value.includes("/") && !value.includes("\\") && value !== "." && value !== ".." && !value.includes("..");
}

function uniqueName(name: string, existing: Set<string>, isDirectory: boolean) {
  if (!existing.has(name)) return name;
  const { base, ext } = splitName(name, isDirectory);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${base} copy${i > 1 ? ` ${i}` : ""}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} copy ${Date.now()}${ext}`;
}

function splitName(name: string, isDirectory: boolean) {
  if (isDirectory) return { base: name, ext: "" };
  const index = name.lastIndexOf(".");
  if (index <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, index), ext: name.slice(index) };
}

function clampMenuPosition(x: number, y: number, width: number, estimatedHeight: number) {
  const margin = 8;
  return {
    left: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin)),
    top: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - estimatedHeight - margin))
  };
}
