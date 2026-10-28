import { live } from "./store";
import { useSimulationState, useView } from "../app/hooks";

/** The shown simulation's failure and oscillation alerts. */
export function SimulationAlerts() {
  const shown = live(useSimulationState(), useView());
  const clock = shown?.frame.clock;
  return (
    <>
      {clock?.failure && (
        <p className="dialog-error" role="alert">
          {clock.failure.message}
        </p>
      )}
      {clock?.oscillating && (
        <p className="dialog-error" role="alert">
          电路发生振荡，时钟已暂停
        </p>
      )}
    </>
  );
}
