import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, PlugZap, RotateCcw, SquareTerminal } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { closeWebSocketQuietly, wsUrl } from "../lib/api";
import type { AgentSessionRecord } from "../lib/types";

export function TuiSessionPane({ session }: { session?: AgentSessionRecord }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const wsRef = useRef<WebSocket>();
  const resizeTimer = useRef<number>();
  const [connected, setConnected] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string>();
  const [size, setSize] = useState("—");

  useEffect(() => {
    setConnected(Boolean(session?.id));
    setError(undefined);
    setSize("—");
  }, [session?.id]);

  function fitAndNotify() {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !hostRef.current) return;
    try {
      fit.fit();
      setSize(`${term.cols}×${term.rows}`);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    } catch {
    }
  }

  useEffect(() => {
    if (!session?.id || !hostRef.current || !connected) return;
    setError(undefined);
    const term = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
      lineHeight: 1,
      letterSpacing: 0,
      scrollback: 50_000,
      convertEol: false,
      macOptionIsMeta: true,
      theme: {
        background: "#101014",
        foreground: "#ECE6F0",
        cursor: "#D0BCFF",
        cursorAccent: "#1D1B20",
        selectionBackground: "#4A4458",
        black: "#1D1B20",
        red: "#F2B8B5",
        green: "#B5CEA8",
        yellow: "#E6C87C",
        blue: "#A8C7FA",
        magenta: "#D0BCFF",
        cyan: "#8DDDD0",
        white: "#E6E1E5",
        brightBlack: "#49454F",
        brightRed: "#FFDAD6",
        brightGreen: "#D9E7CB",
        brightYellow: "#FFE08A",
        brightBlue: "#D3E3FD",
        brightMagenta: "#EADDFF",
        brightCyan: "#AEEFE3",
        brightWhite: "#FFFBFE"
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const scheduleFit = () => {
      if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(fitAndNotify, 35);
    };

    requestAnimationFrame(() => {
      fitAndNotify();
      term.writeln("\x1b[38;5;141mAttaching to pi TUI session…\x1b[0m");
      const cols = term.cols || 120;
      const rows = term.rows || 32;
      const ws = new WebSocket(wsUrl(`/ws/sessions/${session.id}/tui?cols=${cols}&rows=${rows}`));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onmessage = async (event) => {
        if (typeof event.data !== "string") {
          const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
          term.write(new Uint8Array(data));
          return;
        }
        const msg = JSON.parse(event.data);
        if (msg.type === "error") {
          setError(msg.error);
          term.writeln(`\r\n\x1b[31m${msg.error}\x1b[0m`);
        }
        if (msg.type === "ready") {
          term.clear();
          fitAndNotify();
          term.focus();
        }
      };
      ws.onerror = () => setError("TUI session websocket failed");
      ws.onclose = () => setConnected(false);
    });

    const input = term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(hostRef.current);
    window.addEventListener("resize", scheduleFit);
    void document.fonts?.ready.then(scheduleFit).catch(() => undefined);

    return () => {
      if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
      window.removeEventListener("resize", scheduleFit);
      ro.disconnect();
      input.dispose();
      const ws = wsRef.current;
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
      }
      closeWebSocketQuietly(ws);
      wsRef.current = undefined;
      fitRef.current = undefined;
      termRef.current = undefined;
      term.dispose();
    };
  }, [session?.id, connected]);

  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(fitAndNotify));
  }, [fullscreen]);

  if (!session) return null;
  return <div className={`tui-session-shell terminal-shell ${fullscreen ? "fullscreen" : ""}`}>
    <div className="terminal-topbar">
      <div className="row"><SquareTerminal size={15} /> TUI Session <span className="terminal-size">{size}</span></div>
      <div className="row">
        {connected && <button className="button-tonal compact" onClick={() => { setConnected(false); setTimeout(() => setConnected(true), 60); }}><RotateCcw size={14} /> 重连</button>}
        <button className="button-tonal compact" onClick={() => setFullscreen((v) => !v)}>{fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{fullscreen ? "退出" : "全屏"}</button>
      </div>
    </div>
    <div className="terminal-wrap">
      {!connected && <div className="terminal-overlay">
        <button className="primary" onClick={() => setConnected(true)}><PlugZap size={15} /> 重新连接 TUI</button>
        <p className="small">TUI 进程会保留在后端；关闭页面只会 detach，不会结束 pi。</p>
        {error && <p className="small error-text">{error}</p>}
      </div>}
      <div ref={hostRef} className="terminal" />
    </div>
  </div>;
}
