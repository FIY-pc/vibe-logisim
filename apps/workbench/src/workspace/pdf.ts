import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Opens a base64 PDF with the bundled worker, character maps and fonts. */
export async function openPdf(data: string): Promise<PDFDocumentProxy> {
  const { GlobalWorkerOptions, getDocument } = await import("pdfjs-dist");
  GlobalWorkerOptions.workerSrc = workerUrl;
  return getDocument({
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
  }).promise;
}

export async function pageText(pdf: PDFDocumentProxy, page: number) {
  const contents = await (await pdf.getPage(page)).getTextContent();
  return contents.items
    .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
    .join("");
}
