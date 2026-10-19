import type { WebSocket } from "ws";
import type { WsEvent } from "@ai-caller/shared";

/** Fan-out of call events to signed-in dashboard sockets; each socket only gets its own user's events. */
export class Hub {
  private sockets = new Map<WebSocket, string>();

  /** Registers a socket whose session cookie was already checked on upgrade. */
  accept(ws: WebSocket, userId: string) {
    this.sockets.set(ws, userId);
    ws.on("close", () => this.sockets.delete(ws));
    ws.send(JSON.stringify({ type: "ready" }));
  }

  /** Closes every socket of a user (sign-out, account removal). */
  disconnect(userId: string) {
    for (const [ws, uid] of this.sockets) if (uid === userId) ws.close(4401, "signed out");
  }

  emit(userId: string, event: WsEvent) {
    const data = JSON.stringify(event);
    for (const [ws, uid] of this.sockets) if (uid === userId && ws.readyState === ws.OPEN) ws.send(data);
  }
}
