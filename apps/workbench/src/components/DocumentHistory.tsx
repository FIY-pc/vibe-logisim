import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { command } from "../lib/transport";
import { subscribeEvents } from "../lib/events";
import { useProposals } from "../lib/useProposals";
import type { Document } from "../lib/types";
import type {
  HistoryEntry,
  HistoryList,
  LocateChange,
} from "../lib/reviewTypes";
import {
  HistoryReview,
  ProposalReview,
  type SourceProposal,
} from "./ProposalReview";
import "./DocumentHistory.css";
export function DocumentHistory({
  doc,
  circuit,
  visible,
  onError,
  onDocument,
  onLocate,
}: {
  doc: Document | null;
  circuit: string | null;
  visible: boolean;
  onError: (error: unknown) => void;
  onDocument: (doc: Document, expectedBaseRevision?: string) => void;
  onLocate: (target: LocateChange) => void;
}) {
  const [pane, setPane] = useState<"pending" | "history">("pending"),
    [connection, setConnection] = useState(0);
  const proposals = useProposals(doc?.id, connection, onError);
  const [history, setHistory] = useState<{
      documentId: string;
      data: HistoryList;
    } | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<{
      documentId: string;
      entry: HistoryEntry;
    } | null>(null),
    [reviewing, setReviewing] = useState<SourceProposal | null>(null);
  useEffect(() => {
    const stop = subscribeEvents((event) => {
      if (event.topic === "resync") setConnection((v) => v + 1);
      if (
        event.topic === "agent" &&
        event.data.event.type === "proposed-source"
      )
        proposals.receive(event.data.event);
    });
    return stop;
  }, []);
  useEffect(() => {
    setSelected(null);
    setReviewing(null);
  }, [doc?.id]);
  useEffect(() => {
    if (!doc || !visible || pane !== "history") return;
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
  }, [doc?.id, doc?.revision, doc?.dirty, visible, pane, connection]);
  const data = history?.documentId === doc?.id ? history?.data : null;
  const discard = (proposal: SourceProposal) => {
    void proposals.discard(proposal).then((done) => {
      if (done)
        setReviewing((current) =>
          current?.id === proposal.id ? null : current,
        );
    });
  };
  return (
    <section
      className="document-history"
      style={{ display: visible ? undefined : "none" }}
      aria-label="工程改动"
    >
      <nav aria-label="工程改动范围">
        <button
          aria-pressed={pane === "pending"}
          onClick={() => setPane("pending")}
        >
          待应用
          {proposals.proposals.length ? ` · ${proposals.proposals.length}` : ""}
        </button>
        <button
          aria-pressed={pane === "history"}
          onClick={() => setPane("history")}
        >
          历史
        </button>
        <button
          title="刷新改动"
          aria-label="刷新改动"
          onClick={() => setConnection((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </nav>
      {!doc ? (
        <p className="quiet-empty">打开电路后查看改动。</p>
      ) : pane === "pending" ? (
        <div className="document-change-list">
          {proposals.proposals.map((proposal) => (
            <article className="candidate-entry" key={proposal.id}>
              <button onClick={() => setReviewing(proposal)}>
                <strong>待审阅改动</strong>
                <time dateTime={new Date(proposal.createdAt).toISOString()}>
                  {new Date(proposal.createdAt).toLocaleString()}
                </time>
                {proposal.revision !== doc.revision && (
                  <small>基于此前版本</small>
                )}
              </button>
              <button
                disabled={proposals.pending.has(proposal.id)}
                onClick={() => discard(proposal)}
              >
                放弃
              </button>
            </article>
          ))}
          {!proposals.proposals.length && (
            <p className="quiet-empty">没有待应用的改动。</p>
          )}
        </div>
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
          onLocate={onLocate}
        />
      )}
      {visible && doc && reviewing?.documentId === doc.id && (
        <ProposalReview
          key={reviewing.id}
          proposal={reviewing}
          doc={doc}
          circuit={circuit}
          onClose={() => setReviewing(null)}
          onDiscard={() => discard(reviewing)}
          onDocument={onDocument}
          onLocate={onLocate}
        />
      )}
    </section>
  );
}
