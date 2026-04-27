import type { FastifyInstance } from "fastify";
import httpProxy from "http-proxy";
import { WebSocket } from "ws";
import { store } from "../core/store.js";
import { dockerService } from "../docker/docker-service.js";

function rewriteUrl(original: string | undefined, boxId: string): string {
  const url = original ?? "/";
  const prefix = `/codeserver/${boxId}`;
  const stripped = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  return stripped || "/";
}

function serializeProxyBody(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
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

function upstreamHeaders(headers: Record<string, string | string[] | undefined>, target: string) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    // code-server validates WebSocket Origin against its own bind host. Browser
    // requests hit BoxedAgent's public origin, so forwarding that origin makes
    // upstream reject the upgrade with 403. Let ws generate protocol headers and
    // rewrite Origin to the upstream target origin.
    if (["host", "connection", "upgrade", "origin", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"].includes(lower)) continue;
    if (value === undefined) continue;
    next[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  next.origin = new URL(target).origin;
  return next;
}

export async function registerCodeServerProxy(app: FastifyInstance) {
  // code-server login posts application/x-www-form-urlencoded. Fastify rejects
  // unknown content-types before our proxy handler unless we register a parser.
  // We keep the raw string so the proxy can replay the exact form body upstream.
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));
  }
  if (!app.hasContentTypeParser("text/plain")) {
    app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => done(null, body));
  }

  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: true });
  app.addHook("onClose", (_instance, done) => {
    proxy.close();
    done();
  });

  proxy.on("proxyReq", (proxyReq, req) => {
    const body = (req as any).boxedAgentProxyBody as Buffer | undefined;
    if (!body) return;
    proxyReq.setHeader("content-length", String(body.length));
    proxyReq.write(body);
  });

  proxy.on("error", (err, _req, res) => {
    app.log.warn({ err }, "code-server proxy error");
    if (res && "writeHead" in res && !res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "code-server proxy error" }));
    }
  });

  const wsHandler = async (client: WebSocket, req: any) => {
    const { boxId } = req.params as { boxId: string };
    let upstream: WebSocket | undefined;
    let clientClosed = false;
    let clientCloseCode: number | undefined;
    let clientCloseReason: Buffer | undefined;
    const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

    // Register browser-side listeners synchronously. VS Code sends its first
    // protocol bytes immediately after the WebSocket opens; if we await Docker
    // inspection/startup first, ws may emit and drop that first message before a
    // listener exists, making code-server's application-level handshake timeout.
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
      const box = store.getBox(boxId);
      const target = await dockerService.codeServerTarget(box);
      const upstreamUrl = toWsUrl(target, rewriteUrl(req.raw.url, boxId));
      upstream = new WebSocket(upstreamUrl, { headers: upstreamHeaders(req.headers as any, target), perMessageDeflate: false });

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
        app.log.warn({ err: error }, "code-server upstream websocket error");
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(1011, "upstream websocket error");
      });
    } catch (error) {
      app.log.warn({ err: error }, "code-server websocket bridge failed");
      if (upstream) upstream.terminate();
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(1011, "code-server websocket bridge failed");
    }
  };

  const httpHandler = async (req: any, reply: any) => {
    const { boxId } = req.params as { boxId: string };
    const box = await store.patchBox(boxId, { status: "starting", error: undefined });
    const started = await dockerService.start(box);
    await store.patchBox(boxId, { containerId: started.containerId, status: "running", lastActiveAt: new Date().toISOString(), error: undefined });
    const target = await dockerService.codeServerTarget(box);
    req.raw.url = rewriteUrl(req.raw.url, boxId);
    (req.raw as any).boxedAgentProxyBody = serializeProxyBody(req.body);
    reply.hijack();
    proxy.web(req.raw, reply.raw, { target }, (error) => {
      app.log.warn({ err: error }, "code-server proxy request failed");
      if (!reply.raw.headersSent) reply.raw.writeHead(502, { "content-type": "application/json" });
      if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify({ error: "code-server proxy error" }));
    });
  };

  app.route({ method: "GET", url: "/codeserver/:boxId/*", handler: httpHandler, wsHandler });
  app.route({ method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"], url: "/codeserver/:boxId/*", handler: httpHandler });

  app.get("/api/boxes/:boxId/codeserver", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const box = store.getBox(boxId);
    const target = await dockerService.codeServerTarget(box);
    return { url: `/codeserver/${boxId}/`, target };
  });
}
