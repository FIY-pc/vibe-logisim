import { liveRun } from "../stores/simulation";
import { command } from "../lib/transport";
import type { LocateChange } from "../lib/reviewTypes";
import type { SessionInfo } from "../generated/SessionInfo";
import type { Document } from "../lib/types";
import type { Actions, Stores } from "../workbench/createWorkbench";
import { currentView, type View } from "../workbench/view";
import type { EditorActions } from "./editor";

/**
 * Moving between documents, circuits, simulation instances and objects,
 * including the circuit changes that move the view. Every navigation bumps
 * the editor's navigation counter, so results requested before it are dropped.
 */
export function createNavigation(
  stores: Stores,
  editing: EditorActions,
  actions: Pick<Actions, "simulation">,
) {
  const { documents, editor, notices, shell, simulation } = stores;
  const onError = (error: unknown) => notices.getState().onError(error);

  /** Shows a circuit of the view's document. Switching to the root circuit
   * of a run that is inside an instance shows the run again, from its root;
   * switching anywhere else leaves the run alone. */
  const switchCircuit = (view: View, name: string) => {
    editor.getState().navigation.next();
    editor.getState().setCircuitName(name);
    editing.select(view, []);
    editor.getState().setPlace(null);
    // The window's own simulation reaction restores the run once the circuit
    // is shown; nothing to do here but keep this the only place that moves.
  };

  /** Shows the instance of the running simulation at `path`. */
  const navigateSimulation = async (view: View, path: string[]) => {
    if (!view.doc || !view.circuit) return;
    await actions.simulation.navigate(view, path).catch(onError);
  };

  /** Opens a subcircuit: inside the running simulation, its instance;
   * otherwise its definition. */
  const enterCircuit = (view: View, name: string, id: string) => {
    const live = liveRun(simulation.getState(), view.doc, view.circuit?.name);
    if (live)
      void navigateSimulation(view, [...live.view.instancePath, id]);
    else switchCircuit(view, name);
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

  /** Shows the object a change comparison refers to, if it is still the
   * shown revision and the object is unambiguous. */
  const locateChange = (
    view: View,
    { circuit: name, revision, object }: LocateChange,
  ) => {
    const { doc } = view;
    if (!doc || revision !== doc.revision) {
      onError("文档已有后续修改，无法定位这份对照中的对象");
      return;
    }
    const definition = doc.circuits.find((item) => item.name === name);
    const matches =
      definition?.components.filter(
        (item) =>
          item.name === object.factory &&
          item.location.x === object.location.x &&
          item.location.y === object.location.y,
      ) || [];
    const wires =
      object.factory === "wire" && object.from && object.to
        ? definition?.wires.filter(
            (wire) =>
              wire.id === object.id &&
              ((wire.from.x === object.from!.x &&
                wire.from.y === object.from!.y &&
                wire.to.x === object.to!.x &&
                wire.to.y === object.to!.y) ||
                (wire.from.x === object.to!.x &&
                  wire.from.y === object.to!.y &&
                  wire.to.x === object.from!.x &&
                  wire.to.y === object.from!.y)),
          ) || []
        : [];
    const targets = [...matches, ...wires];
    if (targets.length !== 1) {
      onError("无法唯一对应当前工程中的对象");
      return;
    }
    focusObject(view, name, targets[0].id);
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

  /** Shows the circuit the run is showing, in its document. */
  const returnToSimulation = (view: View, session: SessionInfo) => {
    const run = simulation.getState().view;
    const owner = documents
      .getState()
      .docs.find(
        (item) =>
          item.id === session.documentId && item.revision === session.revision,
      );
    if (!owner || !run) return;
    editor.getState().navigation.next();
    documents.getState().setActive(owner.id);
    editor.getState().setCircuitName(run.circuit);
    editing.select(view, []);
    void command({ op: "activate", id: owner.id }).catch(onError);
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
    navigateSimulation,
    enterCircuit,
    focusObject,
    locateChange,
    activateDocument,
    returnToSimulation,
    addCircuit,
    renameCircuit,
    requestDeleteCircuit,
  };
}
export type Navigation = ReturnType<typeof createNavigation>;
