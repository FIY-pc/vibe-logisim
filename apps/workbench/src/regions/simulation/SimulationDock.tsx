import { Waveform } from "../../components/Waveform";
import { useNotices, useSimulation, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";
import { activeSimulation } from "../../workbench/view";

/** The watched signals of the shown simulation and their waveform. */
export function SimulationDock() {
  const { actions } = useWorkbench();
  const view = useView();
  const { circuit } = view;
  const sim = useSimulation((state) => state.sim);
  const onError = useNotices((state) => state.onError);
  const trace = activeSimulation(sim, view)?.frame.children.find(
    (n) => n.tag === "trace",
  );
  if (!trace || !trace.children.some((n) => n.tag === "signal")) return null;
  const traceLabels = Object.fromEntries(
    trace.children
      .filter((n) => n.tag === "signal")
      .map((n) => {
        const [id, port] = n.attributes.key.split(":");
        const c = circuit?.components.find((c) => c.id === id);
        return [
          n.attributes.key,
          `${c?.attributes.label || c?.name || id} [${port}]`,
        ];
      }),
  );
  const recording = trace.attributes.recording === "true";
  return (
    <section className="simulation-dock" aria-label="观察信号">
      <header>
        <span>观察信号</span>
        <button
          onClick={() =>
            void actions.simulation
              .simulate(
                view,
                recording ? "trace-stop" : "trace",
                recording
                  ? {}
                  : {
                      signals: trace.children
                        .filter((n) => n.tag === "signal")
                        .map((n) => n.attributes.key)
                        .join(","),
                    },
              )
              .catch(onError)
          }
        >
          {recording ? "停止记录" : "重新记录"}
        </button>
      </header>
      <Waveform key={trace.attributes.id} trace={trace} labels={traceLabels} />
    </section>
  );
}
