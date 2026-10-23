import { DecisionDialog, type Decision } from "../shared/DecisionDialog";
import { TextPrompt } from "../shared/TextPrompt";
import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { ObservationRecord } from "../generated/ObservationRecord";
import type { ObservationSummary } from "../generated/ObservationSummary";
import type { ReferenceInput } from "../conversation/references";
import { command } from "../shared/transport";
import { Waveform } from "./Waveform";
import { Checkbox } from "../shared/Checkbox";
import { DialogClose, useModal } from "../shared/Dialog";

/**
 * The observations a document kept, with one or two shown side by side. The
 * list is cheap; a record's frame and waveform are read when it is selected,
 * and its picture when it reaches the viewer.
 */
export function Observations({
  documentId,
  onClose,
  initial,
  onQuote,
}: {
  documentId: string;
  onClose: () => void;
  initial?: string;
  onQuote: (references: ReferenceInput[]) => void;
}) {
  const dialog = useModal();
  const [renaming, setRenaming] = useState<ObservationSummary | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [records, setRecords] = useState<ObservationSummary[]>([]),
    [selection, setSelection] = useState<string[]>(initial ? [initial] : []),
    [shown, setShown] = useState<Record<string, ObservationRecord>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    void command<ObservationSummary[]>({
      op: "observationList",
      id: documentId,
    })
      .then(setRecords)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [documentId]);
  useEffect(() => {
    for (const id of selection.slice(-2))
      if (!shown[id])
        void command<ObservationRecord>({
          op: "observationGet",
          id: documentId,
          record: id,
        })
          .then((record) =>
            setShown((all) => ({ ...all, [record.id]: record })),
          )
          .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [selection, shown, documentId]);
  const selected = selection
    .map((id) => shown[id])
    .filter((record): record is ObservationRecord => !!record);
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
        <DialogClose label="关闭留存观察" onClick={onClose} />
      </header>
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      <div className="observations-body">
        <div className="observation-list">
          {records.length ? (
            records.map((record) => (
              <div key={record.id}>
                <label>
                  <Checkbox
                    disabled={Boolean(record.damaged)}
                    checked={selection.includes(record.id)}
                    onCheckedChange={(checked) =>
                      setSelection((old) =>
                        checked
                          ? [...old.slice(-1), record.id]
                          : old.filter((id) => id !== record.id),
                      )
                    }
                  />
                  <span>
                    {record.title}
                    <small>
                      {record.damaged
                        ? record.damaged
                        : new Date(record.createdAt).toLocaleString()}
                    </small>
                  </span>
                </label>
                <button
                  aria-label={`重命名观察 ${record.title}`}
                  disabled={Boolean(record.damaged)}
                  onClick={() => setRenaming(record)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  aria-label={`删除观察 ${record.title}`}
                  onClick={() =>
                    setDecision({
                      title: `删除 ${record.title}？`,
                      message: "这条观察记录删除后无法恢复。",
                      actions: [
                        {
                          label: "删除",
                          run: async () => {
                            await command({
                              op: "observationDelete",
                              record: record.id,
                            });
                            setRecords((old) =>
                              old.filter((item) => item.id !== record.id),
                            );
                            setSelection((old) =>
                              old.filter((id) => id !== record.id),
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
          {selected.map((record) => (
            <article key={record.id}>
              <h3>{record.title}</h3>
              <p className="muted">
                {record.rootCircuit}
                {record.instancePath.length
                  ? ` › ${record.circuit} (${record.instancePath.join(" / ")})`
                  : ""}{" "}
                · 修订 {record.revision.slice(0, 8)}
              </p>
              <Picture record={record} />
              {record.signals.length > 0 && (
                <table>
                  <tbody>
                    {record.signals.map((signal) => (
                      <tr key={signal.key}>
                        <th>{signal.label}</th>
                        <td>
                          <code>{signal.bits}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {record.trace && (
                <Waveform
                  trace={record.trace}
                  labels={Object.fromEntries(
                    record.signals.map((signal) => [signal.key, signal.label]),
                  )}
                />
              )}
            </article>
          ))}
        </div>
      </div>
      <footer>
        <button
          disabled={!selected.length}
          onClick={() => {
            onQuote(
              selected.map((record) => ({
                kind: "observation",
                documentId: record.documentId,
                recordId: record.id,
              })),
            );
            onClose();
          }}
        >
          {selected.length === 2 ? "引用两条观察" : "引用到对话"}
        </button>
      </footer>
      {renaming && (
        <TextPrompt
          title="重命名观察"
          initial={renaming.title}
          onClose={() => setRenaming(null)}
          onSubmit={async (title) => {
            const result = await command<ObservationRecord>({
              op: "observationRename",
              record: renaming.id,
              title,
            });
            setRecords((old) =>
              old.map((record) =>
                record.id === result.id
                  ? { ...record, title: result.title }
                  : record,
              ),
            );
            setShown((old) =>
              old[result.id] ? { ...old, [result.id]: result } : old,
            );
          }}
        />
      )}
      {decision && (
        <DecisionDialog decision={decision} onClose={() => setDecision(null)} />
      )}
    </dialog>
  );
}

/** The kept frame's picture, fetched once per record. */
function Picture({ record }: { record: ObservationRecord }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    void command<string>({ op: "observationImage", record: record.id })
      .then((data) => live && setUrl(data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [record.id]);
  if (!url) return null;
  return (
    <img
      className="observation-image"
      src={url}
      alt={`${record.circuit} 留存画面`}
    />
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
  const pairs = a.signals.flatMap((signal) => {
    const next = b.signals.find((other) => other.key === signal.key);
    return next ? [{ ...signal, next: next.bits }] : [];
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
        {pairs.map((signal) => (
          <tr
            key={signal.key}
            className={signal.bits !== signal.next ? "changed" : ""}
          >
            <th>{signal.label}</th>
            <td>{signal.bits}</td>
            <td>{signal.next}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
