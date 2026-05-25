import { useState } from "react";
import { Code2, Files, Link2, Plug, Settings2, Terminal as TerminalIcon } from "lucide-react";
import { api } from "../lib/api";
import type { BoxRecord } from "../lib/types";
import { FileBrowser } from "./FileBrowser";
import { PiSettingsPane } from "./PiSettingsPane";
import { PiExtensionsPane } from "./PiExtensionsPane";
import { TerminalPane } from "./TerminalPane";
import { PortMappingsPane } from "./PortMappingsPane";

type RightPanelTab = "terminal" | "files" | "pi" | "extensions" | "ports" | "code";

const RIGHT_PANEL_TABS: Array<{ id: RightPanelTab; label: string; icon: typeof TerminalIcon }> = [
  { id: "terminal", label: "Shell", icon: TerminalIcon },
  { id: "files", label: "Files", icon: Files },
  { id: "pi", label: "Pi", icon: Settings2 },
  { id: "extensions", label: "Extensions", icon: Plug },
  { id: "ports", label: "Ports", icon: Link2 },
  { id: "code", label: "code-server", icon: Code2 }
];

export function RightPanel({ box, boxes = [], sessionId, sessionCwd, onRefresh }: { box?: BoxRecord; boxes?: BoxRecord[]; sessionId?: string; sessionCwd?: string; onRefresh: () => void }) {
  const [tab, setTab] = useState<RightPanelTab>("terminal");
  const boxId = box?.id;
  return <aside className="rightbar">
    <div className="tabs">
      {RIGHT_PANEL_TABS.map((item) => {
        const Icon = item.icon;
        const active = tab === item.id;
        return <button key={item.id} className={active ? "active" : ""} title={item.label} aria-label={item.label} onClick={() => setTab(item.id)}>
          <Icon size={15} />{active && <span className="tab-label">{item.label}</span>}
        </button>;
      })}
    </div>
    {tab === "terminal" && <div className="panel terminal-panel"><TerminalPane boxId={boxId} /></div>}
    {tab === "files" && <FileBrowser key={boxId ?? "none"} boxId={boxId} />}
    {tab === "pi" && <PiSettingsPane box={box} onSaved={onRefresh} />}
    {tab === "extensions" && <PiExtensionsPane box={box} boxes={boxes} sessionId={sessionId} sessionCwd={sessionCwd} onSessionReloaded={onRefresh} />}
    {tab === "ports" && <PortMappingsPane box={box} onRefresh={onRefresh} />}
    {tab === "code" && <div className="panel">
      {boxId ? <>
        <p>code-server 通过 BoxedAgent 反向代理访问。</p>
        <a href={api.codeServerUrl(boxId)} target="_blank" rel="noreferrer"><button className="primary">打开 code-server</button></a>
        <p className="small">默认密码：{box?.codeServerPassword || "boxedagent"}。首次启动可能需要数秒。</p>
      </> : <p className="small">请选择 Box</p>}
    </div>}
  </aside>;
}
