import { createRef, type RefObject } from "react";
import { createStore } from "zustand/vanilla";
import type { PreviewFile } from "./FilePreview";
import type { ProjectFolder } from "./Files";
import { field, type Update } from "../shared/setter";
import { readerKey } from "./reader/types";

export interface FilesState {
  /** The open project folder. */
  folder: ProjectFolder | null;
  /** The active material tab. */
  preview: PreviewFile | null;
  readers: PreviewFile[];
  readerMode: "split" | "focus";
  readerWidth: number;
  closeReader(key: string): void;
  hideReader(): void;
  setReaderMode(mode: "split" | "focus"): void;
  setReaderWidth(width: number): void;
  /** The document whose information and export dialog is open. */
  infoTarget: string | null;
  /** Whether the prompt for a folder path is open (outside the desktop app). */
  folderPrompt: boolean;
  /** Whether the prompt for a new circuit file's name is open. */
  newFilePrompt: boolean;
  /** Changes whenever the file tree should be listed again. */
  treeVersion: number;
  /** The hidden file input that imports a circuit outside the desktop app. */
  uploadInput: RefObject<HTMLInputElement | null>;
  setFolder(folder: Update<ProjectFolder | null>): void;
  setPreview(preview: Update<PreviewFile | null>): void;
  setInfoTarget(id: Update<string | null>): void;
  setFolderPrompt(open: Update<boolean>): void;
  setNewFilePrompt(open: Update<boolean>): void;
  refreshTree(): void;
}

export function createFilesStore() {
  return createStore<FilesState>()((set, get) => ({
    folder: null,
    preview: null,
    readers: [],
    readerMode: "split",
    readerWidth: 560,
    hideReader: () => set({ preview: null }),
    closeReader(key) {
      const state = get(),
        readers = state.readers.filter((file) => readerKey(file) !== key);
      set({
        readers,
        preview:
          state.preview && readerKey(state.preview) === key
            ? readers.at(-1) || null
            : state.preview,
      });
    },
    setReaderMode: (readerMode) => set({ readerMode }),
    setReaderWidth: (width) =>
      set({ readerWidth: Math.max(360, Math.min(1400, width)) }),
    infoTarget: null,
    folderPrompt: false,
    newFilePrompt: false,
    treeVersion: 0,
    uploadInput: createRef<HTMLInputElement>(),
    setFolder(value) {
      const folder = typeof value === "function" ? value(get().folder) : value;
      set({
        folder,
        ...(folder?.id !== get().folder?.id
          ? { readers: [], preview: null }
          : {}),
      });
    },
    setPreview(value) {
      const preview =
        typeof value === "function" ? value(get().preview) : value;
      if (!preview) {
        set({ preview: null, readers: [] });
        return;
      }
      const readers = get().readers.filter(
        (file) => readerKey(file) !== readerKey(preview),
      );
      const index = get().readers.findIndex(
        (file) => readerKey(file) === readerKey(preview),
      );
      const { page: _page, region: _region, ...tab } = preview;
      readers.splice(index < 0 ? readers.length : index, 0, tab);
      set({ preview, readers });
    },
    setInfoTarget: field(set, "infoTarget"),
    setFolderPrompt: field(set, "folderPrompt"),
    setNewFilePrompt: field(set, "newFilePrompt"),
    refreshTree: () => set((state) => ({ treeVersion: state.treeVersion + 1 })),
  }));
}
