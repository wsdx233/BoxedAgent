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
import { registerEventWs } from "./ws/events.js";
import { registerTerminalWs } from "./ws/terminal.js";
import { registerCodeServerProxy } from "./routes/codeserver.js";
import { agentManager } from "./agent/agent-manager.js";

export async function buildServer() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

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

  await app.register(cors, { origin: true, credentials: true });
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
  await registerCodeServerProxy(app);

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
  const shutdown = async () => {
    app.log.info("shutting down");
    await agentManager.stopAll();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await app.listen({ host: env.HOST, port: env.PORT });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
