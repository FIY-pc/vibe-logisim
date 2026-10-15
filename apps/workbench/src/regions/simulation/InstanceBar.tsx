import { useNotices, useSimulation, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";
import { activeSimulation } from "../../workbench/view";

/** Returns the running simulation to the instance that contains the shown one. */
export function ParentInstanceButton() {
  const { actions } = useWorkbench();
  const view = useView();
  const sim = useSimulation((state) => state.sim);
  const onError = useNotices((state) => state.onError);
  const activeSim = activeSimulation(sim, view);
  if (!activeSim || activeSim.instancePath.length === 0) return null;
  return (
    <button
      onClick={() =>
        void actions.navigation
          .navigateSimulation(view, activeSim.instancePath.slice(0, -1))
          .catch(onError)
      }
    >
      ↑ 返回上层实例
    </button>
  );
}

/** Which simulation instance the canvas shows, or which circuit's
 * simulation is kept while another circuit is shown. */
export function InstanceStatus() {
  const view = useView();
  const { circuit } = view;
  const sim = useSimulation((state) => state.sim);
  if (!circuit) return null;
  const activeSim = activeSimulation(sim, view);
  return (
    <>
      {activeSim && (
        <span className="muted">
          运行实例 · {activeSim.rootCircuit}
          {activeSim.instancePath.length ? ` / ${circuit.name}` : ""}
        </span>
      )}
      {sim && !activeSim && (
        <span className="muted">{sim.circuit} 的仿真保留中</span>
      )}
    </>
  );
}
