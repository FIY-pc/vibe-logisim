import { X } from "lucide-react";
import { Waveform } from "./Waveform";
import { tip } from "../shared/Tooltips";
import { live } from "./store";
import { useSimulation, useSimulationState, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The watched signals of the shown simulation and their waveform. */
export function SimulationDock() {
  const { actions } = useWorkbench();
  const view = useView();
  const { circuit } = view;
  const state = useSimulationState();
  const trace = useSimulation((simulation) => simulation.trace);
  if (!live(state, view) || !trace?.signals.length) return null;
  const { recording } = trace;
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
        <strong>观察信号</strong>
        <button
          onClick={() =>
            void (
              recording
                ? actions.simulation.stopTrace()
                : actions.simulation.startTrace()
            ).catch(() => {})
          }
        >
          {recording ? "停止记录" : "重新记录"}
        </button>
        <button
          aria-label="关闭观察信号"
          {...tip("不再观察这些端口")}
          onClick={(event) => {
            // Keyboard focus moves on to the canvas instead of leaving with the panel.
            event.currentTarget
              .closest("main")
              ?.querySelector<HTMLElement>(".canvas")
              ?.focus({ preventScroll: true });
            actions.simulation.clearWatches(view);
          }}
        >
          <X size={15} />
        </button>
      </header>
      <Waveform key={trace.id} trace={trace} labels={labels} />
    </section>
  );
}
