import type { ObservationRecord } from "../generated/ObservationRecord";
import { command } from "../lib/transport";
import type { Stores } from "../workbench/createWorkbench";
import { activeSimulation, currentView, type View } from "../workbench/view";

/** Driving the simulation of the shown circuit. */
export function createSimulationActions(stores: Stores) {
  const { editor, shell, simulation } = stores;
  const busy = <T>(action: () => Promise<T>) => shell.getState().busy(action);

  /** Queues a simulation action. Actions run one at a time; one whose view
   * was left before its turn is dropped. */
  const simulate = async (
    { doc, circuit, scope: origin }: View,
    op: string,
    attributes: Record<string, string> = {},
  ) => {
    if (!doc || !circuit) return;
    const { navigation } = editor.getState();
    const { sequence: counter, queue, frequency } = simulation.getState();
    const requested = navigation.current;
    const sequence = counter.next();
    const request =
      op === "stop"
        ? { op: "simulationStop" as const }
        : {
            op: "simulationAction" as const,
            id: doc.id,
            revision: doc.revision,
            circuit: circuit.name,
            command: op,
            attributes: { initialFrequency: String(frequency), ...attributes },
          };
    const previous = queue.current;
    simulation
      .getState()
      .setRequests((items) => [...items, { id: sequence, scope: origin, op }]);
    const next = busy(async () => {
      await previous.catch(() => {});
      // A queued action belongs to the view where it was requested. Releasing
      // a held button is safe across navigation: the host checks its viewId.
      if (
        op !== "button-release" &&
        (currentView(stores).scope !== origin ||
          navigation.current !== requested)
      )
        return;
      await command(request);
    }).finally(() => {
      simulation
        .getState()
        .setRequests((items) => items.filter((item) => item.id !== sequence));
    });
    queue.current = next;
    await next;
  };

  /** Records the running view as an observation and offers it in a notice. */
  const capture = async (view: View) => {
    const { doc } = view;
    const active = activeSimulation(simulation.getState().sim, view);
    if (!doc || !active) return;
    const record = await busy(() =>
      command<ObservationRecord>({
        op: "observationCapture",
        id: doc.id,
        revision: doc.revision,
        view_id: active.viewId,
        title: "",
      }),
    );
    simulation.getState().setLastCapture(record);
  };

  /** Sets the clock frequency; a running simulation changes with it. */
  const changeFrequency = async (view: View, value: number) => {
    if (activeSimulation(simulation.getState().sim, view))
      await simulate(view, "configure", { frequency: String(value) });
    if (currentView(stores).scope === view.scope)
      simulation.getState().setFrequency(value);
  };

  /** Opens the memory panel of a component of the shown circuit. */
  const openMemory = ({ doc, circuit }: View, id: string) => {
    const c = circuit?.components.find((c) => c.id === id);
    if (doc && circuit && c)
      simulation.getState().setMemory({
        documentId: doc.id,
        circuit: circuit.name,
        name: c.name,
        x: c.location.x,
        y: c.location.y,
      });
  };

  return { simulate, capture, changeFrequency, openMemory };
}
export type SimulationActions = ReturnType<typeof createSimulationActions>;
