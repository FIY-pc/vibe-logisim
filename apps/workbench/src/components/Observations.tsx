import { DecisionDialog, type Decision } from "./DecisionDialog";
import { useEffect, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { command } from "../lib/transport";
import type { ObservationRecord } from "../generated/ObservationRecord";
import type { XmlNode } from "../lib/types";
import { Waveform } from "./Waveform";
export function Observations({
  documentId,
  onClose,
  initial,
}: {
  documentId: string;
  onClose: () => void;
  initial?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [records, setRecords] = useState<ObservationRecord[]>([]),
    [selection, setSelection] = useState<string[]>(initial ? [initial] : []),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    void command<ObservationRecord[]>({ op: "observations", id: documentId })
      .then(setRecords)
      .catch((e) => setError(String(e)));
    return () => dialog.current?.close();
  }, [documentId]);
  const selected = selection
    .map((id) => records.find((r) => r.id === id))
    .filter((r): r is ObservationRecord => !!r);
  return (
    <dialog
      ref={dialog}
      className="observations-dialog"
      aria-label="留存观察"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>留存观察</h2>
        <button aria-label="关闭留存观察" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      <div className="observations-body">
        <div className="observation-list">
          {records.length ? (
            records.map((r) => (
              <div key={r.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selection.includes(r.id)}
                    onChange={(e) =>
                      setSelection((old) =>
                        e.target.checked
                          ? [...old.slice(-1), r.id]
                          : old.filter((id) => id !== r.id),
                      )
                    }
                  />
                  <span>
                    {r.title}
                    <small>{new Date(r.createdAt).toLocaleString()}</small>
                  </span>
                </label>
                <button
                  aria-label={`删除观察 ${r.title}`}
                  onClick={() =>
                    setDecision({
                      title: `删除 ${r.title}？`,
                      message: "这条观察记录删除后无法恢复。",
                      actions: [
                        {
                          label: "删除",
                          run: async () => {
                            await command({
                              op: "observationDelete",
                              id: documentId,
                              record: r.id,
                            });
                            setRecords((old) =>
                              old.filter((x) => x.id !== r.id),
                            );
                            setSelection((old) =>
                              old.filter((id) => id !== r.id),
                            );
                          },
                        },
                      ],
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <p className="quiet-empty">在仿真菜单中留存此刻（F6）</p>
          )}
        </div>
        <div className="observation-viewer">
          {selected.length === 2 && <Comparison records={selected} />}
          {selected.map((r) => {
            const frame = r.frame as unknown as XmlNode;
            const render = frame.children.find((n) => n.tag === "render"),
              trace = frame.children.find((n) => n.tag === "trace");
            return (
              <article key={r.id}>
                <h3>{r.title}</h3>
                <p className="muted">
                  {r.rootCircuit}
                  {r.instancePath.length
                    ? ` › ${r.circuit} (${r.instancePath.join(" / ")})`
                    : ""}{" "}
                  · 修订 {r.revision.slice(0, 8)}
                </p>
                {render?.text && (
                  <img
                    className="observation-image"
                    src={`data:image/png;base64,${render.text}`}
                    alt={`${r.circuit} 留存画面`}
                  />
                )}
                {r.signals.length > 0 && (
                  <table>
                    <tbody>
                      {r.signals.map((s) => (
                        <tr key={s.key}>
                          <th>{s.label}</th>
                          <td>
                            <code>{s.bits}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {trace && (
                  <Waveform
                    trace={trace}
                    labels={Object.fromEntries(
                      r.signals.map((s) => [s.key, s.label]),
                    )}
                  />
                )}
              </article>
            );
          })}
        </div>
      </div>
      {decision && (
        <DecisionDialog decision={decision} onClose={() => setDecision(null)} />
      )}
    </dialog>
  );
}
function Comparison({ records: [a, b] }: { records: ObservationRecord[] }) {
  const same =
    a.revision === b.revision &&
    a.rootCircuit === b.rootCircuit &&
    JSON.stringify(a.instancePath) === JSON.stringify(b.instancePath);
  if (!same)
    return (
      <p className="source-notice">
        电路版本或运行实例不同，分别显示原始记录。
      </p>
    );
  const pairs = a.signals.flatMap((s) => {
    const next = b.signals.find((n) => n.key === s.key);
    return next ? [{ ...s, next: next.bits }] : [];
  });
  return (
    <table className="observation-comparison">
      <thead>
        <tr>
          <th>信号</th>
          <th>{a.title}</th>
          <th>{b.title}</th>
        </tr>
      </thead>
      <tbody>
        {pairs.map((s) => (
          <tr key={s.key} className={s.bits !== s.next ? "changed" : ""}>
            <th>{s.label}</th>
            <td>{s.bits}</td>
            <td>{s.next}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
