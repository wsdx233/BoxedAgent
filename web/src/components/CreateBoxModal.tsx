import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { ImageProfileRecord, ThinkingLevel } from "../lib/types";

type ImageSource = "profile" | "custom";

export function CreateBoxModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState(`box-${Math.floor(Math.random() * 1000)}`);
  const [image, setImage] = useState("boxedagent/ubuntu-dev:24.04");
  const [imageSource, setImageSource] = useState<ImageSource>("profile");
  const [profiles, setProfiles] = useState<ImageProfileRecord[]>([]);
  const [profileId, setProfileId] = useState<string>();
  const [buildImage, setBuildImage] = useState(true);
  const [password, setPassword] = useState("boxedagent");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    api.listImageProfiles().then((res) => {
      if (cancelled) return;
      setProfiles(res.profiles);
      const preferred = res.profiles.find((profile) => profile.image === "boxedagent/ubuntu-dev:24.04") ?? res.profiles[0];
      if (preferred) applyProfile(preferred);
      else setImageSource("custom");
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === profileId), [profiles, profileId]);

  function applyProfile(profile: ImageProfileRecord) {
    setImageSource("profile");
    setProfileId(profile.id);
    setImage(profile.image);
    setDescription((current) => current || profile.description || "");
    setPassword(profile.boxDefaults.codeServerPassword ?? "boxedagent");
    setProvider(profile.boxDefaults.pi?.defaultProvider ?? "");
    setModel(profile.boxDefaults.pi?.defaultModel ?? "");
    setThinking(profile.boxDefaults.pi?.defaultThinkingLevel ?? "medium");
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setLoading(true); setProgress("准备创建 Box..."); setError(undefined);
    try {
      setProgress(imageSource === "profile" ? "检查/构建模板镜像（首次会花几分钟）..." : "检查/拉取 Docker 镜像...");
      const box = await api.createBox({
        name,
        description,
        image: imageSource === "custom" ? image : undefined,
        imageProfileId: imageSource === "profile" ? profileId : undefined,
        buildImage,
        codeServerPassword: password,
        enableCodeServer: true,
        autostart: true,
        pi: { defaultProvider: provider || undefined, defaultModel: model || undefined, defaultThinkingLevel: thinking }
      });
      setProgress("创建默认 agent session...");
      await api.createSession({ boxId: box.id, name: "默认会话", model: model || undefined, provider: provider || undefined, thinkingLevel: thinking, autostart: false });
      onCreated(); onClose();
    } catch (err) { const message = err instanceof Error ? err.message : String(err); setError(message); alert(message); }
    finally { setLoading(false); setProgress(""); }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
      <h2>创建 Box</h2>
      <form className="form" onSubmit={submit}>
        {error && <div className="notice error">{error}</div>}
        <section className="settings-card">
          <div className="section-title">镜像来源</div>
          <div className="editor-mode-tabs">
            <button type="button" className={imageSource === "profile" ? "active" : ""} onClick={() => { setImageSource("profile"); if (selectedProfile) applyProfile(selectedProfile); }}>选择模板</button>
            <button type="button" className={imageSource === "custom" ? "active" : ""} onClick={() => setImageSource("custom")}>自定义镜像名</button>
          </div>
          {imageSource === "profile" ? <>
            <label>镜像模板<select value={profileId ?? ""} onChange={(event) => { const profile = profiles.find((item) => item.id === event.target.value); if (profile) applyProfile(profile); }}>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.image}</option>)}
            </select></label>
            {selectedProfile && <div className="notice">
              <div><strong>{selectedProfile.name}</strong><div className="small">{selectedProfile.description || selectedProfile.image}</div><div className="small">状态：{selectedProfile.status}{selectedProfile.lastBuiltAt ? ` · 上次构建 ${new Date(selectedProfile.lastBuiltAt).toLocaleString()}` : ""}</div></div>
            </div>}
            <label className="checkbox-label"><input type="checkbox" checked={buildImage} onChange={(event) => setBuildImage(event.target.checked)} /> 创建时自动确保/构建模板镜像</label>
          </> : <label>Docker 镜像<input value={image} onChange={(e) => setImage(e.target.value)} required /></label>}
        </section>

        <div className="settings-grid">
          <label>名称<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>实际镜像<input value={image} readOnly={imageSource === "profile"} onChange={(e) => setImage(e.target.value)} required /></label>
        </div>
        <label>描述<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="例如：安卓开发 / CUDA Torch / 前端开发" /></label>
        <div className="settings-grid">
          <label>code-server 密码<input value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label>Thinking<select value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingLevel)}><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label>
          <label>默认 Provider<input placeholder="anthropic/openai/ollama..." value={provider} onChange={(e) => setProvider(e.target.value)} /></label>
          <label>默认 Model<input placeholder="sonnet/gpt-4.1/qwen..." value={model} onChange={(e) => setModel(e.target.value)} /></label>
        </div>
        <p className="small">模板会把 Dockerfile 构建产物、容器启动配置、资源限制和 Pi 默认配置应用到新 Box；修改模板不会影响已有 Box。</p>
        {progress && <div className="notice">{progress}</div>}
        <div className="row space"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={loading || (imageSource === "profile" && !profileId)}>{loading ? "创建中..." : "创建 Box"}</button></div>
      </form>
    </div>
  </div>;
}
