import { Waveform } from "./Waveform";
import { liveRun, watchScope } from "./store";
import { useSimulation, useSimulationState, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The watched signals of the shown simulation and their waveform. */
export function SimulationDock() {
  const { actions } = useWorkbench();
  const view = useView();
  const { circuit } = view;
  const state = useSimulationState();
  const trace = useSimulation((simulation) => simulation.trace);
  const recording = useSimulation((simulation) => simulation.recording);
  const watches = useSimulation((simulation) => simulation.watches);
  const live = liveRun(state, view.doc, circuit?.name);
  if (!live) return null;
  const watched = state.session
    ? (watches[watchScope(state.session.sessionId, live.view.instancePath)] ??
      [])
    : [];
  if (!watched.length || !trace?.signals.length) return null;
  if (!recording && !trace.samples.length) return null;
  const labels = Object.fromEntries(
    trace.signals.map((signal) => {
      const component = circuit?.components.find(
        (item) => item.id === signal.componentId,
      );
      return [
        signal.id,
        `${component?.attributes.label || component?.name || signal.componentId} [${signal.port}]`,
      ];
    }),
  );
  return (
    <section className="simulation-dock" aria-label="观察信号">
      <header>
        <span>观察信号</span>
        <button
          onClick={() =>
            void (
              recording
                ? actions.simulation.stopTrace(view)
                : actions.simulation.startTrace(view)
            ).catch(() => {})
          }
        >
          {recording ? "停止记录" : "重新记录"}
        </button>
      </header>
      <Waveform key={trace.id} trace={trace} labels={labels} />
    </section>
  );
}
