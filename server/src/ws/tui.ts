import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { agentManager } from "../agent/agent-manager.js";
import { store } from "../core/store.js";

export async function registerTuiWs(app: FastifyInstance) {
  app.get("/ws/sessions/:sessionId/tui", { websocket: true }, async (socket: WebSocket, req) => {
    const { sessionId } = req.params as { sessionId: string };
    let detach: (() => void) | undefined;
    try {
      const session = store.getSession(sessionId);
      if (session.kind !== "tui") throw new Error("session is not a TUI session");
      const query = req.query as { cols?: string; rows?: string };
      const cols = clampInteger(query.cols, 20, 400, 120);
      const rows = clampInteger(query.rows, 8, 160, 32);
      const attached = await agentManager.attachTui(sessionId, { cols, rows });
      const forward = (chunk: Buffer) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
      };
      detach = agentManager.onTuiData(sessionId, forward);

      socket.send(JSON.stringify({ type: "ready", cols: attached.cols, rows: attached.rows }));
      if (attached.history.length > 0 && socket.readyState === socket.OPEN) socket.send(attached.history, { binary: true });

      socket.on("message", async (raw) => {
        try {
          let msg: any;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (msg.type === "input") agentManager.writeTui(sessionId, String(msg.data ?? ""));
          if (msg.type === "resize") await agentManager.resizeTui(sessionId, Number(msg.cols) || 80, Number(msg.rows) || 24).catch(() => undefined);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "error", error: text }));
        }
      });
      socket.on("close", () => detach?.());
    } catch (error) {
      detach?.();
      const text = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, "tui session websocket failed");
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "error", error: text }));
        socket.close();
      }
    }
  });
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
