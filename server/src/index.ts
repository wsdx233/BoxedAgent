import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import fs from "fs-extra";
import { env, ensureDataDirs, paths } from "./config/env.js";
import { store } from "./core/store.js";
import { HttpError } from "./core/errors.js";
import { dockerService } from "./docker/docker-service.js";
import { registerBoxRoutes } from "./routes/boxes.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerPiConfigRoutes } from "./routes/pi-config.js";
import { registerPiExtensionRoutes } from "./routes/pi-extensions.js";
import { registerEventWs } from "./ws/events.js";
import { registerTerminalWs } from "./ws/terminal.js";
import { registerCodeServerProxy } from "./routes/codeserver.js";
import { registerPortProxyRoutes } from "./routes/ports.js";
import { agentManager } from "./agent/agent-manager.js";
import { assertProductionAuthConfigured, registerAuth } from "./auth.js";

export async function buildServer() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, bodyLimit: env.MAX_UPLOAD_MB * 1024 * 1024 });

  app.setErrorHandler((error, _req, reply) => {
    const err = error as any;
    const statusCode = error instanceof HttpError ? error.statusCode : err.statusCode ?? 500;
    if (statusCode >= 500) app.log.error({ err: error }, "request failed");
    else app.log.warn({ err: error }, "request rejected");
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({ error: error.message, code: error.code, details: error.details });
      return;
    }
    reply.status(statusCode).send({ error: err.message ?? "Internal server error", code: statusCode === 500 ? "INTERNAL" : "REQUEST_ERROR" });
  });

  await app.register(cors, { origin: corsOrigin(), credentials: true });
  await registerAuth(app);
  await app.register(websocket, { options: { maxPayload: env.MAX_UPLOAD_MB * 1024 * 1024 } });
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 } });

  app.get("/api/health", async () => {
    let docker = "ok";
    try { await dockerService.ping(); } catch (e) { docker = e instanceof Error ? e.message : String(e); }
    const image = docker === "ok" ? await dockerService.imageStatus(env.BOX_IMAGE).catch((e) => ({ image: env.BOX_IMAGE, available: false, source: "missing", error: e instanceof Error ? e.message : String(e) })) : undefined;
    return { ok: true, docker, image, version: "0.1.0" };
  });

  await registerEventWs(app);
  await registerTerminalWs(app);
  await registerBoxRoutes(app);
  await registerSessionRoutes(app);
  await registerFileRoutes(app);
  await registerPiConfigRoutes(app);
  await registerPiExtensionRoutes(app);
  await registerCodeServerProxy(app);
  await registerPortProxyRoutes(app);

  if (await fs.pathExists(paths.webDistDir)) {
    await app.register(staticPlugin, { root: paths.webDistDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/ws")) {
        reply.status(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  return app;
}

async function main() {
  assertProductionAuthConfigured();
  await ensureDataDirs();
  await store.load();
  await store.pruneOrphanSessions();
  for (const box of store.listBoxes()) {
    try {
      const container = await dockerService.findContainer(box);
      if (container) {
        const info = await container.inspect();
        const status = info.State.Running ? "running" : info.State.Paused ? "paused" : "stopped";
        await store.patchBox(box.id, { containerId: info.Id, status, error: status === "running" ? undefined : box.error });
      } else if (box.containerId || box.status === "running" || box.status === "creating" || box.status === "starting") {
        await store.patchBox(box.id, { containerId: undefined, status: box.status === "creating" ? "error" : "stopped", error: box.status === "creating" ? "container was not created" : box.error });
      }
    } catch (error) {
      await store.patchBox(box.id, { status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const session of store.listSessions()) {
    if (session.status === "running" || session.status === "starting") {
      await store.patchSession(session.id, { status: "stopped" });
    }
  }
  const app = await buildServer();
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      app.log.warn({ signal }, "shutdown already in progress, forcing exit");
      process.exit(1);
    }
    shuttingDown = true;
    const forceExitTimer = setTimeout(() => {
      app.log.warn({ signal }, "shutdown timed out, forcing exit");
      process.exit(1);
    }, 8_000);
    forceExitTimer.unref();

    app.log.info({ signal }, "shutting down");
    closeWebSocketClients(app);
    closeHttpConnections(app);
    await settleShutdownStep("agent runtimes", agentManager.stopAll(), app.log);
    await settleShutdownStep("http server", app.close(), app.log);
    clearTimeout(forceExitTimer);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ host: env.HOST, port: env.PORT });
}

async function settleShutdownStep(label: string, promise: Promise<unknown>, log: { warn: (obj: unknown, msg?: string) => void }) {
  const timeout = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 3_500);
    timer.unref();
  });
  try {
    const result = await Promise.race([promise.then(() => "done" as const), timeout]);
    if (result === "timeout") log.warn({ step: label }, "shutdown step timed out");
  } catch (error) {
    log.warn({ err: error, step: label }, "shutdown step failed");
  }
}

function closeWebSocketClients(app: { websocketServer?: { clients?: Set<{ close: (code?: number, data?: string) => void; terminate: () => void }> } }) {
  for (const client of app.websocketServer?.clients ?? []) {
    try { client.close(1001, "server shutting down"); } catch { /* ignore */ }
    const timer = setTimeout(() => {
      try { client.terminate(); } catch { /* ignore */ }
    }, 1_000);
    timer.unref();
  }
}

function closeHttpConnections(app: { server: { closeIdleConnections?: () => void; closeAllConnections?: () => void } }) {
  try { app.server.closeIdleConnections?.(); } catch { /* ignore */ }
  const timer = setTimeout(() => {
    try { app.server.closeAllConnections?.(); } catch { /* ignore */ }
  }, 1_000);
  timer.unref();
}

function corsOrigin() {
  if (env.PUBLIC_ORIGIN) {
    const allowed = env.PUBLIC_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
    return allowed.length <= 1 ? allowed[0] : allowed;
  }
  return env.NODE_ENV === "development";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
