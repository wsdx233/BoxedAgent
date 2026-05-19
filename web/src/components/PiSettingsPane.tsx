import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";
import { Bot, CheckCircle2, Code2, Edit3, FileText, Plus, Save, Server, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { api } from "../lib/api";
import type { BoxRecord, ThinkingLevel } from "../lib/types";

const DEFAULT_MODELS_JSON = `{
  "providers": {
    "ollama": {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen2.5-coder:7b", "name": "Qwen Coder Local", "contextWindow": 128000 }
      ]
    }
  }
}`;

const API_TYPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
const INPUT_TYPES = ["text", "image"] as const;
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MAX_TOKENS_FIELDS = ["max_completion_tokens", "max_tokens"];
const THINKING_FORMATS = ["openai", "reasoning_effort", "openrouter", "deepseek", "together", "zai", "qwen", "qwen-chat-template"];
const CACHE_CONTROL_FORMATS = ["anthropic"];
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const COMPAT_FLAGS = [
  { key: "supportsStore", desc: "支持 store 字段 (OpenAI 存储功能)" },
  { key: "supportsDeveloperRole", desc: "支持 developer 角色；false 时降级为 system" },
  { key: "supportsReasoningEffort", desc: "支持 reasoning_effort 参数" },
  { key: "supportsUsageInStreaming", desc: "支持流式 include_usage；部分兼容端需设为 false" },
  { key: "requiresToolResultName", desc: "工具结果消息必须包含 name 字段" },
  { key: "requiresAssistantAfterToolResult", desc: "工具返回后插入 assistant 消息再接 user" },
  { key: "requiresThinkingAsText", desc: "将 thinking 块转为纯文本" },
  { key: "requiresReasoningContentOnAssistantMessages", desc: "开启推理时重放 assistant 空 reasoning_content" },
  { key: "supportsStrictMode", desc: "工具定义支持 strict 字段" },
  { key: "supportsLongCacheRetention", desc: "支持长效 prompt/cache retention" },
  { key: "supportsEagerToolInputStreaming", desc: "Anthropic 工具级 eager_input_streaming" },
  { key: "sendSessionIdHeader", desc: "OpenAI Responses: 发送 session id header" }
] as const;

type ModelsEditorMode = "visual" | "json";
type JsonRecord = Record<string, unknown>;
type ModelInputType = (typeof INPUT_TYPES)[number];
type CostField = (typeof COST_FIELDS)[number];
type ProviderConfig = JsonRecord & {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  compat?: JsonRecord;
  models?: ModelDefinition[];
};
type ModelDefinition = JsonRecord & {
  id?: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  input?: ModelInputType[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: JsonRecord;
  cost?: Partial<Record<CostField, number>>;
};
type ModelsConfig = JsonRecord & { providers: Record<string, ProviderConfig> };

export function PiSettingsPane({ box, onSaved }: { box?: BoxRecord; onSaved: () => void }) {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [enabledModels, setEnabledModels] = useState("");
  const [settingsText, setSettingsText] = useState("{}");
  const [modelsText, setModelsText] = useState("{}");
  const [modelsMode, setModelsMode] = useState<ModelsEditorMode>("visual");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [appendSystemPrompt, setAppendSystemPrompt] = useState("");
  const [agentsMd, setAgentsMd] = useState("");
  const [envText, setEnvText] = useState("{}");
  const [materialized, setMaterialized] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();

  useEffect(() => {
    if (!box) return;
    setError(undefined); setOk(undefined);
    api.getPiConfig(box.id).then((cfg) => {
      setProvider(cfg.pi.defaultProvider ?? "");
      setModel(cfg.pi.defaultModel ?? "");
      setThinking(cfg.pi.defaultThinkingLevel ?? "medium");
      setEnabledModels((cfg.pi.enabledModels ?? []).join(", "));
      setSettingsText(JSON.stringify(cfg.pi.settingsJson ?? {}, null, 2));
      setModelsText(JSON.stringify(cfg.pi.modelsJson ?? {}, null, 2));
      setSystemPrompt(cfg.pi.systemPrompt ?? "");
      setAppendSystemPrompt(cfg.pi.appendSystemPrompt ?? "");
      setAgentsMd(cfg.pi.agentsMd ?? "");
      setEnvText(JSON.stringify(cfg.env ?? {}, null, 2));
      setMaterialized(cfg.materialized.piCodingAgentDir);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [box?.id]);

  const effectiveSettingsPreview = useMemo(() => {
    try {
      const custom = JSON.parse(settingsText || "{}");
      return JSON.stringify({ ...custom, defaultProvider: provider || undefined, defaultModel: model || undefined, defaultThinkingLevel: thinking, enabledModels: enabledModels.split(",").map((s) => s.trim()).filter(Boolean), sessionDir: "/workspace/.pi-sessions" }, null, 2);
    } catch { return "settings.json 不是合法 JSON"; }
  }, [settingsText, provider, model, thinking, enabledModels]);

  const jsonHealth = useMemo(() => ({
    env: jsonStatus(envText),
    models: jsonStatus(modelsText),
    settings: jsonStatus(settingsText)
  }), [envText, modelsText, settingsText]);

  async function save() {
    if (!box) return;
    setSaving(true); setError(undefined); setOk(undefined);
    try {
      const env = parseEnv(envText);
      parseObject(settingsText, "settings.json");
      parseObject(modelsText, "models.json");
      await api.updatePiConfig(box.id, {
        defaultProvider: provider || undefined,
        defaultModel: model || undefined,
        defaultThinkingLevel: thinking,
        enabledModels: enabledModels.split(",").map((s) => s.trim()).filter(Boolean),
        settingsJsonText: settingsText,
        modelsJsonText: modelsText,
        systemPrompt,
        appendSystemPrompt,
        agentsMd,
        env
      });
      setOk("已保存并写入 Box workspace。新的 agent session 会使用这些配置；正在运行的 session 建议重启。");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  if (!box) return <div className="panel small">请选择 Box</div>;

  return <div className="panel pi-settings">
    <div className="settings-hero elevated">
      <div className="hero-icon"><Sparkles size={20} /></div>
      <div><strong>Pi 配置 · {box.name}</strong><div className="small">独立 PI_CODING_AGENT_DIR：{materialized ?? "/workspace/.boxedagent/pi-agent"}</div></div>
    </div>

    {error && <div className="notice error"><TriangleAlert size={16} /> {error}</div>}
    {ok && <div className="notice ok"><CheckCircle2 size={16} /> {ok}</div>}

    <section className="settings-card">
      <div className="section-title"><Sparkles size={16} /> 模型与运行参数</div>
      <div className="settings-grid">
        <label>默认 Provider<input placeholder="anthropic / openai / ollama" value={provider} onChange={(e) => setProvider(e.target.value)} /></label>
        <label>默认 Model<input placeholder="claude-sonnet... / gpt-4.1 / qwen..." value={model} onChange={(e) => setModel(e.target.value)} /></label>
        <label>Thinking<select value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingLevel)}><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label>
        <label>模型轮换 enabledModels<input placeholder="claude-*, gpt-4o, qwen*" value={enabledModels} onChange={(e) => setEnabledModels(e.target.value)} /></label>
      </div>
    </section>

    <section className="settings-card">
      <div className="section-title"><Code2 size={16} /> JSON 配置</div>
      <EditorBlock title="环境变量 JSON" subtitle="会注入容器，适合 API Key、私有 Provider URL 等。" status={jsonHealth.env}>
        <CodeEditor value={envText} onChange={setEnvText} language="json" minHeight="150px" />
      </EditorBlock>
      <EditorBlock title="models.json" subtitle="自定义 Provider / Model；保存后写入 Box 的 pi agent 配置目录。" status={jsonHealth.models}>
        <div className="editor-mode-tabs">
          <button type="button" className={modelsMode === "visual" ? "active" : ""} onClick={() => setModelsMode("visual")}><Sparkles size={14} /> 可视化</button>
          <button type="button" className={modelsMode === "json" ? "active" : ""} onClick={() => setModelsMode("json")}><Code2 size={14} /> JSON</button>
        </div>
        {modelsMode === "visual"
          ? <ModelsJsonVisualEditor value={modelsText} onChange={setModelsText} />
          : <CodeEditor value={modelsText} onChange={setModelsText} language="json" minHeight="260px" />}
        <div className="row editor-actions"><button onClick={() => setModelsText(DEFAULT_MODELS_JSON)}>填入 Ollama 示例</button><button onClick={() => setModelsText("{}")}>清空 models.json</button></div>
      </EditorBlock>
      <EditorBlock title="settings.json 额外配置" subtitle="会和默认 Provider / Model / Thinking 合并。" status={jsonHealth.settings}>
        <CodeEditor value={settingsText} onChange={setSettingsText} language="json" minHeight="220px" />
      </EditorBlock>
      <details className="preview-details"><summary>最终 settings.json 预览</summary><pre className="preview">{effectiveSettingsPreview}</pre></details>
    </section>

    <section className="settings-card">
      <div className="section-title"><FileText size={16} /> Prompt 与项目上下文</div>
      <EditorBlock title="SYSTEM.md" subtitle="替换系统提示词；留空则使用 pi 默认系统提示词。">
        <CodeEditor value={systemPrompt} onChange={setSystemPrompt} language="markdown" minHeight="170px" placeholder="留空则使用 pi 默认系统提示词" />
      </EditorBlock>
      <EditorBlock title="APPEND_SYSTEM.md" subtitle="追加系统提示词，适合团队规范、安全策略、工具使用规则。">
        <CodeEditor value={appendSystemPrompt} onChange={setAppendSystemPrompt} language="markdown" minHeight="170px" placeholder="适合放团队规范、安全策略、工具使用规则" />
      </EditorBlock>
      <EditorBlock title="AGENTS.md" subtitle="Box 全局项目上下文，会被 materialize 到 pi 配置目录。">
        <CodeEditor value={agentsMd} onChange={setAgentsMd} language="markdown" minHeight="170px" placeholder="描述该 Box 擅长的任务、常用命令、代码规范" />
      </EditorBlock>
    </section>

    <div className="sticky-actions"><button className="primary" onClick={save} disabled={saving}><Save size={15} /> {saving ? "保存中..." : "保存 Pi 配置"}</button></div>
  </div>;
}

function EditorBlock({ title, subtitle, status, children }: { title: string; subtitle?: string; status?: string; children: React.ReactNode }) {
  return <div className="editor-block">
    <div className="editor-block-head">
      <div><strong>{title}</strong>{subtitle && <div className="small">{subtitle}</div>}</div>
      {status && <span className={`json-status ${status === "合法 JSON" ? "ok" : "error"}`}>{status}</span>}
    </div>
    {children}
  </div>;
}

function CodeEditor({ value, onChange, language, minHeight, placeholder }: { value: string; onChange: (value: string) => void; language: "json" | "markdown"; minHeight: string; placeholder?: string }) {
  const extensions: Extension[] = [language === "json" ? json() : markdown()];
  return <div className="code-editor-shell" data-placeholder={placeholder}>
    <CodeMirror
      value={value}
      height="auto"
      minHeight={minHeight}
      theme={oneDark}
      extensions={extensions}
      basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, bracketMatching: true, closeBrackets: true }}
      onChange={(next) => onChange(next)}
    />
  </div>;
}

function ModelsJsonVisualEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const parsed = useMemo<{ config?: ModelsConfig; error?: string }>(() => {
    try { return { config: parseModelsConfigText(value) }; }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [value]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [compactLayout, setCompactLayout] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [providerIdDraft, setProviderIdDraft] = useState("");
  const [editing, setEditing] = useState<{ index: number | null; model: ModelDefinition } | null>(null);

  const providerIds = parsed.config ? Object.keys(parsed.config.providers) : [];
  const providerIdsKey = providerIds.join("\u0000");
  const selectedProvider = selectedProviderId && parsed.config ? parsed.config.providers[selectedProviderId] : undefined;
  const providerModels = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];
  const providerCompat = isRecord(selectedProvider?.compat) ? selectedProvider.compat : {};
  const editingModel = editing?.model;

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const applyWidth = (width: number) => {
      const next = width < 700;
      setCompactLayout((current) => current === next ? current : next);
    };
    applyWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") {
      const onResize = () => applyWidth(element.getBoundingClientRect().width);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const observer = new ResizeObserver((entries) => {
      applyWidth(entries[0]?.contentRect.width ?? element.getBoundingClientRect().width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!parsed.config) return;
    if (providerIds.length === 0) {
      if (selectedProviderId) setSelectedProviderId(undefined);
      return;
    }
    if (!selectedProviderId || !providerIds.includes(selectedProviderId)) setSelectedProviderId(providerIds[0]);
  }, [parsed.config, providerIdsKey, selectedProviderId]);

  useEffect(() => {
    setProviderIdDraft(selectedProviderId ?? "");
  }, [selectedProviderId]);

  function commit(updater: (draft: ModelsConfig) => void) {
    try {
      const draft = parseModelsConfigText(value);
      updater(draft);
      onChange(JSON.stringify(cleanModelsConfig(draft), null, 2));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  function addProvider() {
    const id = uniqueId("new-provider", providerIds);
    commit((draft) => {
      draft.providers[id] = { api: "openai-completions", compat: {}, models: [] };
    });
    setSelectedProviderId(id);
  }

  function selectProvider(id: string) {
    setSelectedProviderId(id);
    setEditing(null);
  }

  function deleteProvider(id: string) {
    if (!window.confirm(`确定要删除 Provider [${id}] 吗？`)) return;
    commit((draft) => { delete draft.providers[id]; });
    setSelectedProviderId(undefined);
    setEditing(null);
  }

  function renameProvider() {
    const oldId = selectedProviderId;
    const newId = providerIdDraft.trim();
    if (!oldId) return;
    if (!newId || newId === oldId) {
      setProviderIdDraft(oldId);
      return;
    }
    if (parsed.config?.providers[newId]) {
      window.alert("该 Provider ID 已存在！");
      setProviderIdDraft(oldId);
      return;
    }
    commit((draft) => {
      const provider = draft.providers[oldId];
      if (!provider) return;
      draft.providers[newId] = provider;
      delete draft.providers[oldId];
    });
    setSelectedProviderId(newId);
  }

  function setProviderStringField(key: string, next: string) {
    if (!selectedProviderId) return;
    commit((draft) => {
      const provider = draft.providers[selectedProviderId];
      if (!provider) return;
      setOptionalString(provider, key, next);
    });
  }

  function setProviderBooleanField(key: string, checked: boolean) {
    if (!selectedProviderId) return;
    commit((draft) => {
      const provider = draft.providers[selectedProviderId];
      if (!provider) return;
      if (checked) provider[key] = true;
      else delete provider[key];
    });
  }

  function setProviderCompatField(key: string, next: unknown) {
    if (!selectedProviderId) return;
    commit((draft) => {
      const provider = draft.providers[selectedProviderId];
      if (!provider) return;
      const compat = ensureRecordField(provider, "compat");
      if (next === "" || next === undefined) delete compat[key];
      else compat[key] = next;
    });
  }

  function openModelDialog(index: number | null) {
    const source = index === null ? createEmptyModel() : providerModels[index] ?? createEmptyModel();
    setEditing({ index, model: normalizeModelForEdit(source) });
  }

  function deleteModel(index: number) {
    if (!selectedProviderId || !window.confirm("确定删除该 Model 吗？")) return;
    commit((draft) => {
      const provider = draft.providers[selectedProviderId];
      if (!provider) return;
      ensureModels(provider).splice(index, 1);
    });
  }

  function duplicateModel(index: number) {
    if (!selectedProviderId) return;
    const source = providerModels[index];
    if (!source) return;
    const copy = deepClone(source);
    copy.id = uniqueId(`${stringValue(copy.id) || "model"}-copy`, providerModels.map((model) => stringValue(model.id)).filter(Boolean));
    commit((draft) => {
      const provider = draft.providers[selectedProviderId];
      if (!provider) return;
      ensureModels(provider).push(copy);
    });
  }

  function patchEditingModel(updater: (draft: ModelDefinition) => void) {
    setEditing((current) => {
      if (!current) return current;
      const model = deepClone(current.model);
      updater(model);
      return { ...current, model };
    });
  }

  function setModelStringField(key: string, next: string) {
    patchEditingModel((model) => setOptionalString(model, key, next));
  }

  function setModelNumberField(key: string, next: string) {
    patchEditingModel((model) => setOptionalNumber(model, key, next));
  }

  function setModelBooleanField(key: string, checked: boolean) {
    patchEditingModel((model) => { model[key] = checked; });
  }

  function toggleModelInput(type: ModelInputType, checked: boolean) {
    patchEditingModel((model) => {
      const current = modelInputTypes(model);
      const next = checked ? Array.from(new Set([...current, type])) : current.filter((item) => item !== type);
      if (next.length > 0) model.input = next;
      else delete model.input;
    });
  }

  function setModelCostField(key: CostField, next: string) {
    patchEditingModel((model) => {
      const cost = ensureRecordField(model, "cost");
      const trimmed = next.trim();
      if (!trimmed) delete cost[key];
      else {
        const number = Number(trimmed);
        if (Number.isFinite(number)) cost[key] = number;
      }
      if (Object.keys(cost).length === 0) delete model.cost;
    });
  }

  function setModelThinkingLevel(level: ThinkingLevel, next: string) {
    patchEditingModel((model) => {
      const thinkingLevelMap = ensureRecordField(model, "thinkingLevelMap");
      const trimmed = next.trim();
      if (!trimmed) delete thinkingLevelMap[level];
      else thinkingLevelMap[level] = trimmed === "null" ? null : next;
      if (Object.keys(thinkingLevelMap).length === 0) delete model.thinkingLevelMap;
    });
  }

  function saveEditingModel() {
    if (!selectedProviderId || !editing) return;
    const next = normalizeModelForSave(editing.model);
    if (!next.id) {
      window.alert("Model ID 是必填项");
      return;
    }
    commit((draft) => {
      const provider = draft.providers[selectedProviderId];
      if (!provider) return;
      const models = ensureModels(provider);
      if (editing.index === null) models.push(next);
      else models[editing.index] = next;
    });
    setEditing(null);
  }

  if (parsed.error) {
    return <div ref={rootRef} className={`models-visual-editor ${compactLayout ? "compact" : ""}`}>
      <div className="notice error"><TriangleAlert size={16} /> models.json 解析失败：{parsed.error}</div>
      <div className="small">请切换到 JSON 模式修复格式后再使用可视化编辑器。</div>
    </div>;
  }

  return <div ref={rootRef} className={`models-visual-editor ${compactLayout ? "compact" : ""}`}>
    <div className="models-visual-shell">
      <aside className="models-provider-sidebar">
        <div className="row space models-sidebar-head"><strong>Providers</strong><span className="mini-badge">{providerIds.length}</span></div>
        <div className="models-provider-list">
          {providerIds.map((id) => {
            const provider = parsed.config?.providers[id];
            const modelCount = Array.isArray(provider?.models) ? provider.models.length : 0;
            return <button type="button" key={id} className={`models-provider-item ${selectedProviderId === id ? "active" : ""}`} onClick={() => selectProvider(id)}>
              <Server size={14} />
              <span className="models-provider-main"><span>{id}</span><small>{modelCount} models</small></span>
            </button>;
          })}
          {providerIds.length === 0 && <div className="models-empty-note">还没有 Provider。</div>}
        </div>
        <button type="button" className="button-tonal models-add-provider" onClick={addProvider}><Plus size={14} /> 添加 Provider</button>
      </aside>

      <main className="models-visual-main">
        {selectedProviderId && selectedProvider ? <>
          <div className="models-provider-card">
            <div className="models-provider-head">
              <div><strong>Provider: {selectedProviderId}</strong><div className="small">配置接口、鉴权方式和兼容性开关。</div></div>
              <button type="button" className="danger compact" onClick={() => deleteProvider(selectedProviderId)}><Trash2 size={14} /> 删除</button>
            </div>
            <div className="models-form-grid">
              <label>Provider ID
                <div className="inline-field">
                  <input value={providerIdDraft} onChange={(e) => setProviderIdDraft(e.currentTarget.value)} onBlur={renameProvider} onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      renameProvider();
                      e.currentTarget.blur();
                    }
                  }} />
                  <button type="button" className="compact" onClick={renameProvider}>重命名</button>
                </div>
              </label>
              <label>Base URL<input placeholder="https://..." value={stringValue(selectedProvider.baseUrl)} onChange={(e) => setProviderStringField("baseUrl", e.currentTarget.value)} /></label>
              <label>API Type
                <select value={stringValue(selectedProvider.api)} onChange={(e) => setProviderStringField("api", e.currentTarget.value)}>
                  <option value="">未设置 / 继承</option>
                  {selectedProvider.api && !API_TYPES.includes(selectedProvider.api) && <option value={selectedProvider.api}>{selectedProvider.api}</option>}
                  {API_TYPES.map((apiType) => <option key={apiType} value={apiType}>{apiType}</option>)}
                </select>
              </label>
              <label>API Key / 环境变量 / !command<input placeholder="OPENAI_API_KEY / !op read ..." value={stringValue(selectedProvider.apiKey)} onChange={(e) => setProviderStringField("apiKey", e.currentTarget.value)} /></label>
              <label className="checkbox-label models-checkbox wide"><input type="checkbox" checked={selectedProvider.authHeader === true} onChange={(e) => setProviderBooleanField("authHeader", e.currentTarget.checked)} /> 自动添加 Authorization: Bearer &lt;apiKey&gt;</label>
            </div>

            <details className="models-details" open>
              <summary><span>Provider Compat</span><span className="small">常见第三方 / 本地 OpenAI 兼容服务适配项</span></summary>
              <div className="compat-grid">
                {COMPAT_FLAGS.map((flag) => {
                  const hasValue = hasOwn(providerCompat, flag.key);
                  return <label key={flag.key} className="compat-toggle">
                    <span className="compat-toggle-head">
                      <input type="checkbox" checked={providerCompat[flag.key] === true} onChange={(e) => setProviderCompatField(flag.key, e.currentTarget.checked)} />
                      <span>{flag.key}</span>
                      <code className={hasValue ? "compat-state set" : "compat-state"}>{hasValue ? String(providerCompat[flag.key]) : "unset"}</code>
                    </span>
                    <span>{flag.desc}</span>
                  </label>;
                })}
              </div>
              <div className="models-form-grid compat-selects">
                <label>maxTokensField
                  <select value={stringValue(providerCompat.maxTokensField)} onChange={(e) => setProviderCompatField("maxTokensField", e.currentTarget.value)}>
                    <option value="">未设置</option>
                    {Boolean(providerCompat.maxTokensField) && !MAX_TOKENS_FIELDS.includes(stringValue(providerCompat.maxTokensField)) && <option value={stringValue(providerCompat.maxTokensField)}>{stringValue(providerCompat.maxTokensField)}</option>}
                    {MAX_TOKENS_FIELDS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
                <label>thinkingFormat
                  <select value={stringValue(providerCompat.thinkingFormat)} onChange={(e) => setProviderCompatField("thinkingFormat", e.currentTarget.value)}>
                    <option value="">未设置</option>
                    {Boolean(providerCompat.thinkingFormat) && !THINKING_FORMATS.includes(stringValue(providerCompat.thinkingFormat)) && <option value={stringValue(providerCompat.thinkingFormat)}>{stringValue(providerCompat.thinkingFormat)}</option>}
                    {THINKING_FORMATS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
                <label>cacheControlFormat
                  <select value={stringValue(providerCompat.cacheControlFormat)} onChange={(e) => setProviderCompatField("cacheControlFormat", e.currentTarget.value)}>
                    <option value="">未设置</option>
                    {Boolean(providerCompat.cacheControlFormat) && !CACHE_CONTROL_FORMATS.includes(stringValue(providerCompat.cacheControlFormat)) && <option value={stringValue(providerCompat.cacheControlFormat)}>{stringValue(providerCompat.cacheControlFormat)}</option>}
                    {CACHE_CONTROL_FORMATS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
              </div>
            </details>
          </div>

          <div className="models-list-head row space">
            <div><strong>Models</strong><div className="small">{providerModels.length} 个自定义模型；高级字段可切换 JSON 模式继续编辑。</div></div>
            <button type="button" className="primary compact" onClick={() => openModelDialog(null)}><Plus size={14} /> 添加 Model</button>
          </div>
          {providerModels.length > 0 ? <div className="models-model-grid">
            {providerModels.map((model, index) => <div key={`${stringValue(model.id) || "model"}-${index}`} className="model-config-card">
              <div className="model-card-title"><Bot size={15} /><strong>{stringValue(model.name) || stringValue(model.id) || "未命名模型"}</strong></div>
              <div className="model-card-sub">{stringValue(model.id) || "缺少 id"}</div>
              <div className="model-chip-row">
                {model.reasoning && <span className="mini-badge">reasoning</span>}
                <span className="mini-badge">{stringValue(model.contextWindow) || "128000"} ctx</span>
                {modelInputTypes(model).includes("image") && <span className="mini-badge">image</span>}
              </div>
              <div className="model-card-actions">
                <button type="button" className="compact" onClick={() => openModelDialog(index)}><Edit3 size={13} /> 编辑</button>
                <button type="button" className="compact" onClick={() => duplicateModel(index)}>复制</button>
                <button type="button" className="danger compact" onClick={() => deleteModel(index)}><Trash2 size={13} /> 删除</button>
              </div>
            </div>)}
          </div> : <div className="models-empty-visual"><Bot size={22} /><strong>还没有 Model</strong><span>添加模型后，pi 才能在这个自定义 Provider 下列出它。</span></div>}
        </> : <div className="models-empty-visual"><Server size={26} /><strong>请选择或添加一个 Provider</strong><span>Provider 保存到 models.json 的 providers 字段。</span></div>}
      </main>
    </div>

    {editingModel && <div className="modal-backdrop" onMouseDown={() => setEditing(null)}>
      <div className="modal wide models-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="models-modal-head row space">
          <div><strong>{editing?.index === null ? "添加 Model" : "编辑 Model"}</strong><div className="small">{selectedProviderId ? `${selectedProviderId} / ${stringValue(editingModel.id) || "new model"}` : "models.json"}</div></div>
          <button type="button" className="compact-icon" onClick={() => setEditing(null)}><X size={16} /></button>
        </div>

        <div className="models-modal-grid">
          <label>Model ID (必填)<input value={stringValue(editingModel.id)} onChange={(e) => setModelStringField("id", e.currentTarget.value)} placeholder="gpt-4.1 / qwen2.5-coder:7b" autoFocus /></label>
          <label>Name (可选)<input value={stringValue(editingModel.name)} onChange={(e) => setModelStringField("name", e.currentTarget.value)} placeholder="显示名称" /></label>
          <label>API Override
            <select value={stringValue(editingModel.api)} onChange={(e) => setModelStringField("api", e.currentTarget.value)}>
              <option value="">继承 Provider</option>
              {editingModel.api && !API_TYPES.includes(editingModel.api) && <option value={editingModel.api}>{editingModel.api}</option>}
              {API_TYPES.map((apiType) => <option key={apiType} value={apiType}>{apiType}</option>)}
            </select>
          </label>
          <label>Base URL Override<input value={stringValue(editingModel.baseUrl)} onChange={(e) => setModelStringField("baseUrl", e.currentTarget.value)} placeholder="留空则继承 Provider" /></label>
          <label>Context Window<input type="number" min="1" value={numberInputValue(editingModel.contextWindow)} onChange={(e) => setModelNumberField("contextWindow", e.currentTarget.value)} /></label>
          <label>Max Tokens<input type="number" min="1" value={numberInputValue(editingModel.maxTokens)} onChange={(e) => setModelNumberField("maxTokens", e.currentTarget.value)} /></label>
          <div className="models-field-block">
            <div className="models-field-label">Input Types</div>
            <div className="input-toggle-row">
              {INPUT_TYPES.map((type) => <label key={type} className="checkbox-label models-checkbox"><input type="checkbox" checked={modelInputTypes(editingModel).includes(type)} onChange={(e) => toggleModelInput(type, e.currentTarget.checked)} /> {type}</label>)}
            </div>
          </div>
          <label className="checkbox-label models-checkbox models-field-block"><input type="checkbox" checked={editingModel.reasoning === true} onChange={(e) => setModelBooleanField("reasoning", e.currentTarget.checked)} /> Supports Extended Thinking</label>
        </div>

        {editingModel.reasoning === true && <details className="models-details" open>
          <summary><span>Thinking Level Map</span><span className="small">留空使用默认映射；填 null 表示不支持该档位。</span></summary>
          <div className="thinking-map-grid">
            {THINKING_LEVELS.map((level) => <label key={level}>{level}<input value={thinkingLevelInputValue(editingModel, level)} onChange={(e) => setModelThinkingLevel(level, e.currentTarget.value)} placeholder="默认 / null / provider value" /></label>)}
          </div>
        </details>}

        <details className="models-details" open>
          <summary><span>Cost (per million tokens)</span><span className="small">留空则省略；保存部分字段时其余成本按 0 补齐。</span></summary>
          <div className="cost-grid">
            {COST_FIELDS.map((field) => <label key={field}>{field}<input type="number" step="any" value={costInputValue(editingModel, field)} onChange={(e) => setModelCostField(field, e.currentTarget.value)} /></label>)}
          </div>
        </details>

        <div className="modal-actions row space">
          <span className="small">会保留 JSON 中未在表单展示的高级字段。</span>
          <div className="row"><button type="button" onClick={() => setEditing(null)}>取消</button><button type="button" className="primary" onClick={saveEditingModel}>保存 Model</button></div>
        </div>
      </div>
    </div>}
  </div>;
}

function parseModelsConfigText(text: string): ModelsConfig {
  const parsed = JSON.parse(text.trim() || "{}") as unknown;
  if (!isRecord(parsed)) throw new Error("models.json 必须是 JSON 对象");
  const config = parsed as ModelsConfig;
  if (config.providers === undefined) config.providers = {};
  if (!isRecord(config.providers)) throw new Error("models.json.providers 必须是 JSON 对象");
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider)) throw new Error(`Provider ${providerId} 必须是 JSON 对象`);
    if (provider.compat !== undefined && !isRecord(provider.compat)) throw new Error(`Provider ${providerId}.compat 必须是 JSON 对象`);
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models)) throw new Error(`Provider ${providerId}.models 必须是数组`);
      provider.models.forEach((model, index) => {
        if (!isRecord(model)) throw new Error(`Provider ${providerId}.models[${index}] 必须是 JSON 对象`);
      });
    }
  }
  return config;
}

function cleanModelsConfig(config: ModelsConfig): ModelsConfig {
  const cleaned = removeEmptyValues(deepClone(config)) as ModelsConfig;
  if (!isRecord(cleaned.providers)) cleaned.providers = {};
  return cleaned;
}

function removeEmptyValues(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => removeEmptyValues(item));
  if (!isRecord(value)) return value;
  const result: JsonRecord = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryValue === undefined) continue;
    if (typeof entryValue === "string" && entryValue.trim() === "") continue;
    const cleaned = removeEmptyValues(entryValue, entryKey);
    if (cleaned === undefined) continue;
    if (isRecord(cleaned) && Object.keys(cleaned).length === 0 && entryKey !== "providers" && entryKey !== "compat") continue;
    result[entryKey] = cleaned;
  }
  if (Object.keys(result).length === 0 && key !== "providers" && key !== "compat") return {};
  return result;
}

function createEmptyModel(): ModelDefinition {
  return {
    id: "",
    name: "",
    input: ["text"],
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 16384,
    thinkingLevelMap: {},
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function normalizeModelForEdit(model: ModelDefinition): ModelDefinition {
  const draft = deepClone(model);
  if (!Array.isArray(draft.input)) draft.input = ["text"];
  else draft.input = draft.input.filter((item): item is ModelInputType => INPUT_TYPES.includes(item as ModelInputType));
  if (!isRecord(draft.thinkingLevelMap)) draft.thinkingLevelMap = {};
  if (!isRecord(draft.cost)) draft.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  else {
    const cost = draft.cost as JsonRecord;
    for (const field of COST_FIELDS) {
      if (cost[field] === undefined) cost[field] = 0;
    }
  }
  return draft;
}

function normalizeModelForSave(model: ModelDefinition): ModelDefinition {
  const next = removeEmptyValues(deepClone(model)) as ModelDefinition;
  if (typeof next.id === "string") next.id = next.id.trim();
  if (typeof next.name === "string") next.name = next.name.trim();
  if (typeof next.api === "string") next.api = next.api.trim();
  if (typeof next.baseUrl === "string") next.baseUrl = next.baseUrl.trim();
  if (Array.isArray(next.input)) {
    const input = next.input.filter((item): item is ModelInputType => INPUT_TYPES.includes(item as ModelInputType));
    if (input.length > 0) next.input = Array.from(new Set(input));
    else delete next.input;
  }
  if (isRecord(next.thinkingLevelMap)) {
    const thinkingLevelMap = next.thinkingLevelMap;
    for (const [level, raw] of Object.entries(thinkingLevelMap)) {
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) delete thinkingLevelMap[level];
        else thinkingLevelMap[level] = trimmed === "null" ? null : trimmed;
      }
    }
    if (Object.keys(thinkingLevelMap).length === 0) delete next.thinkingLevelMap;
  }
  if (isRecord(next.cost)) {
    const rawCost = next.cost as JsonRecord;
    const hasAnyCost = COST_FIELDS.some((field) => rawCost[field] !== undefined && rawCost[field] !== "");
    if (hasAnyCost) {
      const cost: Record<CostField, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const field of COST_FIELDS) {
        const raw = rawCost[field];
        const number = typeof raw === "number" ? raw : Number(raw ?? 0);
        cost[field] = Number.isFinite(number) ? number : 0;
      }
      next.cost = cost;
    } else delete next.cost;
  }
  return next;
}

function ensureModels(provider: ProviderConfig): ModelDefinition[] {
  if (!Array.isArray(provider.models)) provider.models = [];
  return provider.models;
}

function ensureRecordField(target: JsonRecord, key: string): JsonRecord {
  if (!isRecord(target[key])) target[key] = {};
  return target[key] as JsonRecord;
}

function setOptionalString(target: JsonRecord, key: string, next: string) {
  const trimmed = next.trim();
  if (!trimmed) delete target[key];
  else target[key] = trimmed;
}

function setOptionalNumber(target: JsonRecord, key: string, next: string) {
  const trimmed = next.trim();
  if (!trimmed) {
    delete target[key];
    return;
  }
  const number = Number(trimmed);
  if (Number.isFinite(number)) target[key] = number;
}

function modelInputTypes(model: ModelDefinition): ModelInputType[] {
  if (!Array.isArray(model.input)) return ["text"];
  const input = model.input.filter((item): item is ModelInputType => INPUT_TYPES.includes(item as ModelInputType));
  return input.length > 0 ? input : ["text"];
}

function numberInputValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return "";
}

function costInputValue(model: ModelDefinition, field: CostField): string {
  if (!isRecord(model.cost)) return "";
  return numberInputValue(model.cost[field]);
}

function thinkingLevelInputValue(model: ModelDefinition, level: ThinkingLevel): string {
  if (!isRecord(model.thinkingLevelMap)) return "";
  const value = model.thinkingLevelMap[level];
  if (value === null) return "null";
  return stringValue(value);
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function uniqueId(base: string, existing: string[]): string {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  let count = 1;
  while (used.has(`${base}-${count}`)) count += 1;
  return `${base}-${count}`;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function jsonStatus(text: string): string {
  try { parseObject(text, "JSON"); return "合法 JSON"; }
  catch (e) { return e instanceof Error ? e.message : "JSON 错误"; }
}

function parseObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text.trim() || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as Record<string, unknown>;
}

function parseEnv(text: string): Record<string, string> {
  const parsed = parseObject(text, "环境变量 JSON");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? "")]));
}
