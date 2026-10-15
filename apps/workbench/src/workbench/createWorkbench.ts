import type { StoreApi } from "zustand/vanilla";
import {
  createConversationStore,
  type ConversationState,
} from "../stores/conversation";
import {
  createDocumentsStore,
  type DocumentsState,
} from "../stores/documents";
import { createEditorStore, type EditorState } from "../stores/editor";
import { createFilesStore, type FilesState } from "../stores/files";
import { createNoticesStore, type NoticesState } from "../stores/notices";
import { createSettingsStore, type SettingsState } from "../stores/settings";
import { createShellStore, type ShellState } from "../stores/shell";
import {
  createSimulationStore,
  type SimulationState,
} from "../stores/simulation";
import { startWorkbench } from "./start";

export interface Stores {
  notices: StoreApi<NoticesState>;
  settings: StoreApi<SettingsState>;
  shell: StoreApi<ShellState>;
  conversation: StoreApi<ConversationState>;
  documents: StoreApi<DocumentsState>;
  files: StoreApi<FilesState>;
  editor: StoreApi<EditorState>;
  simulation: StoreApi<SimulationState>;
}

/** All state and actions of one workbench window. App creates one per mount. */
export interface Workbench {
  stores: Stores;
  /** Starts the host subscriptions and window listeners; returns the stop. */
  start(): () => void;
}

export function createWorkbench(): Workbench {
  const notices = createNoticesStore();
  const files = createFilesStore();
  const editor = createEditorStore();
  const stores: Stores = {
    notices,
    settings: createSettingsStore(),
    shell: createShellStore(),
    conversation: createConversationStore(),
    documents: createDocumentsStore({ notices, editor, files }),
    files,
    editor,
    simulation: createSimulationStore(),
  };
  const workbench: Workbench = {
    stores,
    start: () => startWorkbench(workbench),
  };
  return workbench;
}
