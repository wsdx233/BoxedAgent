import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ExternalLink, Link2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { BoxPortMapping, BoxRecord } from "../lib/types";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i;

export function PortMappingsPane({ box, onRefresh }: { box?: BoxRecord; onRefresh: () => void }) {
  const [mappings, setMappings] = useState<BoxPortMapping[]>(box?.portMappings ?? []);
  const [name, setName] = useState("");
  const [port, setPort] = useState("3000");
  const [protocol, setProtocol] = useState<"http" | "https">("http");
  const [slug, setSlug] = useState("");
  const [openPath, setOpenPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    setMappings(box?.portMappings ?? []);
    setError(undefined);
    setNotice(undefined);
  }, [box?.id, box?.portMappings]);

  const suggestedSlug = useMemo(() => slugify(`${box?.name ?? "box"}-${port || "port"}`), [box?.name, port]);

  async function refresh() {
    if (!box) return;
    setLoading(true);
    setError(undefined);
    try {
      const res = await api.listPortMappings(box.id);
      setMappings(res.mappings);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!box) return;
    const parsedPort = Number(port);
    const finalSlug = (slug.trim() || suggestedSlug).toLowerCase();
    const finalOpenPath = normalizeOpenPath(openPath);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError("端口必须是 1-65535 的整数");
      return;
    }
    if (!SLUG_PATTERN.test(finalSlug) || finalSlug.length < 2 || finalSlug.length > 64) {
      setError("URL 标识只能包含字母、数字、-、_，长度 2-64，并以字母或数字开头/结尾");
      return;
    }
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api.createPortMapping(box.id, { name: name.trim() || undefined, port: parsedPort, protocol, slug: finalSlug, openPath: finalOpenPath });
      setMappings(res.box.portMappings ?? []);
      setName("");
      setSlug("");
      setOpenPath("");
      setNotice(`已创建映射：${api.portProxyUrl(res.mapping.slug, res.mapping.openPath)}`);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(mapping: BoxPortMapping) {
    if (!box || !confirm(`删除端口映射「${mapping.name}」?`)) return;
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api.deletePortMapping(box.id, mapping.id);
      setMappings(res.box.portMappings ?? []);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copy(mapping: BoxPortMapping) {
    const url = api.portProxyUrl(mapping.slug, mapping.openPath);
    try {
      await navigator.clipboard.writeText(url);
      setNotice(`已复制：${url}`);
    } catch {
      window.prompt("复制 URL", url);
    }
  }

  if (!box) return <div className="panel"><p className="small">请选择 Box</p></div>;

  return <div className="panel port-mappings-pane">
    <div className="settings-hero">
      <div className="hero-icon"><Link2 size={20} /></div>
      <div>
        <strong>端口映射</strong>
        <div className="small">给 Box 内部 HTTP 服务分配自定义 URL；可自定义打开路径和查询参数，适配 noVNC 等需要指定 WebSocket path 的应用。</div>
      </div>
    </div>

    {error && <div className="notice error">{error}</div>}
    {notice && <div className="notice ok">{notice}</div>}

    <form className="settings-card port-mapping-form" onSubmit={submit}>
      <div className="section-title"><Plus size={16} /> 新增映射</div>
      <div className="settings-grid">
        <label>名称（可选）<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Vite / Next.js / API" /></label>
        <label>容器端口<input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ""))} placeholder="3000" /></label>
        <label>协议<select value={protocol} onChange={(event) => setProtocol(event.target.value as "http" | "https")}><option value="http">HTTP</option><option value="https">HTTPS</option></select></label>
        <label>自定义 URL 标识<input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))} placeholder={suggestedSlug} /></label>
      </div>
      <label>打开路径 / 查询参数（可选）<input value={openPath} onChange={(event) => setOpenPath(event.target.value)} placeholder="例如 /vnc.html?path=ports/my-vnc/websockify" /></label>
      <div className="row space">
        <span className="small">服务需监听 <code>0.0.0.0:{port || "端口"}</code>，访问路径：<code>/ports/{slug.trim() || suggestedSlug}{normalizeOpenPath(openPath) || "/"}</code></span>
        <button className="primary" disabled={saving}>{saving ? "创建中…" : "创建映射"}</button>
      </div>
    </form>

    <div className="settings-card">
      <div className="row space">
        <div className="section-title"><Link2 size={16} /> 已配置映射</div>
        <button className="compact" onClick={refresh} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} /> 刷新</button>
      </div>
      {mappings.length === 0 ? <div className="empty-menu">还没有端口映射。启动 Box 内的网站后在上方添加。</div> : <div className="port-mapping-list">
        {mappings.map((mapping) => <div className="port-mapping-row" key={mapping.id}>
          <div className="port-mapping-main">
            <strong>{mapping.name}</strong>
            <div className="small"><code>{mapping.protocol}://127.0.0.1:{mapping.port}</code> · <code>/ports/{mapping.slug}{mapping.openPath || "/"}</code></div>
          </div>
          <div className="port-mapping-actions">
            <button className="compact" onClick={() => copy(mapping)} type="button"><Link2 size={13} /> 复制</button>
            <a href={api.portProxyUrl(mapping.slug, mapping.openPath)} target="_blank" rel="noreferrer"><button className="compact" type="button"><ExternalLink size={13} /> 打开</button></a>
            <button className="compact danger" type="button" onClick={() => remove(mapping)}><Trash2 size={13} /> 删除</button>
          </div>
        </div>)}
      </div>}
    </div>
  </div>;
}

function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug.length >= 2 ? slug : "box-app";
}

function normalizeOpenPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return undefined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

