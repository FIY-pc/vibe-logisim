import type { Command } from "../generated/Command";
import type { MemoryPage } from "../generated/MemoryPage";
import type { ObservationRecord } from "../generated/ObservationRecord";
import type { PaintEvent } from "../generated/PaintEvent";
import type { Request } from "../generated/Request";
import type { RunInfo } from "../generated/RunInfo";
import type { SimulationEvent } from "../generated/SimulationEvent";
import { traced } from "./simulation";
import { command } from "../shared/transport";
import type { Component, Document, Point } from "../shared/types";
import { sourceStatusOf } from "../workspace/documents";
import {
  live,
  ofView,
  type LivePaint,
  type MemoryTarget,
  type PendingInput,
  type SimulationState,
} from "./store";
import type { Stores } from "../app/createWorkbench";
import { reaction } from "../app/reaction";
import { currentView, type View } from "../app/view";

/** The controls the window offers; `start` makes a run and the others drive
 * the run of the shown circuit, making one first when there is none. */
export type RunAction =
  | "start"
  | "stop"
  | "toggle-clock"
  | "tick"
  | "step"
  | "reset"
  | "toggle-propagation";

/** How many ports the waveform records at once. */
const WATCH_LIMIT = 12;
/** How long a RAM page may take to appear in a frame. */
const PAGE_TIMEOUT = 10_000;

/** A page of a memory component of the shown circuit. */
export interface MemoryRequest {
  /** The component as the document places it. */
  component: Component;
  offset: number;
  count: number;
}

export interface MemoryWriteRequest extends MemoryRequest {
  address: number;
  /** The word as the page showed it, so a changed word is not overwritten. */
  expected: string;
  value: string;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Whether the poke tool operates a component: input pins, clocks and
 * buttons; the run says why when it cannot (driven by the parent). */
const operable = ({ name, attributes }: Component) =>
  name === "Button" ||
  name === "Clock" ||
  (name === "Pin" && attributes.output !== "true");

/** Lays a frame's paint over the picture, or starts one from a whole frame.
 * The maps and tables change in place; a paint with nothing in it keeps the
 * picture. */
function painted(previous: LivePaint | null, event: PaintEvent): LivePaint {
  if (
    previous &&
    !Object.keys(event.wires).length &&
    !Object.keys(event.dots).length &&
    !Object.keys(event.components).length
  )
    return previous;
  const paint: LivePaint = previous ?? {
    wires: new Map(),
    dots: new Map(),
    components: new Map(),
    ops: [],
    lists: [],
    version: 0,
  };
  for (const color in event.wires) {
    const xs = event.wires[color];
    for (let i = 0; i + 3 < xs.length; i += 4)
      paint.wires.set(`${xs[i]},${xs[i + 1]},${xs[i + 2]},${xs[i + 3]}`, [
        xs[i],
        xs[i + 1],
        xs[i + 2],
        xs[i + 3],
        color,
      ]);
  }
  for (const color in event.dots) {
    const xs = event.dots[color];
    for (let i = 0; i + 1 < xs.length; i += 2)
      paint.dots.set(`${xs[i]},${xs[i + 1]}`, [xs[i], xs[i + 1], color]);
  }
  // The event's ops and lists continue the numbers of the picture's.
  for (const op of event.ops) paint.ops.push(op);
  for (const list of event.lists)
    paint.lists.push(list.map((number) => paint.ops[number]));
  for (const id in event.components)
    paint.components.set(id, paint.lists[event.components[id]]);
  return { ...paint, version: paint.version + 1 };
}

/** Drives the run through the host and follows it by its events: `onEvent`
 * is the only writer of run state, requests only report failures. There is
 * one run; requests go out one at a time in the order they were made, so a
 * command waits for the start before it and a release follows its press. */
export function createSimulationActions(stores: Stores) {
  const { documents, editor, notices, shell, simulation } = stores;
  const state = () => simulation.getState();
  const patch = (change: Partial<SimulationState>) =>
    simulation.setState(change);
  const onError = (error: unknown) => notices.getState().onError(error);
  const toast = (message: string) => notices.getState().setNotice(message);
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  let inputKey = 0;

  let queue: Promise<unknown> = Promise.resolve();
  /** Sends a request after the ones before it. A failure is shown and reads
   * as `null`. */
  const request = <T>(body: Request, silent = false): Promise<T | null> => {
    const next = queue.then(() => command<T>(body));
    queue = next.catch(() => undefined);
    return next.then(
      (result) => {
        if (state().error) patch({ error: "" });
        return result;
      },
      (error: unknown) => {
        if (silent) return null;
        patch({ error: message(error) });
        toast(message(error));
        return null;
      },
    );
  };
  /** Sends a command to the run; its number, or `null` when it failed. */
  const send = async (change: Command, silent = false) =>
    (
      await request<{ commandSequence: number }>(
        { op: "simulationCommand", command: change },
        silent,
      )
    )?.commandSequence ?? null;

  /** The circuit can take commands: it is open, nothing else is loading, and
   * its source file can still be read. A file changed on disk is fine: the
   * run uses the document, not the file. */
  const canRun = (view: View) => {
    const { doc, circuit } = view;
    if (!doc || !circuit || shell.getState().pending) return false;
    const source = sourceStatusOf(documents.getState(), doc);
    return (
      !source || (source.state !== "unreadable" && source.state !== "missing")
    );
  };

  /** A start on its way, until its run's event arrives: a second action on
   * the same circuit waits for it instead of starting another run. */
  let starting: { scope: string; done: Promise<boolean> } | null = null;
  /** Makes the shown circuit's run, unless the view already shows the run. */
  const ensureRun = (view: View): Promise<boolean> => {
    if (ofView(state(), view)) return Promise.resolve(true);
    if (starting?.scope === view.scope) return starting.done;
    const { doc, circuit } = view;
    if (!doc || !circuit || !canRun(view)) return Promise.resolve(false);
    const done = request<RunInfo>({
      op: "simulationStart",
      documentId: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
      frequency: state().frequency,
    }).then((run) => {
      if (!run && starting?.done === done) starting = null;
      return Boolean(run);
    });
    starting = { scope: view.scope, done };
    return done;
  };

  /** Ends the run, whatever the window shows. */
  const stop = async (): Promise<boolean> =>
    Boolean(await request<{ stopped: boolean }>({ op: "simulationStop" }));

  /** Runs one control action as the released version does: the first one
   * starts a run, later ones share it. Toggles are the run's: it reads its
   * own clock. */
  const run = async (view: View, action: RunAction): Promise<boolean> => {
    if (action === "stop") return ofView(state(), view) && stop();
    const had = ofView(state(), view);
    if (!had && !canRun(view)) return false;
    if (!(await ensureRun(view))) return false;
    if (action === "start") return true;
    // A new run propagates already; toggling there would turn it off.
    if (action === "toggle-propagation" && !had) return true;
    return (await send({ kind: action })) !== null;
  };

  /** Marks an input as not yet shown by a frame. */
  const beginInput = (componentId: string): PendingInput => {
    const marker = { key: ++inputKey, componentId };
    patch({ pending: [...state().pending, marker] });
    return marker;
  };
  /** Gives a marker its command's number, or drops it when the command
   * failed or a frame already took it. */
  const settle = (marker: PendingInput, sequence: number | null) => {
    const { pending, frame } = state();
    if (!pending.includes(marker)) return;
    patch({
      pending:
        sequence === null || (frame?.commandSequence ?? 0) >= sequence
          ? pending.filter((item) => item !== marker)
          : pending.map((item) =>
              item === marker ? { ...marker, sequence } : item,
            ),
    });
  };
  /** Sends an input command for a component of the shown circuit, making the
   * run first when there is none. */
  const operate = async (
    view: View,
    component: Component,
    change: Command,
  ): Promise<boolean> => {
    if (!ofView(state(), view) && !canRun(view)) {
      toast("当前电路尚未就绪，请等待载入或处理文件变化后重试");
      return false;
    }
    const marker = beginInput(component.id);
    try {
      if (!(await ensureRun(view))) return false;
      const sequence = await send(change);
      settle(marker, sequence);
      return sequence !== null;
    } finally {
      settle(marker, null);
    }
  };

  /** Clicks a component with the poke tool: memories open their contents,
   * buttons pulse, and an input or clock takes the click at its point. */
  const poke = async (view: View, component: Component, point: Point) => {
    if (component.name === "RAM" || component.name === "ROM") {
      openMemory(view, component.id);
      return;
    }
    if (!operable(component)) return;
    await operate(
      view,
      component,
      component.name === "Button"
        ? { kind: "pulse", componentId: component.id }
        : { kind: "poke", componentId: component.id, ...point },
    );
  };

  /** The button held down, and whether its press landed. */
  let holding: { componentId: string; pressed: Promise<boolean> } | null = null;

  /** Holds a button down; a press that starts the run first waits for it. */
  const press = (view: View, component: Component) => {
    release();
    patch({ pressed: component.id });
    holding = {
      componentId: component.id,
      pressed: operate(view, component, {
        kind: "button",
        componentId: component.id,
        value: "1",
      }),
    };
  };

  /** Lets go of the held button. The run ignores a release of a button it
   * no longer holds (another instance shown, a reset). */
  const release = () => {
    const record = holding;
    holding = null;
    if (!record) return;
    if (state().pressed === record.componentId) patch({ pressed: null });
    void record.pressed.then(async (pressed) => {
      if (!pressed) return;
      const marker = beginInput(record.componentId);
      settle(
        marker,
        await send(
          { kind: "button", componentId: record.componentId, value: "0" },
          true,
        ),
      );
    });
  };

  /** Sets an input of the run to `bits` (`0`, `1` and `x` only, as wide as
   * the input), making the run first when needed. Returns whether the run
   * took it. */
  const setInput = async (
    view: View,
    component: Component,
    bits: string,
  ): Promise<boolean> =>
    Boolean(bits) &&
    /^[01x]+$/.test(bits) &&
    operate(view, component, {
      kind: "input",
      componentId: component.id,
      bits,
    });

  /** The watched ports of the shown run, as `componentId:port`. */
  const watched = () => state().trace?.signals.map((signal) => signal.id) ?? [];
  /** Records the ports given, from now; none stops and clears the waveform. */
  const sendTrace = (keys: string[]) =>
    send({
      kind: "trace",
      signals: keys.map((key) => {
        const split = key.lastIndexOf(":");
        return {
          componentId: key.slice(0, split),
          port: Number(key.slice(split + 1)) || 0,
        };
      }),
    });

  /** Watches or stops watching a port of the shown run; the waveform follows
   * the watch list. */
  const toggleWatch = (view: View, key: string) => {
    if (!live(state(), view)) return;
    const list = watched();
    if (list.includes(key)) void sendTrace(list.filter((item) => item !== key));
    else if (list.length >= WATCH_LIMIT)
      toast(`最多同时观察 ${WATCH_LIMIT} 个端口`);
    else void sendTrace([...list, key]);
  };

  /** Stops watching every port, which closes the waveform. */
  const clearWatches = (view: View) => {
    if (live(state(), view)) void sendTrace([]);
  };

  /** Stops recording, keeping the samples on screen. */
  const stopTrace = async () => {
    await send({ kind: "trace-stop" });
  };

  /** Records the watched ports again, after a stop: a new waveform. */
  const startTrace = async () => {
    await sendTrace(watched());
  };

  /** Reads a page of a memory: a RAM's from the run, a ROM's from the
   * document. */
  const readMemory = async (
    view: View,
    { component, offset, count }: MemoryRequest,
  ): Promise<MemoryPage | null> => {
    if (component.name === "ROM") {
      if (!view.doc || !view.circuit) return null;
      return command<MemoryPage>({
        op: "memory",
        id: view.doc.id,
        revision: view.doc.revision,
        circuit: view.circuit.name,
        component: component.id,
        offset,
        count,
      });
    }
    const sequence = await send({
      kind: "memory",
      componentId: component.id,
      offset,
      count,
    });
    return sequence === null ? null : pageAfter(sequence, component.id, offset);
  };

  /** Waits for the frame that took a memory command, then takes its page. */
  const pageAfter = async (
    sequence: number,
    componentId: string,
    offset: number,
  ): Promise<MemoryPage | null> => {
    const run = state().run;
    const deadline = performance.now() + PAGE_TIMEOUT;
    while (run && state().run === run && performance.now() < deadline) {
      const { frame, page } = state();
      if (
        frame &&
        frame.commandSequence >= sequence &&
        page?.componentId === componentId &&
        page.offset === offset
      )
        return page;
      await sleep(25);
    }
    return null;
  };

  /** Writes one word: a RAM's through the run, a ROM's as a document edit. */
  const writeMemory = async (
    view: View,
    { component, offset, count, address, expected, value }: MemoryWriteRequest,
  ): Promise<MemoryPage | null> => {
    const doc = view.doc;
    if (!doc || !view.circuit) return null;
    if (component.name === "ROM") {
      const document = await shell.getState().busy(() =>
        command<Document>({
          op: "memoryWrite",
          id: doc.id,
          revision: doc.revision,
          circuit: view.circuit!.name,
          component: component.id,
          address,
          expected,
          value,
        }),
      );
      documents.getState().mergeDocument(document, doc.revision);
      return readMemory(view, { component, offset, count });
    }
    const sequence = await send({
      kind: "memory-write",
      componentId: component.id,
      offset,
      count,
      address,
      expected: Number.parseInt(expected, 16),
      value: Number.parseInt(value, 16),
    });
    return sequence === null ? null : pageAfter(sequence, component.id, offset);
  };

  /** Opens the memory panel of a component, or closes it when it is the same
   * component again. */
  const openMemory = (view: View, id: string) => {
    const { doc, circuit } = view;
    const component = circuit?.components.find((item) => item.id === id);
    if (!doc || !circuit || !component) return;
    const open = state().memory;
    const target: MemoryTarget = {
      documentId: doc.id,
      circuit: circuit.name,
      name: component.name,
      id: component.id,
    };
    if (
      open &&
      open.documentId === target.documentId &&
      open.circuit === target.circuit &&
      open.id === target.id
    ) {
      patch({ memory: null });
      return;
    }
    patch({ memory: target });
    editor.getState().setFocusTarget({
      documentId: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
      id: component.id,
      token: Date.now(),
    });
  };

  const closeMemory = () => patch({ memory: null });

  /** The picture the canvas shows, on white, as a PNG data URL. */
  const shownPicture = (): string | undefined => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "canvas.canvas-picture",
    );
    if (!canvas?.width || !canvas.height) return undefined;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, copy.width, copy.height);
    ctx.drawImage(canvas, 0, 0);
    return copy.toDataURL("image/png");
  };

  /** Keeps the run's newest frame and the picture on the canvas as an
   * observation, and offers it. */
  const capture = async (view: View): Promise<ObservationRecord | null> => {
    if (!live(state(), view)) return null;
    try {
      const record = await shell.getState().busy(() =>
        command<ObservationRecord>({
          op: "observationCapture",
          title: "",
          imageData: shownPicture(),
        }),
      );
      patch({ lastCapture: record });
      return record;
    } catch (error) {
      onError(error);
      return null;
    }
  };

  /** Sets the clock frequency of the run, and the one the next run starts
   * with. */
  const changeFrequency = async (
    view: View,
    value: number,
  ): Promise<boolean> => {
    if (!(value > 0) || !canRun(view)) return false;
    if (
      ofView(state(), view) &&
      (await send({ kind: "configure", frequency: value })) === null
    )
      return false;
    patch({ frequency: value });
    return true;
  };

  /** A run this page did not start (it was reloaded during the run): its
   * first frame takes the page to the circuit and instance the run shows. */
  let adopting: RunInfo | null = null;

  /** Folds one run event into the store. Each subscription starts with the
   * run and a whole frame, so a reloaded page gets the whole picture. */
  const onEvent = (event: SimulationEvent) => {
    const current = state();
    if (event.kind === "run") {
      const mine = starting !== null;
      starting = null;
      const { run } = current;
      if (
        run &&
        run.documentId === event.run.documentId &&
        run.startedAt === event.run.startedAt
      )
        return;
      adopting = mine ? null : event.run;
      patch({
        run: event.run,
        frame: null,
        components: {},
        paint: null,
        trace: null,
        page: null,
        ended: null,
        error: "",
        pending: [],
        pressed: null,
      });
      return;
    }
    if (event.kind === "ended") {
      holding = null;
      patch({
        run: null,
        frame: null,
        components: {},
        paint: null,
        trace: null,
        page: null,
        ended: event.ended,
        pending: [],
        pressed: null,
      });
      if (editor.getState().instance.length)
        editor.getState().showInstance(editor.getState().circuitName, []);
      return;
    }
    if (!current.run) return;
    const { full } = event;
    patch({
      frame: {
        circuit: event.circuit,
        instancePath: event.instancePath,
        commandSequence: event.commandSequence,
        clock: event.clock,
      },
      components: full
        ? event.components
        : { ...current.components, ...event.components },
      paint: painted(full ? null : current.paint, event.paint),
      trace: full
        ? (event.trace ?? null)
        : event.trace
          ? traced(current.trace, event.trace)
          : current.trace,
      page: full ? (event.memory ?? null) : (event.memory ?? current.page),
      pending: current.pending.filter(
        (item) =>
          item.sequence === undefined || item.sequence > event.commandSequence,
      ),
    });
  };

  /** Keeps the run on the instance the page shows: entering an instance,
   * going up, or showing the root circuit again moves the view, and the run
   * follows. A run the page did not start moves the page instead, once. */
  const follow = () => {
    const view = currentView(stores);
    const current = state();
    const { run, frame } = current;
    if (!run || !frame || !view.doc || !view.circuit) return;
    const adopt = adopting === run;
    adopting = null;
    if (run.documentId !== view.doc.id || run.revision !== view.doc.revision)
      return;
    if (
      adopt &&
      (view.circuit.name !== frame.circuit ||
        view.instance.join("/") !== frame.instancePath.join("/"))
    ) {
      editor.getState().showInstance(frame.circuit, frame.instancePath);
      return;
    }
    if (live(current, view) || !ofView(current, view)) return;
    release();
    void request({ op: "simulationNavigate", instancePath: view.instance });
  };

  /** Starts the window's part of the run: the run follows the shown
   * instance, and a button held while the window loses focus is released.
   * Returns the stop. */
  const start = (): (() => void) => {
    const following = reaction(
      [simulation, documents, editor],
      () => {
        const view = currentView(stores);
        const { run, frame } = state();
        return [
          view.doc?.id,
          view.doc?.revision,
          view.circuit?.name,
          view.instance.join("/"),
          run,
          Boolean(frame),
        ] as const;
      },
      follow,
    );
    const letGo = () => release();
    window.addEventListener("blur", letGo);
    document.addEventListener("pointerup", letGo);
    document.addEventListener("visibilitychange", letGo);
    return () => {
      following();
      window.removeEventListener("blur", letGo);
      document.removeEventListener("pointerup", letGo);
      document.removeEventListener("visibilitychange", letGo);
      release();
    };
  };

  return {
    run,
    stop,
    poke,
    press,
    release,
    setInput,
    watched,
    toggleWatch,
    clearWatches,
    stopTrace,
    startTrace,
    readMemory,
    writeMemory,
    capture,
    changeFrequency,
    openMemory,
    closeMemory,
    onEvent,
    start,
  };
}
export type SimulationActions = ReturnType<typeof createSimulationActions>;
