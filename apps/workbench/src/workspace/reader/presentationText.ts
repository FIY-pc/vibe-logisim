import { PptxHandler, findText } from "ooxml-core/pptx";

/** File quotations contain extractable text; page quotations also carry the rendered diagram. */
export async function presentationText(base64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const handler = new PptxHandler();
  try {
    const data = await handler.load(bytes.buffer, {
      eagerDecodeImages: false,
      allowExternalImages: false,
    });
    const pages = data.slides.map((slide, index) => {
      const elements = new Map<string, string[]>();
      for (const match of findText([slide], /[\s\S]+/g)) {
        const segments = elements.get(match.elementId) || [];
        segments.push(match.text);
        elements.set(match.elementId, segments);
      }
      const text = [...elements.values()]
        .map((segments) => segments.join(""))
        .join("\n");
      return `第 ${index + 1} 页\n${text || "（无可提取文字）"}`;
    });
    return `PPTX 文件，共 ${data.slides.length} 页。以下为可提取文字，不含图像中的文字；图表可在预览中引用对应页。\n\n${pages.join("\n\n")}`;
  } finally {
    handler.dispose();
  }
}
