import { liveRun } from "../../stores/simulation";
import { useSimulationState, useView } from "../../workbench/hooks";

/** The shown simulation's failure and oscillation alerts. */
export function SimulationAlerts() {
  const view = useView();
  const state = useSimulationState();
  const live = liveRun(state, view.doc, view.circuit?.name);
  return (
    <>
      {live?.view.clock.failure && (
        <p className="dialog-error" role="alert">
          {live.view.clock.failure.message}
        </p>
      )}
      {live?.view.clock.oscillating && (
        <p className="dialog-error" role="alert">
          电路发生振荡，时钟已暂停
        </p>
      )}
    </>
  );
}
