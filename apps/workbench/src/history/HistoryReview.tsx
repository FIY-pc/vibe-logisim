import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { HistoryEntry } from "../generated/HistoryEntry";
import type { HistoryReview as Review } from "../generated/HistoryReview";
import { sourceDiff } from "./sourceDiff";
import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import "./HistoryReview.css";

interface Preview {
  image: string | null;
  missing?: boolean;
  warnings?: string[];
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const circuitNames = (xml: string) =>
  [...xml.matchAll(/<circuit\s+name="([^"]*)"/g)].map((match) => match[1]);

/** One entry of the document history: the source before and after it, a
 * rendering of either side, and restoring the document to it. */
export function HistoryReview({
  entry,
  doc,
  circuit,
  onClose,
  onDocument,
}: {
  entry: HistoryEntry;
  doc: Document;
  circuit: string | null;
  onClose: () => void;
  onDocument: (doc: Document, expectedBaseRevision?: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = useRef({ id: doc.id, revision: doc.revision }).current;
  const [mode, setMode] = useState<"change" | "current">(
    entry.beforeRevision ? "change" : "current",
  );
  const [review, setReview] = useState<Review | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const [selected, setSelected] = useState(circuit || doc.main),
    [after, setAfter] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null),
    [previewError, setPreviewError] = useState("");
  const [showSource, setShowSource] = useState(false),
    [allLines, setAllLines] = useState(false);
  const binding = {
    id: initial.id,
    revision: initial.revision,
    entry: entry.id,
    mode,
  };
  const stale = doc.id !== initial.id || doc.revision !== initial.revision;
  const beforeLabel = mode === "change" ? "修改前" : "历史版本";
  const afterLabel = mode === "change" ? "修改后" : "当前工程";
  const names = review
    ? [
        ...new Set([
          ...circuitNames(review.original),
          ...circuitNames(review.xml),
        ]),
      ]
    : [selected];
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    let live = true;
    setReview(null);
    setError("");
    void command<Review>({ op: "historyReview", ...binding })
      .then((next) => {
        if (!live) return;
        setReview(next);
        const all = [
          ...new Set([
            ...circuitNames(next.original),
            ...circuitNames(next.xml),
          ]),
        ];
        setSelected((old) => (all.includes(old) ? old : all[0] || old));
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [mode]);
  useEffect(() => {
    if (!review) return;
    let live = true;
    setPreview(null);
    setPreviewError("");
    void command<Preview>({
      op: "historyPreview",
      ...binding,
      circuit: selected,
      candidate: after,
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
  }, [review, selected, after]);
  const lines = useMemo(
    () => (showSource && review ? sourceDiff(review.original, review.xml) : []),
    [review, showSource],
  );
  const shown = useMemo(
    () =>
      new Set(
        lines.flatMap((line, index) =>
          line.changed
            ? Array.from({ length: 7 }, (_, offset) => index + offset - 3)
            : [],
        ),
      ),
    [lines],
  );
  const restore = async () => {
    setPending(true);
    setError("");
    try {
      const updated = await command<Document>({
        op: "historyRestore",
        id: initial.id,
        revision: initial.revision,
        entry: entry.id,
      });
      onDocument(updated, initial.revision);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="history-review"
      aria-label="历史版本"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <header>
        <h2>
          {entry.title}
          <small>
            {doc.name} · {new Date(entry.createdAt).toLocaleString()}
          </small>
        </h2>
        <button aria-label="关闭" disabled={pending} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <nav aria-label="对照方式">
        <select
          aria-label="对照方式"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="change" disabled={!entry.beforeRevision}>
            这次修改
          </option>
          <option value="current">与当前工程比较</option>
        </select>
        <select
          aria-label="电路"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button aria-pressed={!after} onClick={() => setAfter(false)}>
          {beforeLabel}
        </button>
        <button aria-pressed={after} onClick={() => setAfter(true)}>
          {afterLabel}
        </button>
      </nav>
      {stale && (
        <p className="history-review-note" role="status">
          文档已有后续修改，这个版本只能查看。
        </p>
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <div className="history-review-image">
        {previewError ? (
          <p role="alert">预览失败：{previewError}</p>
        ) : !review ? (
          <p>{error ? "" : "正在读取…"}</p>
        ) : preview?.image ? (
          <img
            src={preview.image}
            alt={`${selected} · ${after ? afterLabel : beforeLabel}`}
          />
        ) : preview ? (
          <p>此版本没有这份电路。</p>
        ) : (
          <p>正在生成预览…</p>
        )}
      </div>
      {preview?.warnings && preview.warnings.length > 0 && (
        <details className="history-review-note">
          <summary>加载提示</summary>
          <ul>
            {preview.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      <details
        className="history-review-source"
        open={showSource}
        onToggle={(e) => setShowSource(e.currentTarget.open)}
      >
        <summary>
          原始 XML
          {showSource && (
            <label onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={allLines}
                onChange={(e) => setAllLines(e.target.checked)}
              />
              显示完整源码
            </label>
          )}
        </summary>
        <div className="history-review-source-scroll">
          <table aria-label="源码对照">
            <colgroup>
              <col style={{ width: 38 }} />
              <col />
              <col style={{ width: 38 }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th colSpan={2}>{beforeLabel}</th>
                <th colSpan={2}>{afterLabel}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) =>
                !allLines && !shown.has(index) ? (
                  index === 0 || shown.has(index - 1) ? (
                    <tr key={index}>
                      <td className="source-omitted" colSpan={4}>
                        ⋯ 未改动 ⋯
                      </td>
                    </tr>
                  ) : null
                ) : (
                  <tr key={index}>
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
                ),
              )}
              {showSource && review && !lines.some((line) => line.changed) && (
                <tr>
                  <td className="source-omitted" colSpan={4}>
                    两个版本的源码相同
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
      <footer>
        <span>恢复会追加一条修改记录，已有历史保留。</span>
        <button
          className="primary"
          disabled={
            pending || stale || !review || entry.revision === doc.revision
          }
          onClick={() => void restore()}
        >
          {pending ? "正在恢复…" : "恢复到这个版本"}
        </button>
      </footer>
    </dialog>
  );
}
