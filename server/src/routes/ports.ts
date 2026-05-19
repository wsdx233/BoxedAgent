import type { FastifyInstance } from "fastify";
import httpProxy from "http-proxy";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { badRequest, notFound } from "../core/errors.js";
import { store } from "../core/store.js";
import type { BoxPortMapping, BoxRecord } from "../core/types.js";
import { dockerService } from "../docker/docker-service.js";
import { wsHub } from "../ws/hub.js";

const SlugSchema = z.string().trim().min(2).max(64).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i, "URL 标识只能包含字母、数字、-、_，且必须以字母或数字开头/结尾");

const OpenPathSchema = z.string().trim().max(600).optional().transform((value) => normalizeOpenPath(value));

const CreatePortMapping = z.object({
  name: z.string().trim().max(80).optional(),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["http", "https"]).default("http"),
  slug: SlugSchema,
  openPath: OpenPathSchema
});

const PatchPortMapping = z.object({
  name: z.string().trim().max(80).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(["http", "https"]).optional(),
  slug: SlugSchema.optional(),
  openPath: OpenPathSchema
});

function normalizeOpenPath(value?: string): string | undefined {
  if (!value || value === "/") return undefined;
  return value.startsWith("/") ? value : `/${value}`;
}


function rewriteUrl(original: string | undefined, slug: string): string {
  const url = original ?? "/";
  const prefix = `/ports/${slug}`;
  const stripped = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  return stripped || "/";
}

function serializeProxyBody(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

function toWsUrl(httpTarget: string, pathAndQuery: string): string {
  const base = httpTarget.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
  return `${base}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
}

function validCloseCode(code: number): number | undefined {
  if (!Number.isInteger(code)) return undefined;
  if (code < 1000 || code > 4999) return undefined;
  if (code === 1005 || code === 1006 || code === 1015) return undefined;
  return code;
}

function upstreamHeaders(headers: Record<string, string | string[] | undefined>, target: string, forwardedPrefix?: string) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["host", "connection", "upgrade", "origin", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"].includes(lower)) continue;
    if (value === undefined) continue;
    next[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  next.origin = new URL(target).origin;
  if (forwardedPrefix) next["x-forwarded-prefix"] = forwardedPrefix;
  return next;
}

function publicPath(slug: string) {
  return `/ports/${slug}`;
}

function publicUrl(slug: string, openPath?: string) {
  return `${publicPath(slug)}${openPath || "/"}`;
}

function cloneMapping(mapping: BoxPortMapping): BoxPortMapping {
  return JSON.parse(JSON.stringify(mapping)) as BoxPortMapping;
}

function findPortMapping(slug: string): { box: BoxRecord; mapping: BoxPortMapping } {
  for (const box of store.listBoxes()) {
    const mapping = (box.portMappings ?? []).find((item) => item.slug === slug);
    if (mapping) return { box, mapping: cloneMapping(mapping) };
  }
  throw notFound("port mapping");
}

function assertSlugAvailable(slug: string, current?: { boxId: string; mappingId: string }) {
  const existing = findMappingBySlug(slug);
  if (!existing) return;
  if (current && existing.box.id === current.boxId && existing.mapping.id === current.mappingId) return;
  throw badRequest(`URL 标识已被占用: ${slug}`);
}

function findMappingBySlug(slug: string): { box: BoxRecord; mapping: BoxPortMapping } | undefined {
  for (const box of store.listBoxes()) {
    const mapping = (box.portMappings ?? []).find((item) => item.slug === slug);
    if (mapping) return { box, mapping: cloneMapping(mapping) };
  }
  return undefined;
}

function rewriteLocationHeader(location: string | undefined, target: string, slug: string): string | undefined {
  if (!location) return location;
  const prefix = publicPath(slug);
  try {
    const targetUrl = new URL(target);
    const value = new URL(location, targetUrl);
    if (value.origin === targetUrl.origin) return `${prefix}${value.pathname}${value.search}${value.hash}`;
  } catch {
    // Keep unknown Location values unchanged.
  }
  if (location.startsWith("/")) return `${prefix}${location}`;
  return location;
}

async function ensurePortTarget(box: BoxRecord, port: number, protocol: "http" | "https"): Promise<{ box: BoxRecord; target: string }> {
  const starting = await store.patchBox(box.id, { status: "starting", error: undefined });
  wsHub.publishGlobal({ type: "boxes_changed" });
  wsHub.publishBox(box.id, { type: "box_updated", box: starting });
  const started = await dockerService.start(starting);
  const running = await store.patchBox(box.id, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString(), error: undefined });
  wsHub.publishGlobal({ type: "boxes_changed" });
  wsHub.publishBox(box.id, { type: "box_updated", box: running });
  return { box: running, target: await dockerService.boxPortTarget(running, port, protocol) };
}

export async function registerPortProxyRoutes(app: FastifyInstance) {
  if (!app.hasContentTypeParser("*")) {
    app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  }

  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: true });
  app.addHook("onClose", (_instance, done) => {
    proxy.close();
    done();
  });

  proxy.on("proxyReq", (proxyReq, req) => {
    const meta = (req as any).boxedAgentPortProxy as { target?: string; slug?: string } | undefined;
    if (meta?.slug) proxyReq.setHeader("x-forwarded-prefix", publicPath(meta.slug));
    const body = (req as any).boxedAgentProxyBody as Buffer | undefined;
    if (!body) return;
    proxyReq.setHeader("content-length", String(body.length));
    proxyReq.write(body);
  });

  proxy.on("proxyRes", (proxyRes, req) => {
    const meta = (req as any).boxedAgentPortProxy as { target?: string; slug?: string } | undefined;
    if (!meta?.target || !meta.slug) return;
    const location = proxyRes.headers.location;
    if (typeof location === "string") proxyRes.headers.location = rewriteLocationHeader(location, meta.target, meta.slug);
  });

  proxy.on("error", (err, _req, res) => {
    app.log.warn({ err }, "port proxy error");
    if (res && "writeHead" in res && !res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "port proxy error" }));
    }
  });

  const wsHandler = async (client: WebSocket, req: any) => {
    const { slug } = req.params as { slug: string };
    let upstream: WebSocket | undefined;
    let clientClosed = false;
    let clientCloseCode: number | undefined;
    let clientCloseReason: Buffer | undefined;
    const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

    client.on("message", (data, isBinary) => {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push({ data, isBinary });
    });
    client.on("close", (code, reason) => {
      clientClosed = true;
      clientCloseCode = code;
      clientCloseReason = Buffer.from(reason);
      const closeCode = validCloseCode(code);
      if (upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) {
        if (closeCode) upstream.close(closeCode, reason);
        else upstream.close();
      }
    });
    client.on("error", () => upstream?.terminate());

    try {
      const { box, mapping } = findPortMapping(slug);
      const { target } = await ensurePortTarget(box, mapping.port, mapping.protocol);
      const upstreamUrl = toWsUrl(target, rewriteUrl(req.raw.url, slug));
      upstream = new WebSocket(upstreamUrl, { headers: upstreamHeaders(req.headers as any, target, publicPath(slug)), perMessageDeflate: false });

      upstream.on("open", () => {
        if (clientClosed) {
          const closeCode = validCloseCode(clientCloseCode ?? 1000);
          if (closeCode) upstream!.close(closeCode, clientCloseReason);
          else upstream!.close();
          return;
        }
        for (const item of pending.splice(0)) upstream!.send(item.data, { binary: item.isBinary });
      });
      upstream.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      upstream.on("close", (code, reason) => {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          const closeCode = validCloseCode(code);
          if (closeCode) client.close(closeCode, reason);
          else client.close();
        }
      });
      upstream.on("error", (error) => {
        app.log.warn({ err: error, slug }, "port upstream websocket error");
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(1011, "upstream websocket error");
      });
    } catch (error) {
      app.log.warn({ err: error, slug }, "port websocket bridge failed");
      if (upstream) upstream.terminate();
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(1011, "port websocket bridge failed");
    }
  };

  const httpHandler = async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const { box, mapping } = findPortMapping(slug);
    const { target } = await ensurePortTarget(box, mapping.port, mapping.protocol);
    req.raw.url = rewriteUrl(req.raw.url, slug);
    (req.raw as any).boxedAgentProxyBody = serializeProxyBody(req.body);
    (req.raw as any).boxedAgentPortProxy = { target, slug };
    reply.hijack();
    proxy.web(req.raw, reply.raw, { target }, (error) => {
      app.log.warn({ err: error, slug }, "port proxy request failed");
      if (!reply.raw.headersSent) reply.raw.writeHead(502, { "content-type": "application/json" });
      if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify({ error: "port proxy error" }));
    });
  };

  app.get("/api/boxes/:boxId/ports", async (req) => {
    const box = store.getBox((req.params as any).boxId);
    return { mappings: box.portMappings ?? [] };
  });

  app.post("/api/boxes/:boxId/ports", async (req, reply) => {
    const boxId = (req.params as any).boxId as string;
    const body = CreatePortMapping.parse(req.body ?? {});
    const box = store.getBox(boxId);
    assertSlugAvailable(body.slug);
    const now = new Date().toISOString();
    const mapping: BoxPortMapping = {
      id: `port_${randomUUID()}`,
      name: body.name || `${body.protocol.toUpperCase()} ${body.port}`,
      port: body.port,
      protocol: body.protocol,
      slug: body.slug,
      openPath: body.openPath,
      createdAt: now,
      updatedAt: now
    };
    const next = await store.patchBox(boxId, { portMappings: [...(box.portMappings ?? []), mapping] });
    wsHub.publishGlobal({ type: "boxes_changed" });
    wsHub.publishBox(boxId, { type: "box_updated", box: next });
    reply.code(201);
    return { mapping, url: publicUrl(mapping.slug, mapping.openPath), box: next };
  });

  app.patch("/api/boxes/:boxId/ports/:mappingId", async (req) => {
    const { boxId, mappingId } = req.params as { boxId: string; mappingId: string };
    const body = PatchPortMapping.parse(req.body ?? {});
    const box = store.getBox(boxId);
    const mappings = box.portMappings ?? [];
    const index = mappings.findIndex((mapping) => mapping.id === mappingId);
    if (index < 0) throw notFound("port mapping");
    if (body.slug) assertSlugAvailable(body.slug, { boxId, mappingId });
    const nextMapping: BoxPortMapping = {
      ...mappings[index],
      ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)),
      updatedAt: new Date().toISOString()
    };
    const nextMappings = mappings.map((mapping, i) => i === index ? nextMapping : mapping);
    const next = await store.patchBox(boxId, { portMappings: nextMappings });
    wsHub.publishGlobal({ type: "boxes_changed" });
    wsHub.publishBox(boxId, { type: "box_updated", box: next });
    return { mapping: nextMapping, url: publicUrl(nextMapping.slug, nextMapping.openPath), box: next };
  });

  app.delete("/api/boxes/:boxId/ports/:mappingId", async (req) => {
    const { boxId, mappingId } = req.params as { boxId: string; mappingId: string };
    const box = store.getBox(boxId);
    const mappings = box.portMappings ?? [];
    if (!mappings.some((mapping) => mapping.id === mappingId)) throw notFound("port mapping");
    const next = await store.patchBox(boxId, { portMappings: mappings.filter((mapping) => mapping.id !== mappingId) });
    wsHub.publishGlobal({ type: "boxes_changed" });
    wsHub.publishBox(boxId, { type: "box_updated", box: next });
    return { ok: true, box: next };
  });

  app.route({ method: "GET", url: "/ports/:slug", handler: httpHandler, wsHandler });
  app.route({ method: "GET", url: "/ports/:slug/*", handler: httpHandler, wsHandler });
  app.route({ method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"], url: "/ports/:slug", handler: httpHandler });
  app.route({ method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"], url: "/ports/:slug/*", handler: httpHandler });
}
