import { createStore } from "zustand/vanilla";
import type { Decision } from "./DecisionDialog";
import { field, type Update } from "./setter";

/** A revision of an open document. */
export interface DocumentRevision {
  id: string;
  revision: string;
}

export interface NoticesState {
  /** A transient message; the capture notice is hidden while one shows. */
  notice: string;
  /** The error bar's text; empty when no error shows. */
  error: string;
  /** The document revision the error is about, when a read of that revision
   * failed: the error goes once the document leaves that revision. */
  errorRevision: DocumentRevision | null;
  /** A pending confirmation, such as closing a document with unsaved changes. */
  decision: Decision | null;
  setNotice(notice: Update<string>): void;
  setError(error: Update<string>): void;
  setDecision(decision: Update<Decision | null>): void;
  /** Shows a failure in the error bar; `about` ties it to a document revision. */
  onError(error: unknown, about?: DocumentRevision): void;
  /** Hides the error tied to a document revision once that document is
   * closed or at another revision. */
  dropOutdatedError(docs: readonly DocumentRevision[]): void;
  /** Shows a notice once per key, so a warning repeated by later snapshots shows only once. */
  warn(key: string, message: string): void;
}

export function createNoticesStore() {
  const shown = new Set<string>();
  return createStore<NoticesState>()((set, get) => ({
    notice: "",
    error: "",
    errorRevision: null,
    decision: null,
    setNotice: field(set, "notice"),
    setError: (update) =>
      set((state) => {
        const error =
          typeof update === "function" ? update(state.error) : update;
        return error === state.error ? {} : { error, errorRevision: null };
      }),
    setDecision: field(set, "decision"),
    onError: (error, about) =>
      set({
        error: error instanceof Error ? error.message : String(error),
        errorRevision: about
          ? { id: about.id, revision: about.revision }
          : null,
      }),
    dropOutdatedError: (docs) => {
      const about = get().errorRevision;
      if (
        about &&
        !docs.some(
          (doc) => doc.id === about.id && doc.revision === about.revision,
        )
      )
        set({ error: "", errorRevision: null });
    },
    warn: (key, message) => {
      if (shown.has(key)) return;
      shown.add(key);
      set({ notice: message });
    },
  }));
}
