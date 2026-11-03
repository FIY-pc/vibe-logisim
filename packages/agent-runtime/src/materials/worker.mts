import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type { MaterialRequest, MaterialPage } from "./read.mts";

async function read(): Promise<MaterialPage> {
  const { file, request } = workerData as {
    file: string;
    request: MaterialRequest;
  };
  const bytes = await readFile(file),
    revision = createHash("sha256").update(bytes).digest("hex");
  const extension = path.extname(file).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    const canvas = await import("@napi-rs/canvas");
    const image = await canvas.loadImage(bytes),
      scale = Math.min(1, 2400 / Math.max(image.width, image.height));
    const surface = canvas.createCanvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    surface
      .getContext("2d")
      .drawImage(image, 0, 0, surface.width, surface.height);
    return {
      path: request.path,
      revision,
      pages: 1,
      page: 1,
      image: surface.toDataURL("image/png"),
    };
  }
  if (extension !== ".pdf")
    throw new Error(
      "read_material 支持 PDF、PNG、JPEG 和 WebP；文本文件请用 read_file。",
    );
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = path.dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
  );
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    // PDF.js requires a trailing '/', including for local Windows paths.
    // Keep filesystem paths: its Node data factory passes them to fs.readFile.
    cMapUrl: path.join(root, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: path.join(root, "standard_fonts") + "/",
    wasmUrl: path.join(root, "wasm") + "/",
  });
  try {
    const pdf = await task.promise;
    const result: MaterialPage = {
      path: request.path,
      revision,
      pages: pdf.numPages,
    };
    const text = async (number: number) =>
      (await (await pdf.getPage(number)).getTextContent()).items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("");
    if (request.query !== undefined) {
      if (!request.query.trim()) throw new Error("搜索词不能为空");
      const start = request.startPage ?? 1;
      if (!Number.isSafeInteger(start) || start < 1 || start > pdf.numPages)
        throw new Error(`页码范围为 1–${pdf.numPages}`);
      const end = Math.min(pdf.numPages, start + 19);
      result.matches = [];
      for (let page = start; page <= end; page++) {
        const contents = await text(page),
          index = contents
            .toLocaleLowerCase()
            .indexOf(request.query.toLocaleLowerCase());
        if (index >= 0)
          result.matches.push({
            page,
            excerpt: contents.slice(
              Math.max(0, index - 100),
              index + request.query.length + 200,
            ),
          });
      }
      result.nextPage = end < pdf.numPages ? end + 1 : undefined;
      return result;
    }
    const number = request.page ?? 1;
    if (!Number.isSafeInteger(number) || number < 1 || number > pdf.numPages)
      throw new Error(`页码范围为 1–${pdf.numPages}`);
    const page = await pdf.getPage(number),
      contents = await text(number),
      offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > contents.length)
      throw new Error(`offset 范围为 0–${contents.length}`);
    result.page = number;
    result.text = contents.slice(offset, offset + 48000);
    result.nextOffset =
      offset + result.text.length < contents.length
        ? offset + result.text.length
        : undefined;
    result.nextPage = number < pdf.numPages ? number + 1 : undefined;
    result.scanned = !contents.trim();
    if (!request.page) {
      const outline = await pdf.getOutline();
      const flatten = (items: typeof outline): unknown[] =>
        (items || []).flatMap((item) => [
          { title: item.title, destination: item.dest },
          ...flatten(item.items),
        ]);
      result.outline = flatten(outline);
    }
    if (request.render || result.scanned) {
      const { createCanvas } = await import("@napi-rs/canvas");
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(2, 2400 / Math.max(base.width, base.height)),
      });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvas: canvas as any,
        canvasContext: canvas.getContext("2d") as any,
        viewport,
      }).promise;
      result.image = canvas.toDataURL("image/png");
    }
    return result;
  } finally {
    await task.destroy();
  }
}
read().then(
  (value) => parentPort!.postMessage({ value }),
  (error) => parentPort!.postMessage({ error: error.message }),
);
