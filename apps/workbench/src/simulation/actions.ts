import type { ActResult } from "../generated/ActResult";
import type { Command } from "../generated/Command";
import type { ComponentState } from "../generated/ComponentState";
import type { MemoryPage } from "../generated/MemoryPage";
import type { NavigateResult } from "../generated/NavigateResult";
import type { ObservationRecord } from "../generated/ObservationRecord";
import type { SessionInfo } from "../generated/SessionInfo";
import type { SimulationEvent } from "../generated/SimulationEvent";
import type { Snapshot } from "../generated/Snapshot";
import type { StateEvent } from "../generated/StateEvent";
import type { Status } from "../generated/Status";
import type { TargetRequest } from "../generated/TargetRequest";
import type { TraceKey } from "../generated/TraceKey";
import { traced } from "./simulation";
import { command } from "../shared/transport";
import type { Component, Document } from "../shared/types";
import { sourceStatusOf } from "../workspace/documents";
import {
  liveRun,
  simulationStatus,
  watchScope,
  type MemoryTarget,
  type LivePaint,
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
/** Watch lists kept per run view, the size of the released version's cache. */
const WATCH_SCOPES = 64;
/** The frequency a new run starts with unless the user set another. */
const DEFAULT_FREQUENCY = 2;
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

export interface RefreshOptions {
  /** Also fetch the waveform, for a window that may have missed samples. */
  trace?: boolean;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Drives the simulation of the shown circuit: one run at a time through the
 * host's session registry, with the window following it by events. A
 * navigation leaves the run alone; the canvas shows live values only while
 * the run's current view is the one shown. */
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

  /** Where a command came from: it applies only while the window is still
   * there, so a late reply cannot move the view. */
  interface Origin {
    scope: string;
    navigation: number;
    documentId: string;
    revision: string;
    circuit: string;
  }
  const originOf = (view: View): Origin | null =>
    view.doc && view.circuit
      ? {
          scope: view.scope,
          navigation: editor.getState().navigation.current,
          documentId: view.doc.id,
          revision: view.doc.revision,
          circuit: view.circuit.name,
        }
      : null;
  const sameTarget = (origin: Origin) => {
    const view = currentView(stores);
    return (
      view.scope === origin.scope &&
      editor.getState().navigation.current === origin.navigation &&
      view.doc?.id === origin.documentId &&
      view.doc?.revision === origin.revision &&
      view.circuit?.name === origin.circuit
    );
  };

  /** Runs tasks one at a time in the order they were asked for. */
  function serial() {
    let queue: Promise<unknown> = Promise.resolve();
    return function <T>(task: () => Promise<T>): Promise<T> {
      const next = queue.then(task, task);
      queue = next.catch(() => undefined);
      return next;
    };
  }
  // Host commands go out one at a time in request order. A control action is
  // a sequence of commands, so control actions take their own turns: the one
  // after a start sees that run, and a toggle decides from the clock the
  // previous one left. One queue for both would have a control action wait
  // for its own commands.
  const enqueue = serial();
  const control = serial();

  const status = (view: View) =>
    simulationStatus(state(), view.doc, view.circuit?.name);

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

  /** Whether the control at hand can act as things stand. */
  const allowed = (view: View, action: RunAction) => {
    const current = status(view);
    if (current.viewBusy) return false;
    if (action === "stop") return current.current;
    return (
      canRun(view) ||
      (current.current && action === "toggle-clock" && current.running)
    );
  };

  /** What a command addresses: the run's current view when the canvas shows
   * it, otherwise the circuit definition on screen. The host turns a
   * definition into a run only for a command that starts one. */
  const targetOf = (view: View): TargetRequest | null => {
    const { session, view: run } = state();
    if (
      session &&
      run &&
      view.doc &&
      session.documentId === view.doc.id &&
      session.revision === view.doc.revision
    ) {
      const live = liveRun(state(), view.doc, view.circuit?.name);
      return live
        ? {
            kind: "run",
            sessionId: session.sessionId,
            viewId: live.view.viewId,
          }
        : { kind: "definition", circuit: run.circuit };
    }
    return view.circuit
      ? { kind: "definition", circuit: view.circuit.name }
      : null;
  };

  /** Sends one command and folds its acknowledgement; a failure becomes the
   * store's error and reads as "not applied". */
  const act = async (
    view: View,
    change: Command,
    options: { initialFrequency?: number; silent?: boolean } = {},
  ): Promise<ActResult | null> => {
    const origin = originOf(view);
    const target = targetOf(view);
    if (!origin || !target) return null;
    try {
      const result = await enqueue(() =>
        command<ActResult>({
          op: "simulationAct",
          documentId: origin.documentId,
          revision: origin.revision,
          target,
          command: change,
          ...(options.initialFrequency === undefined
            ? {}
            : { initialFrequency: options.initialFrequency }),
        }),
      );
      if (sameTarget(origin)) patch({ error: "" });
      return result;
    } catch (error) {
      if (!options.silent && sameTarget(origin))
        patch({ error: message(error) });
      return null;
    }
  };

  /** Forgets the run, keeping how it ended for the status line. */
  const clearRun = () =>
    patch({
      session: null,
      view: null,
      displayed: null,
      components: {},
      frame: null,
      paint: null,
      trace: null,
      page: null,
      pressed: null,
      pending: [],
      watches: {},
      busy: null,
    });

  /** Ends the run, whatever the window shows. */
  const stop = async (view: View): Promise<boolean> => {
    const current = state();
    if (!current.session || current.busy) return false;
    const sessionId = current.session.sessionId;
    const circuit = view.circuit?.name ?? current.session.rootCircuit;
    patch({
      busy: { action: "stop", documentId: current.session.documentId, circuit },
    });
    try {
      await enqueue(() =>
        command<{ stopped: boolean }>({ op: "simulationStop", sessionId }),
      );
      if (state().session?.sessionId === sessionId) clearRun();
      return true;
    } catch (error) {
      patch({ error: message(error) });
      return false;
    } finally {
      patch({ busy: null });
    }
  };

  /** Makes the run show the instance at `path` of its circuit, keeping its
   * state, and shows it if the window is still there. */
  const navigate = async (view: View, path: string[]): Promise<boolean> => {
    const current = state();
    const origin = originOf(view);
    if (!current.session || current.viewBusy || !origin) return false;
    const sessionId = current.session.sessionId;
    patch({ viewBusy: true });
    release();
    try {
      const result = await enqueue(() =>
        command<NavigateResult>({
          op: "simulationNavigate",
          sessionId,
          instancePath: path,
        }),
      );
      // The reply shows the instance the run switched to; the window moves
      // only if the user is still there, as with every other reply.
      if (
        !result ||
        state().session?.sessionId !== sessionId ||
        !sameTarget(origin)
      )
        return false;
      const clock = state().view?.clock;
      patch({
        view: {
          viewId: result.viewId,
          circuit: result.circuit,
          instancePath: result.instancePath,
          frameSequence: 0,
          commandSequence: 0,
          clock: clock ?? {
            ticks: 0,
            running: false,
            automatic: true,
            pending: false,
            frequency: state().frequency,
            actualFrequency: 0,
            oscillating: false,
          },
        },
        // Another instance keeps none of the waveform, page or held button.
        trace: null,
        page: null,
        pressed: null,
        error: "",
      });
      const shown = currentView(stores);
      if (shown.circuit?.name !== result.circuit) {
        editor.getState().setCircuitName(result.circuit);
        editor.getState().setPlace(null);
        editor.getState().setSelected({
          scope: view.doc
            ? `${view.doc.id}:${view.doc.revision}:${result.circuit}`
            : "",
          ids: [],
        });
      }
      patch({ displayed: { sessionId, viewId: result.viewId } });
      // Watches belong to the instance; a new one starts empty.
      void sendTrace(currentView(stores)).catch(() => {});
      return true;
    } catch (error) {
      patch({ error: message(error) });
      return false;
    } finally {
      patch({ viewBusy: false });
    }
  };

  /** Shows the run again when the canvas is on a circuit the run belongs to
   * but does not show the run: the window switched back to the root circuit
   * from an instance, or a run just started for it. */
  const restore = async (view: View): Promise<boolean> => {
    const { session, view: run, displayed } = state();
    if (!session || !run || !view.doc || !view.circuit) return false;
    if (
      session.documentId !== view.doc.id ||
      session.revision !== view.doc.revision
    )
      return false;
    const showing =
      displayed?.sessionId === session.sessionId &&
      displayed.viewId === run.viewId;
    if (showing && run.circuit === view.circuit.name) return true;
    const inInstance =
      run.instancePath.length > 0 && session.rootCircuit === view.circuit.name;
    if (run.circuit !== view.circuit.name && !inInstance) return false;
    return navigate(view, []);
  };

  /** Starts a run of the shown circuit, ending a run of an older revision of
   * the document first. */
  const startRun = async (view: View): Promise<boolean> => {
    const previous = state();
    if (
      previous.session &&
      previous.session.documentId === view.doc?.id &&
      previous.session.revision !== view.doc?.revision
    ) {
      if (!(await stop(view))) return false;
      if (!canRun(view)) return false;
    }
    const frequency =
      state().frequency === DEFAULT_FREQUENCY ? undefined : state().frequency;
    const result = await act(
      view,
      { kind: "start" },
      { initialFrequency: frequency },
    );
    if (!result?.sessionId) return false;
    patch({
      components: {},
      frame: null,
      trace: null,
      page: null,
      pending: [],
      error: "",
    });
    return true;
  };

  /** Runs one control action as the released version does: the first one
   * starts a run, later ones share it, and a toggle decides from the clock
   * the preceding command left. */
  const run = async (view: View, action: RunAction): Promise<boolean> => {
    if (action === "stop") return stop(view);
    if (!allowed(view, action)) return false;
    const origin = originOf(view);
    if (!origin) return false;
    return control(async () => {
      if (!sameTarget(origin) || !allowed(view, action)) return false;
      const wasActive = status(view).current;
      if (!wasActive) {
        if (!(await startRun(view))) return false;
        if (!sameTarget(origin)) return false;
        if (action === "start") return true;
      } else if (!(await restore(view))) {
        return false;
      }
      if (!sameTarget(origin)) return false;
      if (action === "start") return true;
      if (action === "toggle-clock")
        return Boolean(
          await act(view, { kind: status(view).running ? "pause" : "play" }),
        );
      // A fresh run propagates already; toggling there would turn it off.
      if (action === "toggle-propagation")
        return wasActive
          ? Boolean(
              await act(view, {
                kind: "configure",
                automatic: !status(view).automatic,
              }),
            )
          : true;
      return Boolean(await act(view, { kind: action }));
    });
  };

  /** The watched ports of a run view, under the key they live in. */
  const watchesAt = (session: SessionInfo, path: string[]) => {
    const key = watchScope(session.sessionId, path);
    return { key, list: state().watches[key] ?? [] };
  };
  const setWatches = (key: string, list: string[]) => {
    const watches: Record<string, string[]> = {
      ...state().watches,
      [key]: list,
    };
    const keys = Object.keys(watches);
    for (const extra of keys.slice(0, Math.max(0, keys.length - WATCH_SCOPES)))
      delete watches[extra];
    patch({ watches });
  };

  /** Watches or stops watching a port of the shown run; the waveform follows
   * the watch list. Returns whether the port is watched now. */
  const toggleWatch = (view: View, key: string): boolean => {
    const live = liveRun(state(), view.doc, view.circuit?.name);
    if (!live) return false;
    const scope = watchesAt(live.session, live.view.instancePath);
    let next: string[];
    if (scope.list.includes(key))
      next = scope.list.filter((item) => item !== key);
    else if (scope.list.length >= WATCH_LIMIT) {
      toast(`最多同时观察 ${WATCH_LIMIT} 个端口`);
      next = scope.list;
    } else next = [...scope.list, key];
    setWatches(scope.key, next);
    void sendTrace(view).catch(() => {});
    return next.includes(key);
  };

  /** Stops watching every port of the shown run, which closes the waveform. */
  const clearWatches = (view: View) => {
    const live = liveRun(state(), view.doc, view.circuit?.name);
    if (!live) return;
    setWatches(watchesAt(live.session, live.view.instancePath).key, []);
    void sendTrace(view).catch(() => {});
  };

  /** Stops recording the waveform, keeping the samples on screen. */
  const stopTrace = async (view: View) => {
    const result = await act(view, { kind: "trace-stop" }, { silent: true });
    if (result) patch({ recording: false });
  };

  /** Starts recording the watched ports again, after a stop. */
  const startTrace = async (view: View) => {
    await sendTrace(view);
  };

  /** Sends the watch list of the run's current view, or stops recording when
   * it holds none. */
  const sendTrace = async (view: View) => {
    const { session, view: run } = state();
    if (!session || !run) return;
    const { list } = watchesAt(session, run.instancePath);
    if (!list.length) {
      await stopTrace(view);
      return;
    }
    const signals: TraceKey[] = [];
    for (const key of list) {
      const split = key.lastIndexOf(":");
      if (split <= 0) continue;
      signals.push({
        componentId: key.slice(0, split),
        port: Number(key.slice(split + 1)) || 0,
      });
    }
    if (!signals.length) return;
    const result = await act(
      view,
      { kind: "trace", signals },
      { silent: true },
    );
    if (result) patch({ recording: true });
  };

  /** Marks an input as not yet reflected in a frame; the marker clears when a
   * frame has processed its command, or when the view changes. */
  const beginInput = (componentId: string): PendingInput => {
    const item: PendingInput = {
      key: ++inputKey,
      componentId,
      scope: currentView(stores).scope,
      navigation: editor.getState().navigation.current,
    };
    patch({ pending: [...state().pending, item] });
    return item;
  };
  const finishInput = (item: PendingInput, result?: ActResult | null) => {
    const pending = state().pending;
    if (!pending.includes(item)) return;
    if (!result?.commandSequence) {
      patch({ pending: pending.filter((other) => other !== item) });
      return;
    }
    item.sequence = result.commandSequence;
    item.sessionId = result.sessionId;
    patch({ pending: [...pending] });
  };

  /** The run's control for a component of the shown circuit, making or
   * restoring the run when needed. */
  const prepare = async (
    view: View,
    component: Component,
  ): Promise<ComponentState | null> => {
    if (!canRun(view)) {
      toast("当前电路尚未就绪，请等待载入或处理文件变化后重试");
      return null;
    }
    if (!status(view).visible) {
      const shown = status(view).current
        ? await restore(view)
        : await run(view, "start");
      if (!shown) return null;
    }
    const live = state().components[component.id];
    if (!live) {
      toast("运行画面尚未就绪，请重试");
      return null;
    }
    if (live.control === "parent-input") {
      toast("此输入由父电路驱动，请返回父图调整");
      return null;
    }
    return live;
  };

  /** Clicks a component with the poke tool: memories open their contents,
   * buttons pulse, and an input takes the value at the point clicked. */
  const poke = async (
    view: View,
    component: Component,
    point: { x: number; y: number } | null,
  ): Promise<void> => {
    if (component.name === "RAM" || component.name === "ROM") {
      openMemory(view, component.id);
      return;
    }
    const feedback = beginInput(component.id);
    try {
      const live = await prepare(view, component);
      if (!live?.control) return;
      if (live.control === "pulse") {
        finishInput(
          feedback,
          await act(view, { kind: "pulse", componentId: component.id }),
        );
      } else if (
        point ||
        live.control === "clock" ||
        live.ports[0]?.width === 1
      ) {
        // A one-bit input acts as a whole switch wherever it is clicked;
        // wider ones keep their per-digit hit testing.
        const at = point ?? {
          x: component.location.x,
          y: component.location.y,
        };
        finishInput(
          feedback,
          await act(view, {
            kind: "poke",
            componentId: component.id,
            x: at.x,
            y: at.y,
          }),
        );
      }
    } finally {
      finishInput(feedback);
    }
  };

  /** The button held down, until its press landed and the pointer is up. */
  let holding: {
    componentId: string;
    feedback: PendingInput;
    sessionId: string | null;
    pressed: Promise<boolean>;
  } | null = null;

  /** Holds a button down; a press that starts the run first waits for it. */
  const press = (view: View, component: Component) => {
    release();
    const record = {
      componentId: component.id,
      feedback: beginInput(component.id),
      sessionId: null as string | null,
      pressed: Promise.resolve(false),
    };
    holding = record;
    patch({
      pressed: { componentId: component.id, scope: currentView(stores).scope },
    });
    record.pressed = (async () => {
      const live = await prepare(view, component);
      if (live?.control !== "pulse") return false;
      record.sessionId = state().session?.sessionId ?? null;
      const result = await act(view, {
        kind: "button",
        componentId: component.id,
        value: "1",
      });
      finishInput(record.feedback, result);
      return Boolean(result);
    })().finally(() => finishInput(record.feedback));
  };

  /** Lets go of the held button, if the run that holds it is still running. */
  const release = () => {
    const record = holding;
    holding = null;
    if (!record) return;
    if (state().pressed?.componentId === record.componentId)
      patch({ pressed: null });
    void record.pressed
      .then(async (pressed) => {
        const session = state().session;
        if (!pressed || !session || session.sessionId !== record.sessionId)
          return;
        const feedback = beginInput(record.componentId);
        const result = await act(
          currentView(stores),
          { kind: "button", componentId: record.componentId, value: "0" },
          { silent: true },
        );
        finishInput(feedback, result);
      })
      .catch(() => {});
  };

  /** Sets an input of the run to `bits` (`0`, `1` and `x` only, as wide as
   * the input), starting or restoring the run when needed. Returns whether
   * the run took it. */
  const setInput = async (
    view: View,
    component: Component,
    bits: string,
  ): Promise<boolean> => {
    if (!bits || !/^[01x]+$/.test(bits)) return false;
    const feedback = beginInput(component.id);
    try {
      const live = await prepare(view, component);
      if (live?.control !== "input") return false;
      if (bits === (live.input?.bits ?? "").replaceAll(" ", "")) return true;
      const result = await act(view, {
        kind: "input",
        componentId: component.id,
        bits,
      });
      finishInput(feedback, result);
      return Boolean(result);
    } finally {
      finishInput(feedback);
    }
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
    const result = await act(view, {
      kind: "memory",
      componentId: component.id,
      offset,
      count,
    });
    return result ? pageAfter(view, result, component.id, offset) : null;
  };

  /** Waits until a frame has applied a memory command, then takes its page. */
  const pageAfter = async (
    view: View,
    result: ActResult,
    componentId: string,
    offset: number,
  ): Promise<MemoryPage | null> => {
    const sessionId = result.sessionId ?? state().session?.sessionId;
    if (!sessionId) return null;
    const sequence = result.commandSequence ?? 0;
    const deadline = performance.now() + PAGE_TIMEOUT;
    while (
      state().session?.sessionId === sessionId &&
      performance.now() < deadline
    ) {
      const current = state();
      if (
        (current.view?.commandSequence ?? 0) >= sequence &&
        current.page?.componentId === componentId &&
        current.page.offset === offset
      )
        return current.page;
      await sleep(25);
    }
    const session = state().session;
    if (!session || session.sessionId !== sessionId) return null;
    // A frame the window missed may carry it instead.
    const snapshot = await command<Snapshot>({
      op: "simulationSnapshot",
      sessionId,
      trace: false,
      memory: true,
    });
    const page = snapshot.frame.memory;
    return page?.componentId === componentId && page.offset === offset
      ? page
      : null;
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
    const result = await act(view, {
      kind: "memory-write",
      componentId: component.id,
      offset,
      count,
      address,
      expected: Number.parseInt(expected, 16),
      value: Number.parseInt(value, 16),
    });
    return result ? pageAfter(view, result, component.id, offset) : null;
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
    patch({ memory: target, page: null });
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

  /** Keeps the frame the canvas shows, and its picture, as an observation
   * and offers it. */
  const capture = async (view: View): Promise<ObservationRecord | null> => {
    const { session, frame, displayed, view: run } = state();
    if (!view.doc || !session || !frame || !displayed || !run) return null;
    if (
      session.documentId !== view.doc.id ||
      session.revision !== view.doc.revision ||
      displayed.viewId !== run.viewId
    )
      return null;
    try {
      const record = await shell.getState().busy(() =>
        command<ObservationRecord>({
          op: "observationCapture",
          sessionId: session.sessionId,
          viewId: displayed.viewId,
          frameSequence: frame.frameSequence,
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

  /** Sets the clock frequency of the run, or the one the next run starts
   * with. */
  const changeFrequency = async (
    view: View,
    value: number,
  ): Promise<boolean> => {
    if (!(value > 0) || !canRun(view)) return false;
    if (status(view).current) {
      const result = await act(view, { kind: "configure", frequency: value });
      if (!result) return false;
    }
    patch({ frequency: value });
    return true;
  };

  /** Folds one run event into the store. */
  const onEvent = (event: SimulationEvent) => {
    const current = state();
    if (event.kind === "session") {
      if (current.session?.sessionId === event.session.sessionId) return;
      patch({
        session: event.session,
        ...emptyRun(),
        watches: {},
        error: "",
      });
      return;
    }
    if (event.kind === "ended") {
      if (current.paint?.sessionId === event.ended.sessionId)
        patch({ paint: null });
      if (current.session?.sessionId !== event.ended.sessionId) return;
      patch({
        lastEnded: event.ended,
        ...emptyRun(),
        watches: {},
        busy: null,
      });
      return;
    }
    overlay(event);
    fold(event);
  };

  const emptyRun = (): Partial<SimulationState> => ({
    view: null,
    displayed: null,
    components: {},
    frame: null,
    trace: null,
    page: null,
    pressed: null,
    pending: [],
  });

  /** Lays a state event's paint over the picture of its view. Each listener
   * gets what changed since its own last event, and ops and op lists once by
   * number, so every event counts, in order, even one `fold` drops as older
   * than a snapshot; a full one starts the picture and the numbering over. */
  const overlay = ({ sessionId, viewId, paint: delta }: StateEvent) => {
    const current = state().paint;
    const changed = [delta.wires, delta.dots, delta.components].some(
      (map) => Object.keys(map).length,
    );
    if (
      !delta.full &&
      (current?.sessionId !== sessionId ||
        current.viewId !== viewId ||
        !changed)
    )
      return;
    const paint: LivePaint =
      delta.full || !current
        ? {
            sessionId,
            viewId,
            wires: new Map(),
            dots: new Map(),
            ops: [],
            lists: [],
            components: new Map(),
            version: 0,
          }
        : current;
    for (const color in delta.wires) {
      const xs = delta.wires[color];
      for (let i = 0; i + 3 < xs.length; i += 4)
        paint.wires.set(`${xs[i]},${xs[i + 1]},${xs[i + 2]},${xs[i + 3]}`, [
          xs[i],
          xs[i + 1],
          xs[i + 2],
          xs[i + 3],
          color,
        ]);
    }
    for (const color in delta.dots) {
      const xs = delta.dots[color];
      for (let i = 0; i + 1 < xs.length; i += 2)
        paint.dots.set(`${xs[i]},${xs[i + 1]}`, [xs[i], xs[i + 1], color]);
    }
    for (const op of delta.ops) paint.ops.push(op);
    for (const list of delta.lists)
      paint.lists.push(list.map((number) => paint.ops[number]));
    for (const id in delta.components)
      paint.components.set(id, paint.lists[delta.components[id]]);
    patch({ paint: { ...paint, version: paint.version + 1 } });
  };

  /** Applies a state event: a newer frame replaces the view and clock and
   * carries the components that changed; an older one is dropped. */
  const fold = (event: StateEvent) => {
    const current = state();
    const session = current.session;
    if (!session || event.sessionId !== session.sessionId) return;
    if (current.frame && event.frameSequence <= current.frame.frameSequence)
      return;
    const changed = Object.fromEntries(
      event.components.items.map((item) => [item.id, item]),
    );
    const view = {
      viewId: event.viewId,
      circuit: event.circuit,
      instancePath: event.instancePath,
      frameSequence: event.frameSequence,
      commandSequence: event.commandSequence,
      clock: event.clock,
    };
    patch({
      view,
      components: event.components.full
        ? changed
        : { ...current.components, ...changed },
      frame: {
        viewId: event.viewId,
        frameSequence: event.frameSequence,
        commandSequence: event.commandSequence,
      },
      trace: event.trace ? traced(current.trace, event.trace) : current.trace,
      recording: event.trace ? event.trace.recording : current.recording,
      page:
        event.memory && event.memory.componentId === current.memory?.id
          ? event.memory
          : current.page,
      pending: settled(
        current.pending,
        view,
        session.sessionId,
        event.commandSequence,
      ),
    });
  };

  /** Pending markers a frame has applied, or that belong to a view the user
   * left, are done. */
  const settled = (
    pending: PendingInput[],
    view: { viewId: string; instancePath: string[] },
    sessionId: string,
    commandSequence: number,
  ): PendingInput[] => {
    const shown = currentView(stores);
    const navigation = editor.getState().navigation.current;
    const displayed = state().displayed;
    // A frame counts for a marker only when the canvas shows that view.
    const onScreen =
      displayed?.sessionId === sessionId && displayed.viewId === view.viewId;
    return pending.filter((item) => {
      if (item.scope !== shown.scope || item.navigation !== navigation)
        return false;
      if (item.sequence === undefined) return true;
      if (item.sessionId && item.sessionId !== sessionId) return false;
      return !onScreen || commandSequence < item.sequence;
    });
  };

  /** Re-reads the run the host keeps, for a window that just connected or
   * may have missed events. */
  const refresh = async (options: RefreshOptions = {}): Promise<void> => {
    const record = await command<Status>({ op: "simulationStatus" });
    const current = state();
    const session = record.session;
    if (!session) {
      if (current.session || current.view) clearRun();
      if (record.lastEnded) patch({ lastEnded: record.lastEnded });
      return;
    }
    const same = current.session?.sessionId === session.sessionId;
    patch({
      session,
      lastEnded: record.lastEnded ?? current.lastEnded,
      ...(same ? {} : { ...emptyRun(), watches: {} }),
    });
    const snapshot = await command<Snapshot>({
      op: "simulationSnapshot",
      sessionId: session.sessionId,
      trace: Boolean(options.trace),
      memory: Boolean(state().memory),
    });
    if (state().session?.sessionId !== session.sessionId) return;
    const frame = snapshot.frame;
    if (frame.frameSequence < (state().frame?.frameSequence ?? 0)) return;
    patch({
      view: record.state ?? state().view,
      frame: {
        viewId: frame.viewId,
        frameSequence: frame.frameSequence,
        commandSequence: frame.commandSequence,
      },
      components: Object.fromEntries(
        frame.components.map((item) => [item.id, item]),
      ),
      trace: snapshot.trace ?? state().trace,
      recording: snapshot.trace?.recording ?? state().recording,
      page: frame.memory ?? state().page,
    });
    const view = currentView(stores);
    if (view.doc && view.circuit) void restore(view).catch(() => {});
  };

  /** Starts the window's part of the run: the canvas follows the run of the
   * shown circuit, and a button held while the window loses focus is
   * released. Returns the stop. */
  const start = (): (() => void) => {
    const follow = reaction(
      [simulation, documents, editor],
      () => {
        const current = state();
        const shown = currentView(stores);
        return [
          shown.scope,
          editor.getState().navigation.current,
          current.session?.sessionId ?? "",
          current.session?.revision ?? "",
          current.view?.viewId ?? "",
          current.view?.circuit ?? "",
          current.displayed?.viewId ?? "",
          shown.circuit?.name ?? "",
          String(current.viewBusy || Boolean(current.busy)),
        ] as const;
      },
      () => {
        const current = state();
        const shown = currentView(stores);
        if (!shown.doc || !shown.circuit || current.viewBusy || current.busy)
          return;
        void restore(shown).catch(() => {});
      },
    );
    const letGo = () => release();
    window.addEventListener("blur", letGo);
    document.addEventListener("pointerup", letGo);
    document.addEventListener("visibilitychange", letGo);
    return () => {
      follow();
      window.removeEventListener("blur", letGo);
      document.removeEventListener("pointerup", letGo);
      document.removeEventListener("visibilitychange", letGo);
      release();
    };
  };

  return {
    status,
    allowed,
    canRun,
    run,
    stop,
    restore,
    navigate,
    poke,
    press,
    release,
    setInput,
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
    refresh,
    start,
  };
}
export type SimulationActions = ReturnType<typeof createSimulationActions>;
