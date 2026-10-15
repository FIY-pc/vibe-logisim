import { useStore } from "zustand";
import type { ConversationState } from "../stores/conversation";
import type { DocumentsState } from "../stores/documents";
import type { EditorState } from "../stores/editor";
import type { FilesState } from "../stores/files";
import type { NoticesState } from "../stores/notices";
import type { SettingsState } from "../stores/settings";
import type { ShellState } from "../stores/shell";
import type { SimulationState } from "../stores/simulation";
import { useWorkbench } from "./provider";
import { viewOf, type View } from "./view";

export const useNotices = <T>(selector: (state: NoticesState) => T): T =>
  useStore(useWorkbench().stores.notices, selector);
export const useSettings = <T>(selector: (state: SettingsState) => T): T =>
  useStore(useWorkbench().stores.settings, selector);
export const useShell = <T>(selector: (state: ShellState) => T): T =>
  useStore(useWorkbench().stores.shell, selector);
export const useConversation = <T>(
  selector: (state: ConversationState) => T,
): T => useStore(useWorkbench().stores.conversation, selector);
export const useDocuments = <T>(selector: (state: DocumentsState) => T): T =>
  useStore(useWorkbench().stores.documents, selector);
export const useFiles = <T>(selector: (state: FilesState) => T): T =>
  useStore(useWorkbench().stores.files, selector);
export const useEditor = <T>(selector: (state: EditorState) => T): T =>
  useStore(useWorkbench().stores.editor, selector);
export const useSimulation = <T>(selector: (state: SimulationState) => T): T =>
  useStore(useWorkbench().stores.simulation, selector);

/** The view as of this render. */
export function useView(): View {
  const docs = useDocuments((state) => state.docs);
  const active = useDocuments((state) => state.active);
  const circuitName = useEditor((state) => state.circuitName);
  return viewOf(docs, active, circuitName);
}
