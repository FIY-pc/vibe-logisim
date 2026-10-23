/**
 * Model-facing views of one native circuit observation. A large definition
 * observes to megabytes, so every view is bounded: a summary with the first
 * page of components, then byte-budgeted pages continued by a cursor bound to
 * the exact observation, and detail only for the components or ports asked for.
 */
import { createHash } from "node:crypto";
import { CircuitToolError } from "./errors.mts";

export interface ObservedEnd {
  index: number;
  location: { x: number; y: number };
  width: number | null;
  direction: string | null;
  exclusive?: boolean;
  semanticRole?: string | null;
  runtimeTooltip?: string | null;
  netBits?: { bit: number; netId: string }[];
  [key: string]: unknown;
}
export interface ObservedComponent {
  componentId: string;
  factory: string;
  displayName: string | null;
  label: string | null;
  location: { x: number; y: number };
  bounds: { x: number; y: number; width: number; height: number };
  attributes: Record<string, string | null>;
  attributeDetails: any[];
  ends: ObservedEnd[];
  subcircuit: string | null;
}
export interface CircuitView {
  name: string;
  bounds: any;
  components: ObservedComponent[];
  wires: any[];
  nets: any[];
  bundles: any[];
  instances: any[];
  tunnels: any[];
  stateElements: any[];
  widthIncompatibilities: any[];
}
export interface ObservationView {
  circuit: CircuitView;
  project: any;
  unknowns: any[];
  artifactSha256: string | null;
  runtime: { reportedVersion?: string | null; jarSha256?: string | null };
}
/** Which document version an inspection describes; cursors are bound to it. */
export interface Identity {
  documentId: string;
  revision: string;
  circuit: string;
  [key: string]: unknown;
}

const json = (value: unknown) => JSON.stringify(value);
const size = (value: unknown) => Buffer.byteLength(json(value), "utf8");
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const clone = <T,>(value: T): T =>
  value === undefined ? value : structuredClone(value);

/** The native observation of one definition, keyed the way the tools speak. */
export function observationView(document: any): ObservationView {
  const focus = document?.focus;
  if (!focus || !Array.isArray(focus.components))
    throw new CircuitToolError(
      "EXACT_OBSERVER_FAILED",
      "原生观察没有返回电路",
      {
        retryable: true,
        hint: "重新观察；若仍失败，检查文件能否在 Logisim 中打开。",
      },
    );
  const components = focus.components.map((c: any): ObservedComponent => ({
    componentId: c.componentId,
    factory: c.factoryName,
    displayName: c.displayName ?? null,
    label: c.selector?.label ?? null,
    location: c.location,
    bounds: c.bounds,
    attributes: Object.fromEntries(
      (c.attributes || [])
        .filter((a: any) => a?.name)
        .map((a: any) => [a.name, a.standard ?? null]),
    ),
    attributeDetails: c.attributes || [],
    ends: c.ends || [],
    subcircuit: c.subcircuit ?? null,
  }));
  const summary = (document.project?.circuits || []).find(
    (item: any) => item.name === focus.circuit,
  );
  return {
    circuit: {
      name: focus.circuit,
      bounds: focus.bounds,
      components,
      wires: focus.wires || [],
      nets: focus.bitNets || [],
      bundles: focus.wireBundles || [],
      instances: summary?.instances || [],
      tunnels: focus.tunnels || [],
      stateElements: focus.stateElements || [],
      widthIncompatibilities: focus.widthIncompatibilities || [],
    },
    project: document.project || {},
    unknowns: document.unknowns || [],
    artifactSha256: document.revision?.artifactSha256 ?? null,
    runtime: {
      reportedVersion: document.runtime?.reportedVersion ?? null,
      jarSha256: document.runtime?.jarSha256 ?? null,
    },
  };
}

/**
 * Connectivity fingerprint independent of geometry and component IDs: ports
 * named (factory, label, port, width) grouped by shared net, Tunnels dropped,
 * single-port groups dropped. Equal digests mean identical connectivity.
 */
export function netlistSignature(components: ObservedComponent[]) {
  const groups = new Map<string, unknown[][]>();
  const constants = new Map<string, Set<string>>();
  for (const c of components) {
    if (c.factory === "Tunnel") continue;
    for (const end of c.ends || []) {
      const bits = end.netBits || [];
      if (!bits.length) continue;
      const key = json(
        [...bits].sort((a, b) => a.bit - b.bit).map((b) => [b.bit, b.netId]),
      );
      if (c.factory === "Constant") {
        const value = String(c.attributes?.value ?? null).toLowerCase();
        if (!constants.has(key)) constants.set(key, new Set());
        constants.get(key)!.add(json([value, end.width]));
        continue;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups
        .get(key)!
        .push([c.factory || "", c.label || "", end.index, end.width]);
    }
  }
  const byJson = (a: unknown, b: unknown) =>
    json(a) < json(b) ? -1 : json(a) > json(b) ? 1 : 0;
  const canonical: unknown[] = [];
  for (const [key, ports] of groups) {
    const driven = constants.get(key);
    if (driven)
      for (const port of ports)
        canonical.push([["const", ...[...driven].sort()], port]);
    else if (ports.length >= 2) canonical.push([...ports].sort(byJson));
  }
  canonical.sort(byJson);
  return {
    sha256: sha256(json(canonical)),
    groups: canonical.length,
    ports: canonical.reduce(
      (n: number, g: any) => n + (g[0]?.[0] === "const" ? 1 : g.length),
      0,
    ),
    note: "Ports grouped by shared net, keyed by (factory,label,port,width), Tunnels excluded; equal digests mean identical connectivity regardless of layout.",
  };
}

const endGeometry = (end: ObservedEnd) => ({
  index: end.index,
  location: clone(end.location),
  width: end.width,
  direction: end.direction,
  ...(end.exclusive ? { exclusive: true } : {}),
  ...(end.semanticRole ? { semanticRole: end.semanticRole } : {}),
  ...(end.runtimeTooltip ? { runtimeTooltip: end.runtimeTooltip } : {}),
});
const directoryEntry = (c: ObservedComponent) => ({
  componentId: c.componentId,
  factory: c.factory,
  ...(c.label ? { label: c.label } : {}),
  location: clone(c.location),
  bounds: clone(c.bounds),
  ...(c.subcircuit ? { subcircuit: c.subcircuit } : {}),
  ends: c.ends.map(endGeometry),
});

function cursorDigest(
  kind: string,
  identity: Identity,
  view: ObservationView,
  extra?: unknown,
) {
  return sha256(
    json([kind, identity, view.artifactSha256, view.runtime, extra ?? null]),
  );
}
function parseCursor(
  cursor: unknown,
  prefix: string,
  digest: string,
  total: number,
  code: string,
) {
  if (cursor === undefined || cursor === null) return 0;
  const match =
    typeof cursor === "string" &&
    new RegExp(`^${prefix}:([0-9a-f]{64}):([1-9][0-9]{0,11})$`).exec(cursor);
  if (!match)
    throw new CircuitToolError(`INVALID_${code}_CURSOR`, "游标格式无效。", {
      hint: "使用本次返回的 nextCursor，或省略 cursor 从第一页开始。",
    });
  if (match[1] !== digest)
    throw new CircuitToolError(
      `STALE_${code}_CURSOR`,
      "电路版本或实际观察已变化，不能续接旧页。",
      { hint: "省略 cursor 重新读取；不要把旧页的 ID 与新页混用。" },
    );
  const offset = Number(match[2]);
  if (!(offset > 0 && offset < total))
    throw new CircuitToolError(`INVALID_${code}_CURSOR`, "游标位置无效。", {
      hint: "使用本次返回的 nextCursor，或省略 cursor。",
    });
  return offset;
}

/**
 * Fill `key` of `base` with entries from `offset` while the whole JSON stays
 * within `maxBytes`. The page record measures the complete encoding.
 */
function pageInto(
  base: Record<string, any>,
  key: string,
  entries: unknown[],
  offset: number,
  maxBytes: number,
  cursorOf: (next: number) => string,
  budgetError: () => CircuitToolError,
) {
  const page = (returned: number) => ({
    offset,
    total: entries.length,
    returned,
    nextCursor:
      offset + returned < entries.length ? cursorOf(offset + returned) : null,
    maxBytes,
    bytes: 0,
  });
  const measure = (items: unknown[]) => {
    const record = { ...base, [key]: items, page: page(items.length) };
    let bytes = size(record);
    while (record.page.bytes !== bytes) {
      record.page.bytes = bytes;
      bytes = size(record);
    }
    return record;
  };
  // Measure entries once; the page metadata is re-measured only at the end.
  const fixed = size({ ...base, [key]: [], page: page(entries.length) }) + 128;
  const items: unknown[] = [];
  let used = fixed;
  for (const entry of entries.slice(offset)) {
    const cost = size(entry) + (items.length ? 1 : 0);
    if (used + cost > maxBytes) break;
    items.push(entry);
    used += cost;
  }
  let record = measure(items);
  while (record.page.bytes > maxBytes && items.length) {
    items.pop();
    record = measure(items);
  }
  if (!items.length && entries.length > offset) throw budgetError();
  return record;
}

const budget = (value: unknown, fallback: number, path: string) => {
  const bytes = value === undefined ? fallback : value;
  if (
    !Number.isInteger(bytes) ||
    (bytes as number) < 1024 ||
    (bytes as number) > 32000
  )
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      `${path} 必须为 1024–32000 的整数。`,
      { context: { path, received: value ?? null } },
    );
  return bytes as number;
};

/** Static components with indexed port geometry, a page at a time. */
export function componentDirectory(
  view: ObservationView,
  identity: Identity,
  options: { maxBytes?: number; cursor?: string } = {},
  base: Record<string, unknown> = {},
) {
  const maxBytes = budget(
    options.maxBytes,
    24000,
    "componentDirectory.maxBytes",
  );
  const components = view.circuit.components;
  const digest = cursorDigest("d1", identity, view);
  const offset = parseCursor(
    options.cursor,
    "d1",
    digest,
    components.length,
    "COMPONENT",
  );
  return pageInto(
    {
      ...identity,
      ...base,
      scope:
        "Static components with circuit-coordinate locations, bounds and indexed port geometry. Attributes and bit nets come with componentIds; connectivity of chosen ports with portConnections. No simulation values.",
    },
    "components",
    components.map(directoryEntry),
    offset,
    maxBytes,
    (next) => `d1:${digest}:${next}`,
    () =>
      new CircuitToolError(
        "COMPONENT_DIRECTORY_BUDGET",
        "单个组件条目及必要页信息超过字节预算；未截断条目。",
        {
          hint: "提高 maxBytes（上限 32000），或用 componentIds 读取该元件。",
          context: { offset, maxBytes },
        },
      ),
  );
}

/** Attributes, ports and bit nets of named components. */
export function componentDetails(
  view: ObservationView,
  identity: Identity,
  ids: string[],
) {
  const byId = new Map(view.circuit.components.map((c) => [c.componentId, c]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length)
    throw new CircuitToolError(
      "UNKNOWN_COMPONENT",
      `当前观察中没有这些元件：${missing.join("、")}`,
      {
        hint: "使用本电路、本修订的 componentId；ID 随元件位置变化，编辑后重新读取。",
        context: { circuit: view.circuit.name, missing },
      },
    );
  const entries = ids.map((id) => {
    const c = byId.get(id)!;
    return {
      ...directoryEntry(c),
      ...(c.displayName && c.displayName !== c.factory
        ? { displayName: c.displayName }
        : {}),
      attributes: clone(c.attributes),
      attributeOptions: Object.fromEntries(
        c.attributeDetails
          .filter((a: any) => a?.name && !a.readOnly && a.options?.length)
          .map((a: any) => [a.name, a.options.map((o: any) => o.value)]),
      ),
      ends: c.ends.map((end) => ({
        ...endGeometry(end),
        netBits: clone(end.netBits || []),
      })),
    };
  });
  const result: Record<string, any> = {
    ...identity,
    components: entries,
    scope:
      "attributes are the native values; attributeOptions lists the allowed values of enumerated attributes. netBits name each port bit's native net, bound to this revision.",
  };
  // Wide buses carry one net per bit; past the budget keep geometry only.
  if (size(result) > 48000) {
    for (const entry of entries)
      for (const end of entry.ends) delete (end as any).netBits;
    result.netBitsOmitted =
      "Bit nets exceed the result budget for this many components; ask for fewer componentIds or use portConnections.";
  }
  if (size(result) > 64000)
    throw new CircuitToolError(
      "COMPONENT_DETAIL_BUDGET",
      "所选元件的明细超过结果预算。",
      {
        hint: "减少 componentIds 的数量后分批读取。",
        context: { requested: ids.length },
      },
    );
  return result;
}

function endpoint(component: ObservedComponent, end: ObservedEnd) {
  return {
    componentId: component.componentId,
    factory: component.factory,
    ...(component.label ? { label: component.label } : {}),
    port: end.index,
    location: clone(end.location),
    width: end.width,
    direction: end.direction,
    ...(end.semanticRole ? { semanticRole: end.semanticRole } : {}),
  };
}

/** Ascending bits as "0-7,12" ("" for none). */
function bitList(bits: number[]) {
  const parts: string[] = [];
  for (let i = 0; i < bits.length;) {
    let j = i;
    while (j + 1 < bits.length && bits[j + 1] === bits[j] + 1) j++;
    parts.push(range(bits[i], j - i + 1));
    i = j + 1;
  }
  return parts.join(",");
}
const range = (start: number, length: number) =>
  length === 1 ? String(start) : `${start}-${start + length - 1}`;
/** Bit pairs as runs, e.g. {source:"0-31", peer:"0-31"}; a bit on several peer bits stands alone. */
function bitRuns(pairs: { sourceBit: number; peerBits: number[] }[]) {
  const runs: { source: string; peer: string }[] = [];
  let run: { source: number; peer: number; length: number } | null = null;
  const flush = () => {
    if (run)
      runs.push({
        source: range(run.source, run.length),
        peer: range(run.peer, run.length),
      });
    run = null;
  };
  for (const pair of [...pairs].sort((a, b) => a.sourceBit - b.sourceBit)) {
    if (pair.peerBits.length !== 1) {
      flush();
      runs.push({
        source: String(pair.sourceBit),
        peer: pair.peerBits.join(","),
      });
      continue;
    }
    const peer = pair.peerBits[0];
    if (
      run &&
      pair.sourceBit === run.source + run.length &&
      peer === run.peer + run.length
    )
      run.length++;
    else {
      flush();
      run = { source: pair.sourceBit, peer, length: 1 };
    }
  }
  flush();
  return runs;
}

/** Native shared bit nets of chosen ports: who shares a net, bit by bit. */
export function portConnections(
  view: ObservationView,
  identity: Identity,
  options: {
    ports: { componentId: string; port: number }[];
    maxBytes?: number;
    cursor?: string;
  },
) {
  const maxBytes = budget(options.maxBytes, 24000, "portConnections.maxBytes");
  const components = view.circuit.components;
  const byId = new Map(components.map((c) => [c.componentId, c]));
  const selected = options.ports.map((request, index) => {
    const component = byId.get(request.componentId);
    if (!component)
      throw new CircuitToolError(
        "UNKNOWN_COMPONENT",
        `portConnections.ports[${index}] 指向当前观察中不存在的元件 ${request.componentId}。`,
        {
          hint: "用当前电路、当前修订的 componentId。",
          context: { path: `portConnections.ports[${index}].componentId` },
        },
      );
    const end = component.ends.find((e) => e.index === request.port);
    if (!end)
      throw new CircuitToolError(
        "UNKNOWN_PORT",
        `元件 ${request.componentId} 没有端口 ${request.port}。`,
        {
          hint: "先读取该元件的端口索引。",
          context: {
            path: `portConnections.ports[${index}].port`,
            ports: component.ends.map((e) => e.index),
          },
        },
      );
    return { component, end };
  });
  const contacts = new Map<string, Map<string, Set<number>>>();
  for (const net of view.circuit.nets) {
    const members = new Map<string, Set<number>>();
    for (const item of net?.contacts || []) {
      if (typeof item?.componentId !== "string") continue;
      const key = `${item.componentId}#${item.endIndex}`;
      if (!members.has(key)) members.set(key, new Set());
      members.get(key)!.add(item.bit);
    }
    contacts.set(net.netId, members);
  }
  const endpoints = new Map<string, [ObservedComponent, ObservedEnd]>();
  for (const c of components)
    for (const end of c.ends)
      endpoints.set(`${c.componentId}#${end.index}`, [c, end]);
  const ports: any[] = [];
  const finished: {
    connectedBits: number[];
    unconnectedBits: number[];
    unknownBits: number[];
  }[] = [];
  const connections = new Map<string, any>();
  for (const { component, end } of selected) {
    const self = `${component.componentId}#${end.index}`;
    const summary = {
      source: endpoint(component, end),
      connectedBits: [] as number[],
      unconnectedBits: [] as number[],
      unknownBits: [] as number[],
    };
    ports.push(summary);
    finished.push(summary);
    const nets = new Map((end.netBits || []).map((b) => [b.bit, b.netId]));
    for (let bit = 0; bit < (end.width || 0); bit++) {
      const members = contacts.get(nets.get(bit) || "");
      if (!members || !members.get(self)?.has(bit)) {
        summary.unknownBits.push(bit);
        continue;
      }
      const peers = [...members].filter(([key]) => key !== self);
      if (!peers.length) {
        summary.unconnectedBits.push(bit);
        continue;
      }
      summary.connectedBits.push(bit);
      for (const [key, bits] of peers) {
        const peer = endpoints.get(key);
        if (!peer) continue;
        const id = `${self}>${key}`;
        if (!connections.has(id))
          connections.set(id, {
            source: { componentId: component.componentId, port: end.index },
            peer: endpoint(...peer),
            bitPairs: [],
          });
        connections.get(id).bitPairs.push({
          sourceBit: bit,
          peerBits: [...bits].sort((a, b) => a - b),
        });
      }
    }
  }
  for (const summary of finished)
    for (const key of [
      "connectedBits",
      "unconnectedBits",
      "unknownBits",
    ] as const)
      (summary as any)[key] = bitList(summary[key]);
  for (const item of connections.values()) {
    item.bits = bitRuns(item.bitPairs);
    delete item.bitPairs;
  }
  const entries = [...connections.values()].sort((a, b) =>
    json([a.source, a.peer.componentId, a.peer.port]) <
    json([b.source, b.peer.componentId, b.peer.port])
      ? -1
      : 1,
  );
  const digest = cursorDigest("pc1", identity, view, options.ports);
  const offset = parseCursor(
    options.cursor,
    "pc1",
    digest,
    entries.length,
    "PORT_CONNECTION",
  );
  return pageInto(
    {
      ...identity,
      scope:
        "Native shared bit nets inside this definition. A connection means the two ports share a net; bits lists source-port bits against peer-port bits as runs. It does not infer drive direction or correctness. unknownBits are not proof of a break.",
      ports,
    },
    "connections",
    entries,
    offset,
    maxBytes,
    (next) => `pc1:${digest}:${next}`,
    () =>
      new CircuitToolError(
        "PORT_CONNECTION_BUDGET",
        "单条端点连接记录超过字节预算；未截断记录。",
        { hint: "提高 portConnections.maxBytes，或减少请求的端口。" },
      ),
  );
}

/** Wire segments as loaded by the native runtime, a slice at a time. */
export function wireGeometry(
  view: ObservationView,
  options: { wireOffset?: number; wireLimit?: number },
) {
  const offset = options.wireOffset ?? 0;
  const limit = options.wireLimit ?? 128;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 256
  )
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "wireOffset 必须为非负整数，wireLimit 必须在 1–256 之间。",
    );
  // Ids follow the loaded segments, which is what removeWireIds and reroute
  // resolve against. The runtime merges collinear wires, so one id can stand
  // for several file lines; the end points are always the loaded ones.
  const wires = view.circuit.wires
    .slice(offset, offset + limit)
    .map((w: any, index: number) => ({
      id: `w${offset + index}`,
      from: w.from,
      to: w.to,
      bundleId: w.bundleId,
    }));
  const bundleIds = new Set(wires.map((w) => w.bundleId));
  return {
    bounds: view.circuit.bounds,
    wireCount: view.circuit.wires.length,
    wireOffset: offset,
    wireLimit: limit,
    wiresTruncated:
      offset > 0 || offset + wires.length < view.circuit.wires.length,
    wires,
    bundles: view.circuit.bundles
      .filter((b: any) => bundleIds.has(b.bundleId))
      .map((b: any) => ({
        bundleId: b.bundleId,
        width: b.width,
        valid: b.valid,
      })),
    scope:
      "Segments after native loading (overlapping or collinear segments may be merged), one id per loaded segment; removeWireIds takes these ids.",
  };
}
const MAX_SCHEMA_ITEMS = 96;
const capped = <T,>(items: T[]) =>
  items.length > MAX_SCHEMA_ITEMS
    ? { items: items.slice(0, MAX_SCHEMA_ITEMS), truncated: items.length }
    : { items };
export function circuitOverview(
  view: ObservationView,
  identity: Identity,
  options: { maxBytes?: number } = {},
) {
  const circuit = view.circuit;
  const factories: Record<string, number> = {};
  for (const c of circuit.components)
    factories[c.factory] = (factories[c.factory] || 0) + 1;
  const pins = circuit.components.filter((c) => c.factory === "Pin");
  const inputs = capped(
    pins.flatMap((c) =>
      c.ends
        .filter((e) => e.direction === "output")
        .map((e) => ({
          component: c.componentId,
          label: c.label,
          port: e.index,
          width: e.width,
        })),
    ),
  );
  const outputs = capped(
    pins.flatMap((c) =>
      c.ends
        .filter((e) => e.direction !== "output")
        .map((e) => ({
          component: c.componentId,
          label: c.label,
          port: e.index,
          width: e.width,
        })),
    ),
  );
  const clocks = capped(
    circuit.components
      .filter((c) => c.factory === "Clock")
      .map((c) => ({
        component: c.componentId,
        label: c.label,
        location: c.location,
      })),
  );
  const parents = (view.project.circuits || [])
    .map((c: any) => ({
      circuit: c.name,
      instances: (c.instances || [])
        .filter((i: any) => i.target === circuit.name)
        .map((i: any) => ({
          instanceId: i.instanceId,
          label: i.label,
          location: i.location,
        })),
    }))
    .filter((c: any) => c.instances.length);
  const tunnels = new Map<string, number>();
  for (const t of circuit.tunnels)
    tunnels.set(t.label, (tunnels.get(t.label) || 0) + 1);
  const base = {
    authority: "exact-runtime",
    netlistSignature: netlistSignature(circuit.components),
    counts: {
      components: circuit.components.length,
      wireSegments: circuit.wires.length,
      tunnels: circuit.tunnels.length,
      tunnelLabels: tunnels.size,
      factories,
    },
    bounds: circuit.bounds,
    stimulusSchema: inputs.items,
    ...(inputs.truncated ? { stimulusSchemaTotal: inputs.truncated } : {}),
    outputPins: outputs.items,
    ...(outputs.truncated ? { outputPinsTotal: outputs.truncated } : {}),
    clockSchema: clocks.items,
    instances: circuit.instances.map((i: any) => ({
      instanceId: i.instanceId,
      target: i.target,
      label: i.label,
      location: i.location,
    })),
    parents,
    widthIncompatibilities: circuit.widthIncompatibilities.length,
  };
  return componentDirectory(
    view,
    identity,
    { maxBytes: options.maxBytes ?? 32000 },
    base,
  );
}

const DETAIL_OPTIONS = [
  "componentIds",
  "componentDirectory",
  "portConnections",
  "includeWires",
  "wireOffset",
  "wireLimit",
];

/** One named-definition view per call: overview, a directory page, details, connections or wires. */
export function inspectView(
  view: ObservationView,
  identity: Identity,
  args: Record<string, any>,
) {
  const used = DETAIL_OPTIONS.filter((key) => args[key] !== undefined);
  const wires = used.every(
    (key) => key.startsWith("includeWires") || key.startsWith("wire"),
  );
  if (used.length > 1 && !wires)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      `一次只能使用一种明细视图：${used.join("、")}。`,
      {
        hint: "分开调用；每次只给 componentIds、componentDirectory、portConnections 或 includeWires 中的一种。",
      },
    );
  if (args.portConnections)
    return portConnections(view, identity, args.portConnections);
  if (args.componentIds?.length)
    return componentDetails(view, identity, args.componentIds);
  if (args.componentDirectory)
    return componentDirectory(view, identity, args.componentDirectory);
  if (
    args.includeWires ||
    args.wireOffset !== undefined ||
    args.wireLimit !== undefined
  )
    return { ...identity, wireGeometry: wireGeometry(view, args) };
  return circuitOverview(view, identity);
}
