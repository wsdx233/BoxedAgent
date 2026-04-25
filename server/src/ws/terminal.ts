import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { dockerService } from "../docker/docker-service.js";
import { store } from "../core/store.js";

export async function registerTerminalWs(app: FastifyInstance) {
  app.get("/ws/boxes/:boxId/terminal", { websocket: true }, async (socket: WebSocket, req) => {
    const { boxId } = req.params as { boxId: string };
    let stream: NodeJS.ReadWriteStream | undefined;
    try {
      const box = await store.patchBox(boxId, { status: "starting", error: undefined });
      const started = await dockerService.start(box);
      await store.patchBox(boxId, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString(), error: undefined });
      const query = req.query as { cols?: string; rows?: string };
      const initialCols = Math.max(20, Math.min(400, Number(query.cols) || 120));
      const initialRows = Math.max(8, Math.min(120, Number(query.rows) || 32));
      const exec = await dockerService.createInteractiveExec(box, ["/bin/bash", "-l"], {
        cwd: "/workspace",
        env: [
          "TERM=xterm-256color",
          "COLORTERM=truecolor",
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
          `COLUMNS=${initialCols}`,
          `LINES=${initialRows}`
        ],
        tty: true
      });
      stream = await exec.start({ hijack: true, stdin: true }) as NodeJS.ReadWriteStream;
      await exec.resize({ h: initialRows, w: initialCols }).catch(() => undefined);

      socket.send(JSON.stringify({ type: "ready", cols: initialCols, rows: initialRows }));
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const forward = (chunk: Buffer | string) => {
        // Dockerode exec streams are multiplexed with an 8-byte stdout/stderr
        // header even for TTY execs in our environment. Strip that header with
        // demuxStream, then forward payload bytes directly. Sending raw bytes
        // lets xterm's UTF-8 decoder handle multi-byte line drawing safely.
        if (socket.readyState === socket.OPEN) socket.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), { binary: true });
      };
      dockerService.docker.modem.demuxStream(stream, stdout, stderr);
      stdout.on("data", forward);
      stderr.on("data", forward);
      stream.on("error", (error) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "error", error: error.message }));
      });
      stream.on("close", () => socket.close());

      socket.on("message", async (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "input") stream?.write(String(msg.data ?? ""));
        if (msg.type === "resize") await exec.resize({ h: Number(msg.rows) || 24, w: Number(msg.cols) || 80 }).catch(() => undefined);
      });
      socket.on("close", () => (stream as any)?.destroy?.());
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, "terminal websocket failed");
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "error", error: text }));
        socket.close();
      }
    }
  });
}
