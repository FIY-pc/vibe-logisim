import { useStore } from "zustand";
import type { ConversationState } from "../stores/conversation";
import type { NoticesState } from "../stores/notices";
import type { SettingsState } from "../stores/settings";
import type { ShellState } from "../stores/shell";
import { useWorkbench } from "./provider";

export const useNotices = <T>(selector: (state: NoticesState) => T): T =>
  useStore(useWorkbench().stores.notices, selector);
export const useSettings = <T>(selector: (state: SettingsState) => T): T =>
  useStore(useWorkbench().stores.settings, selector);
export const useShell = <T>(selector: (state: ShellState) => T): T =>
  useStore(useWorkbench().stores.shell, selector);
export const useConversation = <T>(
  selector: (state: ConversationState) => T,
): T => useStore(useWorkbench().stores.conversation, selector);
