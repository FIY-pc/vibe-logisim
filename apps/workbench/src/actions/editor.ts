import { command } from "../lib/transport";
import type { CatalogTool, Document, Edit, XmlNode } from "../lib/types";
import type { SourceDraft } from "../stores/editor";
import type { Stores } from "../workbench/createWorkbench";
import { reaction } from "../workbench/reaction";
import { currentView, type View } from "../workbench/view";

/** Editing the shown circuit: edits, history, selection, placement and the XML source. */
export function createEditorActions(stores: Stores) {
  const { documents, editor, notices, shell } = stores;
  const busy = <T>(action: () => Promise<T>) => shell.getState().busy(action);
  const onError = (error: unknown) => notices.getState().onError(error);

  const edit = async ({ doc, circuit, scope }: View, change: Edit) => {
    if (!doc || !circuit) return;
    const { navigation } = editor.getState();
    const originSelection = editor.getState().selected;
    const originNavigation = navigation.current;
    const next = await busy(() =>
      command<Document>({
        op: "edit",
        id: doc.id,
        revision: doc.revision,
        circuit: circuit.name,
        edit: change,
      }),
    );
    documents.getState().mergeDocument(next, doc.revision);
    // A field commit keeps its object selected. Preserve the revision guard for
    // other edits, late responses and selections the user changed meanwhile.
    if (
      change.kind === "attributes" &&
      editor.getState().selected === originSelection &&
      documents.getState().active === doc.id &&
      navigation.current === originNavigation &&
      documents.getState().docs.find((item) => item.id === doc.id)?.revision ===
        next.revision &&
      originSelection.scope === scope &&
      originSelection.ids.includes(change.id) &&
      next.circuits
        .find((item) => item.name === circuit.name)
        ?.components.some((item) => item.id === change.id)
    ) {
      editor.getState().setSelected({
        scope: `${doc.id}:${next.revision}:${circuit.name}`,
        ids: [change.id],
      });
    }
  };

  /** Commits a placement the canvas made at `revision`. */
  const placeComponent = async (
    doc: Document,
    circuit: string,
    revision: string,
    change: Edit,
  ) => {
    const next = await busy(() =>
      command<Document>({
        op: "edit",
        id: doc.id,
        revision,
        circuit,
        edit: change,
      }),
    );
    documents.getState().mergeDocument(next, revision);
    return next;
  };

  const history = ({ doc }: View, op: "undo" | "redo") => {
    if (doc)
      void busy(() =>
        command<Document>({ op, id: doc.id, revision: doc.revision }),
      )
        .then((next) => documents.getState().mergeDocument(next, doc.revision))
        .catch(onError);
  };

  /** Selects objects of the view's circuit. */
  const select = ({ scope }: View, ids: string[]) =>
    editor.getState().setSelected({ scope, ids });

  /** Selects objects and shows their properties. */
  const inspect = (view: View, ids: string[]) => {
    select(view, ids);
    if (ids.length) shell.getState().revealInspector();
  };

  /** Starts placing a catalog tool. */
  const startPlacing = (view: View, tool: CatalogTool) => {
    editor.getState().setPlace(tool);
    select(view, []);
    shell.getState().revealInspector();
    editor.getState().setTool("select");
    if (shell.getState().narrow) shell.getState().closeDrawers();
  };

  /** Opens the XML source dialog. Only the latest read opens, and only in the
   * view it was requested from. */
  const readSource = async ({ doc, circuit, scope }: View) => {
    if (!doc || !circuit) return;
    const { navigation, sourceRequest } = editor.getState();
    const requested = sourceRequest.next();
    const origin = navigation.current;
    const stillCurrent = () =>
      requested === sourceRequest.current &&
      origin === navigation.current &&
      currentView(stores).scope === scope;
    try {
      const result = await command<{ xml: string }>({
        op: "source",
        id: doc.id,
        revision: doc.revision,
      });
      if (stillCurrent())
        editor.getState().setSource({
          xml: result.xml,
          id: doc.id,
          name: doc.name,
          revision: doc.revision,
          circuit: circuit.name,
        });
    } catch (error) {
      if (stillCurrent()) onError(error);
    }
  };

  /** Replaces the document with the source dialog's draft; a failure stays in the dialog. */
  const applySource = (source: SourceDraft) =>
    void busy(() =>
      command<Document>({
        op: "edit",
        id: source.id,
        revision: source.revision,
        circuit: source.circuit,
        edit: { kind: "replace", xml: source.xml },
      }),
    )
      .then((next) => documents.getState().mergeDocument(next, source.revision))
      .then(() => editor.getState().setSource(null))
      .catch((error) =>
        editor.getState().setSource((current) =>
          current?.id === source.id && current.revision === source.revision
            ? {
                ...current,
                error: error instanceof Error ? error.message : String(error),
              }
            : current,
        ),
      );

  /** Loads the component catalog of each shown circuit. Returns the stop. */
  const watchCatalog = () =>
    reaction(
      [documents, editor],
      () => {
        const { doc, circuit } = currentView(stores);
        return [doc?.id, doc?.revision, circuit?.name];
      },
      () => {
        const { doc, circuit } = currentView(stores);
        if (!doc || !circuit) {
          editor.getState().setCatalog([]);
          return;
        }
        let live = true;
        command<XmlNode>({
          op: "catalog",
          id: doc.id,
          revision: doc.revision,
          circuit: circuit.name,
        })
          .then((root) => {
            if (live)
              editor.getState().setCatalog(
                root.children
                  .filter((n) => n.tag === "group")
                  .map((g) => ({
                    id: g.attributes.id,
                    label: g.attributes.label,
                    tools: g.children.map((t) => ({
                      ...t.attributes,
                      library: g.attributes.id,
                    })) as unknown as CatalogTool[],
                  })),
              );
          })
          .catch((e) => {
            if (live) onError(e);
          });
        return () => {
          live = false;
        };
      },
    );

  return {
    edit,
    placeComponent,
    history,
    select,
    inspect,
    startPlacing,
    readSource,
    applySource,
    watchCatalog,
  };
}
export type EditorActions = ReturnType<typeof createEditorActions>;
