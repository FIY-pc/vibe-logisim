import { createStore } from "zustand/vanilla";
import type { Decision } from "../components/DecisionDialog";
import { field, type Update } from "./setter";

export interface NoticesState {
  /** A transient message; the capture notice is hidden while one shows. */
  notice: string;
  /** The error bar's text; empty when no error shows. */
  error: string;
  /** A pending confirmation, such as closing a document with unsaved changes. */
  decision: Decision | null;
  setNotice(notice: Update<string>): void;
  setError(error: Update<string>): void;
  setDecision(decision: Update<Decision | null>): void;
  /** Shows a failure in the error bar. */
  onError(error: unknown): void;
  /** Shows a notice once per key, so a warning repeated by later snapshots shows only once. */
  warn(key: string, message: string): void;
}

export function createNoticesStore() {
  const shown = new Set<string>();
  return createStore<NoticesState>()((set) => ({
    notice: "",
    error: "",
    decision: null,
    setNotice: field(set, "notice"),
    setError: field(set, "error"),
    setDecision: field(set, "decision"),
    onError: (error) =>
      set({ error: error instanceof Error ? error.message : String(error) }),
    warn: (key, message) => {
      if (shown.has(key)) return;
      shown.add(key);
      set({ notice: message });
    },
  }));
}
