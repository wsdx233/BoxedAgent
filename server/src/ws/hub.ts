import type { WebSocket } from "ws";
import { truncateTransportPayload } from "../agent/message-truncation.js";

export type Topic = `box:${string}` | `session:${string}` | "global";

const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;

export class WsHub {
  private topics = new Map<Topic, Set<WebSocket>>();
  private queues = new WeakMap<WebSocket, string[]>();
  private flushing = new WeakSet<WebSocket>();

  subscribe(topic: Topic, socket: WebSocket) {
    const set = this.topics.get(topic) ?? new Set<WebSocket>();
    set.add(socket);
    this.topics.set(topic, set);
    socket.on("close", () => {
      set.delete(socket);
      this.queues.delete(socket);
      this.flushing.delete(socket);
    });
  }

  publish(topic: Topic, payload: unknown) {
    const data = JSON.stringify(truncateTransportPayload(payload));
    for (const socket of this.topics.get(topic) ?? []) this.enqueue(socket, data);
  }

  send(socket: WebSocket, payload: unknown) {
    this.enqueue(socket, JSON.stringify(truncateTransportPayload(payload)));
  }

  publishBox(boxId: string, event: unknown) { this.publish(`box:${boxId}`, event); }
  publishSession(sessionId: string, event: unknown) { this.publish(`session:${sessionId}`, event); }
  publishGlobal(event: unknown) { this.publish("global", event); }

  private enqueue(socket: WebSocket, data: string) {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return;
    const queue = this.queues.get(socket) ?? [];
    if (queue.length > 200) queue.shift();
    queue.push(data);
    this.queues.set(socket, queue);
    this.scheduleFlush(socket);
  }

  private scheduleFlush(socket: WebSocket) {
    if (this.flushing.has(socket)) return;
    this.flushing.add(socket);
    setImmediate(() => this.flush(socket));
  }

  private flush(socket: WebSocket) {
    const queue = this.queues.get(socket);
    if (!queue?.length || socket.readyState !== socket.OPEN) {
      this.flushing.delete(socket);
      return;
    }
    const data = queue.shift()!;
    socket.send(data, (error) => {
      if (error || socket.readyState !== socket.OPEN) {
        this.queues.delete(socket);
        this.flushing.delete(socket);
        return;
      }
      if (queue.length) setImmediate(() => this.flush(socket));
      else this.flushing.delete(socket);
    });
  }
}

export const wsHub = new WsHub();
