import { listen } from "@tauri-apps/api/event";
import { desktop } from "./transport";
export interface WorkbenchEvent {
  topic: "agent" | "simulation" | "resync" | "warning" | "connection";
  data: any;
}
type Listener = (event: WorkbenchEvent) => void;
const listeners = new Set<Listener>();
let disconnect: (() => void) | null = null;
let connected = false;
const emit = (event: WorkbenchEvent) => {
  for (const listener of listeners) listener(event);
};
export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  if (!disconnect) {
    if (desktop()) {
      let closed = false;
      let unlisten: (() => void) | undefined;
      disconnect = () => {
        closed = true;
        unlisten?.();
      };
      void listen<WorkbenchEvent>("workbench-event", (event) =>
        emit(event.payload),
      )
        .then((stop) => {
          if (closed) {
            stop();
            return;
          }
          unlisten = stop;
          connected = true;
          emit({ topic: "resync", data: null });
        })
        .catch((error) => {
          if (!closed) emit({ topic: "connection", data: String(error) });
        });
    } else {
      let closed = false;
      let source: EventSource | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let delay = 1000;
      const connect = () => {
        if (closed) return;
        source = new EventSource("/api/events");
        source.onopen = () => {
          connected = true;
          delay = 1000;
        };
        source.onmessage = (event) => emit(JSON.parse(event.data));
        source.onerror = () => {
          source?.close();
          connected = false;
          emit({ topic: "connection", data: "连接中断，正在重新连接…" });
          // EventSource stops retrying after HTTP 5xx from a development proxy.
          // Recreate the connection explicitly; snapshots repair any missed events.
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 15000);
        };
      };
      disconnect = () => {
        closed = true;
        clearTimeout(retry);
        source?.close();
      };
      connect();
    }
  } else if (connected)
    queueMicrotask(() => {
      if (listeners.has(listener)) listener({ topic: "resync", data: null });
    });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      disconnect?.();
      disconnect = null;
      connected = false;
    }
  };
}
