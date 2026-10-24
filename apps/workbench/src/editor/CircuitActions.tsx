import { useSettings, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { tip } from "../shared/Tooltips";

/** The shown circuit's interface editor and component search. */
export function CircuitActions() {
  const { stores } = useWorkbench();
  const { doc, circuit } = useView();
  const shortcuts = useSettings((state) => state.labels);
  if (!doc || !circuit) return null;
  const { setInterfaceTarget, setFind } = stores.editor.getState();
  return (
    <div className="circuit-actions">
      <button
        onClick={() => setInterfaceTarget({ doc, circuit: circuit.name })}
      >
        封装与接口…
      </button>
      <button
        onClick={() => setFind("component")}
        {...tip("查找元件", shortcuts.find)}
      >
        查找元件…
      </button>
    </div>
  );
}
