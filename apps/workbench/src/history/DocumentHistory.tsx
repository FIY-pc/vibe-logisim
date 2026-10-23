import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { HistoryEntry } from "../generated/HistoryEntry";
import type { HistoryList } from "../generated/HistoryList";
import { subscribeEvents } from "../shared/events";
import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import { HistoryReview } from "./HistoryReview";
import "./DocumentHistory.css";

/** The active document's history; an entry opens its review. */
export function DocumentHistory({
  doc,
  circuit,
  visible,
  onDocument,
}: {
  doc: Document | null;
  circuit: string | null;
  visible: boolean;
  onDocument: (doc: Document, expectedBaseRevision?: string) => void;
}) {
  const [connection, setConnection] = useState(0);
  const [history, setHistory] = useState<{
      documentId: string;
      data: HistoryList;
    } | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<{
    documentId: string;
    entry: HistoryEntry;
  } | null>(null);
  useEffect(
    () =>
      subscribeEvents((event) => {
        if (event.topic === "resync") setConnection((v) => v + 1);
      }),
    [],
  );
  useEffect(() => setSelected(null), [doc?.id]);
  useEffect(() => {
    if (!doc || !visible) return;
    let live = true;
    setLoading(true);
    setError("");
    void command<HistoryList>({ op: "historyList", id: doc.id })
      .then((data) => {
        if (live) setHistory({ documentId: doc.id, data });
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [doc?.id, doc?.revision, doc?.dirty, visible, connection]);
  const data = history?.documentId === doc?.id ? history?.data : null;
  return (
    <section
      className="document-history"
      style={{ display: visible ? undefined : "none" }}
      aria-label="修改历史"
    >
      <nav>
        <span>修改历史</span>
        <button
          title="刷新"
          aria-label="刷新修改历史"
          onClick={() => setConnection((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </nav>
      {!doc ? (
        <p className="quiet-empty">打开电路后查看修改历史。</p>
      ) : (
        <div className="document-history-list">
          {loading && <p role="status">正在读取历史…</p>}
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          {data?.entries.map((entry, index) => (
            <button
              className="history-entry"
              key={entry.id}
              onClick={() => setSelected({ documentId: doc.id, entry })}
            >
              <span className="history-entry-title">
                {entry.title}
                {index === 0 && entry.revision === data.currentRevision && (
                  <small>当前</small>
                )}
                {entry.saved && <small>已保存</small>}
                {entry.baseline && <small>打开时</small>}
              </span>
              <time dateTime={new Date(entry.createdAt).toISOString()}>
                {new Date(entry.createdAt).toLocaleString()}
              </time>
            </button>
          ))}
          {!loading && !error && !data?.entries.length && (
            <p className="quiet-empty">还没有修改记录。</p>
          )}
        </div>
      )}
      {visible && doc && selected?.documentId === doc.id && (
        <HistoryReview
          key={selected.entry.id}
          entry={selected.entry}
          doc={doc}
          circuit={circuit}
          onClose={() => setSelected(null)}
          onDocument={(document, expectedBaseRevision) => {
            onDocument(document, expectedBaseRevision);
            setConnection((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}
