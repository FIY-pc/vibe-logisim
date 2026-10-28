import { live } from "./store";
import { useSimulationState, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** Shows the instance that contains the shown one. */
export function ParentInstanceButton() {
  const { actions } = useWorkbench();
  const view = useView();
  if (!view.instance.length) return null;
  return (
    <button onClick={() => actions.navigation.leaveInstance(view)}>
      ↑ 返回上层实例
    </button>
  );
}

/** Which simulation instance the canvas shows, or which circuit's
 * simulation is kept while another circuit is shown. */
export function InstanceStatus() {
  const view = useView();
  const state = useSimulationState();
  if (!view.circuit || !state.run) return null;
  return live(state, view) ? (
    <span className="muted">
      运行实例 · {state.run.rootCircuit}
      {view.instance.length ? ` / ${view.circuit.name}` : ""}
    </span>
  ) : (
    <span className="muted">{state.run.rootCircuit} 的仿真保留中</span>
  );
}
