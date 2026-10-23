import type { Circuit, Document } from "../shared/types";
import type { Stores } from "./createWorkbench";

/** The shown document and circuit. `scope` identifies them with the document
 * revision: selections, queued simulation actions and canvas observations
 * apply only within the scope they were made in. */
export interface View {
  doc: Document | null;
  circuit: Circuit | undefined;
  scope: string;
}

export function viewOf(
  docs: Document[],
  active: string | null,
  circuitName: string,
): View {
  const doc = docs.find((d) => d.id === active) || null;
  const circuit =
    doc?.circuits.find((c) => c.name === circuitName) || doc?.circuits[0];
  return {
    doc,
    circuit,
    scope: `${doc?.id}:${doc?.revision}:${circuit?.name}`,
  };
}

/** The view as of now; continuations compare it with the view they started in. */
export function currentView({
  documents,
  editor,
}: Pick<Stores, "documents" | "editor">): View {
  const { docs, active } = documents.getState();
  return viewOf(docs, active, editor.getState().circuitName);
}
