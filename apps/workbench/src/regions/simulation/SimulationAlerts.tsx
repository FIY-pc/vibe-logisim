import { useSimulation, useView } from "../../workbench/hooks";
import { activeSimulation } from "../../workbench/view";

/** The shown simulation's failure and oscillation alerts. */
export function SimulationAlerts() {
  const view = useView();
  const sim = useSimulation((state) => state.sim);
  const activeSim = activeSimulation(sim, view);
  return (
    <>
      {activeSim?.frame.attributes.failure && (
        <p className="dialog-error" role="alert">
          {activeSim.frame.attributes.failure}
        </p>
      )}
      {activeSim?.frame.attributes.oscillating === "true" && (
        <p className="dialog-error" role="alert">
          电路发生振荡，时钟已暂停
        </p>
      )}
    </>
  );
}
