import { live } from "../simulation/store";
import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import type { Stores } from "../app/createWorkbench";
import type { View } from "../app/view";
import type { EditorActions } from "./actions";

/**
 * Moving between documents, circuits, simulation instances and objects,
 * including the circuit changes that move the view. Every navigation bumps
 * the editor's navigation counter, so results requested before it are dropped.
 * The run follows the instance shown (`simulation/actions.ts`, `follow`).
 */
export function createNavigation(stores: Stores, editing: EditorActions) {
  const { documents, editor, notices, shell, simulation } = stores;
  const onError = (error: unknown) => notices.getState().onError(error);

  /** Shows a circuit of the view's document, outside any instance. Showing
   * the root circuit of a run that is inside an instance takes the run back
   * to its root. */
  const switchCircuit = (view: View, name: string) => {
    editor.getState().navigation.next();
    editor.getState().setCircuitName(name);
    editing.select(view, []);
    editor.getState().setPlace(null);
  };

  /** Shows the instance at `path` of the run, whose circuit is `name`. */
  const showInstance = (view: View, name: string, path: string[]) => {
    editor.getState().navigation.next();
    editor.getState().showInstance(name, path);
    editing.select(view, []);
    editor.getState().setPlace(null);
  };

  /** Opens a subcircuit: inside the running simulation, its instance;
   * otherwise its definition. */
  const enterCircuit = (view: View, name: string, id: string) => {
    if (live(simulation.getState(), view))
      showInstance(view, name, [...view.instance, id]);
    else switchCircuit(view, name);
  };

  /** Shows the instance that contains the shown one. */
  const leaveInstance = (view: View) => {
    const { run } = simulation.getState();
    if (!run || !view.doc || !view.instance.length) return;
    const path = view.instance.slice(0, -1);
    let name = run.rootCircuit;
    for (const id of path) {
      const component = view.doc.circuits
        .find((circuit) => circuit.name === name)
        ?.components.find((item) => item.id === id);
      if (!component) return;
      name = component.name;
    }
    showInstance(view, name, path);
  };

  /** Shows an object of the view's document: selected, revealed on the
   * canvas and in the inspector. */
  const focusObject = (view: View, name: string, id: string) => {
    const { doc } = view;
    if (!doc) return;
    switchCircuit(view, name);
    editor
      .getState()
      .setSelected({ scope: `${doc.id}:${doc.revision}:${name}`, ids: [id] });
    editor.getState().setFocusTarget({
      documentId: doc.id,
      revision: doc.revision,
      circuit: name,
      id,
      token: Date.now(),
    });
    shell.getState().revealInspector();
  };

  /** Shows an open document at its main circuit. */
  const activateDocument = (view: View, d: Document) => {
    editor.getState().navigation.next();
    documents.getState().setActive(d.id);
    editor.getState().setPlace(null);
    void command({ op: "activate", id: d.id }).catch(onError);
    editor.getState().setCircuitName(d.main);
    editing.select(view, []);
    shell.getState().closeDrawers();
  };

  /** Shows what the run shows, in its document. */
  const returnToSimulation = (view: View) => {
    const { run, frame } = simulation.getState();
    const runDoc =
      run &&
      documents
        .getState()
        .docs.find(
          (item) =>
            item.id === run.documentId && item.revision === run.revision,
        );
    if (!run || !runDoc) return;
    editor.getState().navigation.next();
    documents.getState().setActive(runDoc.id);
    editor
      .getState()
      .showInstance(
        frame?.circuit ?? run.rootCircuit,
        frame?.instancePath ?? [],
      );
    editing.select(view, []);
    void command({ op: "activate", id: runDoc.id }).catch(onError);
  };

  /** Adds a circuit to the view's document and shows it. */
  const addCircuit = async (view: View, name: string) => {
    await editing.edit(view, { kind: "addCircuit", name });
    switchCircuit(view, name);
  };

  /** Renames the shown circuit and keeps showing it. */
  const renameCircuit = async (view: View, name: string) => {
    await editing.edit(view, { kind: "renameCircuit", name });
    switchCircuit(view, name);
  };

  /** Asks to delete the shown circuit, then shows another circuit. */
  const requestDeleteCircuit = (view: View) => {
    const { doc, circuit } = view;
    if (!doc || !circuit) return;
    notices.getState().setDecision({
      title: `删除电路 ${circuit.name}？`,
      message: "删除后可以撤销。",
      actions: [
        {
          label: "删除",
          run: async () => {
            await editing.edit(view, { kind: "deleteCircuit" });
            switchCircuit(
              view,
              doc.circuits.find((x) => x.name !== circuit.name)!.name,
            );
          },
        },
      ],
    });
  };

  return {
    switchCircuit,
    enterCircuit,
    leaveInstance,
    focusObject,
    activateDocument,
    returnToSimulation,
    addCircuit,
    renameCircuit,
    requestDeleteCircuit,
  };
}
export type Navigation = ReturnType<typeof createNavigation>;
