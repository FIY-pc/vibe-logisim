import { useEffect, useMemo, useRef, useState } from "react";
import { X, LocateFixed, Minus, Plus, Maximize } from "lucide-react";
import type { EditResult } from "../generated/EditResult";
import { command } from "../lib/transport";
import type { Document, Bounds } from "../lib/types";
import type {
  ComparisonDetail,
  ConnectionEndpoint,
  HistoryEntry,
  LocateChange,
  Review,
  ReviewChange,
  ReviewPreview,
  VerificationRecord,
} from "../lib/reviewTypes";
import { sourceDiff } from "../lib/sourceDiff";
import { VerificationRecords } from "./VerificationRecords";
import "./ProposalReview.css";
export interface SourceProposal {
  id: string;
  createdAt: number;
  documentId: string;
  revision: string;
  original: string;
  xml: string;
}
interface Common {
  doc: Document;
  circuit: string | null;
  onClose: () => void;
  onDocument: (doc: Document, expectedBaseRevision?: string) => void;
  onLocate?: (target: LocateChange) => void;
}
interface Props extends Common {
  proposal: SourceProposal;
  onDiscard: () => void;
}
export function ProposalReview(props: Props) {
  return <ChangeReview {...props} />;
}
export function HistoryReview(props: Common & { entry: HistoryEntry }) {
  return <ChangeReview {...props} />;
}
interface LoadedReview {
  review: Review;
  original: string;
  xml: string;
  evidence?: VerificationRecord[];
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const changeNames = { added: "新增", removed: "移除", modified: "修改" };
const categoryNames = {
  all: "全部",
  interfaces: "接口与封装",
  components: "元件",
  connections: "信号连接",
  layout: "布局与布线",
  settings: "工程设置",
};
const connectivityNames: Record<string, string> = {
  unchanged: "已对应端口的连接关系未变",
  changed: "信号连接发生变化",
  partial: "连接未完全核对",
  unavailable: "连接对照暂不可用",
};
const padded = (bounds: Bounds): Bounds => ({
  x: bounds.x - 24,
  y: bounds.y - 24,
  width: Math.max(80, bounds.width + 48),
  height: Math.max(60, bounds.height + 48),
});
function union(bounds: Bounds[]): Bounds | null {
  if (!bounds.length) return null;
  const x = Math.min(...bounds.map((b) => b.x)),
    y = Math.min(...bounds.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...bounds.map((b) => b.x + b.width)) - x,
    height: Math.max(...bounds.map((b) => b.y + b.height)) - y,
  };
}
function describeConnections(groups: ConnectionEndpoint[][]) {
  return groups.length
    ? groups
        .map((group) =>
          group
            .map(
              (end) =>
                `${end.label} · ${end.portName || `端口 ${end.port}`} [${end.bits.join(",")}]`,
            )
            .join(" ↔ "),
        )
        .join("\n")
    : "—";
}
function ChangeReview({
  doc,
  circuit,
  onClose,
  onDocument,
  onLocate,
  proposal,
  entry,
  onDiscard,
}: Common & {
  proposal?: SourceProposal;
  entry?: HistoryEntry;
  onDiscard?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = useRef({ id: doc.id, revision: doc.revision }).current;
  const [mode, setMode] = useState<"change" | "current">(
    entry?.beforeRevision ? "change" : "current",
  );
  const [loaded, setLoaded] = useState<LoadedReview | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const [tab, setTab] = useState<"changes" | "source" | "evidence">("changes"),
    [selected, setSelected] = useState(circuit || doc.main),
    [candidate, setCandidate] = useState(true);
  const [detail, setDetail] = useState<ComparisonDetail | null>(null),
    [detailError, setDetailError] = useState(""),
    [preview, setPreview] = useState<ReviewPreview | null>(null),
    [previewError, setPreviewError] = useState("");
  const [reload, setReload] = useState(0),
    [allLines, setAllLines] = useState(false),
    [category, setCategory] = useState("all"),
    [query, setQuery] = useState(""),
    [selectedRow, setSelectedRow] = useState<string | null>(null),
    [camera, setCamera] = useState<Bounds | null>(null);
  const current = useRef({ doc, proposal, entry });
  current.current = { doc, proposal, entry };
  const binding = useMemo(
    () =>
      proposal
        ? {
            id: proposal.documentId,
            revision: proposal.revision,
            original: proposal.original,
            xml: proposal.xml,
          }
        : {
            id: initial.id,
            revision: initial.revision,
            entry: entry!.id,
            mode,
          },
    [proposal, entry?.id, mode],
  );
  const history = Boolean(entry),
    review = loaded?.review;
  const beforeLabel = history
    ? mode === "change"
      ? "修改前"
      : "历史版本"
    : "原版本";
  const afterLabel = history
    ? mode === "change"
      ? "修改后"
      : "当前工程"
    : "候选";
  const expectedRevision = proposal?.revision || initial.revision;
  const stale =
    doc.id !== (proposal?.documentId || initial.id) ||
    doc.revision !== expectedRevision ||
    Boolean(review && review.currentRevision !== expectedRevision);
  const rows: ReviewChange[] = detail
    ? [
        ...(review?.rows || []).filter((row) => row.circuit === null),
        ...(detail.connectivity.status === "unavailable" && !detail.rows.length
          ? (review?.rows || []).filter((row) => row.circuit === selected)
          : detail.rows),
        ...detail.connectivity.rows.map((connection, index) => ({
          id: connection.id,
          category: "connections",
          circuit: selected,
          kind: "modified",
          title: `信号连接 ${index + 1}`,
          beforeObjects: [
            ...new Set(connection.before.flat().map((end) => end.componentId)),
          ],
          afterObjects: [
            ...new Set(connection.after.flat().map((end) => end.componentId)),
          ],
          fields: [
            {
              name: "相连端口",
              before: describeConnections(connection.before),
              after: describeConnections(connection.after),
            },
          ],
        })),
      ]
    : review?.rows || [];
  const circuitRows = rows.filter(
    (row) => row.circuit === null || row.circuit === selected,
  );
  const keyFor = (row: ReviewChange, index: number) =>
    row.id || `${row.circuit}:${row.kind}:${row.title}:${index}`;
  const picked = circuitRows.find(
    (row, index) => keyFor(row, index) === selectedRow,
  );
  const objects = detail?.objects[candidate ? "after" : "before"] || [];
  const selectedObjects = objects.filter((object) =>
    (picked?.[candidate ? "afterObjects" : "beforeObjects"] || []).includes(
      object.id,
    ),
  );
  const pictureBounds = preview?.bounds || null;
  const viewed = camera || pictureBounds;
  const currentSide =
    review?.after.revision === doc.revision
      ? "after"
      : review?.before.revision === doc.revision
        ? "before"
        : null;
  const locateObject = currentSide
    ? detail?.objects[currentSide].find((object) =>
        (
          picked?.[
            currentSide === "after" ? "afterObjects" : "beforeObjects"
          ] || []
        ).includes(object.id),
      )
    : undefined;
  const names = review
    ? [
        ...new Set(
          [...review.before.circuits, ...review.after.circuits].map(
            (item) => item.name,
          ),
        ),
      ]
    : [];
  const records = loaded?.evidence || review?.evidence || [];
  const sourceLines = useMemo(
    () =>
      sourceDiff(
        loaded?.original || proposal?.original || "",
        loaded?.xml || proposal?.xml || "",
      ),
    [loaded?.original, loaded?.xml, proposal],
  );
  const changedLines = useMemo(
    () =>
      new Set(
        sourceLines.flatMap((line, index) =>
          line.changed
            ? Array.from({ length: 7 }, (_, offset) => index + offset - 3)
            : [],
        ),
      ),
    [sourceLines],
  );
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    let live = true;
    setLoaded(null);
    setError("");
    setDetail(null);
    setPreview(null);
    setSelectedRow(null);
    setCamera(null);
    const request = history
      ? command<LoadedReview>({ op: "historyReview", ...binding } as Extract<
          Parameters<typeof command>[0],
          { op: "historyReview" }
        >)
      : command<Review>({ op: "proposalReview", ...binding } as Extract<
          Parameters<typeof command>[0],
          { op: "proposalReview" }
        >).then((review) => ({
          review,
          original: proposal!.original,
          xml: proposal!.xml,
        }));
    void request
      .then((next) => {
        if (!live) return;
        setLoaded(next);
        const all = [
          ...next.review.before.circuits,
          ...next.review.after.circuits,
        ].map((c) => c.name);
        const changed = next.review.rows.flatMap((row) =>
          row.circuit ? [row.circuit] : [],
        );
        setSelected((old) =>
          changed.includes(old)
            ? old
            : changed[0] || (all.includes(old) ? old : next.review.after.main),
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
    if (!review) return;
    let live = true;
    setDetail(null);
    setDetailError("");
    setCategory("all");
    setSelectedRow(null);
    setCamera(null);
    void command<ComparisonDetail>({
      op: history ? "historyDetail" : "proposalDetail",
      ...binding,
      circuit: selected,
    } as Parameters<typeof command>[0])
      .then((next) => {
        if (live) setDetail(next);
      })
      .catch((e) => {
        if (live) setDetailError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [binding, selected, review]);
  useEffect(() => {
    if (!review || tab !== "changes") return;
    let live = true;
    setPreview(null);
    setPreviewError("");
    void command<ReviewPreview>({
      op: history ? "historyPreview" : "proposalPreview",
      ...binding,
      circuit: selected,
      candidate,
    } as Parameters<typeof command>[0])
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
  const selectRow = (row: ReviewChange, index: number) => {
    setSelectedRow(keyFor(row, index));
    const ids = row[candidate ? "afterObjects" : "beforeObjects"] || [];
    const bounds = union(
      objects
        .filter((object) => ids.includes(object.id))
        .map((object) => object.bounds),
    );
    if (bounds) setCamera(padded(bounds));
  };
  const zoom = (factor: number) => {
    if (!viewed) return;
    const width = Math.max(40, viewed.width * factor),
      height = Math.max(30, viewed.height * factor);
    setCamera({
      x: viewed.x + (viewed.width - width) / 2,
      y: viewed.y + (viewed.height - height) / 2,
      width,
      height,
    });
  };
  async function apply() {
    if (
      pending ||
      stale ||
      current.current.doc.id !== doc.id ||
      current.current.doc.revision !== expectedRevision ||
      current.current.proposal !== proposal ||
      current.current.entry !== entry
    )
      return;
    setPending(true);
    setError("");
    try {
      const updated = history
        ? await command<Document>({
            op: "historyRestore",
            id: initial.id,
            revision: initial.revision,
            entry: entry!.id,
          })
        : (
            await command<EditResult>({
              op: "edit",
              id: proposal!.documentId,
              revision: proposal!.revision,
              circuit: doc.main,
              edit: { kind: "replace", xml: proposal!.xml },
            })
          ).view;
      onDocument(updated, expectedRevision);
      if (history) onClose();
      else onDiscard?.();
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
      aria-label={history ? "历史改动对照" : "审阅改动"}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <header>
        <h2>
          {history ? entry!.title : "审阅改动"}
          <small>{doc.name}</small>
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
        <button
          aria-pressed={tab === "evidence"}
          onClick={() => setTab("evidence")}
        >
          运行记录{records.length ? ` · ${records.length}` : ""}
        </button>
        {history && (
          <select
            aria-label="历史对照方式"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="change" disabled={!entry!.beforeRevision}>
              这次修改
            </option>
            <option value="current">与当前工程比较</option>
          </select>
        )}
      </nav>
      {stale && (
        <p className="proposal-warning" role="status">
          文档已有后续修改，这份{history ? "对照" : "候选"}只能查看。
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
                    {names.map((name) => (
                      <option key={name} value={name}>
                        {name}
                        {!review.before.circuits.some((c) => c.name === name)
                          ? " · 新增"
                          : !review.after.circuits.some((c) => c.name === name)
                            ? " · 移除"
                            : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {detail && (
                  <>
                    <p
                      className={`comparison-connectivity ${detail.connectivity.status}`}
                      role="status"
                    >
                      {connectivityNames[detail.connectivity.status] ||
                        "连接核对状态未知"}
                      {detail.connectivity.unknownPorts
                        ? ` · ${detail.connectivity.unknownPorts} 个端口未核对`
                        : ""}
                    </p>
                    {(detail.parents.after.length ||
                      detail.parents.before.length) > 0 && (
                      <details className="comparison-parents">
                        <summary>引用此定义的电路</summary>
                        <div>
                          {[
                            ...new Set(
                              [
                                ...detail.parents.before,
                                ...detail.parents.after,
                              ].map((p) => p.circuit),
                            ),
                          ].map((name) => (
                            <p key={name}>
                              {name}：
                              {detail.parents.before.find(
                                (p) => p.circuit === name,
                              )?.count || 0}{" "}
                              →{" "}
                              {detail.parents.after.find(
                                (p) => p.circuit === name,
                              )?.count || 0}{" "}
                              处
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                    {detail.errors.length > 0 && (
                      <p className="proposal-warning">
                        {detail.errors.join("；")}
                      </p>
                    )}
                  </>
                )}
                {detailError && (
                  <p className="proposal-warning" role="alert">
                    连接与图面对照不可用：{detailError}
                  </p>
                )}
                <div
                  className="comparison-filters"
                  role="group"
                  aria-label="改动类别"
                >
                  {Object.entries(categoryNames)
                    .filter(
                      ([key]) =>
                        key === "all" ||
                        circuitRows.some((row) => row.category === key),
                    )
                    .map(([key, label]) => (
                      <button
                        key={key}
                        aria-pressed={category === key}
                        onClick={() => setCategory(key)}
                      >
                        {label}
                        {key !== "all"
                          ? ` ${circuitRows.filter((row) => row.category === key).length}`
                          : ""}
                      </button>
                    ))}
                </div>
                <input
                  className="comparison-search"
                  type="search"
                  aria-label="查找改动"
                  placeholder="查找元件、接口或信号"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {circuitRows
                  .map((row, index) => ({ row, index }))
                  .filter(
                    ({ row }) =>
                      (category === "all" || row.category === category) &&
                      `${row.title} ${row.fields.map((field) => `${field.name} ${field.before} ${field.after}`).join(" ")}`
                        .toLocaleLowerCase()
                        .includes(query.toLocaleLowerCase()),
                  )
                  .map(({ row, index }) => (
                    <details
                      key={keyFor(row, index)}
                      open={
                        selectedRow === keyFor(row, index) ||
                        circuitRows.length < 5
                      }
                      className={
                        selectedRow === keyFor(row, index)
                          ? "comparison-selected"
                          : ""
                      }
                    >
                      <summary onClick={() => selectRow(row, index)}>
                        <span className={`proposal-kind ${row.kind}`}>
                          {changeNames[row.kind as keyof typeof changeNames] ||
                            row.kind}
                        </span>
                        {row.title}
                      </summary>
                      <table>
                        <thead>
                          <tr>
                            <th>内容</th>
                            <th>{beforeLabel}</th>
                            <th>{afterLabel}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.fields.map((field, i) => (
                            <tr key={i}>
                              <th>{field.name}</th>
                              <td>{field.before ?? "—"}</td>
                              <td>{field.after ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  ))}
                {!circuitRows.length && (
                  <p className="proposal-empty">这份电路没有结构改动。</p>
                )}
              </>
            )}
          </section>
          <section className="proposal-preview" aria-label="电路预览">
            <div className="proposal-preview-toolbar">
              <button
                aria-pressed={!candidate}
                onClick={() => setCandidate(false)}
              >
                {beforeLabel}
              </button>
              <button
                aria-pressed={candidate}
                onClick={() => setCandidate(true)}
              >
                {afterLabel}
              </button>
              <button onClick={() => setReload((v) => v + 1)}>重载</button>
            </div>
            <div className="comparison-viewbar">
              <button
                aria-label="缩小对照"
                disabled={!viewed}
                onClick={() => zoom(1.3)}
              >
                <Minus size={14} />
              </button>
              <button
                aria-label="放大对照"
                disabled={!viewed}
                onClick={() => zoom(1 / 1.3)}
              >
                <Plus size={14} />
              </button>
              <button disabled={!pictureBounds} onClick={() => setCamera(null)}>
                <Maximize size={14} />
                全图
              </button>
            </div>
            <div className="proposal-preview-image">
              {previewError ? (
                <p role="alert">预览失败：{previewError}</p>
              ) : preview?.missing ? (
                <p>此版本没有这份电路。</p>
              ) : preview?.image ? (
                pictureBounds && viewed ? (
                  <svg
                    className="comparison-picture"
                    role="img"
                    aria-label={`${selected} · ${candidate ? afterLabel : beforeLabel}`}
                    viewBox={`${viewed.x} ${viewed.y} ${viewed.width} ${viewed.height}`}
                  >
                    <image href={preview.image} {...pictureBounds} />
                    {selectedObjects.map((object) => (
                      <rect
                        key={object.id}
                        x={object.bounds.x - 3}
                        y={object.bounds.y - 3}
                        width={Math.max(6, object.bounds.width + 6)}
                        height={Math.max(6, object.bounds.height + 6)}
                        fill="var(--selection-fill)"
                        stroke="var(--accent)"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </svg>
                ) : (
                  <img
                    src={preview.image}
                    alt={`${selected} · ${candidate ? afterLabel : beforeLabel}`}
                  />
                )
              ) : (
                <p>{review ? "正在生成原生预览…" : ""}</p>
              )}
            </div>
            {preview?.warnings && preview.warnings.length > 0 && (
              <details className="proposal-warning">
                <summary>原生加载提示</summary>
                <ul>
                  {preview.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            {onLocate && (
              <button
                className="comparison-locate"
                disabled={stale || !locateObject}
                title={
                  locateObject
                    ? "关闭对照并在当前电路中选中"
                    : "这项改动在当前版本没有可定位对象"
                }
                onClick={() => {
                  if (locateObject) {
                    onLocate({
                      circuit: selected,
                      revision: doc.revision,
                      object: locateObject,
                    });
                    onClose();
                  }
                }}
              >
                <LocateFixed size={14} />
                在当前工程中定位
              </button>
            )}
          </section>
        </div>
      ) : tab === "source" ? (
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
                  <th colSpan={2}>{beforeLabel}</th>
                  <th colSpan={2}>{afterLabel}</th>
                </tr>
              </thead>
              <tbody>
                {sourceLines.map((line, index) =>
                  !allLines && !changedLines.has(index) ? (
                    index === 0 || changedLines.has(index - 1) ? (
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
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="comparison-evidence">
          <label className="proposal-circuit">
            电路
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {names.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          {review?.evidenceWarning && (
            <p className="proposal-warning" role="alert">
              {review.evidenceWarning}
            </p>
          )}
          {(!review?.evidenceWarning || records.length > 0) && (
            <VerificationRecords
              records={records}
              circuit={selected}
              versions={
                review
                  ? {
                      [review.before.revision]: beforeLabel,
                      [review.after.revision]: afterLabel,
                    }
                  : {}
              }
            />
          )}
        </div>
      )}
      <footer>
        <span>
          {history
            ? "恢复会追加一条修改记录，已有历史保留。"
            : "原版本来自本轮开始时的工作副本；候选尚未应用。"}
        </span>
        {!history && (
          <button disabled={pending} onClick={onDiscard}>
            放弃候选
          </button>
        )}
        <button
          className="primary"
          disabled={
            pending ||
            stale ||
            !review ||
            (history && entry!.revision === doc.revision)
          }
          onClick={() => void apply()}
        >
          {pending
            ? history
              ? "正在恢复…"
              : "正在应用…"
            : history
              ? "恢复此版本"
              : "应用全部改动"}
        </button>
      </footer>
    </dialog>
  );
}
