import { MemoryPanel } from "../../components/MemoryPanel";
import { useDocuments, useSimulation, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";
import { activeSimulation } from "../../workbench/view";

/** The open memory component's contents editor. */
export function MemoryRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const sim = useSimulation((state) => state.sim);
  const memory = useSimulation((state) => state.memory);
  const mergeDocument = useDocuments((state) => state.mergeDocument);
  if (!doc || !circuit) return null;
  const memoryComponent =
    memory && memory.documentId === doc.id && memory.circuit === circuit.name
      ? circuit.components.find(
          (c) =>
            c.name === memory.name &&
            c.location.x === memory.x &&
            c.location.y === memory.y,
        )
      : null;
  if (!memoryComponent) return null;
  return (
    <MemoryPanel
      key={`${doc.id}:${circuit.name}:${memoryComponent.location.x}:${memoryComponent.location.y}`}
      doc={doc}
      circuit={circuit.name}
      component={memoryComponent}
      simulation={activeSimulation(sim, view)}
      simulate={(op, attributes) =>
        actions.simulation.simulate(view, op, attributes)
      }
      onDocument={mergeDocument}
      onClose={() => stores.simulation.getState().setMemory(null)}
    />
  );
}
