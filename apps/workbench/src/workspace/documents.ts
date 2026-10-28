import { createStore, type StoreApi } from "zustand/vanilla";
import type { ProjectFolder } from "./Files";
import type { SourceStatus } from "../generated/SourceStatus";
import type { DocumentChange } from "../generated/DocumentChange";
import type { DocumentSummary } from "../generated/DocumentSummary";
import { applyDocumentChange } from "../shared/document-change";
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
  /** What the host last said about each document's file, by document id. */
  sourceStatuses: Record<string, SourceStatus>;
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
  /** Takes a document change (the window's own edit, undo or redo, or one
   * the host broadcast), with the width conflicts of the circuits it changed.
   * When the document is not at the change's base revision, that one document
   * is read again instead and replaced where it is. */
  applyChange(change: DocumentChange): void;
  /** Reads one document again and replaces it where it is, for a view the
   * host said is behind; an older read's answer is dropped. */
  reread(id: string): void;
  /** Adds or replaces a document and activates it. */
  update(document: Document): void;
  /** Takes the documents the host opened or closed outside a command of this
   * window: adds, removes and reads the open one, without reading the rest. */
  setWorkspace(change: { documents: DocumentSummary[]; active: string | null }): Promise<void>;
  setSourceStatus(id: string, status: SourceStatus): void;
  /** Asks the host about the active document's file now. */
  recheck(): Promise<void>;
}

/** The host's last word on `doc`'s file. */
export const sourceStatusOf = (
  { sourceStatuses }: DocumentsState,
  doc: Document | null,
) => (doc ? sourceStatuses[doc.id] : undefined);

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
  // The newest read of each document; an older read's answer is dropped.
  const reads = new Map<string, number>();
  let readCount = 0;
  return createStore<DocumentsState>()((set, get) => ({
    docs: [],
    active: null,
    saveFailures: {},
    sourceStatuses: {},
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
        // This view missed a change of the document: read that one again.
        get().reread(change.id);
        return;
      }
      // The new view holds the change's circuit objects.
      recordWidthErrors(change.circuits, change.widthErrors);
      get().setDocs((previous) =>
        previous.map((item) => (item.id === change.id ? next : item)),
      );
    },
    reread: (id) => {
      const read = ++readCount;
      reads.set(id, read);
      void command<Document>({ op: "read", id })
        .then((view) => {
          if (reads.get(view.id) !== read) return;
          reads.delete(view.id);
          get().setDocs((previous) =>
            previous.map((item) => (item.id === view.id ? view : item)),
          );
        })
        .catch(notices.getState().onError);
    },
    update: (document) => {
      get().setDocs((old) =>
        old.some((x) => x.id === document.id)
          ? old.map((x) => (x.id === document.id ? document : x))
          : [...old, document],
      );
      get().setActive(document.id);
    },
    setWorkspace: async ({ documents: summaries, active }) => {
      const { docs } = get();
      const kept = docs.filter((doc) =>
        summaries.some((summary) => summary.id === doc.id),
      );
      const added = summaries.filter(
        (summary) => !docs.some((doc) => doc.id === summary.id),
      );
      const addedViews = await Promise.all(
        added.map((summary) => command<Document>({ op: "read", id: summary.id })),
      );
      // Documents the window already shows keep their content; a change that
      // moved one arrives as a `change` event, from the same host.
      const next = [...kept, ...addedViews];
      get().setDocs(next);
      const shown = next.some((doc) => doc.id === active)
        ? active
        : next[0]?.id ?? null;
      if (shown !== get().active) {
        get().setActive(shown);
        editor
          .getState()
          .setCircuitName(next.find((doc) => doc.id === shown)?.main || "main");
        editor.getState().setPlace(null);
      }
      set((state) => ({
        sourceStatuses: Object.fromEntries(
          Object.entries(state.sourceStatuses).filter(([id]) =>
            next.some((doc) => doc.id === id),
          ),
        ),
      }));
    },
    setSourceStatus: (id, status) =>
      set((state) => ({
        sourceStatuses: { ...state.sourceStatuses, [id]: status },
      })),
    recheck: async () => {
      const doc = get().docs.find((item) => item.id === get().active);
      if (!doc) return;
      try {
        get().setSourceStatus(
          doc.id,
          await command<SourceStatus>({ op: "sourceStatus", id: doc.id }),
        );
      } catch (error) {
        get().setSourceStatus(doc.id, {
          state: "unreadable",
          message: String(error),
        });
      }
    },
  }));
}
