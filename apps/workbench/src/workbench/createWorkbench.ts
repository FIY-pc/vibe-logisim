import type { StoreApi } from "zustand/vanilla";
import { createEditorActions, type EditorActions } from "../actions/editor";
import { createNavigation, type Navigation } from "../actions/navigation";
import {
  createSimulationActions,
  type SimulationActions,
} from "../actions/simulation";
import {
  createWorkspaceActions,
  type WorkspaceActions,
} from "../actions/workspace";
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

export interface Actions {
  workspace: WorkspaceActions;
  editor: EditorActions;
  simulation: SimulationActions;
  navigation: Navigation;
}

/** All state and actions of one workbench window. App creates one per mount. */
export interface Workbench {
  stores: Stores;
  actions: Actions;
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
  const editing = createEditorActions(stores);
  const actions: Actions = {
    workspace: createWorkspaceActions(stores),
    editor: editing,
    simulation: createSimulationActions(stores),
    navigation: createNavigation(stores, editing),
  };
  const workbench: Workbench = {
    stores,
    actions,
    start: () => startWorkbench(workbench),
  };
  return workbench;
}
