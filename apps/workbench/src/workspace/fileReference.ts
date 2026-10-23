import { command } from "../shared/transport";
import { openPdf, pageText } from "./pdf";
import type { ReferenceInput } from "../conversation/references";

// The runtime keeps this much text of one reference.
const TEXT_LIMIT = 24_000;
interface Read {
  revision?: string;
  pathVersion?: number;
}

/** A project file as a conversation reference: its text, or the image itself. */
export async function fileReference(
  folderId: string,
  path: string,
): Promise<ReferenceInput> {
  const label = path.split("/").at(-1) || path;
  const base = { kind: "material", label, path, folderId } as const;
  if (/\.(pdf|png|jpe?g|webp)$/i.test(label)) {
    const file = await command<Read & { data: string; mime: string }>({
      op: "folderPreview",
      folder_id: folderId,
      path,
    });
    const read = { revision: file.revision, pathVersion: file.pathVersion };
    if (file.mime !== "application/pdf")
      return {
        ...base,
        ...read,
        image: `data:${file.mime};base64,${file.data}`,
      };
    const pdf = await openPdf(file.data);
    try {
      let text = "";
      for (
        let page = 1;
        page <= pdf.numPages && text.length < TEXT_LIMIT;
        page++
      )
        text += `[第 ${page} 页]\n${await pageText(pdf, page)}\n`;
      if (text.replace(/\[第 \d+ 页\]/g, "").trim())
        return { ...base, ...read, text };
      // A scanned document has no text layer: its first page is the reference.
      const first = await pdf.getPage(1),
        viewport = first.getViewport({ scale: 1.25 }),
        canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await first.render({ canvas, viewport }).promise;
      return {
        ...base,
        ...read,
        page: 1,
        image: canvas.toDataURL("image/png"),
      };
    } finally {
      await pdf.loadingTask.destroy();
    }
  }
  const file = await command<Read & { text: string }>({
    op: "folderRead",
    folder_id: folderId,
    path,
  });
  return {
    ...base,
    revision: file.revision,
    pathVersion: file.pathVersion,
    text: file.text,
  };
}
