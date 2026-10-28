import { createStore, type StoreApi } from "zustand/vanilla";
import type { ProjectFolder } from "./Files";
import type { SourceStatus } from "../generated/SourceStatus";
import type { DocumentChange } from "../generated/DocumentChange";
import { applyDocumentChange } from "../../../../packages/agent-runtime/src/protocol/document-change.ts";
import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import type { EditorState } from "../editor/store";
import { recordWidthErrors } from "../editor/symbols";
import type { FilesState } from "./filesStore";
import type { NoticesState } from "../shared/notices";
import type { Update } from "../shared/setter";

/** Notes the host attaches to a document returned by a mutation. */
type DocumentResult = Document & {
  historyWarning?: string;
  referenceWarning?: string;
  saveError?: string;
};

export interface DocumentsState {
  /** The open documents. Written synchronously, so continuations read the latest list. */
  docs: Document[];
  /** The active document's id. */
  active: string | null;
  /** The last failed automatic save per document, kept while it stays dirty. */
  saveFailures: Record<string, string>;
  /** The last check of the active document's source file, for one revision. */
  sourceStatus: { id: string; revision: string; status: SourceStatus } | null;
  /** Changes whenever the active document's source file should be checked now. */
  sourceCheck: number;
  /** Replaces the documents; shows their history and reference warnings once each. */
  setDocs(docs: Update<Document[]>): void;
  setActive(id: string | null): void;
  /** Makes workspace snapshots requested before now stale. */
  invalidate(): void;
  /** Reads the host's workspace. A snapshot taken before a newer local change is
   * read again, so it never replaces newer documents. */
  refreshWorkspace(includeFolder?: boolean): Promise<void>;
  /** Takes a document returned by a mutation. When a later change already
   * replaced the base revision, the workspace is read again instead. */
  mergeDocument(document: Document, expectedBaseRevision?: string): void;
  /** Takes what an edit, undo or redo changed, with the width conflicts of
   * the circuits it changed. When the document is no longer at the change's
   * base revision, the workspace is read again instead. */
  applyChange(change: DocumentChange): void;
  /** Adds or replaces a document and activates it. */
  update(document: Document): void;
  setSourceStatus(record: DocumentsState["sourceStatus"]): void;
  /** Checks the active document's source file again now. */
  recheck(): void;
}

/** The source file status of `doc`, if the last check was for its revision. */
export const sourceStatusOf = (
  { sourceStatus }: DocumentsState,
  doc: Document | null,
) =>
  sourceStatus?.id === doc?.id && sourceStatus?.revision === doc?.revision
    ? sourceStatus?.status
    : undefined;

export function createDocumentsStore({
  notices,
  editor,
  files,
}: {
  notices: StoreApi<NoticesState>;
  editor: StoreApi<EditorState>;
  files: StoreApi<FilesState>;
}) {
  // Bumped by every local change to the workspace view.
  let epoch = 0;
  return createStore<DocumentsState>()((set, get) => ({
    docs: [],
    active: null,
    saveFailures: {},
    sourceStatus: null,
    sourceCheck: 0,
    setDocs: (value) => {
      epoch++;
      const next = typeof value === "function" ? value(get().docs) : value;
      set((state) => ({
        docs: next,
        saveFailures: Object.fromEntries(
          next.flatMap((doc) => {
            const failure = (doc as DocumentResult).saveError;
            return failure
              ? [[doc.id, failure]]
              : doc.dirty && state.saveFailures[doc.id]
                ? [[doc.id, state.saveFailures[doc.id]]]
                : [];
          }),
        ),
      }));
      for (const doc of next) {
        const result = doc as DocumentResult;
        const message = [result.historyWarning, result.referenceWarning]
          .filter(Boolean)
          .join("；");
        if (message)
          notices
            .getState()
            .warn(
              `${doc.id}:${doc.revision}:${message}`,
              `${doc.name}：${message}`,
            );
      }
    },
    setActive: (id) => {
      epoch++;
      set({ active: id });
    },
    invalidate: () => {
      epoch++;
    },
    refreshWorkspace: async (includeFolder = false) => {
      for (;;) {
        const requested = epoch;
        const status = await command<{
          documents: Document[];
          active: string | null;
          folder: ProjectFolder | null;
          recoveryError: string | null;
        }>({ op: "status" });
        // Status can wait on the native runtime after taking its document snapshot.
        // Never let that earlier snapshot replace a newer event or local action.
        if (requested !== epoch) continue;
        const { active } = get();
        const nextActive = status.documents.some((d) => d.id === active)
          ? active
          : status.active;
        get().setDocs(status.documents);
        if (get().active !== nextActive) {
          get().setActive(nextActive);
          editor
            .getState()
            .setCircuitName(
              status.documents.find((d) => d.id === nextActive)?.main || "main",
            );
          editor.getState().setPlace(null);
        }
        if (includeFolder) files.getState().setFolder(status.folder);
        if (status.recoveryError)
          notices.getState().onError(status.recoveryError);
        return;
      }
    },
    mergeDocument: (document, expectedBaseRevision) => {
      const current = get().docs.find((item) => item.id === document.id);
      if (!current) return;
      if (
        expectedBaseRevision &&
        current.revision !== expectedBaseRevision &&
        current.revision !== document.revision
      ) {
        // A later host event may arrive before this mutation response. Hashes have no ordering.
        void get().refreshWorkspace().catch(notices.getState().onError);
        return;
      }
      get().setDocs((previous) =>
        previous.map((item) => (item.id === document.id ? document : item)),
      );
    },
    applyChange: (change) => {
      const current = get().docs.find((item) => item.id === change.id);
      if (!current) return;
      const next = applyDocumentChange(current, change);
      if (!next) {
        // A later host event may arrive before this mutation response. Hashes have no ordering.
        void get().refreshWorkspace().catch(notices.getState().onError);
        return;
      }
      // The new view holds the change's circuit objects.
      recordWidthErrors(change.circuits, change.widthErrors);
      get().setDocs((previous) =>
        previous.map((item) => (item.id === change.id ? next : item)),
      );
    },
    update: (document) => {
      get().setDocs((old) =>
        old.some((x) => x.id === document.id)
          ? old.map((x) => (x.id === document.id ? document : x))
          : [...old, document],
      );
      get().setActive(document.id);
    },
    setSourceStatus: (sourceStatus) => set({ sourceStatus }),
    recheck: () => set((state) => ({ sourceCheck: state.sourceCheck + 1 })),
  }));
}
