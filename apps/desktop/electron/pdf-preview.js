import {getDocument, GlobalWorkerOptions} from '../node_modules/pdfjs-dist/build/pdf.mjs';

const assets = new URL('../node_modules/pdfjs-dist/', import.meta.url);
GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', assets).href;

window.renderPdf = async (encoded, pageNumber) => {
  let loading;
  try {
    const data = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    loading = getDocument({data, isEvalSupported: false, useSystemFonts: false,
      cMapUrl: new URL('cmaps/', assets).href, cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', assets).href,
      wasmUrl: new URL('wasm/', assets).href});
    const document = await loading.promise;
    if (pageNumber > document.numPages) return {error: `这份 PDF 只有 ${document.numPages} 页，引用的第 ${pageNumber} 页不存在`, code: 'PAGE_NOT_FOUND'};
    const page = await document.getPage(pageNumber);
    const original = page.getViewport({scale: 1});
    const viewport = page.getViewport({scale: 1400 / Math.max(original.width, original.height)});
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
    const content = await page.getTextContent();
    const text = content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('').trim().slice(0, 30000);
    return {page: pageNumber, pages: document.numPages, text, data: canvas.toDataURL('image/png')};
  } catch (error) {
    return {error: error.name === 'PasswordException' ? '这份 PDF 已加密，请在系统应用中解锁后再预览' : 'PDF 无法预览，请检查文件是否完整'};
  } finally { await loading?.destroy(); }
};
