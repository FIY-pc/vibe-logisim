import { SimulationTransport } from "../../components/SimulationControls";
import { pendingOperation } from "../../stores/simulation";
import {
  useEditor,
  useNotices,
  useSettings,
  useShell,
  useSimulation,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";
import { activeSimulation } from "../../workbench/view";

/** Run, step and reset controls over the canvas. */
export function SimulationTransportRegion() {
  const { actions } = useWorkbench();
  const view = useView();
  const { doc, circuit, scope } = view;
  const sim = useSimulation((state) => state.sim);
  const busyAction = useSimulation((state) => pendingOperation(state, scope));
  const tool = useEditor((state) => state.tool);
  const pending = useShell((state) => state.pending);
  const shortcuts = useSettings((state) => state.labels);
  const onError = useNotices((state) => state.onError);
  if (!doc || !circuit) return null;
  return (
    <SimulationTransport
      activeSim={activeSimulation(sim, view)}
      busyAction={busyAction}
      disabled={Boolean(pending)}
      shortcuts={shortcuts}
      simulate={(op, attributes) =>
        actions.simulation.simulate(view, op, attributes)
      }
      onError={onError}
      tool={tool}
      stale={Boolean(
        sim &&
        sim.documentId === doc.id &&
        sim.circuit === circuit.name &&
        sim.revision !== doc.revision,
      )}
    />
  );
}
