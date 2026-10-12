"use client";
import { useEffect, useRef } from "react";
import type { WsEvent } from "@ai-caller/shared";
import { getToken, wsUrl } from "./api";

export type LiveEvent = WsEvent | { type: "ready" };
type Listener = (e: LiveEvent) => void;

// One shared socket for the whole tab; it reconnects while anything is listening.
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect() {
  clearTimeout(retry);
  const ws = new WebSocket(wsUrl());
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: getToken() }));
  ws.onmessage = (msg) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(String(msg.data));
    } catch {
      return;
    }
    for (const l of listeners) l(event);
  };
  ws.onclose = (e) => {
    if (socket === ws) socket = null;
    if (listeners.size) retry = setTimeout(connect, e.code === 4401 ? 5000 : 1500);
  };
}

/** Subscribes to server events; a "ready" event fires after every (re)connect so callers can refetch. */
export function useEvents(onEvent: Listener) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    if (!socket) connect();
    return () => {
      listeners.delete(l);
      if (!listeners.size) {
        clearTimeout(retry);
        socket?.close();
        socket = null;
      }
    };
  }, []);
}
