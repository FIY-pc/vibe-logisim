import { useEffect, useRef, useState } from "react";
import { desktop } from "../shared/transport";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Scan,
  Quote,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  FileQuestion,
} from "lucide-react";
import type {
  ReferenceInput,
  ReferenceRegion,
} from "../conversation/references";
import {
  readingPosition,
  saveReadingPosition,
  type PreviewFile,
} from "./reader/types";
export type { PreviewFile } from "./reader/types";

interface Props {
  file: PreviewFile;
  onQuote(reference: ReferenceInput): void;
  onError(error: unknown): void;
  canQuote: boolean;
}
const baseReference = (file: PreviewFile) => ({
  kind: "material" as const,
  label: file.name,
  path: file.path || file.name,
  folderId: file.folderId,
  revision: file.revision,
  pathVersion: file.pathVersion,
});

/** Mozilla owns rendering, selection, search and navigation. */
function PdfReader({ file, onQuote, onError, canQuote }: Props) {
  const frame = useRef<HTMLIFrameElement>(null),
    callbacks = useRef({ onQuote, onError, file, canQuote });
  callbacks.current = { onQuote, onError, file, canQuote };
  const [loaded, setLoaded] = useState(false),
    [capturing, setCapturing] = useState(false);
  const send = (type: string, values = {}) =>
    frame.current?.contentWindow?.postMessage(
      { source: "vibe-reader", type, ...values },
      window.location.origin,
    );
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== location.origin ||
        event.data?.source !== "vibe-pdf"
      )
        return;
      const data = event.data,
        current = callbacks.current;
      if (data.type === "ready")
        send("open", {
          data: current.file.data,
          name: current.file.name,
          position: readingPosition(current.file),
        });
      if (data.type === "loaded") setLoaded(true);
      if (data.type === "position")
        saveReadingPosition(current.file, data.position);
      if (data.type === "capture-ended") setCapturing(false);
      if (data.type === "error") current.onError(new Error(data.message));
      if (data.type === "quote" && current.canQuote)
        current.onQuote({
          ...baseReference(current.file),
          page: data.page,
          region: data.region || undefined,
          text: data.text,
          image: data.image,
        });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (loaded && file.page)
      send("goto", { position: { page: file.page, region: file.region } });
  }, [file, loaded]);
  return (
    <>
      <div className="reader-actions">
        <button
          disabled={!loaded || !canQuote}
          onClick={() => send("quote-page")}
        >
          <Quote size={15} />
          引用当前页
        </button>
        <button
          disabled={!loaded || !canQuote}
          aria-pressed={capturing}
          onClick={() => {
            setCapturing(!capturing);
            send("capture");
          }}
        >
          <Scan size={15} />
          框选引用
        </button>
      </div>
      <iframe
        ref={frame}
        title={file.name}
        className="pdf-reader"
        src="/pdf-viewer/web/viewer.html?file="
      />
    </>
  );
}

function ImageReader({ file, onQuote, canQuote }: Props) {
  const [zoom, setZoom] = useState(Number(readingPosition(file).zoom) || 1),
    [capture, setCapture] = useState(false),
    [region, setRegion] = useState<ReferenceRegion | null>(file.region || null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroll.current)
      scroll.current.scrollTop = readingPosition(file).scroll || 0;
  }, []);
  useEffect(() => {
    saveReadingPosition(file, {
      zoom: String(zoom),
      scroll: scroll.current?.scrollTop || 0,
    });
  }, [zoom]);
  useEffect(() => {
    setRegion(file.region || null);
  }, [file.region]);
  const image = useRef<HTMLImageElement>(null),
    start = useRef<{ x: number; y: number } | null>(null);
  const quote = () => {
    const source = image.current;
    if (!source) return;
    let data = `data:${file.mime};base64,${file.data}`;
    if (region) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(
        1,
        Math.round(source.naturalWidth * region.width),
      );
      canvas.height = Math.max(
        1,
        Math.round(source.naturalHeight * region.height),
      );
      canvas
        .getContext("2d")!
        .drawImage(
          source,
          region.x * source.naturalWidth,
          region.y * source.naturalHeight,
          canvas.width,
          canvas.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      data = canvas.toDataURL("image/png");
    }
    onQuote({
      ...baseReference(file),
      region: region || undefined,
      image: data,
    });
  };
  return (
    <>
      <div className="reader-actions">
        <button
          aria-label="缩小图片"
          onClick={() => setZoom(Math.max(0.25, zoom / 1.25))}
        >
          <ZoomOut size={16} />
        </button>
        <button aria-label="适合窗口" onClick={() => setZoom(1)}>
          <RotateCcw size={15} />
        </button>
        <button
          aria-label="放大图片"
          onClick={() => setZoom(Math.min(6, zoom * 1.25))}
        >
          <ZoomIn size={16} />
        </button>
        <button
          aria-pressed={capture}
          onClick={() => {
            setCapture(!capture);
            setRegion(null);
          }}
        >
          <Scan size={15} />
          框选
        </button>
        <button disabled={!canQuote} onClick={quote}>
          <Quote size={15} />
          {region ? "引用选区" : "引用图片"}
        </button>
      </div>
      <div
        ref={scroll}
        className="reader-scroll image-reader"
        onScroll={(event) =>
          saveReadingPosition(file, {
            zoom: String(zoom),
            scroll: event.currentTarget.scrollTop,
          })
        }
      >
        <div
          className={"image-stage" + (capture ? " capturing" : "")}
          style={{ width: `${zoom * 100}%` }}
          onPointerDown={(event) => {
            if (!capture || !image.current) return;
            event.preventDefault();
            const box = image.current.getBoundingClientRect();
            start.current = {
              x: (event.clientX - box.left) / box.width,
              y: (event.clientY - box.top) / box.height,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!start.current || !image.current) return;
            const box = image.current.getBoundingClientRect(),
              x = Math.max(
                0,
                Math.min(1, (event.clientX - box.left) / box.width),
              ),
              y = Math.max(
                0,
                Math.min(1, (event.clientY - box.top) / box.height),
              );
            setRegion({
              x: Math.min(x, start.current.x),
              y: Math.min(y, start.current.y),
              width: Math.abs(x - start.current.x),
              height: Math.abs(y - start.current.y),
            });
          }}
          onPointerCancel={() => {
            start.current = null;
            setCapture(false);
          }}
          onPointerUp={(event) => {
            start.current = null;
            setCapture(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        >
          <img
            ref={image}
            src={`data:${file.mime};base64,${file.data}`}
            alt={file.name}
            draggable={false}
          />
          {region && (
            <div
              className="image-selection"
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.width * 100}%`,
                height: `${region.height * 100}%`,
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}
function TextReader({ file, onQuote, onError, canQuote }: Props) {
  const body = useRef<HTMLDivElement>(null),
    [selection, setSelection] = useState(""),
    [showSource, setShowSource] = useState(false);
  const markdown =
    /\.(md|markdown)$/i.test(file.name) ||
    /^text\/(markdown|x-markdown)(;|$)/i.test(file.mime || "");
  useEffect(() => {
    setShowSource(false);
    setSelection("");
  }, [file]);
  useEffect(() => {
    if (body.current)
      body.current.scrollTop = readingPosition(file).scroll || 0;
  }, []);
  return (
    <>
      <div className="reader-actions">
        {markdown && (
          <button
            aria-pressed={showSource}
            onClick={() => {
              setShowSource((value) => !value);
              setSelection("");
              window.getSelection()?.removeAllRanges();
            }}
          >
            {showSource ? "查看预览" : "查看源码"}
          </button>
        )}
        <button
          disabled={!canQuote}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() =>
            onQuote({
              ...baseReference(file),
              text: selection || file.text || "",
            })
          }
        >
          <Quote size={15} />
          {selection ? "引用选中文字" : "引用文件"}
        </button>
      </div>
      <div
        ref={body}
        className={
          "reader-scroll " +
          (markdown && !showSource ? "material-markdown" : "material-text")
        }
        onScroll={(event) =>
          saveReadingPosition(file, { scroll: event.currentTarget.scrollTop })
        }
        onPointerUp={() => {
          const selected = window.getSelection();
          setSelection(
            selected?.anchorNode &&
              body.current?.contains(selected.anchorNode) &&
              selected.focusNode &&
              body.current?.contains(selected.focusNode)
              ? selected.toString()
              : "",
          );
        }}
      >
        {markdown && !file.text ? (
          <p className="muted">此 Markdown 文件为空。</p>
        ) : markdown && !showSource ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ children, href }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    if (desktop() && href) {
                      event.preventDefault();
                      void import("@tauri-apps/plugin-opener")
                        .then(({ openUrl }) => openUrl(href))
                        .catch(onError);
                    }
                  }}
                >
                  {children}
                </a>
              ),
            }}
          >
            {file.text || ""}
          </ReactMarkdown>
        ) : (
          <pre>{file.text}</pre>
        )}
      </div>
    </>
  );
}
export function FilePreview(props: Props) {
  if (props.file.unavailable)
    return (
      <div className="reader-unavailable">
        <FileQuestion size={32} />
        <p>{props.file.unavailable}</p>
        {desktop() && props.file.location && (
          <button
            onClick={() =>
              void import("@tauri-apps/plugin-opener")
                .then(({ revealItemInDir }) =>
                  revealItemInDir(props.file.location!),
                )
                .catch(props.onError)
            }
          >
            在文件管理器中显示
          </button>
        )}
      </div>
    );
  if (props.file.mime === "application/pdf") return <PdfReader {...props} />;
  if (props.file.mime?.startsWith("image/")) return <ImageReader {...props} />;
  return <TextReader {...props} />;
}
