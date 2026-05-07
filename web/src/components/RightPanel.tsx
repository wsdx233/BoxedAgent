import { useState } from "react";
import { Code2, Files, Plug, Settings2, Terminal as TerminalIcon } from "lucide-react";
import { api } from "../lib/api";
import type { BoxRecord } from "../lib/types";
import { FileBrowser } from "./FileBrowser";
import { PiSettingsPane } from "./PiSettingsPane";
import { PiExtensionsPane } from "./PiExtensionsPane";
import { TerminalPane } from "./TerminalPane";

export function RightPanel({ box, boxes = [], sessionId, onRefresh }: { box?: BoxRecord; boxes?: BoxRecord[]; sessionId?: string; onRefresh: () => void }) {
  const [tab, setTab] = useState<"terminal" | "files" | "pi" | "extensions" | "code">("terminal");
  const boxId = box?.id;
  return <aside className="rightbar">
    <div className="tabs">
      <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}><TerminalIcon size={15} /> Shell</button>
      <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}><Files size={15} /> Files</button>
      <button className={tab === "pi" ? "active" : ""} onClick={() => setTab("pi")}><Settings2 size={15} /> Pi</button>
      <button className={tab === "extensions" ? "active" : ""} onClick={() => setTab("extensions")}><Plug size={15} /> Extensions</button>
      <button className={tab === "code" ? "active" : ""} onClick={() => setTab("code")}><Code2 size={15} /> code-server</button>
    </div>
    {tab === "terminal" && <div className="panel terminal-panel"><TerminalPane boxId={boxId} /></div>}
    {tab === "files" && <FileBrowser key={boxId ?? "none"} boxId={boxId} />}
    {tab === "pi" && <PiSettingsPane box={box} onSaved={onRefresh} />}
    {tab === "extensions" && <PiExtensionsPane box={box} boxes={boxes} sessionId={sessionId} onSessionReloaded={onRefresh} />}
    {tab === "code" && <div className="panel">
      {boxId ? <>
        <p>code-server 通过 BoxedAgent 反向代理访问。</p>
        <a href={api.codeServerUrl(boxId)} target="_blank" rel="noreferrer"><button className="primary">打开 code-server</button></a>
        <p className="small">默认密码：{box?.codeServerPassword || "boxedagent"}。首次启动可能需要数秒。</p>
      </> : <p className="small">请选择 Box</p>}
    </div>}
  </aside>;
}
