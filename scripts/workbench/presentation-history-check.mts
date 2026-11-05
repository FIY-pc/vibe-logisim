import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { act, createElement } from "react";
import type { useEditorHistory } from "pptx-react-viewer/internals";

const require = createRequire(import.meta.url);
const { createRoot } = require("react-dom/client");
const format = process.argv.includes("--cjs") ? "cjs" : "esm";
const { Presentation, PptxHandler } = (
  format === "cjs"
    ? require("ooxml-core/pptx")
    : await import("ooxml-core/pptx")
) as typeof import("ooxml-core/pptx");
const hook = (
  format === "cjs"
    ? require("pptx-react-viewer/internals")
    : await import("pptx-react-viewer/internals")
).useEditorHistory as typeof useEditorHistory;
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<div id="root"></div>');
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const deck = await Presentation.create();
const handler = new PptxHandler();
const noop = () => {};
try {
  deck.addSlide("Blank");
  deck.addSlide("Blank");
  const data = await handler.load(new Uint8Array(await deck.save()).buffer);
  // Run each distribution in a separate process, avoiding duplicate Yjs module state.
  {
    let inspected = 0;
    const elements = data.slides[0].elements;
    Object.defineProperty(data.slides[0], "elements", {
      configurable: true,
      enumerable: true,
      get() {
        inspected++;
        return elements;
      },
    });
    let history: ReturnType<typeof useEditorHistory>;
    const input = {
      enabled: false,
      slides: data.slides,
      canvasSize: { width: data.width, height: data.height },
      activeSlideIndex: 0,
      templateElementsBySlideId: {},
      selectedElementId: null,
      selectedElementIds: [],
      editTemplateMode: false,
      headerFooter: {},
      loading: false,
      error: null,
      hasActivePointerInteraction: () => false,
      pointerCommitNonce: 0,
      setSlides: noop,
      setCanvasSize: noop,
      setActiveSlideIndex: noop,
      setTemplateElementsBySlideId: noop,
      setSelectedElementId: noop,
      setSelectedElementIds: noop,
      setEditTemplateMode: noop,
      setHeaderFooter: noop,
    };
    function View() {
      history = hook(input);
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    const render = () => act(() => root.render(createElement(View)));
    try {
      await render();
      input.activeSlideIndex = 1;
      await render();
      assert.equal(
        inspected,
        0,
        "Read-only paging must not inspect slide contents for undo",
      );
      input.enabled = true;
      await render();
      assert(inspected > 0, "Editable mode still establishes an undo baseline");
      input.canvasSize = { width: data.width + 10, height: data.height };
      await render();
      assert(
        history!.canUndo,
        "Editable document changes still create undo steps",
      );
      input.enabled = false;
      await render();
      const previousReads = inspected;
      input.activeSlideIndex = 0;
      await render();
      assert.equal(inspected, previousReads);
      input.enabled = true;
      await render();
      assert.equal(
        history!.canUndo,
        false,
        "Re-enabling editing starts from the current document",
      );
    } finally {
      await act(() => root.unmount());
    }
  }
  console.log(
    `PPTX history: read-only navigation skips snapshots; editable undo and mode changes pass (${format})`,
  );
} finally {
  handler.dispose();
  deck.dispose();
  dom.window.close();
}
