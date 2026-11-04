import { useRef } from "react";
import { Columns2, Maximize2, FileText, CircuitBoard, X } from "lucide-react";
import { FilePreview } from "./FilePreview";
import { useFiles, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { readerKey } from "./reader/types";
import "./reader/Reader.css";

export function FilePreviewRegion() {
  const { stores } = useWorkbench(),
    { doc } = useView();
  const preview = useFiles((state) => state.preview),
    readers = useFiles((state) => state.readers);
  const mode = useFiles((state) => state.readerMode),
    width = useFiles((state) => state.readerWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  if (!preview) return null;
  const files = stores.files.getState();
  return (
    <>
      {doc && mode === "split" && (
        <div
          className="reader-resizer"
          role="separator"
          aria-label="调整资料宽度"
          aria-orientation="vertical"
          aria-valuemin={360}
          aria-valuemax={1400}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = { x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (drag.current)
              files.setReaderWidth(
                drag.current.width + drag.current.x - event.clientX,
              );
          }}
          onPointerUp={(event) => {
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              files.setReaderWidth(
                width + (event.key === "ArrowLeft" ? 24 : -24),
              );
            }
          }}
        />
      )}
      <section
        className="document-reader"
        aria-label="资料阅读器"
        style={{ width: doc && mode === "split" ? width : undefined }}
      >
        <header className="reader-header">
          <div className="reader-tabs" role="tablist" aria-label="已打开的资料">
            {readers.map((file) => (
              <div
                key={readerKey(file)}
                className={
                  "reader-tab" +
                  (readerKey(file) === readerKey(preview) ? " active" : "")
                }
              >
                <button
                  role="tab"
                  aria-selected={readerKey(file) === readerKey(preview)}
                  onClick={() => files.setPreview(file)}
                  title={file.path || file.name}
                >
                  <FileText size={14} />
                  <span>{file.name}</span>
                </button>
                <button
                  className="reader-tab-close"
                  aria-label={`关闭 ${file.name}`}
                  onClick={() => files.closeReader(readerKey(file))}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          {doc && (
            <button className="reader-back" onClick={() => files.hideReader()}>
              <CircuitBoard size={16} />
              电路
            </button>
          )}
          {doc && (
            <button
              className="reader-layout"
              aria-label={mode === "split" ? "展开资料" : "与电路并排"}
              title={mode === "split" ? "展开资料" : "与电路并排"}
              onClick={() =>
                files.setReaderMode(mode === "split" ? "focus" : "split")
              }
            >
              {mode === "split" ? (
                <Maximize2 size={16} />
              ) : (
                <Columns2 size={16} />
              )}
            </button>
          )}
        </header>
        <FilePreview
          key={
            readerKey(preview) +
            ":" +
            (preview.revision || preview.pathVersion || "")
          }
          file={preview}
          canQuote={!!doc}
          onError={stores.notices.getState().onError}
          onQuote={(reference) => {
            if (!doc) {
              stores.notices
                .getState()
                .onError(new Error("打开电路后可以引用资料"));
              return;
            }
            stores.conversation.getState().setQuotation({
              id: crypto.randomUUID(),
              documentId: doc.id,
              references: [reference],
            });
            stores.shell.getState().setRight("chat");
            stores.shell.getState().setSide("review", true);
          }}
        />
      </section>
    </>
  );
}

/** Keep material tabs reachable when a narrow window returns to the circuit. */
export function ReaderRecall() {
  const { stores } = useWorkbench();
  const readers = useFiles((state) => state.readers),
    preview = useFiles((state) => state.preview);
  if (preview || !readers.length) return null;
  return (
    <div className="reader-recall" aria-label="返回资料">
      {readers.map((file) => (
        <button
          key={readerKey(file)}
          onClick={() => stores.files.getState().setPreview(file)}
        >
          <FileText size={14} />
          {file.name}
        </button>
      ))}
    </div>
  );
}
