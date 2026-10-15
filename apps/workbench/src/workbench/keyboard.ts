import { eventBinding } from "../lib/shortcuts";
import type { Tool } from "../lib/types";
import { canRotate } from "../lib/usePlacement";
import type { Actions, Stores } from "./createWorkbench";
import { currentView } from "./view";

/** Handles the workbench's keyboard shortcuts on the window, with the state
 * as of each key press. Returns the stop. */
export function handleShortcuts(stores: Stores, actions: Actions): () => void {
  const { editor, notices, settings, shell } = stores;
  const { workspace, editor: editing, simulation: simulating } = actions;
  const onError = (error: unknown) => notices.getState().onError(error);
  const listener = (e: KeyboardEvent) => {
    if (document.querySelector('dialog[open],[aria-modal="true"]')) return;
    if (
      (e.target as HTMLElement).closest(
        'input,textarea,select,[contenteditable="true"]',
      )
    )
      return;
    const key = eventBinding(e);
    if (!key) return;
    const view = currentView(stores);
    const { doc } = view;
    const shortcut = Object.entries(settings.getState().bindings).find(
      ([, binding]) => binding === key,
    )?.[0];
    if (shortcut) {
      e.preventDefault();
      if (["select", "wire", "poke", "pan"].includes(shortcut)) {
        editor.getState().setTool(shortcut as Tool);
        editor.getState().setPlace(null);
      } else if (shortcut === "palette") {
        shell.getState().revealFiles();
        shell.getState().setResourceTab("components");
        requestAnimationFrame(() =>
          editor.getState().searchInput.current?.focus(),
        );
      } else if (shortcut === "rotate") {
        const { place, placement } = editor.getState();
        if (place && placement.current && canRotate(placement.current))
          placement.current.rotate();
      } else if (shortcut === "save") workspace.save(view);
      else if (shortcut === "undo") editing.history(view, "undo");
      else if (shortcut === "find" && doc)
        editor.getState().setFind("component");
      else if (shortcut === "circuitSearch" && doc) {
        shell.getState().revealNavigator();
        requestAnimationFrame(() =>
          editor.getState().circuitSearchInput.current?.focus(),
        );
      } else if (shortcut === "fit") editor.getState().requestFit();
      else if (shortcut === "grid")
        editor.getState().setShowGrid((shown) => !shown);
      else if (shortcut === "rail")
        shell.getState().setSide("rail", (shown) => !shown);
      else if (shortcut === "review")
        shell.getState().setSide("review", (shown) => !shown);
      else if (shortcut === "capture")
        void simulating.capture(view).catch(onError);
      else if (shortcut === "clock")
        void simulating.simulate(view, "toggle-clock").catch(onError);
      else if (shortcut === "propagation")
        void simulating.simulate(view, "toggle-propagation").catch(onError);
      else if (["tick", "step", "reset"].includes(shortcut))
        void simulating.simulate(view, shortcut).catch(onError);
      return;
    }
    if (key === "Mod+N") {
      e.preventDefault();
      void workspace.newFile();
    }
    if (key === "Mod+Shift+S") {
      e.preventDefault();
      workspace.save(view, true);
    }
    if (key === "Mod+W" && doc) {
      e.preventDefault();
      workspace.requestClose(doc);
    }
    if (["Mod+Shift+Z", "Mod+Y"].includes(key)) {
      e.preventDefault();
      editing.history(view, "redo");
    }
    if (key === "Mod+,") {
      e.preventDefault();
      settings.getState().setOpen(true);
    }
    if (key === "Mod+Shift+O") {
      shell.getState().setSide("review", true);
      shell.getState().setRight("chat");
    }
    if (key === "Mod+O") {
      e.preventDefault();
      workspace.openFile();
    }
    if (e.key === "Escape") {
      editor.getState().sourceRequest.next();
      editor.getState().setPlace(null);
      editor.getState().setSource(null);
      settings.getState().setOpen(false);
    }
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}
