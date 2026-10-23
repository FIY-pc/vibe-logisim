import { useEffect, useRef, useState } from "react";
import type { ReferenceInput } from "../conversation/references";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { openPdf, pageText } from "./pdf";
import { useModal } from "../shared/dialog";
export interface PreviewFile {
  name: string;
  text?: string;
  data?: string;
  mime?: string;
  path?: string;
  revision?: string;
  page?: number;
  pathVersion?: number;
  folderId?: string;
}
export function FilePreview({
  file,
  onClose,
  onQuote,
}: {
  file: PreviewFile;
  onClose: () => void;
  onQuote: (reference: ReferenceInput) => void;
}) {
  const dialog = useModal(),
    canvas = useRef<HTMLCanvasElement>(null),
    textArea = useRef<HTMLTextAreaElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(file.page || 1),
    [text, setText] = useState(file.text || ""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  useEffect(() => {
    if (file.mime !== "application/pdf" || !file.data) return;
    let live = true,
      loaded: PDFDocumentProxy | undefined;
    setPending(true);
    void openPdf(file.data)
      .then(async (result) => {
        loaded = result;
        if (live) setPdf(result);
        else await result.loadingTask.destroy();
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
      void loaded?.loadingTask.destroy();
    };
  }, [file]);
  useEffect(() => {
    if (!pdf) return;
    let live = true,
      task: RenderTask | undefined;
    setPending(true);
    setText("");
    setError("");
    void pdf
      .getPage(page)
      .then(async (current) => {
        if (!live || !canvas.current) return;
        const viewport = current.getViewport({ scale: 1.25 });
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        task = current.render({ canvas: canvas.current, viewport });
        const contents = await pageText(pdf, page);
        if (live) setText(contents);
        await task.promise;
      })
      .catch((e) => {
        if (live && e.name !== "RenderingCancelledException")
          setError(String(e));
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [pdf, page]);
  const quote = () => {
    const textarea = textArea.current;
    const selection =
      textarea && textarea.selectionEnd > textarea.selectionStart
        ? text.slice(textarea.selectionStart, textarea.selectionEnd)
        : text;
    let image: string | undefined;
    if (file.mime === "application/pdf" && canvas.current)
      image = canvas.current.toDataURL("image/png");
    else if (file.mime?.startsWith("image/") && file.data)
      image = `data:${file.mime};base64,${file.data}`;
    onQuote({
      kind: "material",
      label: file.name,
      path: file.path || file.name,
      revision: file.revision,
      folderId: file.folderId,
      pathVersion: file.pathVersion,
      page: pdf ? page : undefined,
      text: selection,
      image,
    });
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="file-preview"
      aria-label={file.name}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <strong>{file.name}</strong>
        {pdf && (
          <>
            <button
              aria-label="上一页"
              disabled={page === 1 || pending}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <label>
              <input
                aria-label="PDF 页码"
                type="number"
                min={1}
                max={pdf.numPages}
                value={page}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n > 0 && n <= pdf.numPages)
                    setPage(n);
                }}
              />{" "}
              / {pdf.numPages}
            </label>
            <button
              aria-label="下一页"
              disabled={page === pdf.numPages || pending}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </>
        )}
        <button
          className="preview-close"
          aria-label="关闭资料"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      {pending && <p role="status">正在读取…</p>}
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      <div className="file-preview-body">
        {file.mime === "application/pdf" ? (
          <canvas ref={canvas} aria-label={`第 ${page} 页`} />
        ) : file.mime?.startsWith("image/") ? (
          <img src={`data:${file.mime};base64,${file.data}`} alt={file.name} />
        ) : null}
        {text && (
          <textarea
            ref={textArea}
            readOnly
            value={text}
            aria-label="资料文字"
            spellCheck={false}
          />
        )}
      </div>
      {(text || file.data) && (
        <footer>
          <button
            onPointerDown={(e) => e.preventDefault()}
            disabled={
              pending || !!error || (file.mime === "application/pdf" && !pdf)
            }
            onClick={quote}
          >
            {pdf ? "引用这一页" : "引用到对话"}
          </button>
        </footer>
      )}
    </dialog>
  );
}
