import type { StoreApi } from "zustand/vanilla";
import { createEditorActions, type EditorActions } from "../editor/actions";
import { createNavigation, type Navigation } from "../editor/navigation";
import {
  createSimulationActions,
  type SimulationActions,
} from "../simulation/actions";
import {
  createWorkspaceActions,
  type WorkspaceActions,
} from "../workspace/actions";
import {
  createConversationStore,
  type ConversationState,
} from "../conversation/store";
import {
  createDocumentsStore,
  type DocumentsState,
} from "../workspace/documents";
import { createEditorStore, type EditorState } from "../editor/store";
import { createFilesStore, type FilesState } from "../workspace/filesStore";
import { createNoticesStore, type NoticesState } from "../shared/notices";
import { createSettingsStore, type SettingsState } from "../shared/settings";
import { createShellStore, type ShellState } from "../shell/store";
import {
  createSimulationStore,
  type SimulationState,
} from "../simulation/store";
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
  const simulation = createSimulationActions(stores);
  const actions: Actions = {
    workspace: createWorkspaceActions(stores),
    editor: editing,
    simulation,
    navigation: createNavigation(stores, editing, { simulation }),
  };
  const workbench: Workbench = {
    stores,
    actions,
    start: () => startWorkbench(workbench),
  };
  return workbench;
}
