import { createStore } from "zustand/vanilla";
import type { ComponentState } from "../generated/ComponentState";
import type { EndedInfo } from "../generated/EndedInfo";
import type { FrameImage } from "../generated/FrameImage";
import type { MemoryPage } from "../generated/MemoryPage";
import type { ObservationRecord } from "../generated/ObservationRecord";
import type { RunState } from "../generated/RunState";
import type { SessionInfo } from "../generated/SessionInfo";
import type { TraceDelta } from "../generated/TraceDelta";
import type { Displayed } from "./simulation";
import { field, type Update } from "../shared/setter";

export type { Displayed } from "./simulation";

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

/** An input the user operated whose effect the canvas does not show yet. It
 * clears once a frame has processed its command, or when the view changes. */
export interface PendingInput {
  key: number;
  componentId: string;
  /** The view scope and navigation the input was made in. */
  scope: string;
  navigation: number;
  /** Set once the run accepted the command. */
  sessionId?: string;
  sequence?: number;
}

/** A frame picture decoded and ready to paint. */
export interface Picture {
  sessionId: string;
  viewId: string;
  frameSequence: number;
  commandSequence: number;
  url: string;
  image: FrameImage;
}

export interface SimulationState {
  /** The run, whichever document and circuit it belongs to. */
  session: SessionInfo | null;
  /** How the last run ended, until a new one starts. */
  lastEnded: EndedInfo | null;
  /** The run's current view and its latest clock. */
  view: RunState | null;
  /** The view of the run the canvas shows. Only that view shows live values
   * and takes input; the definition never inherits them. */
  displayed: Displayed | null;
  /** The components of the run's current view as of the newest frame, by id. */
  components: Record<string, ComponentState>;
  /** The newest frame of the run. */
  frame: {
    viewId: string;
    frameSequence: number;
    commandSequence: number;
    image: FrameImage;
  } | null;
  /** The newest picture fetched for the displayed view. */
  picture: Picture | null;
  /** The waveform of the run's current view. A new id starts a new one. */
  trace: TraceDelta | null;
  /** Whether the run is recording the watched ports; stopping keeps the
   * samples on screen. */
  recording: boolean;
  /** The page of a RAM the run's current view reports. */
  page: MemoryPage | null;
  /** The memory component whose panel is open. */
  memory: MemoryTarget | null;
  pending: PendingInput[];
  /** The button held down on the canvas or in the inspector. */
  pressed: { componentId: string; scope: string } | null;
  /** A run starting or stopping for the circuit it was requested from. */
  busy: {
    action: "start" | "stop";
    documentId: string;
    circuit: string;
  } | null;
  /** The run is switching to another instance. */
  viewBusy: boolean;
  /** Why the last command failed, until the next one succeeds. */
  error: string;
  /** The clock frequency a new run starts with. */
  frequency: number;
  /** Watched ports (`componentId:port`), by run and instance: a new run or
   * instance starts with an empty waveform, the way the released version did. */
  watches: Record<string, string[]>;
  /** The last kept observation, offered in a notice. */
  lastCapture: ObservationRecord | null;
  /** The observations dialog, when open. */
  observations: ObservationsTarget | null;
  setSession(session: Update<SessionInfo | null>): void;
  setLastEnded(ended: Update<EndedInfo | null>): void;
  setView(view: Update<RunState | null>): void;
  setDisplayed(displayed: Update<Displayed | null>): void;
  setComponents(components: Update<Record<string, ComponentState>>): void;
  setFrame(frame: Update<SimulationState["frame"]>): void;
  setPicture(picture: Update<Picture | null>): void;
  setTrace(trace: Update<TraceDelta | null>): void;
  setRecording(recording: Update<boolean>): void;
  setPage(page: Update<MemoryPage | null>): void;
  setMemory(memory: Update<MemoryTarget | null>): void;
  setPending(pending: Update<PendingInput[]>): void;
  setPressed(pressed: Update<SimulationState["pressed"]>): void;
  setBusy(busy: Update<SimulationState["busy"]>): void;
  setViewBusy(busy: Update<boolean>): void;
  setError(error: Update<string>): void;
  setFrequency(frequency: Update<number>): void;
  setWatches(watches: Update<Record<string, string[]>>): void;
  setLastCapture(record: Update<ObservationRecord | null>): void;
  setObservations(target: Update<ObservationsTarget | null>): void;
}

export function createSimulationStore() {
  return createStore<SimulationState>()((set) => ({
    session: null,
    lastEnded: null,
    view: null,
    displayed: null,
    components: {},
    frame: null,
    picture: null,
    trace: null,
    recording: false,
    page: null,
    memory: null,
    pending: [],
    pressed: null,
    busy: null,
    viewBusy: false,
    error: "",
    frequency: 2,
    watches: {},
    lastCapture: null,
    observations: null,
    setSession: field(set, "session"),
    setLastEnded: field(set, "lastEnded"),
    setView: field(set, "view"),
    setDisplayed: field(set, "displayed"),
    setComponents: field(set, "components"),
    setFrame: field(set, "frame"),
    setPicture: field(set, "picture"),
    setTrace: field(set, "trace"),
    setRecording: field(set, "recording"),
    setPage: field(set, "page"),
    setMemory: field(set, "memory"),
    setPending: field(set, "pending"),
    setPressed: field(set, "pressed"),
    setBusy: field(set, "busy"),
    setViewBusy: field(set, "viewBusy"),
    setError: field(set, "error"),
    setFrequency: field(set, "frequency"),
    setWatches: field(set, "watches"),
    setLastCapture: field(set, "lastCapture"),
    setObservations: field(set, "observations"),
  }));
}

/** The watch list key of a run view: watches belong to one instance of one run. */
export const watchScope = (sessionId: string, instancePath: string[]) =>
  `${sessionId}|${instancePath.join("/")}`;

/** The run view the canvas shows live: the displayed view is the run's
 * current view, of the shown document revision and circuit. */
export function liveRun(
  state: Pick<SimulationState, "session" | "view" | "displayed">,
  doc: { id: string; revision: string } | null,
  circuit: string | undefined,
): { session: SessionInfo; view: RunState } | null {
  const { session, view, displayed } = state;
  return session &&
    view &&
    displayed &&
    doc &&
    session.documentId === doc.id &&
    session.revision === doc.revision &&
    displayed.sessionId === session.sessionId &&
    displayed.viewId === view.viewId &&
    view.circuit === circuit
    ? { session, view }
    : null;
}

/** What the simulation controls show for the shown circuit; as in the
 * released version, `current` means commands act on the existing run rather
 * than starting a new one. */
export interface SimulationStatus {
  /** A run exists, of any document. */
  exists: boolean;
  current: boolean;
  /** The canvas shows a frame of the run. */
  visible: boolean;
  running: boolean;
  automatic: boolean;
  ticks: number | undefined;
  /** The run's clock frequency. */
  frequency: number | undefined;
  actualFrequency: number;
  /** The circuit the run started from. */
  circuit: string | undefined;
  /** The run of this document ended because the document changed. */
  stale: boolean;
  /** A run is starting or stopping for the shown circuit. */
  busy: boolean;
  busyAction: "start" | "stop" | null;
  viewBusy: boolean;
}

export function simulationStatus(
  state: Pick<
    SimulationState,
    | "session"
    | "view"
    | "displayed"
    | "lastEnded"
    | "busy"
    | "viewBusy"
    | "frame"
  >,
  doc: { id: string; revision: string } | null,
  circuit: string | undefined,
): SimulationStatus {
  const { session, view, displayed, lastEnded, busy, frame } = state;
  const live = liveRun(state, doc, circuit);
  const current = Boolean(
    session &&
    doc &&
    session.documentId === doc.id &&
    session.revision === doc.revision &&
    (live || session.rootCircuit === circuit),
  );
  const clock = view?.clock;
  return {
    exists: Boolean(session),
    current,
    visible: Boolean(live && frame?.viewId === displayed?.viewId),
    running: Boolean(clock?.running),
    automatic: clock?.automatic !== false,
    ticks: clock?.ticks,
    frequency: session ? clock?.frequency : undefined,
    actualFrequency: clock?.actualFrequency || 0,
    circuit: session?.rootCircuit,
    stale: Boolean(
      !current &&
      doc &&
      lastEnded?.reasonCode === "revision-changed" &&
      lastEnded.documentId === doc.id,
    ),
    busy: Boolean(
      busy && doc && busy.documentId === doc.id && busy.circuit === circuit,
    ),
    busyAction: busy?.action || null,
    viewBusy: state.viewBusy,
  };
}
