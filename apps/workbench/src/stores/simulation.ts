import { createStore } from "zustand/vanilla";
import type { ObservationRecord } from "../generated/ObservationRecord";
import type { Simulation } from "../lib/types";
import { createCounter, type Counter } from "./counter";
import { field, type Update } from "./setter";

/** A simulation action waiting in the queue, by the view scope it was requested in. */
export interface SimulationRequest {
  id: number;
  scope: string;
  op: string;
}
/** The memory component whose panel is open, by name and location. */
export interface MemoryTarget {
  documentId: string;
  circuit: string;
  name: string;
  x: number;
  y: number;
}

/** The queued action requested in the view `scope`, if any. */
export const pendingOperation = (
  { requests }: SimulationState,
  scope: string,
) => requests.find((request) => request.scope === scope)?.op || null;

export interface SimulationState {
  /** The host's simulation session, whichever document and circuit it runs. */
  sim: Simulation | null;
  /** The clock frequency a new simulation starts with. */
  frequency: number;
  requests: SimulationRequest[];
  memory: MemoryTarget | null;
  /** The open observation records dialog. */
  observations: { documentId: string; initial?: string } | null;
  /** The last captured observation, offered in a notice. */
  lastCapture: ObservationRecord | null;
  /** Numbers the queued actions. */
  sequence: Counter;
  /** The tail of the action queue: actions run one at a time, in request order. */
  queue: { current: Promise<unknown> };
  setSim(sim: Update<Simulation | null>): void;
  setFrequency(frequency: Update<number>): void;
  setRequests(requests: Update<SimulationRequest[]>): void;
  setMemory(memory: Update<MemoryTarget | null>): void;
  setObservations(observations: Update<SimulationState["observations"]>): void;
  setLastCapture(record: Update<ObservationRecord | null>): void;
}

export function createSimulationStore() {
  return createStore<SimulationState>()((set) => ({
    sim: null,
    frequency: 2,
    requests: [],
    memory: null,
    observations: null,
    lastCapture: null,
    sequence: createCounter(),
    queue: { current: Promise.resolve() },
    setSim: field(set, "sim"),
    setFrequency: field(set, "frequency"),
    setRequests: field(set, "requests"),
    setMemory: field(set, "memory"),
    setObservations: field(set, "observations"),
    setLastCapture: field(set, "lastCapture"),
  }));
}
