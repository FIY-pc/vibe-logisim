import { SimulationTransport } from "./SimulationControls";
import { simulationStatus } from "./store";
import {
  useEditor,
  useNotices,
  useSettings,
  useShell,
  useSimulationState,
  useView,
} from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** Run, step and reset controls over the canvas. */
export function SimulationTransportRegion() {
  const { actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const state = useSimulationState();
  const tool = useEditor((editor) => editor.tool);
  const pending = useShell((shell) => shell.pending);
  const shortcuts = useSettings((settings) => settings.labels);
  const onError = useNotices((notices) => notices.onError);
  if (!doc || !circuit) return null;
  const status = simulationStatus(state, doc, circuit.name);
  const simulation = actions.simulation;
  return (
    <SimulationTransport
      status={status}
      shortcuts={shortcuts}
      run={(action) => void simulation.run(view, action).catch(onError)}
      tool={tool}
      disabled={Boolean(pending)}
    />
  );
}
