import { createRef, type RefObject } from "react";
import { createStore } from "zustand/vanilla";
import type { PreviewFile } from "./FilePreview";
import type { ProjectFolder } from "./Files";
import type { RecentProject } from "../generated/RecentProject";
import { field, type Update } from "../shared/setter";
import { readerKey } from "./reader/types";

export interface CopiedFile {
  folderId: string;
  path: string;
  text: string;
}
export interface FilesState {
  copiedFile: CopiedFile | null;
  setCopiedFile(value: CopiedFile | null): void;
  /** The open project folder. */
  folder: ProjectFolder | null;
  recentProjects: RecentProject[];
  recentError: string;
  recentLoading: boolean;
  /** The selected material; it stays mounted when the circuit tab is shown. */
  preview: PreviewFile | null;
  readers: PreviewFile[];
  editorFocus: "circuit" | "material";
  readerMode: "single" | "split";
  readerShare: number;
  closeReader(key: string): void;
  showCircuit(): void;
  setEditorFocus(focus: "circuit" | "material"): void;
  setReaderMode(mode: "single" | "split"): void;
  setReaderShare(share: number): void;
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
    copiedFile: null,
    setCopiedFile: (copiedFile) => set({ copiedFile }),
    recentProjects: [],
    recentError: "",
    recentLoading: true,
    preview: null,
    readers: [],
    editorFocus: "circuit",
    readerMode: "single",
    readerShare: 50,
    showCircuit: () => set({ editorFocus: "circuit" }),
    setEditorFocus: (editorFocus) => set({ editorFocus }),
    closeReader(key) {
      const state = get(),
        readers = state.readers.filter((file) => readerKey(file) !== key);
      set({
        readers,
        preview:
          state.preview && readerKey(state.preview) === key
            ? readers.at(-1) || null
            : state.preview,
        ...(!readers.length
          ? { editorFocus: "circuit", readerMode: "single" }
          : {}),
      });
    },
    setReaderMode: (readerMode) => set({ readerMode }),
    setReaderShare: (share) =>
      set({ readerShare: Math.max(25, Math.min(75, share)) }),
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
          ? {
              copiedFile: null,
              readers: [],
              preview: null,
              editorFocus: "circuit",
              readerMode: "single",
            }
          : {}),
      });
    },
    setPreview(value) {
      const preview =
        typeof value === "function" ? value(get().preview) : value;
      if (!preview) {
        set({
          preview: null,
          readers: [],
          editorFocus: "circuit",
          readerMode: "single",
        });
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
      set({ preview, readers, editorFocus: "material" });
    },
    setInfoTarget: field(set, "infoTarget"),
    setFolderPrompt: field(set, "folderPrompt"),
    setNewFilePrompt: field(set, "newFilePrompt"),
    refreshTree: () => set((state) => ({ treeVersion: state.treeVersion + 1 })),
  }));
}
