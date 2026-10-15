import { persistLayout } from "../stores/shell";
import type { Workbench } from "./createWorkbench";

/** Starts everything that outlives a single render. App calls this from an
 * effect, after child effects have run, so the host sees the same request
 * order as before the split. */
export function startWorkbench({ stores, actions }: Workbench): () => void {
  const stops = [
    persistLayout(stores.shell),
    actions.workspace.watchSource(),
    actions.editor.watchCatalog(),
  ];
  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
