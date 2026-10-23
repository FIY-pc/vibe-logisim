/**
 * Editing tools. Each maps its arguments to host `Edit`s, applies them in
 * sequence on the live document (auto-saved, visible to the user at once)
 * and returns the edit result: new revision, what changed and the ids the
 * model can address next.
 */
import { CircuitToolError } from "./errors.mts";
import { fileWireId, portIndex, route } from "./wiring.mts";
import { resolveLibrary } from "./inspect.mts";
import type { ToolContext } from "./context.mts";
import type { Edit } from "../generated/Edit.ts";
import type { EditResult } from "../protocol/host.mts";

const outcome = (
  context: ToolContext,
  result: EditResult,
  extra: Record<string, unknown> = {},
) => ({
  ...context.identity(result.view, result.circuit),
  title: result.title,
  changedCircuits: result.changedCircuits,
  selection: result.selection,
  ...extra,
});

async function placements(
  context: ToolContext,
  document: { id: string; revision: string },
  circuit: string,
  components: any[],
): Promise<Edit[]> {
  const edits: Edit[] = [];
  for (const part of components) {
    const library = await resolveLibrary(
      context,
      document,
      circuit,
      part.factory,
      part.library,
    );
    edits.push({
      kind: "place",
      name: part.factory,
      library,
      location: part.location,
      attributes: part.attributes ?? {},
    });
  }
  return edits;
}

export async function placeComponent(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  const edits = await placements(
    context,
    document,
    circuit,
    args.components ?? [],
  );
  const { result, results } = await context.edit(document, circuit, edits);
  return outcome(context, result, {
    placed: results.flatMap((r) => r.selection.components),
    note: "已放置；每个元件现在可用 c<x>_<y> 寻址。",
  });
}

export async function setAttributes(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  const edits: Edit[] = (args.edits ?? []).map((e: any) => ({
    kind: "attributes",
    id: e.componentId,
    values: e.attributes,
  }));
  const { result } = await context.edit(document, circuit, edits);
  return outcome(context, result);
}

export async function connect(context: ToolContext, args: Record<string, any>) {
  const { document, circuit } = await context.target(args);
  const edits: Edit[] = [];
  if (args.removeWireIds?.length)
    edits.push({ kind: "delete", ids: args.removeWireIds.map(fileWireId) });
  if (args.additions?.length)
    edits.push(
      ...(await placements(context, document, circuit, args.additions)),
    );
  if (!edits.length && !args.connections?.length)
    throw new CircuitToolError("INVALID_ARGUMENT", "没有要执行的连线操作", {
      hint: "给出 connections、additions 或 removeWireIds。",
    });
  // Removals and placements land first so routing sees the real grid.
  let current = document;
  let last: EditResult | null = null;
  if (edits.length) {
    const applied = await context.edit(document, circuit, edits);
    current = applied.result.view;
    last = applied.result;
  }
  const wires: Edit[] = [];
  if (args.connections?.length) {
    const { view } = await context.observe(current, circuit);
    const ports = portIndex(view.circuit);
    for (const connection of args.connections) {
      const from = ports.get(
        `${connection.from.component}:${connection.from.port}`,
      );
      const to = ports.get(`${connection.to.component}:${connection.to.port}`);
      if (!from || !to)
        throw new CircuitToolError(
          "PORT_NOT_FOUND",
          "连接端点不在当前电路中；先检查端口编号。",
          {
            hint: "用 inspect_circuit 的 portConnections 或 componentIds 确认端口编号。",
            context: { from: connection.from, to: connection.to },
          },
        );
      const points = route(view.circuit, from, to);
      if (!points)
        throw new CircuitToolError(
          "NO_ROUTE",
          "两个端口之间没有找到可行的正交路径。",
          {
            hint: "先移动元件给出空间，或手工指定分段导线。",
            context: { from: connection.from, to: connection.to },
          },
        );
      if (points.length) {
        wires.push({ kind: "wire", points });
        // Later routes must avoid this one: mark it as an existing wire.
        for (let i = 1; i < points.length; i += 1)
          view.circuit.wires.push({
            id: `pending${i}`,
            from: points[i - 1],
            to: points[i],
          });
      }
    }
    if (wires.length)
      last = (await context.edit(current, circuit, wires)).result;
  }
  if (!last)
    throw new CircuitToolError("NO_CHANGE", "端口已经相连，没有新增导线", {
      hint: "用 inspect_circuit 的 portConnections 确认连通。",
    });
  return outcome(context, last, {
    wiresAdded: wires.length,
    note: "导线编号按文件顺序；增删导线后请重新读取。",
  });
}

export async function moveComponents(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  const edits: Edit[] = [];
  if (args.positions?.length) {
    const definition = document.circuits.find((c) => c.name === circuit)!;
    const byDelta = new Map<
      string,
      { ids: string[]; delta: { x: number; y: number } }
    >();
    for (const p of args.positions) {
      const part = definition.components.find((c) => c.id === p.componentId);
      if (!part)
        throw new CircuitToolError(
          "COMPONENT_NOT_FOUND",
          "元件不在当前电路中：" + p.componentId,
          {
            hint: "用 inspect_circuit 读取当前元件 id。",
          },
        );
      const delta = { x: p.x - part.location.x, y: p.y - part.location.y };
      if (!delta.x && !delta.y) continue;
      const key = `${delta.x},${delta.y}`;
      const group = byDelta.get(key) ?? { ids: [], delta };
      group.ids.push(p.componentId);
      byDelta.set(key, group);
    }
    for (const group of byDelta.values())
      edits.push({ kind: "move", ids: group.ids, delta: group.delta });
  } else if (args.componentIds?.length && args.delta) {
    edits.push({ kind: "move", ids: args.componentIds, delta: args.delta });
  } else
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "移动需要 positions，或者 componentIds 与 delta。",
    );
  if (!edits.length)
    throw new CircuitToolError("NO_CHANGE", "所有元件已经在目标位置", {
      hint: "无需移动。",
    });
  const { result } = await context.edit(document, circuit, edits);
  return outcome(context, result, {
    note: "元件 id 随位置改变：移到 (x,y) 的元件现在是 c<x>_<y>。",
  });
}

export async function deleteObjects(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  const ids = [
    ...(args.componentIds ?? []),
    ...(args.wireIds ?? []).map(fileWireId),
  ];
  if (!ids.length)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "请给出要删除的 componentIds 或 wireIds。",
    );
  const { result } = await context.edit(document, circuit, [
    { kind: "delete", ids },
  ]);
  return outcome(context, result);
}
