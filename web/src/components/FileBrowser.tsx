import { type DragEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Bookmark, BookmarkPlus, Check, Clipboard, ClipboardPaste, Copy, Download, File, FileText, Film, Folder, FolderPlus, Image as ImageIcon, Link2, Loader2, MessageSquarePlus, MoreVertical, Pencil, RefreshCw, Scissors, Trash2, Upload, X } from "lucide-react";
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
  const [previewEntry, setPreviewEntry] = useState<FileEntry>();
  const [clipboard, setClipboard] = useState<ClipboardState>();
  const [bookmarks, setBookmarks] = useState<string[]>(() => boxId ? loadBookmarks(boxId) : []);
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const parent = useMemo(() => path === "." || path === "" ? "." : path.split("/").slice(0, -1).join("/") || ".", [path]);
  const breadcrumbs = useMemo(() => breadcrumbParts(path), [path]);
  const normalizedPath = normalizeRelPath(path);
  const currentBookmarked = bookmarks.includes(normalizedPath);

  async function load(targetPath = path) {
    if (!boxId) return;
    const normalizedTarget = normalizeRelPath(targetPath);
    setLoading(true); setError(undefined);
    try {
      setEntries((await api.listFiles(boxId, normalizedTarget)).entries);
      setSelectedPath(undefined);
    }
    catch (e) {
      setEntries([]);
      setSelectedPath(undefined);
      setError(friendlyFileError(e, normalizedTarget));
    }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [boxId, path]);
  useEffect(() => {
    setPath(".");
    setEntries([]);
    setError(undefined);
    setClipboard(undefined);
    setSelectedPath(undefined);
    setMenu(undefined);
    setPreviewEntry(undefined);
    setBookmarks(boxId ? loadBookmarks(boxId) : []);
  }, [boxId]);

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
    else if (previewKindForEntry(entry)) setPreviewEntry(entry);
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

  function saveBookmarkList(next: string[]) {
    if (!boxId) return;
    const cleaned = Array.from(new Set(next.map(normalizeRelPath))).sort((a, b) => a.localeCompare(b));
    setBookmarks(cleaned);
    saveBookmarks(boxId, cleaned);
  }

  function addBookmark(targetPath = path) {
    const normalized = normalizeRelPath(targetPath);
    if (!bookmarks.includes(normalized)) saveBookmarkList([...bookmarks, normalized]);
    setMenu(undefined);
  }

  function removeBookmark(targetPath = path) {
    const normalized = normalizeRelPath(targetPath);
    saveBookmarkList(bookmarks.filter((item) => item !== normalized));
    setMenu(undefined);
  }

  function toggleBookmark(targetPath = path) {
    const normalized = normalizeRelPath(targetPath);
    if (bookmarks.includes(normalized)) removeBookmark(normalized);
    else addBookmark(normalized);
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

  function previewFile(entry: FileEntry) {
    if (!boxId || entry.type !== "file") return;
    if (!previewKindForEntry(entry)) {
      downloadEntry(entry);
      return;
    }
    setPreviewEntry(entry);
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
      { label: currentBookmarked ? "移除当前目录书签" : "收藏当前目录", icon: currentBookmarked ? <Bookmark size={14} /> : <BookmarkPlus size={14} />, onClick: () => toggleBookmark(path) },
      { label: "复制当前路径", icon: <Link2 size={14} />, onClick: () => copyAbsPath() },
      { label: "返回 /workspace", icon: <Folder size={14} />, disabled: normalizedPath === ".", onClick: () => setPath(".") },
      { label: "刷新", icon: <RefreshCw size={14} />, onClick: () => load() }
    ];
    const isDirectory = target.type === "directory";
    const previewKind = previewKindForEntry(target);
    const primaryItems: FileMenuItem[] = isDirectory
      ? [{ label: "打开", icon: <Folder size={14} />, onClick: () => setPath(target.path) }]
      : [
        ...(previewKind ? [{ label: "预览", icon: previewIcon(previewKind, 14), onClick: () => previewFile(target) }] : []),
        { label: "下载", icon: <Download size={14} />, onClick: () => downloadEntry(target) }
      ];
    return [
      ...primaryItems,
      { label: "附加到聊天", icon: <MessageSquarePlus size={14} />, disabled: target.type !== "file" || !activeSessionId, onClick: () => attachToChat(target) },
      { label: "复制路径", icon: <Link2 size={14} />, onClick: () => copyAbsPath(target) },
      ...(isDirectory ? [{ label: bookmarks.includes(normalizeRelPath(target.path)) ? "移除目录书签" : "收藏目录", icon: bookmarks.includes(normalizeRelPath(target.path)) ? <Bookmark size={14} /> : <BookmarkPlus size={14} />, onClick: () => toggleBookmark(target.path) }] : []),
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
        <button type="button" className={`file-action-icon ${currentBookmarked ? "active" : ""}`} title={currentBookmarked ? "移除当前目录书签" : "收藏当前目录"} onClick={() => toggleBookmark(path)}>{currentBookmarked ? <Bookmark size={14} /> : <BookmarkPlus size={14} />}</button>
        <button type="button" className="file-action-icon" title="刷新" onClick={() => load()}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
        <button type="button" className="file-action-icon" title="上传" disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}</button>
        <button type="button" className="file-action-icon" title="新建文件夹" onClick={() => { setShowNewDir(true); setNewDirName(""); }}><FolderPlus size={14} /></button>
        <button type="button" className="file-action-icon" title="更多" onClick={(event) => openMenu(event)}><MoreVertical size={15} /></button>
      </div>
      <input ref={fileInputRef} type="file" hidden multiple onChange={async (e) => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; await uploadFiles(files); }} />
    </div>

    {bookmarks.length > 0 && <div className="file-bookmarks">
      <span>书签</span>
      {bookmarks.map((bookmark) => <button type="button" key={bookmark} className={normalizeRelPath(bookmark) === normalizedPath ? "active" : ""} title={workspaceAbsPath(bookmark)} onClick={() => setPath(bookmark)}>
        <Bookmark size={12} /><span>{bookmarkLabel(bookmark)}</span>
      </button>)}
    </div>}

    {clipboard && <div className="file-clipboard-bar"><span>{clipboard.mode === "cut" ? "剪切" : "复制"}：{workspaceAbsPath(clipboard.entry.path)}</span><button type="button" title="取消" onClick={() => setClipboard(undefined)}><X size={13} /></button></div>}

    {showNewDir && <div className="file-tree-row file-create-row-vscode" onClick={(event) => event.stopPropagation()}>
      <FolderPlus size={15} />
      <input autoFocus value={newDirName} onChange={(e) => setNewDirName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createDirectory(); } if (e.key === "Escape") { setShowNewDir(false); setNewDirName(""); } }} placeholder="新建文件夹" />
      <button type="button" title="确认" disabled={creatingDir || !newDirName.trim()} onClick={createDirectory}>{creatingDir ? <Loader2 size={13} className="spin" /> : <Check size={13} />}</button>
      <button type="button" title="取消" onClick={() => { setShowNewDir(false); setNewDirName(""); }}><X size={13} /></button>
    </div>}

    {error && <div className="file-error small"><span>{error}</span><button type="button" onClick={() => setPath(".")}>返回 /workspace</button></div>}
    {(loading || busy || uploading) && <div className="file-loading small"><Loader2 size={13} className="spin" /> {uploading ? "上传中…" : busy ? "处理中…" : "加载中…"}</div>}

    <div className="file-tree" onContextMenu={(event) => openMenu(event)}>
      {entries.map((entry) => {
        const selected = selectedPath === entry.path;
        const cut = clipboard?.mode === "cut" && clipboard.entry.path === entry.path && clipboard.boxId === boxId;
        const renaming = renamingPath === entry.path;
        const previewKind = previewKindForEntry(entry);
        return <div className={`file-tree-row ${selected ? "selected" : ""} ${cut ? "cut" : ""}`} key={entry.path} onClick={() => setSelectedPath(entry.path)} onDoubleClick={() => openEntry(entry)} onContextMenu={(event) => openMenu(event, entry)}>
          <div className="file-tree-name" title={workspaceAbsPath(entry.path)}>
            {entry.type === "directory" ? <Folder size={15} /> : fileIconForEntry(entry, 15)}
            {renaming ? <input autoFocus value={renameValue} onClick={(event) => event.stopPropagation()} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitRename(entry); } if (event.key === "Escape") cancelRename(); }} onBlur={() => void commitRename(entry)} /> : <span>{entry.name}</span>}
          </div>
          <span className="file-tree-meta">{entry.type === "file" ? formatSize(entry.size) : entry.type === "directory" ? "" : entry.type}</span>
          <div className="file-tree-inline-actions">
            {previewKind && <button type="button" className="file-tree-preview" title="预览" onClick={(event) => { event.stopPropagation(); previewFile(entry); }}>{previewIcon(previewKind, 15)}</button>}
            <button type="button" className="file-tree-menu" title="操作" onClick={(event) => openMenu(event, entry)}><MoreVertical size={15} /></button>
          </div>
        </div>;
      })}
      {!loading && entries.length === 0 && <div className="file-empty small">当前目录为空</div>}
    </div>

    {menu && createPortal(<FileContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(undefined)} />, document.body)}
    {previewEntry && <FilePreviewModal boxId={boxId} entry={previewEntry} onClose={() => setPreviewEntry(undefined)} onDownload={() => downloadEntry(previewEntry)} />}
  </div>;
}

type FilePreviewKind = "image" | "video" | "text";
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

function FilePreviewModal({ boxId, entry, onClose, onDownload }: { boxId: string; entry: FileEntry; onClose: () => void; onDownload: () => void }) {
  const kind = previewKindForEntry(entry);
  const url = api.downloadUrl(boxId, entry.path, { inline: true });
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [wrap, setWrap] = useState(false);
  const [forceLoad, setForceLoad] = useState(false);
  const tooLargeForText = kind === "text" && entry.size > TEXT_PREVIEW_LIMIT && !forceLoad;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (kind !== "text" || tooLargeForText) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setText("");
    fetch(url, { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`);
        return res.text();
      })
      .then(setText)
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kind, tooLargeForText, url]);

  if (!kind) return null;
  const label = kind === "image" ? "图片" : kind === "video" ? "视频" : "文本 / 代码";
  const lineCount = kind === "text" && text ? text.split("\n").length : 0;

  return createPortal(<div className="modal-backdrop file-preview-backdrop" onMouseDown={onClose}>
    <div className={`modal file-preview-modal ${kind}`} role="dialog" aria-modal="true" aria-label={`${entry.name} 预览`} onMouseDown={(event) => event.stopPropagation()}>
      <div className="file-preview-head">
        <div className="file-preview-title">
          {previewIcon(kind, 20)}
          <div>
            <strong title={entry.name}>{entry.name}</strong>
            <small title={workspaceAbsPath(entry.path)}>{workspaceAbsPath(entry.path)} · {formatSize(entry.size)} · {label}{lineCount ? ` · ${lineCount} 行` : ""}</small>
          </div>
        </div>
        <div className="file-preview-actions">
          {kind === "text" && <button type="button" title={wrap ? "关闭自动换行" : "自动换行"} onClick={() => setWrap((value) => !value)}>{wrap ? "不换行" : "换行"}</button>}
          <button type="button" title="下载" onClick={onDownload}><Download size={15} /><span>下载</span></button>
          <button type="button" className="icon-only" title="关闭" onClick={onClose}><X size={17} /></button>
        </div>
      </div>
      <div className="file-preview-body">
        {kind === "image" && <div className="file-media-preview image-preview">
          {error ? <PreviewEmpty icon={<ImageIcon size={30} />} title="图片加载失败" detail={error} /> : <img src={url} alt={entry.name} onError={() => setError("浏览器无法显示该图片格式或文件已不可用。")} />}
        </div>}
        {kind === "video" && <div className="file-media-preview video-preview">
          {error ? <PreviewEmpty icon={<Film size={30} />} title="视频加载失败" detail={error} /> : <video src={url} controls playsInline preload="metadata" onError={() => setError("浏览器无法播放该视频格式。可以下载后用本地播放器打开。")} />}
        </div>}
        {kind === "text" && <div className="file-text-preview-shell">
          {tooLargeForText ? <PreviewEmpty icon={<FileText size={30} />} title="文件较大，未自动加载" detail={`${formatSize(entry.size)} 可能会影响浏览器性能。`} action={<button type="button" onClick={() => setForceLoad(true)}>仍然预览</button>} />
            : loading ? <PreviewEmpty icon={<Loader2 size={30} className="spin" />} title="正在加载文本…" />
              : error ? <PreviewEmpty icon={<FileText size={30} />} title="文本加载失败" detail={error} />
                : <pre className={`file-code-preview ${wrap ? "wrap" : ""}`}><code>{text || " "}</code></pre>}
        </div>}
      </div>
    </div>
  </div>, document.body);
}

function PreviewEmpty({ icon, title, detail, action }: { icon: JSX.Element; title: string; detail?: string; action?: JSX.Element }) {
  return <div className="file-preview-empty">
    {icon}
    <strong>{title}</strong>
    {detail && <span>{detail}</span>}
    {action}
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

function previewKindForEntry(entry: FileEntry): FilePreviewKind | undefined {
  if (entry.type !== "file") return undefined;
  const name = entry.name.toLowerCase();
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(name) || name.startsWith(".env")) return "text";
  return undefined;
}

function previewIcon(kind: FilePreviewKind, size: number): JSX.Element {
  if (kind === "image") return <ImageIcon size={size} />;
  if (kind === "video") return <Film size={size} />;
  return <FileText size={size} />;
}

function fileIconForEntry(entry: FileEntry, size: number): JSX.Element {
  const kind = previewKindForEntry(entry);
  return kind ? previewIcon(kind, size) : <File size={size} />;
}

function extensionOf(name: string) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

const IMAGE_EXTENSIONS = new Set(["apng", "avif", "bmp", "gif", "ico", "jfif", "jpg", "jpeg", "png", "svg", "tif", "tiff", "webp"]);
const VIDEO_EXTENSIONS = new Set(["3gp", "m4v", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"]);
const TEXT_EXTENSIONS = new Set([
  "astro", "bash", "bat", "c", "cc", "cfg", "clj", "cljs", "cmake", "cmd", "conf", "cpp", "cs", "css", "csv", "cts", "cxx", "dart", "diff", "dockerfile", "dts", "env", "fish", "go", "graphql", "gql", "h", "hpp", "hs", "htm", "html", "ini", "java", "jl", "js", "json", "jsonc", "jsx", "kt", "kts", "less", "lock", "log", "lua", "m", "make", "md", "mdx", "mjs", "ml", "mts", "patch", "php", "pl", "properties", "ps1", "py", "r", "rb", "rs", "sass", "scala", "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh"
]);
const TEXT_FILENAMES = new Set(["dockerfile", "makefile", "readme", "license", "licence", "changelog", "authors", "contributors", "copying", ".gitignore", ".dockerignore", ".npmrc", ".nvmrc", ".editorconfig", ".prettierrc", ".eslintrc", "requirements.txt", "pipfile", "gemfile", "rakefile", "go.mod", "go.sum", "cargo.toml", "cargo.lock", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function bookmarkKey(boxId: string) {
  return `boxedagent.fileBookmarks.${boxId}`;
}

function loadBookmarks(boxId: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(bookmarkKey(boxId)) ?? "[]");
    return Array.isArray(parsed) ? Array.from(new Set(parsed.map((item) => normalizeRelPath(String(item))))) : [];
  } catch {
    return [];
  }
}

function saveBookmarks(boxId: string, bookmarks: string[]) {
  try { localStorage.setItem(bookmarkKey(boxId), JSON.stringify(bookmarks)); }
  catch { /* ignore localStorage failures */ }
}

function bookmarkLabel(path: string) {
  const normalized = normalizeRelPath(path);
  if (normalized === ".") return "workspace";
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function friendlyFileError(error: unknown, relPath: string) {
  const raw = error instanceof Error ? error.message : String(error);
  const clean = raw.split("\n").map((line) => line.trim()).filter(Boolean).find((line) => !/^Traceback|^File |^at /.test(line)) ?? raw;
  if (/directory does not exist|does not exist|No such file|not found|ENOENT|FileNotFound/i.test(raw)) return `目录不存在：${workspaceAbsPath(relPath)}`;
  if (/not a directory|NotADirectory|ENOTDIR/i.test(raw)) return `不是目录：${workspaceAbsPath(relPath)}`;
  if (/path escapes workspace|AssertionError|outside workspace/i.test(raw)) return "路径必须位于 /workspace 内。";
  return clean || `无法访问目录：${workspaceAbsPath(relPath)}`;
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
