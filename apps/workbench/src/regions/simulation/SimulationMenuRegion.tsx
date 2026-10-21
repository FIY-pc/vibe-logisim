import { SimulationMenu } from "../../components/SimulationControls";
import { pendingOperation } from "../../stores/simulation";
import {
  useDocuments,
  useNotices,
  useSettings,
  useShell,
  useSimulation,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";
import { activeSimulation } from "../../workbench/view";

/** The titlebar's simulation menu for the shown circuit. */
export function SimulationMenuRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit, scope } = view;
  const docs = useDocuments((state) => state.docs);
  const sim = useSimulation((state) => state.sim);
  const frequency = useSimulation((state) => state.frequency);
  const busyAction = useSimulation((state) => pendingOperation(state, scope));
  const pending = useShell((state) => state.pending);
  const shortcuts = useSettings((state) => state.labels);
  const onError = useNotices((state) => state.onError);
  if (!doc || !circuit) return null;
  const activeSim = activeSimulation(sim, view);
  const { simulation: simulating, navigation } = actions;
  return (
    <SimulationMenu
      contextKey={scope}
      circuitName={circuit.name}
      activeSim={activeSim}
      busyAction={busyAction}
      disabled={Boolean(pending)}
      shortcuts={shortcuts}
      simulate={(op, attributes) => simulating.simulate(view, op, attributes)}
      capture={() => simulating.capture(view)}
      onError={onError}
      onObservations={() =>
        stores.simulation.getState().setObservations({ documentId: doc.id })
      }
      frequency={Number(activeSim?.frame.attributes.frequency) || frequency}
      onFrequencyChange={(value) => simulating.changeFrequency(view, value)}
      onReturnToSimulation={
        sim &&
        !activeSim &&
        docs.some(
          (item) =>
            item.id === sim.documentId && item.revision === sim.revision,
        )
          ? () => navigation.returnToSimulation(view, sim)
          : undefined
      }
    />
  );
}
