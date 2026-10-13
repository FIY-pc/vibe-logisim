import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
export interface PreviewFile {
  name: string;
  text?: string;
  data?: string;
  mime?: string;
  path?: string;
  revision?: string;
}
export function FilePreview({
  file,
  onClose,
  onQuote,
}: {
  file: PreviewFile;
  onClose: () => void;
  onQuote: (label: string, text: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    textArea = useRef<HTMLTextAreaElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [text, setText] = useState(file.text || ""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    if (file.mime !== "application/pdf" || !file.data) return;
    let live = true,
      loaded: PDFDocumentProxy | undefined;
    setPending(true);
    void import("pdfjs-dist")
      .then(async ({ GlobalWorkerOptions, getDocument }) => {
        GlobalWorkerOptions.workerSrc = workerUrl;
        const result = await getDocument({
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
          data: Uint8Array.from(atob(file.data!), (c) => c.charCodeAt(0)),
        }).promise;
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
        const contents = await current.getTextContent();
        if (live)
          setText(
            contents.items
              .map((item) =>
                "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
              )
              .join(""),
          );
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
    onQuote(
      `${file.path || file.name}${pdf ? ` · 第 ${page} 页` : ""}`,
      selection.slice(0, 24000),
    );
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
      {text && (
        <footer>
          <button onClick={quote}>引用到对话</button>
        </footer>
      )}
    </dialog>
  );
}
