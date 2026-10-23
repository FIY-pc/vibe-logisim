import type { SimulationEvent } from "../generated/SimulationEvent";
import { subscribeEvents } from "../shared/events";
import type { Actions, Stores } from "./createWorkbench";
import { reaction } from "./reaction";

/** Applies host events: simulation frames, resynchronization after a
 * (re)connection, connection failures and warnings about changes that took
 * effect while something around them failed. Returns the stop. */
export function routeEvents(
  { documents, notices }: Stores,
  { simulation }: Actions,
): () => void {
  let live = true;
  let version = 0;
  // The first resync only confirms the subscription; the workbench read the
  // workspace when it started. Any later one follows a reconnection or missed
  // events, so the documents may have changed meanwhile.
  let synced = false;
  const stop = subscribeEvents((event) => {
    if (event.topic === "simulation") {
      version++;
      simulation.onEvent(event.data as SimulationEvent);
    }
    if (event.topic === "resync") {
      notices
        .getState()
        .setError((previous) =>
          previous === "连接中断，正在重新连接…" ? "" : previous,
        );
      const requested = ++version;
      void simulation
        .refresh()
        .then(() => {
          if (!live || requested !== version) return;
        })
        .catch(notices.getState().onError);
      if (synced)
        void documents
          .getState()
          .refreshWorkspace()
          .catch(notices.getState().onError);
      synced = true;
    }
    if (event.topic === "warning")
      notices.getState().warn(`host:${event.data.message}`, event.data.message);
    if (event.topic === "connection") notices.getState().onError(event.data);
  });
  return () => {
    live = false;
    stop();
  };
}

/** Shows the conversation tab whenever no document is open. Returns the stop. */
export function showChatWithoutDocument({ documents, shell }: Stores) {
  const activeId = () => {
    const { docs, active } = documents.getState();
    return docs.find((d) => d.id === active)?.id;
  };
  return reaction(
    [documents],
    () => [activeId()],
    ([id]) => {
      if (!id) shell.getState().setRight("chat");
    },
  );
}

/** Asks before the page unloads while a host operation awaits acknowledgement.
 * Returns the stop. */
export function guardUnload({ shell }: Stores) {
  const listener = (e: BeforeUnloadEvent) => {
    // Acknowledged drafts are already checkpointed by Rust. Only warn while an
    // operation is still waiting for acknowledgement, rather than on every reload.
    if (shell.getState().pending) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", listener);
  return () => window.removeEventListener("beforeunload", listener);
}
