import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";
import { Box, CheckCircle2, Copy, Cpu, FileCode2, Play, Plus, RefreshCw, Save, Settings2, ShieldAlert, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { api, wsUrl } from "../lib/api";
import type { ContainerStartupConfig, ImageBuildConfig, ImageProfileRecord, PiBoxConfig, ThinkingLevel } from "../lib/types";

type Tab = "basic" | "dockerfile" | "startup" | "pi" | "build";
type ProfileDraft = Omit<ImageProfileRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<ImageProfileRecord, "id" | "createdAt" | "updatedAt">>;

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const EMPTY_JSON = "{}";
const EMPTY_ARRAY = "[]";

export function ImageProfileEditorModal({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<ImageProfileRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<ProfileDraft>(() => newProfileDraft());
  const [tab, setTab] = useState<Tab>("basic");
  const [advancedAllowed, setAdvancedAllowed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [logs, setLogs] = useState<string[]>([]);
  const selectedIdRef = useRef<string>();
  const buildingRef = useRef(false);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { buildingRef.current = building; }, [building]);

  useEffect(() => {
    let cancelled = false;
    let loadingProfiles = false;
    async function load(options: { keepDraft?: boolean; silent?: boolean } = {}) {
      if (loadingProfiles) return;
      loadingProfiles = true;
      if (!options.silent) setLoading(true);
      setError(undefined);
      try {
        const res = await api.listImageProfiles();
        if (cancelled) return;
        setProfiles(res.profiles);
        setAdvancedAllowed(res.advancedOptionsAllowed);
        const selected = res.profiles.find((profile) => profile.id === selectedIdRef.current) ?? res.profiles[0];
        if (selected) {
          selectedIdRef.current = selected.id;
          setSelectedId(selected.id);
          if (!options.keepDraft) setDraft(profileToDraft(selected));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        loadingProfiles = false;
        if (!cancelled && !options.silent) setLoading(false);
      }
    }
    void load();
    const ws = new WebSocket(wsUrl("/ws/events"));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if ((msg.type === "image_progress" || msg.type === "image_profile_progress") && msg.message) setLogs((items) => [...items.slice(-200), String(msg.message)]);
      if (msg.type === "image_profiles_changed") void load({ keepDraft: !buildingRef.current, silent: true });
      if (msg.type === "image_profile_build_error") setLogs((items) => [...items.slice(-200), `ERROR: ${msg.error}`]);
      if (msg.type === "image_profile_build_end") setLogs((items) => [...items.slice(-200), `DONE: ${msg.image}`]);
    };
    return () => { cancelled = true; closeWs(ws); };
  }, []);

  function select(profile: ImageProfileRecord) {
    selectedIdRef.current = profile.id;
    setSelectedId(profile.id);
    setDraft(profileToDraft(profile));
    setError(undefined);
    setOk(undefined);
  }

  function createLocal() {
    selectedIdRef.current = undefined;
    setSelectedId(undefined);
    setDraft(newProfileDraft());
    setTab("basic");
    setOk(undefined);
    setError(undefined);
  }

  async function save() {
    setSaving(true);
    setError(undefined);
    setOk(undefined);
    try {
      validateDraft(draft);
      const body = draftForSave(draft);
      const saved = draft.id ? await api.updateImageProfile(draft.id, body) : await api.createImageProfile(body);
      selectedIdRef.current = saved.id;
      setSelectedId(saved.id);
      setDraft(profileToDraft(saved));
      const res = await api.listImageProfiles();
      setProfiles(res.profiles);
      setOk("镜像模板已保存。创建 Box 时可以选择它。默认不会影响已有 Box。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function duplicate() {
    if (!draft.id) return;
    setSaving(true);
    setError(undefined);
    try {
      const profile = await api.duplicateImageProfile(draft.id);
      const res = await api.listImageProfiles();
      setProfiles(res.profiles);
      selectedIdRef.current = profile.id;
      setSelectedId(profile.id);
      setDraft(profileToDraft(profile));
      setOk("已复制模板。可以修改 image tag 后构建。 ");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft.id || !confirm(`删除镜像模板 ${draft.name}?`)) return;
    setSaving(true);
    setError(undefined);
    try {
      await api.deleteImageProfile(draft.id);
      const res = await api.listImageProfiles();
      setProfiles(res.profiles);
      const next = res.profiles[0];
      selectedIdRef.current = next?.id;
      setSelectedId(next?.id);
      setDraft(next ? profileToDraft(next) : newProfileDraft());
      setOk("模板已删除。Docker 本地镜像不会被自动删除。 ");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function build() {
    setBuilding(true);
    setError(undefined);
    setOk(undefined);
    setLogs([]);
    try {
      validateDraft(draft);
      let id = draft.id;
      if (!id) {
        const saved = await api.createImageProfile(draftForSave(draft));
        id = saved.id;
        selectedIdRef.current = saved.id;
        setSelectedId(saved.id);
        setDraft(profileToDraft(saved));
      } else {
        const saved = await api.updateImageProfile(id, draftForSave(draft));
        setDraft(profileToDraft(saved));
      }
      const res = await api.buildImageProfile(id);
      selectedIdRef.current = res.profile.id;
      setSelectedId(res.profile.id);
      setDraft(profileToDraft(res.profile));
      const list = await api.listImageProfiles();
      setProfiles(list.profiles);
      setOk(`镜像已构建：${res.image.image}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }

  const selectedProfile = profiles.find((profile) => profile.id === selectedId);

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal image-profile-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="image-profile-head">
        <div>
          <h2>镜像编辑器</h2>
          <p className="small">编辑 Dockerfile、构建镜像和容器启动配置。创建 Box 时可以选择保存好的模板。</p>
        </div>
        <button type="button" className="icon-button compact-icon" title="关闭" onClick={onClose}><X size={16} /></button>
      </div>

      <div className="image-profile-layout">
        <aside className="image-profile-list">
          <button type="button" className="primary image-profile-new" onClick={createLocal}><Plus size={15} /> 新建模板</button>
          {loading && <div className="menu-loading"><RefreshCw size={14} className="spin" /> 正在加载…</div>}
          {profiles.map((profile) => <button type="button" key={profile.id} className={`image-profile-item ${profile.id === selectedId ? "active" : ""}`} onClick={() => select(profile)}>
            <span className={`status ${profile.status}`}>{profile.status}</span>
            <strong>{profile.name}</strong>
            <small>{profile.image}</small>
          </button>)}
        </aside>

        <main className="image-profile-main">
          {error && <div className="notice error"><TriangleAlert size={16} /> {error}</div>}
          {ok && <div className="notice ok"><CheckCircle2 size={16} /> {ok}</div>}
          {!advancedAllowed && <div className="notice"><ShieldAlert size={16} /> 高级容器权限已被服务端 .env 禁用：GPU、devices、mounts、privileged、capAdd、extraHosts、shm/user 等配置创建容器时会被拒绝。</div>}

          <div className="editor-mode-tabs image-profile-tabs">
            <TabButton active={tab === "basic"} onClick={() => setTab("basic")} icon={<Box size={14} />} label="基本" />
            <TabButton active={tab === "dockerfile"} onClick={() => setTab("dockerfile")} icon={<FileCode2 size={14} />} label="Dockerfile" />
            <TabButton active={tab === "startup"} onClick={() => setTab("startup")} icon={<Cpu size={14} />} label="启动配置" />
            <TabButton active={tab === "pi"} onClick={() => setTab("pi")} icon={<Sparkles size={14} />} label="Pi 默认" />
            <TabButton active={tab === "build"} onClick={() => setTab("build")} icon={<Play size={14} />} label="构建" />
          </div>

          {tab === "basic" && <BasicTab draft={draft} setDraft={setDraft} selectedProfile={selectedProfile} />}
          {tab === "dockerfile" && <DockerfileTab draft={draft} setDraft={setDraft} />}
          {tab === "startup" && <StartupTab draft={draft} setDraft={setDraft} advancedAllowed={advancedAllowed} />}
          {tab === "pi" && <PiDefaultsTab draft={draft} setDraft={setDraft} />}
          {tab === "build" && <BuildTab draft={draft} logs={logs} building={building} onBuild={build} />}

          <div className="sticky-actions image-profile-actions">
            <div className="row">
              <button type="button" onClick={duplicate} disabled={!draft.id || saving || building}><Copy size={15} /> 复制</button>
              <button type="button" onClick={remove} disabled={!draft.id || saving || building}><Trash2 size={15} /> 删除</button>
            </div>
            <div className="row">
              <button type="button" className="primary" onClick={save} disabled={saving || building}><Save size={15} /> {saving ? "保存中…" : "保存模板"}</button>
              <button type="button" className="primary" onClick={build} disabled={saving || building}><Play size={15} /> {building ? "构建中…" : "构建镜像"}</button>
            </div>
          </div>
        </main>
      </div>
    </div>
  </div>;
}

function BasicTab({ draft, setDraft, selectedProfile }: { draft: ProfileDraft; setDraft: (updater: (draft: ProfileDraft) => ProfileDraft) => void; selectedProfile?: ImageProfileRecord }) {
  return <section className="settings-card">
    <div className="section-title"><Box size={16} /> 模板信息</div>
    <div className="settings-grid">
      <label>名称<input value={draft.name} onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))} /></label>
      <label>镜像 tag<input value={draft.image} onChange={(event) => setDraft((d) => ({ ...d, image: event.target.value }))} placeholder="boxedagent/my-dev:24.04" /></label>
      <label>基础镜像<input value={draft.baseImage ?? ""} onChange={(event) => setDraft((d) => ({ ...d, baseImage: event.target.value || undefined }))} placeholder="boxedagent/ubuntu-dev:24.04" /></label>
      <label>状态<input value={selectedProfile?.status ?? draft.status} readOnly /></label>
    </div>
    <label>描述<textarea rows={3} value={draft.description ?? ""} onChange={(event) => setDraft((d) => ({ ...d, description: event.target.value }))} placeholder="这个模板适合什么任务？" /></label>
    {selectedProfile?.error && <div className="notice error"><TriangleAlert size={16} /> {selectedProfile.error}</div>}
  </section>;
}

function DockerfileTab({ draft, setDraft }: { draft: ProfileDraft; setDraft: (updater: (draft: ProfileDraft) => ProfileDraft) => void }) {
  const buildArgsText = useMemo(() => JSON.stringify(draft.build?.buildArgs ?? {}, null, 2), [draft.build?.buildArgs]);
  const contextText = useMemo(() => JSON.stringify(draft.build?.contextFiles ?? [], null, 2), [draft.build?.contextFiles]);

  function applyBuildPatch(patch: Partial<ImageBuildConfig>) {
    setDraft((d) => ({ ...d, build: { ...(d.build ?? {}), ...patch } }));
  }

  function applyBuildArgs(value: string) {
    try { applyBuildPatch({ buildArgs: parseObject(value, "build args") as Record<string, string> }); } catch { /* show validation on save */ }
  }

  function applyContext(value: string) {
    try { applyBuildPatch({ contextFiles: parseArray(value, "context files") as any }); } catch { /* show validation on save */ }
  }

  return <section className="settings-card">
    <div className="section-title"><FileCode2 size={16} /> Dockerfile 与构建参数</div>
    <EditorBlock title="Dockerfile" subtitle="例如 FROM boxedagent/ubuntu-dev:24.04；需要 COPY 的文本文件可放到 contextFiles。">
      <CodeEditor value={draft.dockerfile} onChange={(value) => setDraft((d) => ({ ...d, dockerfile: value }))} language="dockerfile" minHeight="360px" />
    </EditorBlock>
    <div className="settings-grid">
      <label>Platform<input value={draft.build?.platform ?? ""} onChange={(event) => applyBuildPatch({ platform: event.target.value || undefined })} placeholder="linux/amd64" /></label>
      <label>Target<input value={draft.build?.target ?? ""} onChange={(event) => applyBuildPatch({ target: event.target.value || undefined })} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={Boolean(draft.build?.noCache)} onChange={(event) => applyBuildPatch({ noCache: event.target.checked })} /> no-cache</label>
      <label className="checkbox-label"><input type="checkbox" checked={Boolean(draft.build?.pull)} onChange={(event) => applyBuildPatch({ pull: event.target.checked })} /> build 时 pull base image</label>
    </div>
    <EditorBlock title="Build Args JSON" status={jsonStatus(buildArgsText)}>
      <CodeEditor value={buildArgsText} onChange={applyBuildArgs} language="json" minHeight="130px" />
    </EditorBlock>
    <EditorBlock title="Context Files JSON" subtitle="数组：[{ path, content, mode? }]，初版适合小型文本文件。" status={jsonArrayStatus(contextText)}>
      <CodeEditor value={contextText} onChange={applyContext} language="json" minHeight="170px" />
    </EditorBlock>
  </section>;
}

function StartupTab({ draft, setDraft, advancedAllowed }: { draft: ProfileDraft; setDraft: (updater: (draft: ProfileDraft) => ProfileDraft) => void; advancedAllowed: boolean }) {
  const startup = draft.boxDefaults?.startup ?? {};
  const envText = useMemo(() => JSON.stringify(draft.boxDefaults?.env ?? {}, null, 2), [draft.boxDefaults?.env]);
  const startupEnvText = useMemo(() => JSON.stringify(startup.env ?? {}, null, 2), [startup.env]);
  const devicesText = useMemo(() => JSON.stringify(startup.devices ?? [], null, 2), [startup.devices]);
  const mountsText = useMemo(() => JSON.stringify(startup.mounts ?? [], null, 2), [startup.mounts]);
  const extraHostsText = useMemo(() => JSON.stringify(startup.extraHosts ?? [], null, 2), [startup.extraHosts]);
  const capAddText = useMemo(() => JSON.stringify(startup.capAdd ?? [], null, 2), [startup.capAdd]);
  const exposedPortsText = useMemo(() => JSON.stringify(startup.exposedPorts ?? [], null, 2), [startup.exposedPorts]);

  function updateDefaults(patch: ProfileDraft["boxDefaults"]) {
    setDraft((d) => ({ ...d, boxDefaults: { ...(d.boxDefaults ?? {}), ...patch } }));
  }

  function updateStartup(patch: Partial<ContainerStartupConfig>) {
    setDraft((d) => ({ ...d, boxDefaults: { ...(d.boxDefaults ?? {}), startup: { ...(d.boxDefaults?.startup ?? {}), ...patch } } }));
  }

  function applyEnv(value: string) { try { updateDefaults({ env: parseObject(value, "env") as Record<string, string> }); } catch { /* validation on save */ } }
  function applyStartupEnv(value: string) { try { updateStartup({ env: parseObject(value, "startup env") as Record<string, string> }); } catch { /* validation on save */ } }
  function applyArray(value: string, key: keyof ContainerStartupConfig) { try { updateStartup({ [key]: parseArray(value, key) } as Partial<ContainerStartupConfig>); } catch { /* validation on save */ } }

  const gpuEnabled = Boolean(startup.gpu?.enabled);

  return <section className="settings-card">
    <div className="section-title"><Cpu size={16} /> Box 默认值与启动配置</div>
    {!advancedAllowed && <div className="notice"><ShieldAlert size={16} /> 服务端当前禁止高级容器权限。你仍可编辑模板，但创建 Box 时会被后端拒绝高级项。</div>}
    <div className="settings-grid">
      <label>默认内存 MB<input type="number" value={draft.boxDefaults?.memoryMb ?? ""} onChange={(event) => updateDefaults({ memoryMb: toNumber(event.target.value) })} /></label>
      <label>默认 CPU<input type="number" step="0.1" value={draft.boxDefaults?.cpus ?? ""} onChange={(event) => updateDefaults({ cpus: toNumber(event.target.value) })} /></label>
      <label>shm MB<input type="number" value={startup.shmSizeMb ?? ""} onChange={(event) => updateStartup({ shmSizeMb: toNumber(event.target.value) })} /></label>
      <label>Working Dir<input value={startup.workingDir ?? ""} onChange={(event) => updateStartup({ workingDir: event.target.value || undefined })} placeholder="/workspace" /></label>
      <label>User<input value={startup.user ?? ""} onChange={(event) => updateStartup({ user: event.target.value || undefined })} placeholder="root / node / 1000:1000" /></label>
      <label>code-server 密码<input value={draft.boxDefaults?.codeServerPassword ?? "boxedagent"} onChange={(event) => updateDefaults({ codeServerPassword: event.target.value })} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={draft.boxDefaults?.enableCodeServer ?? true} onChange={(event) => updateDefaults({ enableCodeServer: event.target.checked })} /> 启用 code-server</label>
      <label className="checkbox-label"><input type="checkbox" checked={Boolean(startup.privileged)} onChange={(event) => updateStartup({ privileged: event.target.checked || undefined })} /> privileged</label>
      <label className="checkbox-label"><input type="checkbox" checked={gpuEnabled} onChange={(event) => updateStartup({ gpu: event.target.checked ? { enabled: true, count: "all" } : undefined })} /> 启用 NVIDIA GPU</label>
      <label>GPU Count<input value={startup.gpu?.count ?? "all"} disabled={!gpuEnabled} onChange={(event) => updateStartup({ gpu: { enabled: true, count: event.target.value === "all" ? "all" : Number(event.target.value) || "all" } })} /></label>
    </div>
    <EditorBlock title="Box env JSON" subtitle="写入 Box env，适合 NVIDIA_VISIBLE_DEVICES 等模板级变量。" status={jsonStatus(envText)}><CodeEditor value={envText} onChange={applyEnv} language="json" minHeight="120px" /></EditorBlock>
    <EditorBlock title="Startup env JSON" subtitle="启动配置 env，优先级高于 Box env。" status={jsonStatus(startupEnvText)}><CodeEditor value={startupEnvText} onChange={applyStartupEnv} language="json" minHeight="120px" /></EditorBlock>
    <EditorBlock title="启动脚本" subtitle="会在 code-server 后执行，然后保持 sleep infinity。"><CodeEditor value={startup.startupScript ?? ""} onChange={(value) => updateStartup({ startupScript: value })} language="markdown" minHeight="160px" /></EditorBlock>
    <details className="preview-details" open>
      <summary>高级配置 JSON</summary>
      <div className="image-profile-json-grid">
        <EditorBlock title="devices" status={jsonArrayStatus(devicesText)}><CodeEditor value={devicesText} onChange={(value) => applyArray(value, "devices")} language="json" minHeight="130px" /></EditorBlock>
        <EditorBlock title="mounts" status={jsonArrayStatus(mountsText)}><CodeEditor value={mountsText} onChange={(value) => applyArray(value, "mounts")} language="json" minHeight="130px" /></EditorBlock>
        <EditorBlock title="extraHosts" status={jsonArrayStatus(extraHostsText)}><CodeEditor value={extraHostsText} onChange={(value) => applyArray(value, "extraHosts")} language="json" minHeight="110px" /></EditorBlock>
        <EditorBlock title="capAdd" status={jsonArrayStatus(capAddText)}><CodeEditor value={capAddText} onChange={(value) => applyArray(value, "capAdd")} language="json" minHeight="110px" /></EditorBlock>
        <EditorBlock title="exposedPorts" status={jsonArrayStatus(exposedPortsText)}><CodeEditor value={exposedPortsText} onChange={(value) => applyArray(value, "exposedPorts")} language="json" minHeight="110px" /></EditorBlock>
      </div>
    </details>
  </section>;
}

function PiDefaultsTab({ draft, setDraft }: { draft: ProfileDraft; setDraft: (updater: (draft: ProfileDraft) => ProfileDraft) => void }) {
  const pi = draft.boxDefaults?.pi ?? {};
  function updatePi(patch: Partial<PiBoxConfig>) {
    setDraft((d) => ({ ...d, boxDefaults: { ...(d.boxDefaults ?? {}), pi: { ...(d.boxDefaults?.pi ?? {}), ...patch } } }));
  }
  return <section className="settings-card">
    <div className="section-title"><Sparkles size={16} /> Pi 默认配置</div>
    <div className="settings-grid">
      <label>默认 Provider<input value={pi.defaultProvider ?? ""} onChange={(event) => updatePi({ defaultProvider: event.target.value || undefined })} placeholder="anthropic / openai / ollama" /></label>
      <label>默认 Model<input value={pi.defaultModel ?? ""} onChange={(event) => updatePi({ defaultModel: event.target.value || undefined })} /></label>
      <label>Thinking<select value={pi.defaultThinkingLevel ?? "medium"} onChange={(event) => updatePi({ defaultThinkingLevel: event.target.value as ThinkingLevel })}>{THINKING_LEVELS.map((level) => <option key={level}>{level}</option>)}</select></label>
      <label>enabledModels<input value={(pi.enabledModels ?? []).join(", ")} onChange={(event) => updatePi({ enabledModels: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="claude-*, gpt-4o" /></label>
    </div>
    <EditorBlock title="APPEND_SYSTEM.md 默认内容"><CodeEditor value={pi.appendSystemPrompt ?? ""} onChange={(value) => updatePi({ appendSystemPrompt: value })} language="markdown" minHeight="150px" /></EditorBlock>
    <EditorBlock title="AGENTS.md 默认内容"><CodeEditor value={pi.agentsMd ?? ""} onChange={(value) => updatePi({ agentsMd: value })} language="markdown" minHeight="150px" /></EditorBlock>
  </section>;
}

function BuildTab({ draft, logs, building, onBuild }: { draft: ProfileDraft; logs: string[]; building: boolean; onBuild: () => void }) {
  const command = `docker build -t ${draft.image || "<image>"} .`;
  return <section className="settings-card">
    <div className="section-title"><Play size={16} /> 构建镜像</div>
    <div className="settings-hero elevated">
      <div className="hero-icon"><Settings2 size={18} /></div>
      <div><strong>{draft.image || "未设置镜像 tag"}</strong><div className="small">{draft.description || command}</div></div>
    </div>
    <p className="small">构建会在服务端临时 build context 中进行。日志可能包含 Dockerfile 输出，请不要在 Dockerfile 中打印 secret。</p>
    <div className="row"><button type="button" className="primary" onClick={onBuild} disabled={building}><Play size={15} /> {building ? "构建中…" : "保存并构建"}</button></div>
    <pre className="image-profile-log">{logs.length ? logs.join("\n") : "构建日志会显示在这里。"}</pre>
  </section>;
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button type="button" className={active ? "active" : ""} onClick={onClick}>{icon} {label}</button>;
}

function EditorBlock({ title, subtitle, status, children }: { title: string; subtitle?: string; status?: string; children: React.ReactNode }) {
  return <div className="editor-block">
    <div className="editor-block-head">
      <div><strong>{title}</strong>{subtitle && <div className="small">{subtitle}</div>}</div>
      {status && <span className={`json-status ${status.includes("合法") ? "ok" : "error"}`}>{status}</span>}
    </div>
    {children}
  </div>;
}

function CodeEditor({ value, onChange, language, minHeight }: { value: string; onChange: (value: string) => void; language: "json" | "markdown" | "dockerfile"; minHeight: string }) {
  const extensions: Extension[] = [language === "json" ? json() : markdown()];
  return <div className="code-editor-shell"><CodeMirror value={value} minHeight={minHeight} extensions={extensions} theme={oneDark} onChange={onChange} basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true, highlightActiveLine: false }} /></div>;
}

function profileToDraft(profile: ImageProfileRecord): ProfileDraft {
  return JSON.parse(JSON.stringify(profile)) as ProfileDraft;
}

function newProfileDraft(): ProfileDraft {
  return {
    name: `Custom Dev ${Math.floor(Math.random() * 1000)}`,
    description: "",
    image: "boxedagent/custom-dev:latest",
    baseImage: "boxedagent/ubuntu-dev:24.04",
    dockerfile: "ARG BASE_IMAGE=boxedagent/ubuntu-dev:24.04\nFROM ${BASE_IMAGE}\n\n# 在这里安装你的开发工具\n",
    build: { buildArgs: { BASE_IMAGE: "boxedagent/ubuntu-dev:24.04" }, contextFiles: [] },
    boxDefaults: { enableCodeServer: true, codeServerPassword: "boxedagent", env: {}, labels: {}, pi: { defaultThinkingLevel: "medium", enabledModels: [] }, startup: {} },
    status: "draft"
  };
}

function draftForSave(draft: ProfileDraft): Partial<ImageProfileRecord> & { name: string; image: string; dockerfile: string } {
  validateDraft(draft);
  return {
    name: draft.name.trim(),
    description: draft.description ?? "",
    image: draft.image.trim(),
    baseImage: draft.baseImage?.trim() || undefined,
    dockerfile: draft.dockerfile,
    build: draft.build ?? {},
    boxDefaults: draft.boxDefaults ?? {},
    status: "draft"
  };
}

function validateDraft(draft: ProfileDraft) {
  if (!draft.name.trim()) throw new Error("请输入模板名称");
  if (!draft.image.trim()) throw new Error("请输入镜像 tag");
  if (!draft.dockerfile.trim()) throw new Error("Dockerfile 不能为空");
  ensureStringRecord(draft.build?.buildArgs, "Build Args JSON");
  for (const file of draft.build?.contextFiles ?? []) {
    const item = file as any;
    if (!item?.path || typeof item.path !== "string") throw new Error("Context Files 中每一项都需要 path");
    if (item.content !== undefined && typeof item.content !== "string") throw new Error("Context Files content 必须是字符串");
  }
  ensureStringRecord(draft.boxDefaults?.env, "Box env JSON");
  ensureStringRecord(draft.boxDefaults?.startup?.env, "Startup env JSON");
}

function ensureStringRecord(value: unknown, label: string) {
  if (!value) return;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON object`);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new Error(`${label} 的 ${key} 必须是字符串`);
  }
}

function parseObject(value: string, label: unknown): Record<string, unknown> {
  const parsed = JSON.parse(value || EMPTY_JSON);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${String(label)} 必须是 JSON object`);
  return parsed as Record<string, unknown>;
}

function parseArray(value: string, label: unknown): unknown[] {
  const parsed = JSON.parse(value || EMPTY_ARRAY);
  if (!Array.isArray(parsed)) throw new Error(`${String(label)} 必须是 JSON array`);
  return parsed;
}

function jsonStatus(value: string): string {
  try { parseObject(value, "JSON"); return "合法 JSON"; } catch { return "JSON 错误"; }
}

function jsonArrayStatus(value: string): string {
  try { parseArray(value, "JSON"); return "合法数组"; } catch { return "JSON 错误"; }
}

function toNumber(value: string): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function closeWs(ws: WebSocket) {
  try {
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.addEventListener("open", () => ws.close(), { once: true });
      ws.addEventListener("error", () => undefined, { once: true });
    } else ws.close();
  } catch { /* ignore */ }
}
