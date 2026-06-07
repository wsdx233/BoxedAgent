import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { PassThrough } from "node:stream";
import type { BoxRecord, PiModel } from "../core/types.js";
import { dockerService } from "../docker/docker-service.js";
import { store } from "../core/store.js";
import { piRuntimeEnv } from "./pi-config.js";
import { PI_BIN_IN_CONTAINER } from "./pi-args.js";
import { ensureCompatiblePiCli } from "./pi-version.js";

export async function listAvailableModelsForBox(box: BoxRecord): Promise<PiModel[]> {
  const starting = await store.patchBox(box.id, { status: "starting", error: undefined });
  const started = await dockerService.start(starting);
  const runningBox = await store.patchBox(box.id, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString(), error: undefined });
  await ensureCompatiblePiCli(runningBox);

  const args = [PI_BIN_IN_CONTAINER, "--mode", "rpc", "--session-dir", `/tmp/boxedagent-model-probe-${randomUUID()}`];
  const exec = await dockerService.createInteractiveExec(box, args, { cwd: "/workspace", tty: false, env: piRuntimeEnv(box) });
  const stream = await exec.start({ hijack: true, stdin: true }) as NodeJS.ReadWriteStream;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderrText = "";

  dockerService.docker.modem.demuxStream(stream, stdout, stderr);

  try {
    return await new Promise<PiModel[]>((resolve, reject) => {
      const id = `req_${Date.now()}`;
      const timer = setTimeout(() => reject(new Error(`Timed out loading pi models${stderrText ? `: ${stderrText.slice(-500)}` : ""}`)), 45_000);
      const cleanup = () => clearTimeout(timer);

      stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });
      stream.on("error", (error) => { cleanup(); reject(error); });
      stream.on("close", () => { cleanup(); reject(new Error(`pi model probe exited${stderrText ? `: ${stderrText.slice(-500)}` : ""}`)); });
      stdout.on("data", (chunk) => {
        stdoutBuffer += decoder.write(chunk as Buffer);
        while (true) {
          const idx = stdoutBuffer.indexOf("\n");
          if (idx < 0) break;
          let line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.trim()) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "response" && msg.id === id) {
            cleanup();
            if (msg.success) resolve(Array.isArray(msg.data?.models) ? msg.data.models : []);
            else reject(new Error(msg.error ?? "failed to load models"));
          }
        }
      });

      stream.write(`${JSON.stringify({ id, type: "get_available_models" })}\n`, "utf8", (error) => {
        if (error) {
          cleanup();
          reject(error);
        }
      });
    });
  } finally {
    (stream as any)?.destroy?.();
  }
}
