/**
 * The circuit tools the model calls: bounded inspection of the working copy,
 * candidate edits that stay in review until the user applies them, and
 * verification of the exact text under review.
 */
import { readFile } from "node:fs/promises";
import { CircuitToolError } from "./errors.mts";
import {
  componentDirectory,
  componentDetails,
  inspectView,
  observationView,
  portConnections,
  wireGeometry,
} from "./observation.mts";
import type { ToolContext, ToolHandler } from "./plugin.mts";
import { artifactSha256, candidateId } from "./turn.mts";

const sha = (xml: string) => artifactSha256(xml);

/** The working copy as this call sees it, with the hash the model was given. */
async function target(context: ToolContext, args: Record<string, any>) {
  const copy = await context.turn.workingCopy();
  if (args.artifactSha256 && args.artifactSha256 !== sha(copy.xml))
    throw new CircuitToolError(
      "STALE_ARTIFACT",
      "电路内容已在本次检查之后改变，请重新检查再修改。",
      {
        retryable: true,
        hint: "用 inspect_circuit 重新读取 artifactSha256，再按当前内容修改。",
        context: {
          expected: args.artifactSha256,
          actual: sha(copy.xml),
        },
      },
    );
  const circuit =
    args.circuit ||
    context.session.canvas?.circuit ||
    context.session.activeCircuit ||
    context.session.project?.mainCircuit ||
    null;
  if (!circuit)
    throw new CircuitToolError("NO_CIRCUIT_OPEN", "当前文件没有电路定义", {
      hint: "用 open_circuit 选择要工作的电路。",
    });
  if (!context.session.project.circuits.includes(circuit))
    throw new CircuitToolError(
      "CIRCUIT_NOT_FOUND",
      "电路定义不存在：" + circuit,
      {
        hint: "可用的定义：" + context.session.project.circuits.join("、"),
        context: { availableCircuits: context.session.project.circuits },
      },
    );
  return { copy, circuit };
}

async function observe(context: ToolContext, circuit: string) {
  const copy = await context.turn.workingCopy();
  const document = await context.turn.call({
    op: "draftObserve",
    id: copy.id,
    revision: copy.revision,
    xml: copy.xml,
    circuit,
  });
  return { copy, view: observationView(document), document };
}

/** Identity every inspection result carries, so later edits can be checked. */
const identityFor = (
  context: ToolContext,
  circuit: string,
  copy: { revision: string; xml: string },
  candidate: string | null,
) => ({
  projectId: context.session.documentId,
  revisionId: copy.revision,
  candidateId: candidate,
  artifactSha256: sha(copy.xml),
  circuit,
});

const inspection: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  const { view } = await observe(context, circuit);
  return inspectView(
    view,
    identityFor(context, circuit, copy, candidateId(copy.xml)),
    args,
  );
};

const render: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  const result = await context.turn.call({
    op: "draftRender",
    id: copy.id,
    revision: copy.revision,
    xml: copy.xml,
    circuit,
    ...(args.viewport ? { viewport: args.viewport } : {}),
  });
  if (!result.image)
    throw new CircuitToolError(
      "RENDER_FAILED",
      "电路无法生成图像：" + circuit,
      { hint: "先确认定义名；电路为空时先放置元件。", retryable: true },
    );
  return {
    circuit,
    artifactSha256: sha(copy.xml),
    candidateId: candidateId(copy.xml),
    viewport: result.viewport,
    note: "图像按当前内容生成；改动后需要重新查看。",
    modelContentItems: [
      {
        type: "inputImage",
        mimeType: "image/png",
        imageData: result.image.split(",")[1],
      },
    ],
  };
};

const describe: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  const result = await context.turn.call({
    op: "draftTemplate",
    id: copy.id,
    revision: copy.revision,
    circuit,
    library: args.library ?? null,
    name: args.tool,
    attributes: args.attributes ?? {},
  });
  const attributes = componentAttributes(result);
  return {
    circuit,
    tool: args.tool,
    library: args.library ?? null,
    attributes,
    note:
      "这些是原生运行时给出的默认值和可选值；放入电路时只需要写出要改的属性，其余按默认值补全。",
  };
};

/** `<comp>` children from a native serialized component. */
function componentAttributes(reply: any): Record<string, any> {
  const component = (reply?.children || []).find((n: any) => n.tag === "comp");
  if (!component) return {};
  const attributes: Record<string, any> = {};
  for (const node of component.children || []) {
    const name = node.attributes?.name;
    if (!name) continue;
    attributes[name] = {
      value: node.attributes?.val ?? node.text ?? "",
      ...(node.children?.length
        ? {
            options: node.children
              .filter((o: any) => o.attributes?.name || o.text)
              .map((o: any) => o.attributes?.name ?? o.text),
          }
        : {}),
    };
  }
  return attributes;
}

/** Apply drafted edits and leave the result as the new working copy. */
async function commit(
  context: ToolContext,
  args: Record<string, any>,
  circuit: string,
  copy: { id: string; revision: string; xml: string; original: string },
  edits: any[],
  title: string,
) {
  if (!edits.length)
    throw new CircuitToolError("INVALID_ARGUMENT", "没有可应用的修改", {
      hint: "请给出至少一个修改。",
    });
  const result = await context.turn.call({
    op: "draftEdit",
    id: copy.id,
    revision: copy.revision,
    xml: copy.xml,
    circuit,
    edits,
  });
  if (result.xml === copy.xml)
    throw new CircuitToolError(
      "NO_CHANGE",
      "修改没有改变任何内容，候选未生成。",
      {
        hint: "确认元件 id、属性和位置来自同一次检查的当前内容。",
      },
    );
  const written = await context.turn.writeWorkingCopy(result.xml);
  context.turn.setTitle(title);
  return {
    circuit,
    title,
    ...written,
    target: "working-copy",
    changeCount: edits.length,
    note:
      "改动已写入工作副本，形成候选；用户审阅并应用之前，打开的文件不变。继续用这个 candidateId 检查、渲染或验证，也可以用 checkout_candidate 让候选进入打开的文件。",
  };
}

const editCandidate: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  const edits = args.edits.map((edit: any) => ({
    kind: "attributes",
    id: edit.componentId,
    values: edit.attributes,
  }));
  return commit(
    context,
    args,
    circuit,
    copy,
    edits,
    args.title || "修改元件属性",
  );
};

/**
 * Connect ports with orthogonal wires. A small grid search prefers short
 * routes with few bends and keeps off component bodies and other wires; the
 * result is checked by re-observing the draft, so a wrong connection is
 * reported instead of silently kept.
 */
const wireCandidate: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  const { view } = await observe(context, circuit);
  const edits: any[] = [];
  const removed = args.removeWireIds || [];
  if (removed.length) {
    const ids = removed.map((id: string) => fileWireId(id));
    edits.push({ kind: "delete", ids });
  }
  for (const addition of args.additions || [])
    edits.push({
      kind: "place",
      name: addition.factory,
      library: addition.library || null,
      location: addition.location,
      attributes: addition.attributes || {},
    });
  const ports = new Map<string, any>();
  for (const c of view.circuit.components)
    for (const end of c.ends) ports.set(`${c.componentId}:${end.index}`, { c, end });
  for (const connection of args.connections || []) {
    const from = ports.get(`${connection.from.component}:${connection.from.port}`);
    const to = ports.get(`${connection.to.component}:${connection.to.port}`);
    if (!from || !to)
      throw new CircuitToolError(
        "PORT_NOT_FOUND",
        "连接端点不在当前电路中；先检查端口编号。",
        {
          context: { from: connection.from, to: connection.to },
          hint: "用 inspect_circuit 的 portConnections 或 componentIds 确认端口编号。",
        },
      );
    const points = route(view, from, to);
    if (!points)
      throw new CircuitToolError(
        "NO_ROUTE",
        "两个端口之间没有找到可行的正交路径。",
        {
          hint: "先移动元件给出空间，或手工指定分段导线。",
        },
      );
    edits.push({ kind: "wire", points });
  }
  if (!edits.length)
    throw new CircuitToolError("INVALID_ARGUMENT", "没有要执行的连线操作", {
      hint: "给出 connections、additions 或 removeWireIds。",
    });
  return commit(
    context,
    args,
    circuit,
    copy,
    edits,
    args.title || "改动连线",
  );
};

/** `w3` on a loaded segment, translated to file-order line ids. */
function fileWireId(id: string) {
  const match = /^w(\d+)$/.exec(id);
  if (!match) throw new CircuitToolError("INVALID_ARGUMENT", "无效的导线编号：" + id);
  const index = Number(match[1]);
  if (index >= 512)
    throw new CircuitToolError("INVALID_ARGUMENT", "导线编号超出范围：" + id);
  return `w${index}`;
}

const GRID = 10;
const key = (x: number, y: number) => `${x},${y}`;

function route(view: any, from: any, to: any) {
  const start = { x: from.end.location.x, y: from.end.location.y };
  const goal = { x: to.end.location.x, y: to.end.location.y };
  if (start.x === goal.x && start.y === goal.y) return [];
  const blocked = new Set<string>();
  for (const component of view.circuit.components) {
    const b = component.bounds;
    if (!b || component.factory === "Tunnel") continue;
    for (let x = Math.ceil(b.x / GRID) * GRID; x < b.x + b.width; x += GRID)
      for (let y = Math.ceil(b.y / GRID) * GRID; y < b.y + b.height; y += GRID)
        blocked.add(key(x, y));
  }
  for (const wire of view.circuit.wires) {
    const steps = Math.max(
      Math.abs(wire.to.x - wire.from.x),
      Math.abs(wire.to.y - wire.from.y),
    ) / GRID;
    for (let i = 0; i <= steps; i += 1)
      blocked.add(
        key(
          wire.from.x + ((wire.to.x - wire.from.x) / steps) * i,
          wire.from.y + ((wire.to.y - wire.from.y) / steps) * i,
        ),
      );
  }
  blocked.delete(key(start.x, start.y));
  blocked.delete(key(goal.x, goal.y));
  const bounds = view.circuit.bounds;
  const minX = Math.floor((bounds.x - 200) / GRID) * GRID;
  const minY = Math.floor((bounds.y - 200) / GRID) * GRID;
  const maxX = Math.ceil((bounds.x + bounds.width + 200) / GRID) * GRID;
  const maxY = Math.ceil((bounds.y + bounds.height + 200) / GRID) * GRID;
  const inside = (x: number, y: number) =>
    x >= minX && x <= maxX && y >= minY && y <= maxY;
  type Node = { x: number; y: number; horizontal: boolean | null };
  const queue: { node: Node; path: Node[] }[] = [
    { node: { x: start.x, y: start.y, horizontal: null }, path: [] },
  ];
  const seen = new Set<string>([key(start.x, start.y) + ":n"]);
  const limit = 60000;
  for (let visited = 0; queue.length && visited < limit; visited += 1) {
    const { node, path } = queue.shift()!;
    for (const [dx, dy] of [
      [GRID, 0],
      [-GRID, 0],
      [0, GRID],
      [0, -GRID],
    ]) {
      const x = node.x + dx;
      const y = node.y + dy;
      if (!inside(x, y)) continue;
      const horizontal = dx !== 0;
      const finish = x === goal.x && y === goal.y;
      if (!finish && blocked.has(key(x, y))) continue;
      const state = key(x, y) + (horizontal ? ":h" : ":v");
      if (seen.has(state)) continue;
      seen.add(state);
      const turned = node.horizontal !== null && node.horizontal !== horizontal;
      const next = [...path, { x, y, horizontal }];
      if (finish) return pointsOf(start, next);
      // Bends first: the queue is a cheap ordered search, not Dijkstra.
      if (turned) queue.push({ node: { x, y, horizontal }, path: next });
      else queue.unshift({ node: { x, y, horizontal }, path: next });
    }
  }
  return null;
}

/** Collapse a grid path into straight wire segments. */
function pointsOf(start: { x: number; y: number }, path: any[]) {
  const points = [{ x: start.x, y: start.y }];
  for (let i = 1; i < path.length; i += 1) {
    const previous = path[i - 1];
    const current = path[i];
    const next = path[i + 1];
    const turn =
      next &&
      (previous.x === current.x) !== (next.x === current.x);
    if (turn) points.push({ x: current.x, y: current.y });
  }
  points.push({ x: path[path.length - 1].x, y: path[path.length - 1].y });
  return points;
}

const moveCandidate: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  const { view } = await observe(context, circuit);
  const edits: any[] = [];
  if (args.positions?.length) {
    const groups = new Map<string, string[]>();
    for (const position of args.positions) {
      const component = view.circuit.components.find(
        (c: any) => c.componentId === position.componentId,
      );
      if (!component)
        throw new CircuitToolError(
          "COMPONENT_NOT_FOUND",
          "元件不在当前电路中：" + position.componentId,
          { hint: "用 inspect_circuit 读取当前元件 id。" },
        );
      const delta = {
        x: position.x - component.location.x,
        y: position.y - component.location.y,
      };
      if (!delta.x && !delta.y) continue;
      const k = `${delta.x},${delta.y}`;
      groups.set(k, [...(groups.get(k) || []), position.componentId]);
    }
    for (const [k, ids] of groups) {
      const [x, y] = k.split(",").map(Number);
      edits.push({ kind: "move", ids, delta: { x, y } });
    }
  } else if (args.componentIds?.length && args.delta) {
    edits.push({
      kind: "move",
      ids: args.componentIds,
      delta: args.delta,
    });
  } else {
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "移动需要 positions，或者 componentIds 与 delta。",
    );
  }
  return commit(
    context,
    args,
    circuit,
    copy,
    edits,
    args.title || "移动元件",
  );
};

const reroute: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  return commit(
    context,
    args,
    circuit,
    copy,
    [{ kind: "delete", ids: args.wireIds.map(fileWireId) }],
    args.title || "重画导线",
  );
};

const simulate: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  let vectors = args.vectors;
  if (!vectors?.length && args.vectorsFile) {
    const folder = await context.turn.call({ op: "status" });
    const root = folder.folder?.path;
    if (!root)
      throw new CircuitToolError(
        "NO_PROJECT",
        "当前电路没有所属工程文件夹，无法读取测试向量文件。",
        { hint: "直接给出 vectors。" },
      );
    const file = context.turn.resolveFile(args.vectorsFile);
    const text = await readFile(`${root}/${file}`, "utf8");
    vectors = JSON.parse(text);
  }
  if (!vectors?.length)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "simulate_circuit 需要 vectors。",
      { hint: "给出 [{inputs:{…}, expected:{…}}] 形式的测试向量。" },
    );
  return context.turn.call({
    op: "draftSimulate",
    id: copy.id,
    revision: copy.revision,
    xml: copy.xml,
    circuit,
    vectors,
  });
};

/** Expand the model's clock descriptions into per-tick input events. */
function stimulus(args: Record<string, any>) {
  const ticks = args.ticks ?? 1;
  const events: any[] = [];
  const clocks = args.inputClocks || [];
  const names = new Set<string>();
  for (const clock of clocks) {
    if (names.has(clock.name) || args.inputEvents?.some((e: any) => e.name === clock.name))
      throw new CircuitToolError(
        "INVALID_ARGUMENT",
        "时钟与输入事件不能同时驱动同一个引脚：" + clock.name,
      );
    names.add(clock.name);
    const high = clock.highTicks ?? 1;
    const low = clock.lowTicks ?? 1;
    const first = clock.firstTick ?? 1;
    const last = clock.lastTick ?? ticks;
    let value = args.inputs?.[clock.name] ?? 0;
    for (let tick = first; tick <= ticks; tick += 1) {
      if (tick > last) break;
      if (tick > first) {
        const phase = (tick - first) % (high + low);
        value = phase < high ? 1 : 0;
      }
      events.push({ tick, name: clock.name, value });
    }
  }
  for (const event of args.inputEvents || [])
    events.push({ tick: event.tick, name: event.name, value: event.value });
  events.sort((a, b) => a.tick - b.tick);
  return events;
}

const trace: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  if (!args.watches?.length)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "trace_circuit 需要 watches。",
      { hint: "给出要观察的元件 id 和端口编号。" },
    );
  const result = await context.turn.call({
    op: "draftTrace",
    id: copy.id,
    revision: copy.revision,
    xml: copy.xml,
    circuit,
    ticks: args.ticks ?? 1,
    inputs: args.inputs ?? {},
    events: stimulus(args),
    buttons: args.buttonEvents ?? [],
    reset: args.resetButton ?? null,
    program: args.program ?? null,
    watches: args.watches.map((w: any) => ({
      component: w.component,
      port: w.port,
      name: w.name ?? `${w.component}:${w.port}`,
    })),
  });
  return boundedRows(result, args.rowStart ?? 0, args.rowLimit ?? 64);
};

/** Long traces are cut down to the rows that explain the outcome. */
function boundedRows(result: any, rowStart: number, rowLimit: number) {
  const samples = result.samples || [];
  if (samples.length <= rowLimit && rowStart === 0) return result;
  const rows = samples.slice(rowStart, rowStart + rowLimit);
  return {
    ...result,
    samples: rows,
    rowCount: samples.length,
    rowStart,
    rowsTruncated: rowStart > 0 || rowStart + rows.length < samples.length,
  };
}

const evaluate: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  const mode = args.mode === "vectors" ? "vectors" : "trace";
  if (mode === "vectors")
    return simulate({ ...args, vectors: args.vectors }, context);
  const result: any = await trace(
    { ...args, watches: args.watches || [] },
    context,
  );
  const expected = args.expectedRows || [];
  const samples = result.samples || [];
  const rows = samples.map((sample: any, index: number) => {
    const want = expected[index]?.signals || {};
    const matched = Object.entries(want).every(
      ([name, value]) => sample.signals?.[name]?.value === value,
    );
    return { ...sample, expected: want, status: matched ? "passed" : "failed" };
  });
  return {
    ...result,
    samples: rows,
    passed: rows.filter((r: any) => r.status === "passed").length,
    failed: rows.filter((r: any) => r.status === "failed").length,
  };
};

const compare: ToolHandler = async (args, context) => {
  if (!args.referenceRevisionId)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "compare_circuit 需要 referenceRevisionId。",
      { hint: "给出要与当前内容比较的历史版本标识。" },
    );
  const { copy, circuit } = await target(context, args);
  const reference = await context.turn.call({
    op: "source",
    id: copy.id,
    revision: args.referenceRevisionId,
  });
  const result = await context.turn.call({
    op: "draftTrace",
    id: copy.id,
    revision: copy.revision,
    xml: copy.xml,
    circuit,
    ticks: args.ticks ?? 1,
    inputs: args.inputs ?? {},
    events: stimulus(args),
    buttons: args.buttonEvents ?? [],
    reset: args.resetButton ?? null,
    program: args.program ?? null,
    watches: (args.watches || []).map((w: any) => ({
      component: w.component,
      port: w.port,
      name: w.name ?? `${w.component}:${w.port}`,
    })),
  });
  const document = await context.turn.call({
    op: "draftObserve",
    id: copy.id,
    revision: copy.revision,
    xml: reference.xml,
    circuit,
  });
  return {
    circuit,
    artifactSha256: sha(copy.xml),
    current: result,
    reference: {
      revision: args.referenceRevisionId,
      observation: observationView(document),
    },
    note:
      "reference 是历史版本；改动后的功能是否一致，需要按 current.samples 与 reference 的连接和输出自行判断。",
  };
};

const keptObservations: ToolHandler = async (_args, context) => {
  const records = await context.turn.call({
    op: "observations",
    id: context.session.documentId,
  });
  return {
    observations: records.map(({ frame, ...record }: any) => ({
      ...record,
      state: frame?.attributes ?? null,
    })),
  };
};

const loadability: ToolHandler = async (args, context) => {
  const { copy, circuit } = await target(context, args);
  const document = await context.turn.call({
    op: "draftObserve",
    id: copy.id,
    revision: copy.revision,
    xml: copy.xml,
    circuit,
  });
  const view = observationView(document);
  return {
    status: "loadable",
    circuit,
    artifactSha256: sha(copy.xml),
    components: view.circuit.components.length,
    wires: view.circuit.wires.length,
    widthIncompatibilities: view.circuit.widthIncompatibilities,
    unknowns: view.unknowns,
    note:
      view.circuit.widthIncompatibilities.length > 0
        ? "原生 Logisim 已加载，但有线束把不同位宽接在一起，仿真会得到 X。"
        : "原生 Logisim 已加载当前内容；这不是功能正确性结论。",
  };
};

const projectFiles: ToolHandler = async (args, context) => {
  const folderId = context.session.folderId;
  if (!folderId) throw new Error("当前电路没有所属的工程文件夹");
  const result = await context.turn.call({
    op: "projectFiles",
    id: context.session.documentId,
    folder_id: folderId,
    path: args.path,
    read: args.read,
  });
  return args.read ? result : { entries: result };
};

export const handlers: Record<string, ToolHandler> = {
  inspect_circuit: inspection,
  render_circuit: render,
  describe_component: describe,
  edit_candidate: editCandidate,
  wire_candidate: wireCandidate,
  move_candidate: moveCandidate,
  reroute_candidate: reroute,
  simulate_circuit: simulate,
  trace_circuit: trace,
  evaluate_circuit: evaluate,
  compare_circuit: compare,
  read_kept_observation: keptObservations,
  check_native_loadability: loadability,
  project_files: projectFiles,
};

export { componentDirectory, componentDetails, portConnections, wireGeometry };
