import { useLayoutEffect, useReducer, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { ConversationState } from "../conversation/store";
import type { DocumentsState } from "../workspace/documents";
import type { EditorState } from "../editor/store";
import type { FilesState } from "../workspace/filesStore";
import type { NoticesState } from "../shared/notices";
import type { SettingsState } from "../shared/settings";
import type { ShellState } from "../shell/store";
import type { SimulationState } from "../simulation/store";
import { useWorkbench } from "./provider";
import { viewOf, type View } from "./view";

/** The part of a store's state that `selector` picks, rendering again when it
 * changes. Unlike zustand's `useStore`, which re-renders through
 * useSyncExternalStore at once, the re-render is an ordinary state update and
 * takes the priority of whatever changed the store: the changes an async
 * action makes one after another (merging the edited document, then switching
 * to the new circuit) render together instead of one at a time. */
function useSelected<S, T>(store: StoreApi<S>, selector: (state: S) => T): T {
  const value = selector(store.getState());
  const [, render] = useReducer((count: number) => count + 1, 0);
  const rendered = useRef({ selector, value });
  useLayoutEffect(() => {
    rendered.current = { selector, value };
    if (!Object.is(selector(store.getState()), value)) render();
  });
  useLayoutEffect(() => {
    const check = () => {
      const { selector, value } = rendered.current;
      let next: T;
      try {
        next = selector(store.getState());
      } catch {
        // A selector can fail on state its component is about to leave; as
        // with useSyncExternalStore, render rather than throw into the code
        // that changed the store, so the parent can unmount it first.
        render();
        return;
      }
      if (!Object.is(next, value)) render();
    };
    check();
    return store.subscribe(check);
  }, [store]);
  return value;
}

export const useNotices = <T>(selector: (state: NoticesState) => T): T =>
  useSelected(useWorkbench().stores.notices, selector);
export const useSettings = <T>(selector: (state: SettingsState) => T): T =>
  useSelected(useWorkbench().stores.settings, selector);
export const useShell = <T>(selector: (state: ShellState) => T): T =>
  useSelected(useWorkbench().stores.shell, selector);
export const useConversation = <T>(
  selector: (state: ConversationState) => T,
): T => useSelected(useWorkbench().stores.conversation, selector);
export const useDocuments = <T>(selector: (state: DocumentsState) => T): T =>
  useSelected(useWorkbench().stores.documents, selector);
export const useFiles = <T>(selector: (state: FilesState) => T): T =>
  useSelected(useWorkbench().stores.files, selector);
export const useEditor = <T>(selector: (state: EditorState) => T): T =>
  useSelected(useWorkbench().stores.editor, selector);
export const useSimulation = <T>(selector: (state: SimulationState) => T): T =>
  useSelected(useWorkbench().stores.simulation, selector);

/** The run and its newest frame as this render sees them: what `live` and
 * `simulationStatus` read. */
export function useSimulationState(): Pick<
  SimulationState,
  "run" | "frame" | "ended"
> {
  const run = useSimulation((state) => state.run);
  const frame = useSimulation((state) => state.frame);
  const ended = useSimulation((state) => state.ended);
  return { run, frame, ended };
}

/** The view as of this render. */
export function useView(): View {
  const docs = useDocuments((state) => state.docs);
  const active = useDocuments((state) => state.active);
  const circuitName = useEditor((state) => state.circuitName);
  const instance = useEditor((state) => state.instance);
  return viewOf(docs, active, circuitName, instance);
}

/** The ids selected in the view of this render. */
export function useSelection(): string[] {
  const { scope } = useView();
  const selected = useEditor((state) => state.selected);
  return selected.scope === scope ? selected.ids : [];
}
