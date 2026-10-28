/**
 * The interactive run as the checks drive it: requests to the run there is,
 * and its state as the window keeps it, folded from the page's `simulation`
 * events. Replies carry no run state; a frame with at least a command's
 * sequence shows its effect.
 */
import type { Command } from "../../apps/workbench/src/generated/Command.ts";
import type { ComponentState } from "../../apps/workbench/src/generated/ComponentState.ts";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import type { EndedInfo } from "../../apps/workbench/src/generated/EndedInfo.ts";
import type { FrameEvent } from "../../apps/workbench/src/generated/FrameEvent.ts";
import type { LiveComponent } from "../../apps/workbench/src/generated/LiveComponent.ts";
import type { MemoryPage } from "../../apps/workbench/src/generated/MemoryPage.ts";
import type { ObservationRecord } from "../../apps/workbench/src/generated/ObservationRecord.ts";
import type { ObservationSummary } from "../../apps/workbench/src/generated/ObservationSummary.ts";
import type { RunInfo } from "../../apps/workbench/src/generated/RunInfo.ts";
import type { SimulationEvent } from "../../apps/workbench/src/generated/SimulationEvent.ts";
import type { TraceDelta } from "../../apps/workbench/src/generated/TraceDelta.ts";
import {
  componentState,
  traced,
} from "../../apps/workbench/src/simulation/simulation.ts";

/** The checks' transport: a request to the host, its result returned as is. */
export type Transport = (request: Record<string, unknown>) => Promise<any>;
/** The page's event stream (`eventStream`). */
export interface Stream {
  events: any[];
  wait(predicate: (event: any) => boolean, from?: number): Promise<any>;
}
/** What the window keeps of the run after the events so far. */
export interface Mirror {
  run: RunInfo | null;
  ended: EndedInfo | null;
  /** The newest frame as it came: its header and what changed. */
  frame: FrameEvent | null;
  components: Record<string, LiveComponent>;
  trace: TraceDelta | null;
  memory: MemoryPage | null;
}

export const sameRun = (a: RunInfo | null, b: RunInfo | null) =>
  Boolean(
    a && b && a.documentId === b.documentId && a.startedAt === b.startedAt,
  );

export function simulationClient(command: Transport, stream: Stream) {
  const mirror: Mirror = {
    run: null,
    ended: null,
    frame: null,
    components: {},
    trace: null,
    memory: null,
  };
  const clear = () => ({
    frame: null,
    components: {},
    trace: null,
    memory: null,
  });
  let seen = 0;
  /** Lays the events not read yet over the mirror, as the window does. */
  const fold = () => {
    for (; seen < stream.events.length; seen++) {
      const { topic, data } = stream.events[seen];
      if (topic !== "simulation") continue;
      const event = data as SimulationEvent;
      if (event.kind === "run") {
        if (!sameRun(mirror.run, event.run))
          Object.assign(mirror, clear(), { run: event.run, ended: null });
      } else if (event.kind === "ended")
        Object.assign(mirror, clear(), { run: null, ended: event.ended });
      else if (mirror.run) {
        const { kind: _, ...frame } = event;
        if (frame.full) {
          mirror.components = { ...frame.components };
          mirror.trace = frame.trace ?? null;
          mirror.memory = frame.memory ?? null;
        } else {
          Object.assign(mirror.components, frame.components);
          if (frame.trace) mirror.trace = traced(mirror.trace, frame.trace);
          if (frame.memory) mirror.memory = frame.memory;
        }
        mirror.frame = frame;
      }
    }
    return mirror;
  };
  /** Waits for events until the mirror holds. */
  const until = async (holds: (mirror: Mirror) => boolean, what: string) => {
    while (!holds(fold()))
      await stream
        .wait((event) => event.topic === "simulation", seen)
        .catch(() => {
          throw new Error(`Timed out waiting for ${what}`);
        });
    return mirror;
  };
  /** Ends the current run and starts one; resolves once its first frame came. */
  const start = async (
    document: Document,
    circuit: string,
    frequency?: number,
  ): Promise<RunInfo> => {
    const run: RunInfo = await command({
      op: "simulationStart",
      documentId: document.id,
      revision: document.revision,
      circuit,
      ...(frequency === undefined ? {} : { frequency }),
    });
    await until(
      (m) => sameRun(m.run, run) && m.frame !== null,
      "the run's first frame",
    );
    return run;
  };
  /** Sends a command; returns its sequence. */
  const send = async (change: Command): Promise<number> =>
    (await command({ op: "simulationCommand", command: change }))
      .commandSequence;
  /** The mirror once a frame shows the command numbered `sequence`. */
  const settled = async (sequence: number) => {
    await until(
      (m) => !m.run || (m.frame?.commandSequence ?? -1) >= sequence,
      `a frame after command ${sequence}`,
    );
    if (!mirror.run)
      throw new Error(`The run ended: ${mirror.ended?.reasonCode}`);
    return mirror;
  };
  /** Sends a command and waits for the frame that shows it. */
  const act = async (change: Command) => settled(await send(change));
  /** Shows an instance of the run and waits for its first frame. */
  const navigate = async (instancePath: string[]) =>
    settled(
      (await command({ op: "simulationNavigate", instancePath }))
        .commandSequence,
    );
  const stop = (): Promise<{ stopped: boolean }> =>
    command({ op: "simulationStop" });
  /** Waits for the end of the run. */
  const ended = async () => (await until((m) => !m.run, "the run's end")).ended;
  /** Keeps the run's newest frame. */
  const keep = (title: string): Promise<ObservationRecord> =>
    command({ op: "observationCapture", title });
  /** The kept rows of a document, newest first. */
  const observations = (document: Document): Promise<ObservationSummary[]> =>
    command({ op: "observationList", id: document.id });
  /** One kept record, read under the document it was kept from. */
  const record = (
    document: Document,
    id: string,
    options: { componentIds?: string[]; offset?: number; limit?: number } = {},
  ): Promise<ObservationRecord> =>
    command({
      op: "observationGet",
      id: document.id,
      record: id,
      ...options,
    });
  /** One component of the shown instance in the newest frame. */
  const component = (id: string): ComponentState => {
    const live = fold().components[id];
    if (!live) throw new Error(`No component ${id} in the frame`);
    return componentState(id, live);
  };
  /** A port's value in the newest frame, most significant bit first. */
  const bits = (id: string, port = 0) => fold().components[id]?.ports[port];
  return {
    mirror: fold,
    until,
    start,
    send,
    settled,
    act,
    navigate,
    stop,
    ended,
    keep,
    observations,
    record,
    component,
    bits,
  };
}
