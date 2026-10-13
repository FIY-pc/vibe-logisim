import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { command } from "../lib/transport";
import type { Document } from "../lib/types";
import type { ProposalReview as Review } from "../generated/ProposalReview";
import { sourceDiff } from "../lib/sourceDiff";
import "./ProposalReview.css";

export interface SourceProposal {
  documentId: string;
  revision: string;
  original: string;
  xml: string;
}
interface Props {
  proposal: SourceProposal;
  doc: Document;
  circuit: string | null;
  onClose: () => void;
  onDiscard: () => void;
  onDocument: (doc: Document) => void;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const changes = { added: "新增", removed: "移除", modified: "修改" };
export function ProposalReview({
  proposal,
  doc,
  circuit,
  onClose,
  onDiscard,
  onDocument,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<"changes" | "source">("changes");
  const [selected, setSelected] = useState(circuit || doc.main);
  const [candidate, setCandidate] = useState(true);
  const [preview, setPreview] = useState<{
    image: string | null;
    missing: boolean;
    warnings?: string[];
  } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [reload, setReload] = useState(0);
  const [allLines, setAllLines] = useState(false);
  const current = useRef({ doc, proposal });
  current.current = { doc, proposal };
  const binding = useMemo(
    () => ({
      id: proposal.documentId,
      revision: proposal.revision,
      original: proposal.original,
      xml: proposal.xml,
    }),
    [proposal],
  );
  const stale =
    doc.id !== proposal.documentId ||
    doc.revision !== proposal.revision ||
    Boolean(review && review.currentRevision !== proposal.revision);
  const lines = useMemo(
    () => sourceDiff(proposal.original, proposal.xml),
    [proposal],
  );
  const changedLines = useMemo(
    () =>
      new Set(
        lines.flatMap((line, i) =>
          line.changed
            ? Array.from({ length: 7 }, (_, offset) => i + offset - 3)
            : [],
        ),
      ),
    [lines],
  );
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    let live = true;
    setReview(null);
    setError("");
    command<Review>({ op: "proposalReview", ...binding })
      .then((next) => {
        if (!live) return;
        setReview(next);
        const names = new Set(
          [...next.before.circuits, ...next.after.circuits].map((c) => c.name),
        );
        if (!names.has(selected))
          setSelected(
            next.rows.find((r) => r.circuit)?.circuit || next.after.main,
          );
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [binding]);
  useEffect(() => {
    if (!review || tab !== "changes") return;
    let live = true;
    setPreview(null);
    setPreviewError("");
    command<{ image: string | null; missing: boolean; warnings?: string[] }>({
      op: "proposalPreview",
      ...binding,
      circuit: selected,
      candidate,
    })
      .then((next) => {
        if (live) setPreview(next);
      })
      .catch((e) => {
        if (live) setPreviewError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [binding, selected, candidate, review, tab, reload]);
  const names = review
    ? [
        ...new Set(
          [...review.before.circuits, ...review.after.circuits].map(
            (c) => c.name,
          ),
        ),
      ]
    : [];
  async function apply() {
    const active = current.current;
    if (
      pending ||
      active.doc.id !== proposal.documentId ||
      active.doc.revision !== proposal.revision ||
      active.proposal !== proposal
    )
      return;
    setPending(true);
    setError("");
    try {
      const updated = await command<Document>({
        op: "edit",
        id: proposal.documentId,
        revision: proposal.revision,
        circuit: doc.main,
        edit: { kind: "replace", xml: proposal.xml },
      });
      onDocument(updated);
      onDiscard();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="proposal-review"
      aria-label="审阅改动"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <header>
        <h2>
          审阅改动 <small>{doc.name}</small>
        </h2>
        <button aria-label="关闭审阅" disabled={pending} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <nav aria-label="审阅方式">
        <button
          aria-pressed={tab === "changes"}
          onClick={() => setTab("changes")}
        >
          改动与预览
        </button>
        <button
          aria-pressed={tab === "source"}
          onClick={() => setTab("source")}
        >
          源码对照
        </button>
      </nav>
      {stale && (
        <p className="proposal-warning" role="status">
          文档已有后续修改，这份候选只能查看。
        </p>
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {tab === "changes" ? (
        <div className="proposal-review-body">
          <section className="proposal-change-list" aria-label="结构变化">
            {!review ? (
              <p>
                {error ? "结构对照不可用，仍可查看源码。" : "正在读取改动…"}
              </p>
            ) : (
              <>
                <label className="proposal-circuit">
                  电路
                  <select
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {names.map((name) => {
                      const count = review.rows.filter(
                        (row) => row.circuit === name,
                      ).length;
                      const change = !review.before.circuits.some(
                        (c) => c.name === name,
                      )
                        ? " · 新增"
                        : !review.after.circuits.some((c) => c.name === name)
                          ? " · 移除"
                          : count
                            ? ` · ${count} 处改动`
                            : "";
                      return (
                        <option key={name} value={name}>
                          {name}
                          {change}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {review.rows
                  .filter(
                    (row) => row.circuit === null || row.circuit === selected,
                  )
                  .map((row, i) => (
                    <details key={i} open={review.rows.length < 5}>
                      <summary>
                        <span className={`proposal-kind ${row.kind}`}>
                          {changes[row.kind as keyof typeof changes] ||
                            row.kind}
                        </span>
                        {row.title}
                      </summary>
                      <table>
                        <thead>
                          <tr>
                            <th>内容</th>
                            <th>原版本</th>
                            <th>候选</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.fields.map((field, index) => (
                            <tr key={index}>
                              <th>{field.name}</th>
                              <td>{field.before ?? "—"}</td>
                              <td>{field.after ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  ))}
                {!review.rows.some(
                  (row) => row.circuit === null || row.circuit === selected,
                ) && <p className="proposal-empty">这份电路没有结构改动。</p>}
              </>
            )}
          </section>
          <section className="proposal-preview" aria-label="电路预览">
            <div className="proposal-preview-toolbar">
              <button
                aria-pressed={!candidate}
                onClick={() => setCandidate(false)}
              >
                原版本
              </button>
              <button
                aria-pressed={candidate}
                onClick={() => setCandidate(true)}
              >
                候选
              </button>
              <button onClick={() => setReload((v) => v + 1)}>重载</button>
            </div>
            <div className="proposal-preview-image">
              {previewError ? (
                <p role="alert">预览失败：{previewError}</p>
              ) : preview?.missing ? (
                <p>此版本没有这份电路。</p>
              ) : preview?.image ? (
                <img
                  src={preview.image}
                  alt={`${selected} · ${candidate ? "候选" : "原版本"}`}
                />
              ) : (
                <p>{review ? "正在生成原生预览…" : ""}</p>
              )}
            </div>
            {preview?.warnings && preview.warnings.length > 0 && (
              <details className="proposal-warning">
                <summary>原生加载提示</summary>
                <ul>
                  {preview.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </div>
      ) : (
        <div className="proposal-source">
          <label>
            <input
              type="checkbox"
              checked={allLines}
              onChange={(e) => setAllLines(e.target.checked)}
            />
            显示完整源码
          </label>
          <div className="proposal-source-scroll">
            <table aria-label="源码对照">
              <colgroup>
                <col style={{ width: 38 }} />
                <col />
                <col style={{ width: 38 }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th colSpan={2}>原版本 · 生成候选时的工作副本</th>
                  <th colSpan={2}>候选 · 运行时工作副本</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  if (!allLines && !changedLines.has(i))
                    return i === 0 || changedLines.has(i - 1) ? (
                      <tr key={i}>
                        <td className="source-omitted" colSpan={4}>
                          ⋯ 未改动 ⋯
                        </td>
                      </tr>
                    ) : null;
                  return (
                    <tr key={i}>
                      <td className="source-number">{line.beforeNumber}</td>
                      <td
                        className={
                          line.changed && line.before !== undefined
                            ? "source-removed"
                            : ""
                        }
                      >
                        <pre>{line.before}</pre>
                      </td>
                      <td className="source-number">{line.afterNumber}</td>
                      <td
                        className={
                          line.changed && line.after !== undefined
                            ? "source-added"
                            : ""
                        }
                      >
                        <pre>{line.after}</pre>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <footer>
        <span>原版本来自本轮开始时的工作副本；候选尚未应用。</span>
        <button disabled={pending} onClick={onDiscard}>
          放弃候选
        </button>
        <button
          className="primary"
          disabled={pending || stale || !review}
          onClick={() => void apply()}
        >
          {pending ? "正在应用…" : "应用全部改动"}
        </button>
      </footer>
    </dialog>
  );
}
