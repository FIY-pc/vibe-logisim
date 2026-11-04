// The stock Mozilla viewer owns rendering, selection, search and navigation.
// This adapter only connects a project file, reading position and quotations.
const send = (type, data = {}) =>
  parent.postMessage({ source: "vibe-pdf", type, ...data }, location.origin);
// Events inside the viewer do not bubble through the iframe to the workspace.
document.addEventListener("pointerdown", () => send("activate"), true);
document.addEventListener("focusin", () => send("activate"));
const configure = (event) => {
  if (event.detail?.source !== window) return;
  window.PDFViewerApplicationOptions.setAll({
    defaultUrl: "",
    disablePreferences: true,
    enableScripting: false,
    viewerCssTheme: 1,
    annotationEditorMode: -1,
    enableAltText: false,
    localeProperties: { lang: "zh-CN" },
  });
};
parent.document.addEventListener("webviewerloaded", configure);
const { PDFViewerApplication: app } = await import("./viewer.mjs");
parent.document.removeEventListener("webviewerloaded", configure);
await app.initializedPromise;
let position = {},
  loading = false,
  areaMode = false,
  drag = null;
const quoteButton = document.createElement("button");
quoteButton.className = "workbench-quote";
quoteButton.textContent = "引用到对话";
quoteButton.hidden = true;
document.body.append(quoteButton);
const focusBox = document.createElement("div");
focusBox.className = "workbench-region";
focusBox.hidden = true;
document.body.append(focusBox);

function pageAt(node) {
  return (node instanceof Element ? node : node?.parentElement)?.closest(
    ".page[data-page-number]",
  );
}
function normalRect(rect, page) {
  const box = page.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (rect.left - box.left) / box.width));
  const y = Math.max(0, Math.min(1, (rect.top - box.top) / box.height));
  return {
    x,
    y,
    width: Math.max(
      0,
      Math.min(1, (rect.left + rect.width - box.left) / box.width) - x,
    ),
    height: Math.max(
      0,
      Math.min(1, (rect.top + rect.height - box.top) / box.height) - y,
    ),
  };
}
function showRegion(page, region) {
  if (!page || !region) return;
  const rect = page.getBoundingClientRect();
  Object.assign(focusBox.style, {
    left: `${rect.left + region.x * rect.width}px`,
    top: `${rect.top + region.y * rect.height}px`,
    width: `${region.width * rect.width}px`,
    height: `${region.height * rect.height}px`,
  });
  focusBox.hidden = false;
}
async function quote(page, region, text = "") {
  const source = await app.pdfDocument.getPage(page);
  const base = source.getViewport({ scale: 1 });
  const viewport = source.getViewport({
    scale: Math.min(1.5, 2400 / Math.max(base.width, base.height)),
  });
  const full = document.createElement("canvas");
  full.width = viewport.width;
  full.height = viewport.height;
  await source.render({ canvasContext: full.getContext("2d"), viewport })
    .promise;
  let image = full;
  if (region) {
    image = document.createElement("canvas");
    image.width = Math.max(1, Math.round(full.width * region.width));
    image.height = Math.max(1, Math.round(full.height * region.height));
    image
      .getContext("2d")
      .drawImage(
        full,
        region.x * full.width,
        region.y * full.height,
        image.width,
        image.height,
        0,
        0,
        image.width,
        image.height,
      );
  }
  send("quote", { page, region, text, image: image.toDataURL("image/png") });
  full.width = full.height = 0;
  quoteButton.hidden = true;
}
quoteButton.addEventListener("pointerdown", (event) => event.preventDefault());
quoteButton.addEventListener("click", () => {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const page = pageAt(selection.anchorNode);
  if (!page) return;
  const region = normalRect(
    selection.getRangeAt(0).getBoundingClientRect(),
    page,
  );
  void quote(
    Number(page.dataset.pageNumber),
    region,
    selection.toString(),
  ).catch((error) => send("error", { message: error.message }));
});
document.addEventListener("selectionchange", () => {
  const selection = getSelection();
  if (
    areaMode ||
    !selection?.rangeCount ||
    selection.isCollapsed ||
    !pageAt(selection.anchorNode)
  ) {
    quoteButton.hidden = true;
    return;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  quoteButton.style.left = `${Math.max(8, Math.min(innerWidth - 150, rect.left))}px`;
  quoteButton.style.top = `${Math.min(innerHeight - 42, rect.bottom + 6)}px`;
  quoteButton.hidden = false;
});
document.addEventListener(
  "pointerdown",
  (event) => {
    if (!areaMode || event.button !== 0) return;
    const page = pageAt(event.target);
    if (!page) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { page, x: event.clientX, y: event.clientY };
    getSelection()?.removeAllRanges();
  },
  true,
);
document.addEventListener(
  "pointermove",
  (event) => {
    if (!drag) return;
    event.preventDefault();
    const box = drag.page.getBoundingClientRect();
    const x = Math.max(box.left, Math.min(box.right, event.clientX)),
      y = Math.max(box.top, Math.min(box.bottom, event.clientY));
    drag.region = normalRect(
      {
        left: Math.min(x, drag.x),
        top: Math.min(y, drag.y),
        width: Math.abs(x - drag.x),
        height: Math.abs(y - drag.y),
      },
      drag.page,
    );
    showRegion(drag.page, drag.region);
  },
  true,
);
document.addEventListener("pointerup", () => {
  if (!drag) return;
  const picked = drag;
  drag = null;
  areaMode = false;
  document.body.classList.remove("workbench-capture");
  send("capture-ended");
  if (picked.region?.width > 0.005 && picked.region?.height > 0.005)
    void quote(Number(picked.page.dataset.pageNumber), picked.region).catch(
      (error) => send("error", { message: error.message }),
    );
});
document.addEventListener("pointercancel", () => {
  drag = null;
  areaMode = false;
  focusBox.hidden = true;
  document.body.classList.remove("workbench-capture");
  send("capture-ended");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    areaMode = false;
    drag = null;
    focusBox.hidden = true;
    document.body.classList.remove("workbench-capture");
    send("capture-ended");
  }
});
app.eventBus.on("updateviewarea", ({ location: at }) => {
  if (!loading)
    send("position", {
      position: {
        page: at.pageNumber,
        zoom: app.pdfViewer.currentScaleValue,
        top: at.top,
        left: at.left,
      },
    });
  focusBox.hidden = true;
});
app.eventBus.on("pagesinit", () => {
  app.pdfViewer.currentScaleValue = position.zoom || "page-width";
  app.pdfViewer.scrollPageIntoView({
    pageNumber: Math.max(
      1,
      Math.min(app.pdfDocument.numPages, position.page || 1),
    ),
    destArray: [
      null,
      { name: "XYZ" },
      position.left || 0,
      position.top ?? null,
      null,
    ],
  });
  loading = false;
});
app.eventBus.on("pagerendered", ({ pageNumber }) => {
  if (position.region && pageNumber === position.page) {
    showRegion(
      document.querySelector(`.page[data-page-number="${pageNumber}"]`),
      position.region,
    );
    position.region = null;
  }
});
window.addEventListener("message", async (event) => {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.source !== "vibe-reader"
  )
    return;
  const data = event.data;
  try {
    if (data.type === "open") {
      loading = true;
      position = data.position || {};
      document.title = data.name;
      await app.open({
        data: Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)),
      });
      send("loaded", { pages: app.pdfDocument.numPages });
    } else if (data.type === "goto") {
      position = data.position;
      app.pdfViewer.scrollPageIntoView({
        pageNumber: position.page,
        destArray: [null, { name: "XYZ" }, 0, null, null],
      });
      requestAnimationFrame(() =>
        showRegion(
          document.querySelector(`.page[data-page-number="${position.page}"]`),
          position.region,
        ),
      );
    } else if (data.type === "quote-page") {
      const page = app.pdfViewer.currentPageNumber;
      const contents = await (
        await app.pdfDocument.getPage(page)
      ).getTextContent();
      const text = contents.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("");
      await quote(page, null, text);
    } else if (data.type === "capture") {
      areaMode = !areaMode;
      focusBox.hidden = true;
      document.body.classList.toggle("workbench-capture", areaMode);
    }
  } catch (error) {
    loading = false;
    send("error", { message: error.message });
  }
});
send("ready");
