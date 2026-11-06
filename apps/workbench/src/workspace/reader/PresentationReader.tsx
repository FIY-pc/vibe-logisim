import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SlideCanvas,
  PptxI18nProvider,
  useViewerBuildingBlocks,
  renderToCanvas,
  type PowerPointViewerHandle,
} from "pptx-react-viewer";
import { translationsZhCN } from "pptx-react-viewer/i18n/zh-CN";
import "pptx-react-viewer/canvas.css";
import {
  ChevronLeft,
  ChevronRight,
  Quote,
  ZoomIn,
  ZoomOut,
  Maximize,
} from "lucide-react";
import { Button, IconButton, TextField } from "../../design/ui";
import type { ReferenceInput } from "../../conversation/references";
import { decodeBase64 } from "../binary";
import { bindPresentationNavigation } from "./presentationNavigation";
import {
  readingPosition,
  saveReadingPosition,
  type PreviewFile,
} from "./types";

interface Props {
  file: PreviewFile;
  canQuote: boolean;
  onQuote(reference: ReferenceInput): void;
  onError(error: unknown): void;
  onActivate?(): void;
}

const translate = (key: string) =>
  translationsZhCN[key as keyof typeof translationsZhCN];

export default function PresentationReader(props: Props) {
  return (
    <PptxI18nProvider locale="zh-CN" translate={translate}>
      <PresentationPages {...props} />
    </PptxI18nProvider>
  );
}

/** The OOXML viewer owns parsing and slide layout; the workspace owns navigation and references. */
function PresentationPages({
  file,
  canQuote,
  onQuote,
  onError,
  onActivate,
}: Props) {
  const handle = useRef<PowerPointViewerHandle>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const content = useMemo(() => decodeBase64(file.data || ""), [file.data]);
  const initialPage = useRef(readingPosition(file).page || 1);
  const [page, setPage] = useState(initialPage.current);
  const [pageInput, setPageInput] = useState(String(page));
  const [capturing, setCapturing] = useState(false);
  const rememberPage = useCallback(
    (index: number) => {
      setPage(index + 1);
      setPageInput(String(index + 1));
      saveReadingPosition(file, { page: index + 1 });
    },
    [file],
  );
  const { canvasProps, toolbarProps, loading, error } = useViewerBuildingBlocks(
    {
      content,
      handle,
      canEdit: false,
      autosaveEnabled: false,
      googleFonts: false,
      allowExternalContent: false,
      initialSlide: initialPage.current - 1,
      fitPadding: 24,
      maxFitScale: null,
      onActiveSlideChange: rememberPage,
    },
  );
  const count = handle.current?.getSlideCount() || 0;
  const ready = !loading && !error && count > 0;
  const goTo = (next: number) => {
    const target = Number.isFinite(next)
      ? Math.min(count, Math.max(1, Math.trunc(next)))
      : page;
    handle.current?.goTo(target - 1);
    setPageInput(String(target));
    if (target !== page)
      canvasProps.zoom.canvasViewportRef.current?.scrollTo({ top: 0, left: 0 });
  };
  const navigation = useRef({ ready, capturing, page, count, goTo });
  navigation.current = { ready, capturing, page, count, goTo };
  useEffect(() => {
    const surface = canvas.current;
    if (!ready || !surface) return;
    const stop = bindPresentationNavigation(surface, () => ({
      enabled: navigation.current.ready && !navigation.current.capturing,
      page: navigation.current.page,
      count: navigation.current.count,
      viewport: canvasProps.zoom.canvasViewportRef.current,
      slide: canvasProps.zoom.canvasStageRef.current,
      goTo: navigation.current.goTo,
    }));
    // Opening a document transfers keyboard navigation from the file tree/tab.
    // A reader that finishes loading while someone types must not steal focus.
    const focused = document.activeElement;
    if (
      focused === document.body ||
      focused?.closest('[role="tree"],[role="tablist"]')
    )
      surface.focus({ preventScroll: true });
    return stop;
  }, [
    ready,
    canvasProps.zoom.canvasViewportRef,
    canvasProps.zoom.canvasStageRef,
  ]);
  const turnPage = (delta: number) => {
    goTo(page + delta);
    canvas.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (ready && file.page) handle.current?.goTo(file.page - 1);
  }, [file.page, ready]);
  const quote = async () => {
    const slide = canvasProps.zoom.canvasStageRef.current;
    if (!slide || !ready || capturing) return;
    setCapturing(true);
    // Capture the page and its identity together, even if the user navigates while rasterising.
    const reference = {
      kind: "material" as const,
      label: file.name,
      path: file.path || file.name,
      folderId: file.folderId,
      revision: file.revision,
      pathVersion: file.pathVersion,
      page,
      text: slide.innerText,
    };
    try {
      const scale =
        Math.min(1600 / canvasProps.canvasSize.width, 2) /
        canvasProps.zoom.editorScale;
      const image = await renderToCanvas(slide, { scale, logging: false });
      if (
        !slide.isConnected ||
        handle.current?.getActiveSlideIndex() !== reference.page - 1
      )
        return;
      onQuote({ ...reference, image: image.toDataURL("image/png") });
    } catch (failure) {
      onError(failure);
    } finally {
      setCapturing(false);
    }
  };
  return (
    <section
      className="presentation-reader"
      aria-label="演示文稿预览"
      onPointerDownCapture={onActivate}
    >
      <div className="reader-actions">
        <IconButton
          aria-label="上一张幻灯片"
          aria-keyshortcuts="ArrowLeft PageUp"
          disabled={!ready || page <= 1 || capturing}
          onClick={() => turnPage(-1)}
        >
          <ChevronLeft size={16} />
        </IconButton>
        <TextField.Root
          aria-label="幻灯片页码"
          className="presentation-page"
          type="number"
          min={1}
          max={count || 1}
          value={pageInput}
          disabled={!ready || capturing}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={() => goTo(Number(pageInput))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              goTo(Number(pageInput));
            }
          }}
        />
        <span aria-live="polite">/ {count || "—"}</span>
        <IconButton
          aria-label="下一张幻灯片"
          aria-keyshortcuts="ArrowRight PageDown"
          disabled={!ready || page >= count || capturing}
          onClick={() => turnPage(1)}
        >
          <ChevronRight size={16} />
        </IconButton>
        <IconButton
          aria-label="缩小幻灯片"
          disabled={!ready || capturing}
          onClick={toolbarProps.onZoomOut}
        >
          <ZoomOut size={16} />
        </IconButton>
        <IconButton
          aria-label="放大幻灯片"
          disabled={!ready || capturing}
          onClick={toolbarProps.onZoomIn}
        >
          <ZoomIn size={16} />
        </IconButton>
        <IconButton
          aria-label="适合窗口"
          disabled={!ready || capturing}
          onClick={toolbarProps.onZoomToFit}
        >
          <Maximize size={16} />
        </IconButton>
        <Button
          variant="ghost"
          color="gray"
          disabled={!ready || !canQuote || capturing}
          onClick={() => void quote()}
        >
          <Quote size={15} />
          {capturing ? "正在引用…" : "引用当前页"}
        </Button>
      </div>
      {error ? (
        <div className="reader-unavailable" role="alert">
          <p>无法预览这份演示文稿</p>
          <p>{error}</p>
        </div>
      ) : loading ? (
        <div className="reader-unavailable" role="status">
          正在加载演示文稿…
        </div>
      ) : (
        <div
          ref={canvas}
          className="presentation-canvas"
          role="region"
          aria-label="幻灯片画布"
          tabIndex={0}
          onFocusCapture={onActivate}
          onWheelCapture={onActivate}
        >
          <SlideCanvas
            {...canvasProps}
            showRulers={false}
            showGrid={false}
            guides={[]}
          />
          <IconButton
            className="presentation-page-turn previous"
            variant="soft"
            aria-label="上一页"
            data-tip="上一页（← / PageUp）"
            disabled={!ready || page <= 1 || capturing}
            onClick={() => turnPage(-1)}
          >
            <ChevronLeft size={20} />
          </IconButton>
          <IconButton
            className="presentation-page-turn next"
            variant="soft"
            aria-label="下一页"
            data-tip="下一页（→ / PageDown）"
            disabled={!ready || page >= count || capturing}
            onClick={() => turnPage(1)}
          >
            <ChevronRight size={20} />
          </IconButton>
        </div>
      )}
    </section>
  );
}
