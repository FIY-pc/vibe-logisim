export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Formats whose original bytes the host supplies to the document reader. */
export function usesFolderPreview(path: string): boolean {
  return /\.(pdf|pptx|png|jpe?g|webp)$/i.test(path);
}
