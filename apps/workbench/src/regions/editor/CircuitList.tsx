import { Plus } from "lucide-react";
import type { Document } from "../../lib/types";
import {
  useEditor,
  useNotices,
  useSimulation,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The circuits of the active document, with the shown circuit's commands. */
export function CircuitList({ doc: d }: { doc: Document }) {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { circuit } = view;
  const circuitSearch = useEditor((state) => state.circuitSearch);
  const onError = useNotices((state) => state.onError);
  const { setRenameCircuit, setInterfaceTarget, setCircuitPrompt } =
    stores.editor.getState();
  const { editor: editing, navigation } = actions;
  return (
    <div className="circuit-list">
      {d.circuits
        .filter((c) =>
          c.name.toLowerCase().includes(circuitSearch.toLowerCase()),
        )
        .map((c) => (
          <div className="circuit-row" key={c.name}>
            <button
              className={c.name === circuit?.name ? "active" : ""}
              onClick={() => navigation.switchCircuit(view, c.name)}
              title={d.main === c.name ? "主电路" : undefined}
            >
              {c.name}
              {d.main === c.name && (
                <span className="main-marker" aria-label="主电路">
                  ⌂
                </span>
              )}
            </button>
            {c.name === circuit?.name && (
              <details className="menu">
                <summary aria-label="电路操作">···</summary>
                <div
                  className="menu-content"
                  onClick={(event) => {
                    if (
                      (event.target as HTMLElement).closest(
                        "button:not(:disabled)",
                      )
                    )
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                  }}
                >
                  <button onClick={() => setRenameCircuit(true)}>
                    重命名…
                  </button>
                  <button
                    onClick={() =>
                      setInterfaceTarget({
                        doc: d,
                        circuit: c.name,
                      })
                    }
                  >
                    封装与接口…
                  </button>
                  <button
                    disabled={d.main === c.name}
                    onClick={() =>
                      void editing
                        .edit(view, { kind: "setMain" })
                        .catch(onError)
                    }
                  >
                    设为主电路
                  </button>
                  <button
                    disabled={d.circuits.length === 1}
                    onClick={() => navigation.requestDeleteCircuit(view)}
                  >
                    删除电路
                  </button>
                </div>
              </details>
            )}
          </div>
        ))}
      <button className="muted" onClick={() => setCircuitPrompt(true)}>
        <Plus size={13} />
        新建电路
      </button>
    </div>
  );
}
