import type { Circuit, Document } from "../shared/types";
import type { Stores } from "./createWorkbench";

/** The shown document and circuit, and the instance of the run shown (empty
 * for the circuit itself). `scope` identifies the circuit with the document
 * revision: selections and canvas observations apply only within the scope
 * they were made in. */
export interface View {
  doc: Document | null;
  circuit: Circuit | undefined;
  instance: string[];
  scope: string;
}

export function viewOf(
  docs: Document[],
  active: string | null,
  circuitName: string,
  instance: string[],
): View {
  const doc = docs.find((d) => d.id === active) || null;
  const named = doc?.circuits.find((c) => c.name === circuitName);
  const circuit = named || doc?.circuits[0];
  return {
    doc,
    circuit,
    instance: named ? instance : [],
    scope: `${doc?.id}:${doc?.revision}:${circuit?.name}`,
  };
}

/** The view as of now; continuations compare it with the view they started in. */
export function currentView({
  documents,
  editor,
}: Pick<Stores, "documents" | "editor">): View {
  const { docs, active } = documents.getState();
  const { circuitName, instance } = editor.getState();
  return viewOf(docs, active, circuitName, instance);
}
