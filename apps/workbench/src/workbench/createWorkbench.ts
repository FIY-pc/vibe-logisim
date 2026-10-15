import type { StoreApi } from "zustand/vanilla";
import {
  createConversationStore,
  type ConversationState,
} from "../stores/conversation";
import { createNoticesStore, type NoticesState } from "../stores/notices";
import { createSettingsStore, type SettingsState } from "../stores/settings";
import { createShellStore, type ShellState } from "../stores/shell";
import { startWorkbench } from "./start";

export interface Stores {
  notices: StoreApi<NoticesState>;
  settings: StoreApi<SettingsState>;
  shell: StoreApi<ShellState>;
  conversation: StoreApi<ConversationState>;
}

/** All state and actions of one workbench window. App creates one per mount. */
export interface Workbench {
  stores: Stores;
  /** Starts the host subscriptions and window listeners; returns the stop. */
  start(): () => void;
}

export function createWorkbench(): Workbench {
  const stores: Stores = {
    notices: createNoticesStore(),
    settings: createSettingsStore(),
    shell: createShellStore(),
    conversation: createConversationStore(),
  };
  const workbench: Workbench = {
    stores,
    start: () => startWorkbench(workbench),
  };
  return workbench;
}
