import { liveRun } from "../../stores/simulation";
import { useNotices, useSimulationState, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** Returns the running simulation to the instance that contains the shown one. */
export function ParentInstanceButton() {
  const { actions } = useWorkbench();
  const view = useView();
  const state = useSimulationState();
  const onError = useNotices((notices) => notices.onError);
  const live = liveRun(state, view.doc, view.circuit?.name);
  if (!live || live.view.instancePath.length === 0) return null;
  return (
    <button
      onClick={() =>
        void actions.navigation
          .navigateSimulation(view, live.view.instancePath.slice(0, -1))
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
  const state = useSimulationState();
  if (!circuit) return null;
  const session = state.session;
  const live = liveRun(state, view.doc, circuit.name);
  return (
    <>
      {live && (
        <span className="muted">
          运行实例 · {live.session.rootCircuit}
          {live.view.instancePath.length ? ` / ${circuit.name}` : ""}
        </span>
      )}
      {session && !live && (
        <span className="muted">{session.rootCircuit} 的仿真保留中</span>
      )}
    </>
  );
}
