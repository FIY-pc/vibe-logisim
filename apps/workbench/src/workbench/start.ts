import { persistLayout } from "../stores/shell";
import type { Workbench } from "./createWorkbench";

/** Starts everything that outlives a single render. App calls this from an
 * effect, after child effects have run, so the host sees the same request
 * order as before the split. */
export function startWorkbench({ stores }: Workbench): () => void {
  const stops = [persistLayout(stores.shell)];
  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
