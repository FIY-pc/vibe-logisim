import { command } from "../shared/transport";
import { openPdf } from "./pdf";
import type { ReferenceInput } from "../conversation/references";
import { PPTX_MIME, usesFolderPreview } from "./materialPreview";

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
  if (usesFolderPreview(label)) {
    const file = await command<Read & { data: string; mime: string }>({
      op: "folderPreview",
      folder_id: folderId,
      path,
    });
    const read = { revision: file.revision, pathVersion: file.pathVersion };
    if (file.mime === PPTX_MIME) {
      const { presentationText } = await import("./reader/presentationText");
      return { ...base, ...read, text: await presentationText(file.data) };
    }
    if (file.mime !== "application/pdf")
      return {
        ...base,
        ...read,
        image: `data:${file.mime};base64,${file.data}`,
      };
    const pdf = await openPdf(file.data);
    try {
      return {
        ...base,
        ...read,
        text: `PDF 文件，共 ${pdf.numPages} 页。完整文件可通过 read_material 按页读取或搜索；本引用没有截取正文。`,
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
