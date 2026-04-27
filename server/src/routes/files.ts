import type { FastifyInstance } from "fastify";
import { z } from "zod";
import mime from "mime-types";
import { store } from "../core/store.js";
import { dockerService } from "../docker/docker-service.js";
import { env } from "../config/env.js";

export async function registerFileRoutes(app: FastifyInstance) {
  app.get("/api/boxes/:boxId/files", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const query = z.object({ path: z.string().default(".") }).parse(req.query ?? {});
    const box = store.getBox(boxId);
    return { entries: await dockerService.listFiles(box, query.path) };
  });

  app.get("/api/boxes/:boxId/files/download", async (req, reply) => {
    const { boxId } = req.params as { boxId: string };
    const query = z.object({ path: z.string().min(1) }).parse(req.query ?? {});
    const box = store.getBox(boxId);
    const file = await dockerService.readArchiveFile(box, query.path);
    const type = mime.lookup(file.filename) || "application/octet-stream";
    reply.raw.on("close", () => file.stream.destroy());
    reply.header("content-type", type);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    if (file.size !== undefined) reply.header("content-length", String(file.size));
    return reply.send(file.stream);
  });

  app.post("/api/boxes/:boxId/files/upload", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const query = z.object({ path: z.string().default(".") }).parse(req.query ?? {});
    const file = await req.file({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 } });
    if (!file) throw new Error("missing file");
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) chunks.push(Buffer.from(chunk));
    const box = store.getBox(boxId);
    await dockerService.putFile(box, query.path, file.filename, Buffer.concat(chunks));
    return { ok: true, filename: file.filename };
  });

  app.post("/api/boxes/:boxId/files/mkdir", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const body = z.object({ path: z.string().min(1) }).parse(req.body);
    const box = store.getBox(boxId);
    await dockerService.mkdir(box, body.path);
    return { ok: true };
  });

  app.post("/api/boxes/:boxId/files/copy", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const body = z.object({ source: z.string().min(1), target: z.string().min(1) }).parse(req.body);
    const box = store.getBox(boxId);
    await dockerService.copyPath(box, body.source, body.target);
    return { ok: true };
  });

  app.post("/api/boxes/:boxId/files/move", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const body = z.object({ source: z.string().min(1), target: z.string().min(1) }).parse(req.body);
    const box = store.getBox(boxId);
    await dockerService.movePath(box, body.source, body.target);
    return { ok: true };
  });

  app.delete("/api/boxes/:boxId/files", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const query = z.object({ path: z.string().min(1) }).parse(req.query ?? {});
    const box = store.getBox(boxId);
    await dockerService.deletePath(box, query.path);
    return { ok: true };
  });
}
