/**
 * Edits, undo and redo answer with a `DocumentChange`: the view's fields at
 * the new revision, only the circuits that changed, and every circuit's name
 * in order. The window and the scripts hold whole views and take changes
 * into them with it; the sidecar holds none.
 */
import type { DocumentChange } from "../generated/DocumentChange.ts";
import type { DocumentView } from "../generated/DocumentView.ts";

/**
 * The view at `change.revision`, made from `view`; null when `view` is not
 * the view at `change.base` (read the document again then). A view already
 * at the new revision takes the change's fields (dirty, notes) and keeps its
 * circuits.
 */
export function applyDocumentChange(
  view: DocumentView | undefined,
  change: DocumentChange,
): DocumentView | null {
  if (!view || view.id !== change.id) return null;
  // Width conflicts belong to the canvas, not to the view.
  const { base, order, circuits: changed, widthErrors, ...fields } = change;
  if (view.revision === change.revision) return { ...view, ...fields };
  if (view.revision !== base) return null;
  const circuits = [];
  for (const name of order) {
    const circuit =
      changed.find((c) => c.name === name) ??
      view.circuits.find((c) => c.name === name);
    if (!circuit) return null;
    circuits.push(circuit);
  }
  return { ...fields, circuits };
}
