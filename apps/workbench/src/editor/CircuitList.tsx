import { Plus } from "lucide-react";
import { Menu, MenuItem, MenuSeparator } from "../shared/Menu";
import type { Document } from "../shared/types";
import { useEditor, useNotices, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

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
              <Menu label="电路操作">
                <MenuItem onSelect={() => setRenameCircuit(true)}>
                  重命名…
                </MenuItem>
                <MenuItem
                  onSelect={() =>
                    setInterfaceTarget({ doc: d, circuit: c.name })
                  }
                >
                  封装与接口…
                </MenuItem>
                <MenuItem
                  disabled={d.main === c.name}
                  onSelect={() =>
                    void editing.edit(view, { kind: "setMain" }).catch(onError)
                  }
                >
                  设为主电路
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  disabled={d.circuits.length === 1}
                  onSelect={() => navigation.requestDeleteCircuit(view)}
                >
                  删除电路…
                </MenuItem>
              </Menu>
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
