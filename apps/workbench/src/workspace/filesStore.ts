import { createRef, type RefObject } from "react";
import { createStore } from "zustand/vanilla";
import type { PreviewFile } from "./FilePreview";
import type { ProjectFolder } from "./Files";
import { field, type Update } from "../shared/setter";

export interface FilesState {
  /** The open project folder. */
  folder: ProjectFolder | null;
  /** The file shown in the preview dialog. */
  preview: PreviewFile | null;
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
  return createStore<FilesState>()((set) => ({
    folder: null,
    preview: null,
    infoTarget: null,
    folderPrompt: false,
    newFilePrompt: false,
    treeVersion: 0,
    uploadInput: createRef<HTMLInputElement>(),
    setFolder: field(set, "folder"),
    setPreview: field(set, "preview"),
    setInfoTarget: field(set, "infoTarget"),
    setFolderPrompt: field(set, "folderPrompt"),
    setNewFilePrompt: field(set, "newFilePrompt"),
    refreshTree: () => set((state) => ({ treeVersion: state.treeVersion + 1 })),
  }));
}
