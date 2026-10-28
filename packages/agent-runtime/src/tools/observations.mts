/**
 * read_observation: the frames the user kept from live simulation, listed
 * or read one at a time. Historical data about one instance and moment;
 * never a new execution.
 */
import { CircuitToolError } from "./errors.mts";
import type { ToolContext } from "./context.mts";
import type { ObservationSummary } from "../generated/ObservationSummary.ts";
import type { ObservationRecord } from "../generated/ObservationRecord.ts";

export async function readObservation(
  context: ToolContext,
  args: Record<string, any>,
) {
  const document = await context.resolveDocument(args.path);
  const rows = await context.host.call<ObservationSummary[]>({
    op: "observationList",
    id: document.id,
  });
  if (!args.observationId)
    return {
      documentId: document.id,
      observations: rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        rootCircuit: r.rootCircuit,
        instancePath: r.instancePath,
        circuit: r.circuit,
        ticks: r.ticks,
        signalCount: r.signalCount,
        ...(r.damaged ? { damaged: r.damaged } : {}),
      })),
      note: "这些是用户从实时仿真留存的瞬间；用 observationId 读取其中一条。",
    };
  const row = rows.find((r) => r.id === args.observationId);
  if (!row)
    throw new CircuitToolError(
      "OBSERVATION_NOT_FOUND",
      "没有这条留存观察：" + args.observationId,
      {
        hint: "先不带 observationId 调用，查看可读的观察列表。",
      },
    );
  if (row.damaged)
    throw new CircuitToolError(
      "OBSERVATION_DAMAGED",
      "这条观察已损坏，无法读取：" + row.damaged,
    );
  const record = await context.host.call<ObservationRecord>({
    op: "observationGet",
    id: document.id,
    record: args.observationId,
    componentIds: args.componentIds,
    offset: args.offset,
    limit: args.limit,
  });
  const { frame, ...rest } = record;
  return {
    ...rest,
    state: {
      circuit: frame.circuit,
      instancePath: frame.instancePath,
      clock: frame.clock,
      components: frame.components,
      ...(frame.memory ? { memory: frame.memory } : {}),
    },
    historical: true,
    note: "这是用户看到的冻结瞬间，描述这一实例、这一刻；新的 trace 是另起的执行。",
  };
}
