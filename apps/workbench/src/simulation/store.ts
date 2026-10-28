import { createStore } from "zustand/vanilla";
import type { ClockState } from "../generated/ClockState";
import type { EndedInfo } from "../generated/EndedInfo";
import type { LiveComponent } from "../generated/LiveComponent";
import type { MemoryPage } from "../generated/MemoryPage";
import type { ObservationRecord } from "../generated/ObservationRecord";
import type { PaintEvent } from "../generated/PaintEvent";
import type { RunInfo } from "../generated/RunInfo";
import type { TraceDelta } from "../generated/TraceDelta";
import type { View } from "../app/view";
import { field, type Update } from "../shared/setter";

/** The memory component whose panel is open: its id survives the revisions a
 * ROM write makes, so the panel stays on it. */
export interface MemoryTarget {
  documentId: string;
  circuit: string;
  name: string;
  id: string;
}

/** The observations dialog's scope, and the record to show first. */
export interface ObservationsTarget {
  documentId: string;
  initial?: string;
}

/** An input the user operated whose effect no frame shows yet. It clears
 * once a frame has taken its command (`sequence`), or when the command
 * failed. */
export interface PendingInput {
  key: number;
  componentId: string;
  sequence?: number;
}

/** One op of a component's picture (the editor's symbol ops). */
export type PaintOp = PaintEvent["ops"][number];

/** The run's picture of the instance it shows: wires and junctions by
 * geometry with their color, each component's ops by id. Each frame's paint
 * is laid over it in place; a new object with the next `version` marks each
 * change. */
export interface LivePaint {
  /** `[x1, y1, x2, y2, color]` by `x1,y1,x2,y2`. */
  wires: Map<string, readonly [number, number, number, number, string]>;
  /** `[x, y, color]` by `x,y`. */
  dots: Map<string, readonly [number, number, string]>;
  components: Map<string, PaintOp[]>;
  /** Every op and op list numbered since the picture started, by number: a
   * component that goes back to a look it had gets the same list. */
  ops: PaintOp[];
  lists: PaintOp[][];
  version: number;
}

/** What the newest frame shows, and the clock as of it. */
export interface FrameHeader {
  circuit: string;
  instancePath: string[];
  /** The number of commands the run had taken. */
  commandSequence: number;
  clock: ClockState;
}

/** The run as the `simulation` events describe it, which only `onEvent`
 * writes, and the window's own state around it. */
export interface SimulationState {
  /** The run, whichever document and circuit it belongs to. */
  run: RunInfo | null;
  frame: FrameHeader | null;
  /** The shown instance's components as of the newest frame, by id. */
  components: Record<string, LiveComponent>;
  paint: LivePaint | null;
  /** The waveform of the shown instance. A new id starts a new one. */
  trace: TraceDelta | null;
  /** The RAM page the run reports. */
  page: MemoryPage | null;
  /** How the last run ended, until a new one starts. */
  ended: EndedInfo | null;
  /** Why the last request failed, until the next one succeeds. */
  error: string;
  pending: PendingInput[];
  /** The button held down on the canvas or in the inspector. */
  pressed: string | null;
  /** The clock frequency a new run starts with. */
  frequency: number;
  /** The memory component whose panel is open. */
  memory: MemoryTarget | null;
  /** The last kept observation, offered in a notice. */
  lastCapture: ObservationRecord | null;
  /** The observations dialog, when open. */
  observations: ObservationsTarget | null;
  setMemory(memory: Update<MemoryTarget | null>): void;
  setLastCapture(record: Update<ObservationRecord | null>): void;
  setObservations(target: Update<ObservationsTarget | null>): void;
}

export function createSimulationStore() {
  return createStore<SimulationState>()((set) => ({
    run: null,
    frame: null,
    components: {},
    paint: null,
    trace: null,
    page: null,
    ended: null,
    error: "",
    pending: [],
    pressed: null,
    frequency: 2,
    memory: null,
    lastCapture: null,
    observations: null,
    setMemory: field(set, "memory"),
    setLastCapture: field(set, "lastCapture"),
    setObservations: field(set, "observations"),
  }));
}

type Shown = Pick<View, "doc" | "circuit" | "instance">;
const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** The run and frame the canvas shows: the run is of the shown document
 * revision and its newest frame shows the shown circuit and instance. Only
 * then does the canvas show live values and take input. */
export function live(
  { run, frame }: Pick<SimulationState, "run" | "frame">,
  { doc, circuit, instance }: Shown,
): { run: RunInfo; frame: FrameHeader } | null {
  return run &&
    frame &&
    doc &&
    circuit &&
    run.documentId === doc.id &&
    run.revision === doc.revision &&
    frame.circuit === circuit.name &&
    samePath(frame.instancePath, instance)
    ? { run, frame }
    : null;
}

/** Whether the run is the shown view's: its root circuit, or one of its
 * instances, of the shown document revision. Commands then act on it rather
 * than start another. */
export function ofView(
  { run }: Pick<SimulationState, "run">,
  { doc, circuit, instance }: Shown,
): boolean {
  return Boolean(
    run &&
    doc &&
    circuit &&
    run.documentId === doc.id &&
    run.revision === doc.revision &&
    (instance.length > 0 || run.rootCircuit === circuit.name),
  );
}

/** What the simulation controls show for the shown view. */
export interface SimulationStatus {
  /** A run exists, of any document. */
  exists: boolean;
  /** The run is the view's (`ofView`). */
  current: boolean;
  /** The canvas shows the run (`live`). */
  live: boolean;
  running: boolean;
  automatic: boolean;
  ticks: number | undefined;
  /** The run's clock frequency. */
  frequency: number | undefined;
  /** The circuit the run started from. */
  circuit: string | undefined;
  /** The run of this document ended because the document changed. */
  stale: boolean;
}

export function simulationStatus(
  state: Pick<SimulationState, "run" | "frame" | "ended">,
  view: Shown,
): SimulationStatus {
  const { run, frame, ended } = state;
  const current = ofView(state, view);
  const clock = frame?.clock;
  return {
    exists: Boolean(run),
    current,
    live: Boolean(live(state, view)),
    running: Boolean(clock?.running),
    automatic: clock?.automatic !== false,
    ticks: clock?.ticks,
    frequency: run ? clock?.frequency : undefined,
    circuit: run?.rootCircuit,
    stale: Boolean(
      !current &&
      view.doc &&
      ended?.reasonCode === "revision-changed" &&
      ended.documentId === view.doc.id,
    ),
  };
}
