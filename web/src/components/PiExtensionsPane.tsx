import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, PackagePlus, Plug, RefreshCw, RotateCw, SendToBack, TerminalSquare, Trash2, TriangleAlert, Upload } from "lucide-react";
import { api } from "../lib/api";
import type { BoxRecord, PiExtensionRecord, PiExtensionScope } from "../lib/types";

export function PiExtensionsPane({ box, boxes, sessionId, onSessionReloaded }: { box?: BoxRecord; boxes: BoxRecord[]; sessionId?: string; onSessionReloaded?: () => void }) {
  const [extensions, setExtensions] = useState<PiExtensionRecord[]>([]);
  const [scope, setScope] = useState<PiExtensionScope>("box");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("/workspace");
  const [overwrite, setOverwrite] = useState(false);
  const [packageSource, setPackageSource] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetScope, setTargetScope] = useState<PiExtensionScope>("box");
  const [targetBoxIds, setTargetBoxIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();

  const otherBoxes = useMemo(() => boxes.filter((item) => item.id !== box?.id && item.status !== "deleted"), [boxes, box?.id]);

  useEffect(() => {
    setSelected(new Set());
    setTargetBoxIds(new Set());
  }, [box?.id]);

  useEffect(() => { void refresh(); }, [box?.id, cwd]);

  async function refresh() {
    if (!box) return;
    setError(undefined);
    try {
      const res = await api.listPiExtensions(box.id, cwd);
      setExtensions(res.extensions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function run<T>(action: () => Promise<T>, success: (value: T) => string) {
    if (!box) return;
    setBusy(true); setError(undefined); setOk(undefined);
    try {
      const value = await action();
      setOk(success(value));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function installLocal() {
    if (!box || !source.trim()) return;
    await run(
      () => api.installPiExtension(box.id, { source: source.trim(), name: name.trim() || undefined, scope, cwd, overwrite }),
      (res) => `${res.extension.name} 已安装到 ${labelScope(res.extension.scope)}。${res.message}`
    );
  }

  async function installPackage() {
    if (!box || !packageSource.trim()) return;
    await run(
      () => api.piInstallPackage(box.id, { source: packageSource.trim(), scope, cwd }),
      (res) => `pi install 完成。${res.message}${res.stdout ? `\n${res.stdout.trim()}` : ""}`
    );
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!box || !file) return;
    await run(
      () => api.uploadPiExtension(box.id, { file, name: name.trim() || undefined, scope, cwd, overwrite }),
      (res) => `${res.extension.name} 已上传到 ${labelScope(res.extension.scope)}。${res.message}`
    );
  }

  async function remove(ext: PiExtensionRecord) {
    if (!box || ext.type === "package" || ext.type === "path") return;
    if (!confirm(`删除 ${labelScope(ext.scope)} extension：${ext.name}？`)) return;
    await run(
      () => api.deletePiExtension(box.id, ext.scope, ext.name, cwd),
      (res) => res.message
    );
  }

  async function reloadSession() {
    if (!sessionId) return;
    await run(
      () => api.reloadSession(sessionId),
      () => "当前 session 已重启并重新加载 extensions / skills / prompts / themes。"
    );
    onSessionReloaded?.();
  }

  async function migrate() {
    if (!box || targetBoxIds.size === 0) return;
    const names = Array.from(selected).map((key) => key.split(":").slice(1).join(":"));
    await run(
      () => api.migratePiExtensions(box.id, { targetBoxIds: Array.from(targetBoxIds), names: names.length ? names : undefined, sourceScope: scope, targetScope, sourceCwd: cwd, targetCwd: cwd, overwrite }),
      (res) => `${res.migrated.reduce((sum, item) => sum + item.extensions.length, 0)} 个 extension 已迁移。${res.message}`
    );
  }

  function toggleSelected(ext: PiExtensionRecord) {
    const key = extensionKey(ext);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleTarget(id: string) {
    setTargetBoxIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (!box) return <div className="panel small">请选择 Box</div>;

  return <div className="panel pi-extensions">
    <div className="settings-hero elevated">
      <div className="hero-icon"><Plug size={20} /></div>
      <div><strong>Pi Extensions · {box.name}</strong><div className="small">管理 Box 全局、工作区本地 extension，并迁移到其他 Box。</div></div>
    </div>

    {error && <div className="notice error"><TriangleAlert size={16} /> <span>{error}</span></div>}
    {ok && <div className="notice ok"><CheckCircle2 size={16} /> <span>{ok}</span></div>}

    <section className="settings-card">
      <div className="section-title"><PackagePlus size={16} /> 安装</div>
      <div className="settings-grid">
        <label>安装范围<select value={scope} onChange={(e) => setScope(e.target.value as PiExtensionScope)}><option value="box">Box 全局</option><option value="workspace">当前文件夹工作区</option></select></label>
        <label>工作区 cwd<input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/workspace 或 /workspace/project" /></label>
        <label>自定义名称（可选）<input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-extension.ts / my-extension" /></label>
        <label className="checkbox-label"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> 覆盖同名 extension</label>
      </div>
      <div className="extension-install-row">
        <label>从 Box 文件路径安装<input value={source} onChange={(e) => setSource(e.target.value)} placeholder="/workspace/my-ext.ts 或 /workspace/my-ext-dir" /></label>
        <button className="primary" disabled={busy || !source.trim()} onClick={installLocal}><Copy size={15} /> 安装文件</button>
      </div>
      <div className="extension-install-row">
        <label>使用 pi install 安装包<input value={packageSource} onChange={(e) => setPackageSource(e.target.value)} placeholder="npm:@scope/pkg / git:github.com/user/repo / ./local-package" /></label>
        <button disabled={busy || !packageSource.trim()} onClick={installPackage}><TerminalSquare size={15} /> pi install</button>
      </div>
      <div className="row editor-actions">
        <label className="upload-button"><Upload size={15} /> 上传 .ts/.js<input type="file" accept=".ts,.js,text/typescript,text/javascript" onChange={upload} disabled={busy} /></label>
        <button onClick={refresh} disabled={busy}><RefreshCw size={15} /> 刷新</button>
      </div>
      <div className="row editor-actions">
        <button type="button" className="button-tonal" disabled={busy || !sessionId} onClick={reloadSession}><RotateCw size={15} /> Reload 当前 session</button>
        <span className="small">也可以在 Chat 输入 <code>/reload</code>。</span>
      </div>
      <div className="small">指令安装也可在 Shell 中运行：<code>pi install &lt;source&gt;</code>（Box 全局）或 <code>pi install &lt;source&gt; -l</code>（工作区）。</div>
    </section>

    <section className="settings-card">
      <div className="section-title"><Plug size={16} /> 已安装 extensions</div>
      <div className="extension-list">
        {extensions.length === 0 && <div className="file-empty">暂无 extension。Box 全局目录：/workspace/.boxedagent/pi-agent/extensions；工作区目录：{cwd.replace(/\/$/, "")}/.pi/extensions</div>}
        {extensions.map((ext) => <div className="extension-row" key={extensionKey(ext)}>
          <label className="extension-check"><input type="checkbox" checked={selected.has(extensionKey(ext))} onChange={() => toggleSelected(ext)} /></label>
          <div className="extension-main">
            <div className="row"><strong>{ext.name}</strong><span className="status">{labelScope(ext.scope)}</span><span className="status">{typeLabel(ext.type)}</span></div>
            <div className="small"><code>{ext.path}</code>{ext.entrypoint ? ` · ${ext.entrypoint}` : ""}</div>
          </div>
          {ext.type === "package" || ext.type === "path" ? <span className="small">settings 中配置</span> : <button className="compact danger" onClick={() => remove(ext)} disabled={busy}><Trash2 size={14} /> 删除</button>}
        </div>)}
      </div>
    </section>

    <section className="settings-card">
      <div className="section-title"><SendToBack size={16} /> 迁移到其他 Box</div>
      <div className="settings-grid">
        <label>源范围<select value={scope} onChange={(e) => setScope(e.target.value as PiExtensionScope)}><option value="box">Box 全局</option><option value="workspace">当前文件夹工作区</option></select></label>
        <label>目标范围<select value={targetScope} onChange={(e) => setTargetScope(e.target.value as PiExtensionScope)}><option value="box">Box 全局</option><option value="workspace">同 cwd 工作区</option></select></label>
      </div>
      <div className="extension-targets">
        {otherBoxes.length === 0 && <div className="small">没有其他 Box 可迁移。</div>}
        {otherBoxes.map((target) => <button key={target.id} className={targetBoxIds.has(target.id) ? "active" : ""} onClick={() => toggleTarget(target.id)}><span className={`status-dot ${target.status === "running" ? "running" : "stopped"}`} /> {target.name}</button>)}
      </div>
      <button className="primary" disabled={busy || targetBoxIds.size === 0} onClick={migrate}><SendToBack size={15} /> 迁移{selected.size ? `选中的 ${selected.size} 个` : "当前源范围下全部"}</button>
      <div className="small">迁移会复制 extension 文件/目录；包管理安装的 npm/git 依赖建议在目标 Box 再执行一次 <code>pi install</code>。</div>
    </section>
  </div>;
}

function extensionKey(ext: PiExtensionRecord): string {
  return `${ext.scope}:${ext.name}`;
}

function labelScope(scope: PiExtensionScope): string {
  return scope === "box" ? "Box 全局" : "工作区";
}

function typeLabel(type: PiExtensionRecord["type"]): string {
  if (type === "package") return "pi package";
  if (type === "path") return "settings path";
  return type;
}
