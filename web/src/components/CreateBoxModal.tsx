import { FormEvent, useState } from "react";
import { api } from "../lib/api";
import type { ThinkingLevel } from "../lib/types";

export function CreateBoxModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState(`box-${Math.floor(Math.random() * 1000)}`);
  const [image, setImage] = useState("boxedagent/ubuntu-dev:24.04");
  const [password, setPassword] = useState("boxedagent");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault(); setLoading(true); setProgress("准备创建 Box...");
    try {
      setProgress("检查/构建 Docker 镜像（默认镜像首次会花几分钟）...");
      const box = await api.createBox({
        name,
        description,
        image,
        codeServerPassword: password,
        enableCodeServer: true,
        autostart: true,
        pi: { defaultProvider: provider || undefined, defaultModel: model || undefined, defaultThinkingLevel: thinking }
      });
      setProgress("创建默认 agent session...");
      await api.createSession({ boxId: box.id, name: "默认会话", model: model || undefined, provider: provider || undefined, thinkingLevel: thinking, autostart: false });
      onCreated(); onClose();
    } catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); setProgress(""); }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
      <h2>创建 Box</h2>
      <form className="form" onSubmit={submit}>
        <div className="settings-grid">
          <label>名称<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Docker 镜像<input value={image} onChange={(e) => setImage(e.target.value)} required /></label>
        </div>
        <label>描述<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="例如：前端开发 / Python 数据分析 / Rust 任务" /></label>
        <div className="settings-grid">
          <label>code-server 密码<input value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label>Thinking<select value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingLevel)}><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label>
          <label>默认 Provider<input placeholder="anthropic/openai/ollama..." value={provider} onChange={(e) => setProvider(e.target.value)} /></label>
          <label>默认 Model<input placeholder="sonnet/gpt-4.1/qwen..." value={model} onChange={(e) => setModel(e.target.value)} /></label>
        </div>
        <p className="small">默认镜像不存在时后端会自动用 <code>docker/box.Dockerfile</code> 构建。更多 pi 配置（models.json、SYSTEM.md、AGENTS.md）可在创建后右侧 Pi 标签页中编辑。</p>
        {progress && <div className="notice">{progress}</div>}
        <div className="row space"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={loading}>{loading ? "创建中..." : "创建 Box"}</button></div>
      </form>
    </div>
  </div>;
}
