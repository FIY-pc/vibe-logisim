import { persistLayout } from "../shell/store";
import type { Workbench } from "./createWorkbench";
import { handleShortcuts } from "./keyboard";
import { guardUnload, routeEvents, showChatWithoutDocument } from "./router";

/** Starts everything that outlives a single render. App calls this from an
 * effect, after child effects have run, so the host sees the same request
 * order as before the split: the update check that a child starts, then the
 * workspace snapshot, then the event subscription. */
export function startWorkbench({ stores, actions }: Workbench): () => void {
  const stops = [
    persistLayout(stores.shell),
    showChatWithoutDocument(stores),
    actions.workspace.watchSource(),
  ];
  void stores.documents
    .getState()
    .refreshWorkspace(true)
    .catch(stores.notices.getState().onError);
  stops.push(
    actions.editor.watchCatalog(),
    routeEvents(stores, actions),
    actions.simulation.start(),
    handleShortcuts(stores, actions),
    guardUnload(stores),
  );
  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
