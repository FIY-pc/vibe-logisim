/**
 * Edits, undo and redo answer with a `DocumentChange`: the view's fields at
 * the new revision, only the circuits that changed, and every circuit's name
 * in order. Shared by the window and the AI sidecar, which both hold whole
 * views and take changes into them.
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

/** Consecutive changes of one document as one change from the first base. */
export function combineChanges(changes: DocumentChange[]): DocumentChange {
  const last = changes[changes.length - 1];
  const latest = new Map<string, DocumentChange["circuits"][number]>();
  // Each circuit's conflicts come from the change its content comes from.
  const widths = new Map<string, [number, number][]>();
  for (const change of changes)
    for (const circuit of change.circuits) {
      latest.set(circuit.name, circuit);
      const points = change.widthErrors?.[circuit.name];
      if (points) widths.set(circuit.name, points);
      else widths.delete(circuit.name);
    }
  const circuits = last.order.flatMap((name) => latest.get(name) ?? []);
  return {
    ...last,
    base: changes[0].base,
    circuits,
    widthErrors: Object.fromEntries(
      circuits.flatMap((c) => {
        const points = widths.get(c.name);
        return points ? [[c.name, points]] : [];
      }),
    ),
  };
}
