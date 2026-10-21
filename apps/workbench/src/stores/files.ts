import { createRef, type RefObject } from "react";
import { createStore } from "zustand/vanilla";
import type { PreviewFile } from "../components/FilePreview";
import type { ProjectFolder } from "../components/Files";
import { field, type Update } from "./setter";

export interface FilesState {
  /** The open project folder. */
  folder: ProjectFolder | null;
  /** The file shown in the preview dialog. */
  preview: PreviewFile | null;
  /** The document whose information and export dialog is open. */
  infoTarget: string | null;
  /** Whether the prompt for a folder path is open (outside the desktop app). */
  folderPrompt: boolean;
  /** The hidden file input that imports a circuit outside the desktop app. */
  uploadInput: RefObject<HTMLInputElement | null>;
  setFolder(folder: Update<ProjectFolder | null>): void;
  setPreview(preview: Update<PreviewFile | null>): void;
  setInfoTarget(id: Update<string | null>): void;
  setFolderPrompt(open: Update<boolean>): void;
}

export function createFilesStore() {
  return createStore<FilesState>()((set) => ({
    folder: null,
    preview: null,
    infoTarget: null,
    folderPrompt: false,
    uploadInput: createRef<HTMLInputElement>(),
    setFolder: field(set, "folder"),
    setPreview: field(set, "preview"),
    setInfoTarget: field(set, "infoTarget"),
    setFolderPrompt: field(set, "folderPrompt"),
  }));
}
