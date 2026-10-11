import type { WebSocket } from "ws";
import type { WsEvent } from "@ai-caller/shared";
import { safeEqual } from "./crypto.js";

/** Fan-out of call events to authenticated dashboard sockets, keyed by user. */
export class Hub {
  private sockets = new Map<WebSocket, string>();

  /** First message must be {type:"auth", token}; a bad token or 5 s of silence closes with 4401. */
  accept(ws: WebSocket, token: string, userId: string) {
    const timer = setTimeout(() => ws.close(4401, "auth timeout"), 5000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      let msg: { type?: string; token?: string } = {};
      try {
        msg = JSON.parse(String(data));
      } catch {
        // invalid JSON is treated as a bad token
      }
      if (msg.type !== "auth" || typeof msg.token !== "string" || !safeEqual(msg.token, token)) {
        ws.close(4401, "unauthorized");
        return;
      }
      this.sockets.set(ws, userId);
      ws.send(JSON.stringify({ type: "ready" }));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(ws);
    });
  }

  emit(userId: string, event: WsEvent) {
    const data = JSON.stringify(event);
    for (const [ws, uid] of this.sockets) if (uid === userId && ws.readyState === ws.OPEN) ws.send(data);
  }
}
