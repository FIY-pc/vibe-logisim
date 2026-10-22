import { SimulationMenu } from "../../components/SimulationControls";
import { simulationStatus } from "../../stores/simulation";
import {
  useDocuments,
  useNotices,
  useSettings,
  useShell,
  useSimulation,
  useSimulationState,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The titlebar's simulation menu for the shown circuit. */
export function SimulationMenuRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit, scope } = view;
  const docs = useDocuments((state) => state.docs);
  const state = useSimulationState();
  const frequency = useSimulation((simulation) => simulation.frequency);
  const pending = useShell((shell) => shell.pending);
  const shortcuts = useSettings((settings) => settings.labels);
  const onError = useNotices((notices) => notices.onError);
  if (!doc || !circuit) return null;
  const status = simulationStatus(state, doc, circuit.name);
  const session = state.session;
  const { simulation, navigation } = actions;
  return (
    <SimulationMenu
      contextKey={scope}
      circuitName={circuit.name}
      status={status}
      frequency={status.frequency ?? frequency}
      shortcuts={shortcuts}
      disabled={Boolean(pending)}
      run={(action) => void simulation.run(view, action).catch(onError)}
      capture={async () => {
        await simulation.capture(view);
      }}
      onError={onError}
      onObservations={() =>
        stores.simulation.getState().setObservations({ documentId: doc.id })
      }
      onFrequencyChange={async (value) => {
        await simulation.changeFrequency(view, value);
      }}
      onReturnToSimulation={
        session &&
        !status.visible &&
        docs.some(
          (item) =>
            item.id === session.documentId &&
            item.revision === session.revision,
        )
          ? () => navigation.returnToSimulation(view, session)
          : undefined
      }
    />
  );
}
