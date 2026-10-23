import { MemoryPanel } from "./MemoryPanel";
import { liveRun, simulationStatus } from "./store";
import {
  useDocuments,
  useSimulation,
  useSimulationState,
  useView,
} from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The open memory component's contents editor. */
export function MemoryRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const state = useSimulationState();
  const memory = useSimulation((store) => store.memory);
  const page = useSimulation((store) => store.page);
  const mergeDocument = useDocuments((store) => store.mergeDocument);
  if (!doc || !circuit) return null;
  const component =
    memory && memory.documentId === doc.id && memory.circuit === circuit.name
      ? circuit.components.find((item) => item.id === memory.id)
      : undefined;
  if (!component) return null;
  // A RAM belongs to the run: the panel reads it only while this circuit is
  // the run's shown view, the same condition that lets the canvas take input.
  const live = liveRun(state, doc, circuit.name);
  const simulating = actions.simulation;
  return (
    <MemoryPanel
      key={`${doc.id}:${doc.revision}:${circuit.name}:${component.id}`}
      doc={doc}
      circuit={circuit.name}
      component={component}
      live={Boolean(live)}
      page={page?.componentId === component.id ? page : null}
      state={
        simulationStatus(state, doc, circuit.name).running ? "运行中" : "已暂停"
      }
      ticks={state.view?.clock.ticks}
      designSaved={!doc.dirty}
      start={() => simulating.run(view, "start")}
      readPage={(offset) =>
        simulating.readMemory(view, { component, offset, count: 64 })
      }
      writePage={(request) =>
        simulating.writeMemory(view, {
          ...request,
          component,
          count: 64,
        })
      }
      onDocument={mergeDocument}
      onClose={() => stores.simulation.getState().setMemory(null)}
    />
  );
}
