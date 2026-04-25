import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";
import { CheckCircle2, Code2, FileText, Save, Sparkles, TriangleAlert } from "lucide-react";
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

export function PiSettingsPane({ box, onSaved }: { box?: BoxRecord; onSaved: () => void }) {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [enabledModels, setEnabledModels] = useState("");
  const [settingsText, setSettingsText] = useState("{}");
  const [modelsText, setModelsText] = useState("{}");
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
        <CodeEditor value={modelsText} onChange={setModelsText} language="json" minHeight="260px" />
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
