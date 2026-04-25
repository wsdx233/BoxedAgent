import type { WebSocket } from "ws";

export type Topic = `box:${string}` | `session:${string}` | "global";

export class WsHub {
  private topics = new Map<Topic, Set<WebSocket>>();

  subscribe(topic: Topic, socket: WebSocket) {
    const set = this.topics.get(topic) ?? new Set<WebSocket>();
    set.add(socket);
    this.topics.set(topic, set);
    socket.on("close", () => set.delete(socket));
  }

  publish(topic: Topic, payload: unknown) {
    const data = JSON.stringify(payload);
    for (const socket of this.topics.get(topic) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  publishBox(boxId: string, event: unknown) { this.publish(`box:${boxId}`, event); }
  publishSession(sessionId: string, event: unknown) { this.publish(`session:${sessionId}`, event); }
  publishGlobal(event: unknown) { this.publish("global", event); }
}

export const wsHub = new WsHub();
