import { createStore } from "zustand/vanilla";
import {
  bindingLabel,
  defaultBindings,
  loadBindings,
  type Bindings,
} from "./shortcuts";
import { field, type Update } from "./setter";

export interface SettingsState {
  /** Keyboard shortcut bindings, persisted in localStorage `vibe.shortcuts`. */
  bindings: Bindings;
  /** Display labels for `bindings`, by shortcut id. */
  labels: Record<string, string>;
  /** Whether the shortcut settings dialog is open. */
  open: boolean;
  setOpen(open: Update<boolean>): void;
  saveBindings(bindings: Bindings): void;
}

const labelsFor = (bindings: Bindings): Record<string, string> =>
  Object.fromEntries(
    Object.entries(bindings).map(([id, binding]) => [
      id,
      bindingLabel(binding),
    ]),
  );

function savedBindings(): Bindings {
  try {
    return loadBindings(
      JSON.parse(localStorage.getItem("vibe.shortcuts") || "null"),
    );
  } catch {
    return { ...defaultBindings };
  }
}

export function createSettingsStore() {
  const bindings = savedBindings();
  return createStore<SettingsState>()((set) => ({
    bindings,
    labels: labelsFor(bindings),
    open: false,
    setOpen: field(set, "open"),
    saveBindings: (next) => {
      localStorage.setItem("vibe.shortcuts", JSON.stringify(next));
      set({ bindings: next, labels: labelsFor(next) });
    },
  }));
}
