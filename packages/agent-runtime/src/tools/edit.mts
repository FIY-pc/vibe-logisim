/**
 * Editing tools. Each maps its arguments to host `Edit`s, applies them in
 * sequence on the live document (auto-saved, visible to the user at once)
 * and returns the edit result: new revision, what changed and the ids the
 * model can address next.
 */
import { CircuitToolError } from "./errors.mts";
import {
  fileWireId,
  netKey,
  portIndex,
  Router,
  type Point,
  type PortRef,
} from "./wiring.mts";
import { libraryResolver } from "./inspect.mts";
import type {
  Applied,
  DocumentRef,
  EditNotes,
  ToolContext,
} from "./context.mts";
import type { Edit } from "../generated/Edit.ts";
import type { EditResult } from "../protocol/host.mts";

/**
 * What one edit changed, said once: the new revision, the history title, the
 * ids the model can address next (the components and wires the edit placed or
 * left selected, and the ones it took away), and the host's notes about it
 * (width conflicts per circuit, a failed save, a history entry that could not
 * be written).
 */
const outcome = (
  context: ToolContext,
  applied: Applied,
  extra: Record<string, unknown> = {},
) => {
  const { result, results, change } = applied;
  return {
    ...context.identity(change, result.circuit),
    title: result.title,
    changedCircuits: result.changedCircuits,
    ...(result.noop ? { noop: true } : {}),
    ids: {
      components: [...new Set(results.flatMap((r) => r.selection.components))],
      wires: [...new Set(results.flatMap((r) => r.selection.wires))],
    },
    ...(change.widthErrors && Object.keys(change.widthErrors).length
      ? { widthErrors: change.widthErrors }
      : {}),
    ...(result.unconnected?.length ? { unconnected: result.unconnected } : {}),
    ...notes(result),
    ...extra,
  };
};

const notes = (result: EditResult & EditNotes) => ({
  ...(result.saveError ? { saveError: result.saveError } : {}),
  ...(result.historyWarning ? { historyWarning: result.historyWarning } : {}),
  ...(result.referenceWarning
    ? { referenceWarning: result.referenceWarning }
    : {}),
});

async function placements(
  context: ToolContext,
  document: DocumentRef,
  circuit: string,
  components: any[],
): Promise<Edit[]> {
  const edits: Edit[] = [];
  const resolve = libraryResolver(context, document, circuit);
  for (const part of components) {
    const library = await resolve(part.factory, part.library);
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
  return outcome(context, await context.edit(document, circuit, edits));
}

export async function setAttributes(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  // One edit per part: the host checks each against the revision it was
  // sent for, so two edits of one part in a batch would undo each other.
  const values = new Map<string, Record<string, string>>();
  for (const e of args.edits ?? [])
    values.set(e.componentId, { ...values.get(e.componentId), ...e.attributes });
  const edits: Edit[] = [...values].map(([id, attributes]) => ({
    kind: "attributes",
    id,
    values: attributes,
  }));
  return outcome(context, await context.edit(document, circuit, edits));
}

const portName = (p: { component: string; port: number }) =>
  `${p.component} 端口 ${p.port}`;

export async function connect(context: ToolContext, args: Record<string, any>) {
  const { document, circuit } = await context.target(args);
  const prelude: Edit[] = [];
  if (args.removeWireIds?.length)
    prelude.push({ kind: "delete", ids: args.removeWireIds.map(fileWireId) });
  if (args.additions?.length)
    prelude.push(
      ...(await placements(context, document, circuit, args.additions)),
    );
  const connections: any[] = args.connections ?? [];
  const drawn: Point[][] = (args.wires ?? []).map((w: any) => w.points);
  if (!prelude.length && !connections.length && !drawn.length)
    throw new CircuitToolError("INVALID_ARGUMENT", "没有要执行的连线操作", {
      hint: "给出 connections、wires、additions 或 removeWireIds。",
    });
  // Removals and placements land first so routing sees the real grid.
  let current: DocumentRef = document;
  let last: EditResult | null = null;
  let first: Applied | null = null;
  if (prelude.length) {
    const applied = await context.edit(document, circuit, prelude);
    first = applied;
    current = applied.change;
    last = applied.result;
  }
  const paths: Point[][] = [...drawn];
  const joined: { from: PortRef; to: PortRef }[] = [];
  const already: number[] = [];
  let before: Map<string, string | null> | null = null;
  if (connections.length) {
    const { view } = await context.observe(current, circuit);
    const ports = portIndex(view.circuit);
    before = netsOf(ports);
    const router = new Router(view.circuit);
    for (const wire of drawn) router.commit(wire);
    for (const [i, connection] of connections.entries()) {
      const from = ports.get(
        `${connection.from.component}:${connection.from.port}`,
      );
      const to = ports.get(`${connection.to.component}:${connection.to.port}`);
      if (!from || !to) {
        const missing = !from ? connection.from : connection.to;
        const part = view.circuit.components.find(
          (c) => c.componentId === missing.component,
        );
        throw new CircuitToolError(
          "PORT_NOT_FOUND",
          part
            ? `第 ${i + 1} 条连接：${missing.component} 没有端口 ${missing.port}（它有 ${part.ends.length} 个端口，编号 0–${part.ends.length - 1}）。`
            : `第 ${i + 1} 条连接：电路里没有元件 ${missing.component}。`,
          {
            hint: "端口编号来自 inspect_circuit 的 componentIds 或 describe_component；元件移动后 id 会变。",
            context: { connection: i, from: connection.from, to: connection.to },
          },
        );
      }
      if (from.end.width && to.end.width && from.end.width !== to.end.width)
        throw new CircuitToolError(
          "WIDTH_MISMATCH",
          `第 ${i + 1} 条连接：${portName(connection.from)} 是 ${from.end.width} 位，${portName(connection.to)} 是 ${to.end.width} 位，不能直接相连。`,
          {
            hint: "先用 set_attributes 统一位宽，或经 Splitter 拆分/合并。",
            context: { connection: i, from: connection.from, to: connection.to },
          },
        );
      if (router.joined(from, to)) {
        already.push(i);
        continue;
      }
      const points = router.route(from, to);
      if (!points)
        throw new CircuitToolError(
          "NO_ROUTE",
          `第 ${i + 1} 条连接：${portName(connection.from)} 到 ${portName(connection.to)} 之间找不到不碰其他元件和导线的正交路径。`,
          {
            hint: "移动元件留出通道，或用 wires 直接给出这段导线的拐点。前面的连接都还没有画。",
            context: { connection: i, from: connection.from, to: connection.to },
          },
        );
      router.commit(points);
      paths.push(points);
      joined.push({ from, to });
    }
  }
  if (paths.length) {
    const applied = await context.edit(
      current,
      circuit,
      paths.map((points) => ({ kind: "wire", points }) as Edit),
    );
    last = applied.result;
    first = first
      ? {
          result: applied.result,
          results: [...first.results, ...applied.results],
          change: applied.change,
        }
      : applied;
    if (before && joined.length) await checkJoins(context, applied, circuit, before, joined);
  }
  const notes = already.length
    ? [`第 ${already.map((i) => i + 1).join("、")} 条连接的两个端口本来就相连，没有画线。`]
    : [];
  if (!last || !first)
    return {
      ...context.identity(current, circuit),
      wiresAdded: 0,
      alreadyConnected: already.length,
      note: notes[0],
    };
  return outcome(context, first, {
    ...(args.removeWireIds?.length
      ? { removed: { [circuit]: args.removeWireIds.map(fileWireId) } }
      : {}),
    wiresAdded: paths.length,
    ...(already.length ? { alreadyConnected: already.length, note: notes[0] } : {}),
  });
}

/** Each port's net, `componentId:port` → bit-net key. */
function netsOf(ports: Map<string, PortRef>) {
  return new Map(
    [...ports].map(([key, port]) => [key, netKey(port.end.netBits)]),
  );
}

/**
 * The drawn wires must join exactly the requested nets: every requested pair
 * shares a net afterwards, and no two nets merged that no request linked.
 * Otherwise the wires are taken back and the call fails with the first
 * unexpected merge.
 */
async function checkJoins(
  context: ToolContext,
  applied: Applied,
  circuit: string,
  before: Map<string, string | null>,
  joined: { from: PortRef; to: PortRef }[],
) {
  const observed = await context.observe(applied.change, circuit);
  const after = netsOf(portIndex(observed.view.circuit));
  // Nets the requests link, as union-find over the nets before.
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    const p = parent.get(n) ?? n;
    if (p === n) return n;
    const root = find(p);
    parent.set(n, root);
    return root;
  };
  for (const { from, to } of joined) {
    const a = netKey(from.end.netBits),
      b = netKey(to.end.netBits);
    if (a && b) parent.set(find(a), find(b));
  }
  const port = (key: string) => key.replace(/:(\d+)$/, " 端口 $1");
  let problem: string | null = null;
  for (const { from, to } of joined) {
    const a = after.get(`${from.c.componentId}:${from.end.index}`);
    const b = after.get(`${to.c.componentId}:${to.end.index}`);
    if (!a || a !== b) {
      problem = `${port(`${from.c.componentId}:${from.end.index}`)} 和 ${port(`${to.c.componentId}:${to.end.index}`)} 画线后仍未相连`;
      break;
    }
  }
  if (!problem) {
    // The first port met on each net after the edit, with its net before.
    const first = new Map<string, [string, string]>();
    for (const [key, net] of after) {
      const was = before.get(key);
      if (!net || !was) continue;
      const seen = first.get(net);
      if (!seen) first.set(net, [key, was]);
      else if (find(seen[1]) !== find(was)) {
        problem = `新导线把原本不相连的 ${port(seen[0])} 和 ${port(key)} 接到了一起`;
        break;
      }
    }
  }
  if (!problem) return;
  // Take the wires of this call back (one batch, or a single wire).
  await context.send(
    applied.change,
    applied.results.map(() => (revision) => ({
      op: "undo",
      id: applied.change.id,
      revision,
    })),
  );
  throw new CircuitToolError(
    "ROUTE_CHANGED_NETS",
    `自动布线出错：${problem}。这次的导线已撤回。`,
    {
      hint: "用 wires 直接给出这段导线的拐点，或移动元件后重试。",
    },
  );
}

/** A component id's anchor: `c<x>_<y>`, `m` for a negative coordinate, `_<n>` for a stacked copy. */
function anchorOf(id: string) {
  const match = /^c(m?)(\d+)_(m?)(\d+)(?:_\d+)?$/.exec(id);
  if (!match)
    throw new CircuitToolError("COMPONENT_NOT_FOUND", "不是元件 id：" + id, {
      hint: "元件 id 形如 c1300_540。",
    });
  const [, xs, x, ys, y] = match;
  return { x: (xs ? -1 : 1) * Number(x), y: (ys ? -1 : 1) * Number(y) };
}

export async function moveComponents(
  context: ToolContext,
  args: Record<string, any>,
) {
  const edits: Edit[] = [];
  if (args.positions?.length) {
    const { document, circuit } = await context.target(args);
    const byDelta = new Map<
      string,
      { ids: string[]; delta: { x: number; y: number } }
    >();
    for (const p of args.positions) {
      const anchor = anchorOf(p.componentId);
      const delta = { x: p.x - anchor.x, y: p.y - anchor.y };
      if (!delta.x && !delta.y) continue;
      const key = `${delta.x},${delta.y}`;
      const group = byDelta.get(key) ?? { ids: [], delta };
      group.ids.push(p.componentId);
      byDelta.set(key, group);
    }
    for (const group of byDelta.values())
      edits.push({ kind: "move", ids: group.ids, delta: group.delta });
    if (!edits.length)
      throw new CircuitToolError("NO_CHANGE", "所有元件已经在目标位置", {
        hint: "无需移动。",
      });
    return outcome(context, await context.edit(document, circuit, edits), {
      note: "元件 id 随位置改变：移到 (x,y) 的元件现在是 c<x>_<y>。",
    });
  }
  const { document, circuit } = await context.target(args);
  if (!args.componentIds?.length || !args.delta)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "移动需要 positions，或者 componentIds 与 delta。",
    );
  edits.push({ kind: "move", ids: args.componentIds, delta: args.delta });
  return outcome(context, await context.edit(document, circuit, edits), {
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
  return outcome(
    context,
    await context.edit(document, circuit, [{ kind: "delete", ids }]),
    { removed: { [circuit]: ids } },
  );
}
