/**
 * The simulation requests the host accepts, as the checks issue them: one
 * definition target that starts or reuses the root run, and run targets for
 * everything the running view owns.
 */
import type { ActResult } from "../../apps/workbench/src/generated/ActResult.ts";
import type { Command } from "../../apps/workbench/src/generated/Command.ts";
import type { ComponentState } from "../../apps/workbench/src/generated/ComponentState.ts";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import type { ObservationRecord } from "../../apps/workbench/src/generated/ObservationRecord.ts";
import type { ObservationSummary } from "../../apps/workbench/src/generated/ObservationSummary.ts";
import type { Snapshot } from "../../apps/workbench/src/generated/Snapshot.ts";
import type { Status } from "../../apps/workbench/src/generated/Status.ts";

/** The checks' transport: a request to the host, its result returned as is. */
export type Transport = (request: Record<string, unknown>) => Promise<any>;
/** The run a document's circuit is shown in, as a request carries it. */
export interface Run {
  sessionId: string;
  viewId: string;
}
export interface View {
  viewId: string;
  circuit: string;
  instancePath: string[];
}

export function simulationClient(command: Transport) {
  const act = (
    document: Document,
    target: unknown,
    request: Command,
    initialFrequency?: number,
  ) =>
    command({
      op: "simulationAct",
      documentId: document.id,
      revision: document.revision,
      target,
      command: request,
      ...(initialFrequency === undefined ? {} : { initialFrequency }),
    }) as Promise<ActResult>;
  /** A command to a circuit definition: `start` starts or reuses its root run. */
  const definition = (
    document: Document,
    circuit: string,
    request: Command,
    initialFrequency?: number,
  ) =>
    act(document, { kind: "definition", circuit }, request, initialFrequency);
  /** A command to a view of a run. */
  const run = (document: Document, target: Run, request: Command) =>
    act(document, { kind: "run", ...target }, request);
  const started = async (
    document: Document,
    circuit: string,
    initialFrequency?: number,
  ): Promise<Run> => {
    const result = await definition(
      document,
      circuit,
      { kind: "start" },
      initialFrequency,
    );
    if (!result.sessionId || !result.viewId)
      throw new Error("simulationAct start returned no run");
    return { sessionId: result.sessionId, viewId: result.viewId };
  };
  const status = () => command({ op: "simulationStatus" }) as Promise<Status>;
  const navigate = (target: Run, instancePath: string[]) =>
    command({
      op: "simulationNavigate",
      sessionId: target.sessionId,
      instancePath,
    }) as Promise<View>;
  /** The current or a numbered frame, with memory and waveform on request. */
  const snapshot = (
    target: Run,
    options: {
      frameSequence?: number;
      componentIds?: string[];
      offset?: number;
      limit?: number;
      trace?: boolean;
      memory?: boolean;
    } = {},
  ) =>
    command({
      op: "simulationSnapshot",
      sessionId: target.sessionId,
      ...options,
    }) as Promise<Snapshot>;
  /** The newest frame, or a numbered one, with its waveform so far. */
  const traced = (target: Run, frameSequence?: number) =>
    command({
      op: "simulationSnapshot",
      sessionId: target.sessionId,
      trace: true,
      ...(frameSequence === undefined ? {} : { frameSequence }),
    }) as Promise<Snapshot>;
  /** Ends the run a target or a session id names. */
  const stop = (target: Run | string) =>
    command({
      op: "simulationStop",
      sessionId: typeof target === "string" ? target : target.sessionId,
    }) as Promise<{
      stopped: boolean;
    }>;
  /** Freezes the shown frame as a kept observation. */
  const keep = (target: Run, title: string, frameSequence?: number) =>
    command({
      op: "observationCapture",
      sessionId: target.sessionId,
      viewId: target.viewId,
      ...(frameSequence === undefined ? {} : { frameSequence }),
      title,
    }) as Promise<ObservationRecord>;
  /** The kept rows of a document, newest first. */
  const observations = (document: Document) =>
    command({
      op: "observationList",
      id: document.id,
    }) as Promise<ObservationSummary[]>;
  /** One kept record, read under the document it was kept from. */
  const record = (
    document: Document,
    id: string,
    options: { componentIds?: string[]; offset?: number; limit?: number } = {},
  ) =>
    command({
      op: "observationGet",
      id: document.id,
      record: id,
      ...options,
    }) as Promise<ObservationRecord>;
  /**
   * The frame after the command the acknowledgement numbered: frames reach the
   * host asynchronously, so a snapshot taken right after `act` may still show
   * the previous one. Status reports the acknowledged command, not the frame,
   * so the frame itself is checked.
   */
  const settled = async (
    target: Run,
    acknowledged: ActResult,
    options: {
      componentIds?: string[];
      trace?: boolean;
      memory?: boolean;
    } = {},
  ) => {
    const wanted = acknowledged.commandSequence ?? 0;
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = await snapshot(target, options);
      if (current.frame.commandSequence >= wanted) return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no frame after command ${wanted}`);
  };
  /** One component's state in the current frame. */
  const component = async (
    target: Run,
    id: string,
  ): Promise<ComponentState> => {
    const { frame } = await snapshot(target, { componentIds: [id], limit: 1 });
    const state = frame.components.find((c) => c.id === id);
    if (!state) throw new Error(`no component ${id} in the frame`);
    return state;
  };
  return {
    act,
    definition,
    run,
    started,
    status,
    navigate,
    snapshot,
    traced,
    stop,
    keep,
    observations,
    record,
    settled,
    component,
  };
}
