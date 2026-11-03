import type { ReferenceRegion } from "../../conversation/references";
export interface ReadingPosition {
  page?: number;
  zoom?: string;
  top?: number;
  left?: number;
  scroll?: number;
  region?: ReferenceRegion;
}
export interface PreviewFile {
  name: string;
  text?: string;
  data?: string;
  mime?: string;
  path?: string;
  revision?: string;
  page?: number;
  region?: ReferenceRegion;
  pathVersion?: number;
  folderId?: string;
  unavailable?: string;
  location?: string;
}
export const readerKey = (file: PreviewFile) =>
  `${file.folderId || ""}:${file.path || file.name}`;
const storageKey = (file: PreviewFile) => "vibe:reading:" + readerKey(file);
export function readingPosition(file: PreviewFile): ReadingPosition {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey(file)) || "{}");
  } catch {}
  return {
    ...saved,
    ...(file.page
      ? { page: file.page, region: file.region, top: undefined, left: 0 }
      : {}),
  };
}
export function saveReadingPosition(
  file: PreviewFile,
  position: ReadingPosition,
) {
  try {
    localStorage.setItem(storageKey(file), JSON.stringify(position));
  } catch {}
}
