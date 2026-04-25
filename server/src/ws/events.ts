import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { wsHub } from "./hub.js";

export async function registerEventWs(app: FastifyInstance) {
  app.get("/ws/events", { websocket: true }, (socket: WebSocket) => {
    wsHub.subscribe("global", socket);
    socket.send(JSON.stringify({ type: "hello", scope: "global" }));
  });

  app.get("/ws/boxes/:boxId/events", { websocket: true }, (socket: WebSocket, req) => {
    const { boxId } = req.params as { boxId: string };
    wsHub.subscribe(`box:${boxId}`, socket);
    socket.send(JSON.stringify({ type: "hello", scope: "box", boxId }));
  });

  app.get("/ws/sessions/:sessionId/events", { websocket: true }, (socket: WebSocket, req) => {
    const { sessionId } = req.params as { sessionId: string };
    wsHub.subscribe(`session:${sessionId}`, socket);
    socket.send(JSON.stringify({ type: "hello", scope: "session", sessionId }));
  });
}
