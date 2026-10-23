import type { EditResult } from "../generated/EditResult";
import { arrangeCircuit } from "./arrange";
import { command } from "../shared/transport";
import type { CatalogTool, Document, Edit, XmlNode } from "../shared/types";
import type { SourceDraft } from "./store";
import type { Stores } from "../app/createWorkbench";
import { reaction } from "../app/reaction";
import { currentView, type View } from "../app/view";

/** Editing the shown circuit: edits, history, selection, placement and the XML source. */
export function createEditorActions(stores: Stores) {
  const { documents, editor, notices, shell } = stores;
  // Arranging runs off the interface thread; the toolbar stays disabled until
  // the slowest one returns.
  const arrangeCount = { current: 0 };
  const busy = <T>(action: () => Promise<T>) => shell.getState().busy(action);
  const onError = (error: unknown) => notices.getState().onError(error);

  const edit = async ({ doc, circuit, scope }: View, change: Edit) => {
    if (!doc || !circuit) return;
    const { navigation } = editor.getState();
    const originSelection = editor.getState().selected;
    const originNavigation = navigation.current;
    const result = await busy(() =>
      command<EditResult>({
        op: "edit",
        id: doc.id,
        revision: doc.revision,
        circuit: circuit.name,
        edit: change,
      }),
    );
    const next = result.view;
    documents.getState().mergeDocument(next, doc.revision);
    // A field commit keeps its object selected and moved objects stay selected
    // under their new ids, as in Logisim. Late responses and selections the
    // user changed meanwhile are left alone.
    const kept =
      change.kind === "attributes"
        ? originSelection.ids.includes(change.id) &&
          next.circuits
            .find((item) => item.name === circuit.name)
            ?.components.some((item) => item.id === change.id)
          ? [change.id]
          : []
        : change.kind === "move"
          ? [...result.selection.components, ...result.selection.wires]
          : [];
    if (
      kept.length &&
      editor.getState().selected === originSelection &&
      documents.getState().active === doc.id &&
      navigation.current === originNavigation &&
      documents.getState().docs.find((item) => item.id === doc.id)?.revision ===
        result.revision &&
      originSelection.scope === scope
    ) {
      editor.getState().setSelected({
        scope: `${doc.id}:${next.revision}:${circuit.name}`,
        ids: kept,
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
    const result = await busy(() =>
      command<EditResult>({
        op: "edit",
        id: doc.id,
        revision,
        circuit,
        edit: change,
      }),
    );
    documents.getState().mergeDocument(result.view, revision);
    return result.view;
  };

  const history = ({ doc }: View, op: "undo" | "redo") => {
    if (doc)
      void busy(() =>
        command<EditResult>({ op, id: doc.id, revision: doc.revision }),
      )
        .then((result) =>
          documents.getState().mergeDocument(result.view, doc.revision),
        )
        .catch(onError);
  };

  /** Rearranges the shown circuit and applies the result as one undoable edit. */
  const arrange = async ({ doc, circuit }: View) => {
    if (!doc || !circuit) return;
    const revision = doc.revision;
    arrangeCount.current += 1;
    editor.getState().setArranging(true);
    try {
      const source = await busy(() =>
        command<{ xml: string }>({ op: "source", id: doc.id, revision }),
      );
      const focus = await busy(() =>
        command<unknown>({
          op: "observe",
          id: doc.id,
          revision,
          circuit: circuit.name,
        }),
      );
      const arranged = await arrangeCircuit({
        xml: source.xml,
        circuit: circuit.name,
        focus,
      });
      const result = await busy(() =>
        command<EditResult>({
          op: "edit",
          id: doc.id,
          revision,
          circuit: circuit.name,
          edit: { kind: "replace", xml: arranged.xml },
        }),
      );
      documents.getState().mergeDocument(result.view, revision);
      const before = arranged.before;
      const after = arranged.after;
      notices
        .getState()
        .setNotice(
          `已整理：导线 ${before.wireSegments} → ${after.wireSegments} 段，交叉 ${before.crossings} → ${after.crossings}，占用 ${before.extent.width}×${before.extent.height} → ${after.extent.width}×${after.extent.height}。可用 Ctrl+Z 撤销。`,
        );
    } catch (error) {
      onError(error);
    } finally {
      arrangeCount.current -= 1;
      editor.getState().setArranging(arrangeCount.current > 0);
    }
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
      command<EditResult>({
        op: "edit",
        id: source.id,
        revision: source.revision,
        circuit: source.circuit,
        edit: { kind: "replace", xml: source.xml },
      }),
    )
      .then((result) =>
        documents.getState().mergeDocument(result.view, source.revision),
      )
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
        // Icons depend on the project's libraries, not on its edits.
        return [doc?.id, doc?.paletteIdentity, circuit?.name];
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
    arrange,
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
