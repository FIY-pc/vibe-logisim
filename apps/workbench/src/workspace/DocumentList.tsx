import { CircuitBoard, X } from "lucide-react";
import { CircuitList } from "../editor/CircuitList";
import { useDocuments, useShell, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The open documents; the active one lists its circuits. */
export function DocumentList() {
  const { actions } = useWorkbench();
  const view = useView();
  const docs = useDocuments((state) => state.docs);
  const active = useDocuments((state) => state.active);
  const pending = useShell((state) => state.pending);
  return (
    <div className="document-list">
      {docs.map((d) => (
        <div key={d.id}>
          <div className={"document-row " + (d.id === active ? "active" : "")}>
            <button
              className="document-item"
              onClick={() => actions.navigation.activateDocument(view, d)}
            >
              <CircuitBoard size={15} />
              <span>{d.name}</span>
              {d.dirty && (
                <span
                  className="dirty-dot"
                  role="img"
                  aria-label="有未保存的修改"
                  data-tip="有未保存的修改"
                />
              )}
            </button>
            <button
              className="document-close"
              data-tip={`关闭 ${d.name}`}
              aria-label={`关闭 ${d.name}`}
              disabled={Boolean(pending)}
              onClick={() => actions.workspace.requestClose(d)}
            >
              <X size={13} />
            </button>
          </div>
          {d.id === active && <CircuitList doc={d} />}
        </div>
      ))}
    </div>
  );
}
