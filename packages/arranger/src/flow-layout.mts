// Small circuits drawn the way people draw them in Logisim: signal flow from
// left to right in columns, input pins in the first column and output pins in
// the last (each in its original order), every connection a wire (Tunnels
// become wires), parallel wires 20 px apart wherever the ports allow it.
//
// ELK's layered algorithm places and routes, the method netlistsvg uses for
// gate-level schematics. This module translates the observation into an ELK
// graph whose node boxes, port offsets and spacings are all multiples of the
// 10 px grid, so the routes come back on the grid, and turns the routes into
// <wire> elements split at every bend and junction. The wires are then held
// against Logisim's connection rules (a wire that ends or bends on another
// net's copper joins it, a port on a wire joins it, a wire through a body
// hides it); a layout that breaks one is skipped, and the column engine
// remains a candidate.
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import { elk } from "./elk-worker.mts";
import { looseWireGeometry } from "./loose-wires.mts";
import type { Point } from "./py.mts";
import {
  attr,
  loc,
  netKey,
  pinOrderKey,
  repointPins,
  spliceCircuit,
} from "./schematic-layout.mts";
import type { Report } from "./schematic-layout.mts";
import type { Bounds, Component, End, Focus, Wire } from "./types.mts";
import { parseXml, subElement } from "./xml.mts";
import type { XmlElement } from "./xml.mts";

const GRID = 10;
// Above this many parts a definition is a sheet, not a sketch: the column
// engine's stages, tunnels and panels read better there.
export const FLOW_MAX_PARTS = 80;

// Every distance a multiple of the grid, so ELK's coordinates stay on it.
const OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.randomSeed": "1",
  "elk.separateConnectedComponents": "false",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
  "elk.spacing.nodeNode": "30",
  "elk.spacing.edgeEdge": "20",
  "elk.spacing.edgeNode": "20",
  "elk.layered.spacing.nodeNodeBetweenLayers": "40",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.unnecessaryBendpoints": "true",
  "elk.layered.thoroughness": "20",
  "elk.layered.crossingMinimization.semiInteractive": "true",
};

// Ways to choose the columns and the order within them. None suits every
// circuit, so a small definition is laid out several ways and the caller
// keeps the drawing that reads best: the sketch's own columns and order
// (good when the author already stacked repeated blocks), network-simplex
// layering (short wires) with a few seeds for ELK's randomised crossing
// minimisation, with and without the parts' given order, and longest-path
// layering (every part as early as its inputs allow).
export interface FlowVariant {
  name: string;
  options: Record<string, string>;
}
const UNORDERED = { "elk.layered.considerModelOrder.strategy": "NONE" };
export const FLOW_VARIANTS: readonly FlowVariant[] = [
  {
    name: "sketch",
    options: {
      "elk.layered.layering.strategy": "INTERACTIVE",
      "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
      "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
    },
  },
  { name: "flow", options: {} },
  { name: "flow, seed 2", options: { "elk.randomSeed": "2" } },
  { name: "flow, seed 3", options: { "elk.randomSeed": "3" } },
  {
    name: "flow unordered, seed 2",
    options: { ...UNORDERED, "elk.randomSeed": "2" },
  },
  { name: "flow, seed 5", options: { "elk.randomSeed": "5" } },
  { name: "flow, seed 4", options: { "elk.randomSeed": "4" } },
  { name: "flow unordered", options: UNORDERED },
  {
    name: "longest path",
    options: { "elk.layered.layering.strategy": "LONGEST_PATH" },
  },
];

// The variants worth their time for a definition of this many parts: about
// 400 part-layouts in all (a 34-part layout takes about 60 ms), at least two.
export function flowVariants(parts: number): readonly FlowVariant[] {
  return FLOW_VARIANTS.slice(
    0,
    Math.max(2, Math.floor(400 / Math.max(parts, 1))),
  );
}

const SIDE: Record<string, string> = {
  east: "EAST",
  west: "WEST",
  north: "NORTH",
  south: "SOUTH",
};
const OPPOSITE_SIDE: Record<string, string> = {
  EAST: "WEST",
  WEST: "EAST",
  NORTH: "SOUTH",
  SOUTH: "NORTH",
};

export interface FlowLayout {
  // The whole file with this definition laid out; every other byte unchanged.
  xml: string;
  // componentId -> [dx, dy] of every part (Tunnels are removed, not moved).
  placement: Map<string, Point>;
  // The observation the result should load as: parts moved, Tunnels gone,
  // the emitted wires. For comparing drawings before applying anything.
  predicted: Focus;
  report: Report;
}

// Why this definition is not laid out by flow, or null when it is.
export function flowIneligible(focus: Focus): string | null {
  const parts = focus.components.filter((c) => c.factoryName !== "Tunnel");
  if (parts.length > FLOW_MAX_PARTS)
    return `${parts.length} parts (flow layout takes at most ${FLOW_MAX_PARTS})`;
  if (parts.some((c) => c.factoryName === "Text")) return "free text";
  // a sheet drawn with tunnels keeps them: as wires they would cross it all
  const tunnels = focus.components.length - parts.length;
  if (tunnels > Math.max(2, parts.length / 10))
    return `${tunnels} tunnels (flow layout draws every connection as a wire)`;
  if (looseWireGeometry(focus)[0].length) return "unfinished wires";
  const at = new Set<string>();
  for (const c of focus.components) {
    const key = `${c.location.x},${c.location.y},${c.factoryName}`;
    if (at.has(key)) return "stacked copies";
    at.add(key);
  }
  return null;
}

const down = (v: number) => Math.floor(v / GRID) * GRID;
const up = (v: number) => Math.ceil(v / GRID) * GRID;
const pointKey = (x: number, y: number) => `${x},${y}`;
const portId = (c: Component, e: End) => `${c.componentId}:${e.index}`;
const isOutputPin = (c: Component) =>
  c.factoryName === "Pin" && attr(c, "output") === "true";
const isInputPin = (c: Component) =>
  c.factoryName === "Pin" && attr(c, "output") !== "true";

// The part's footprint on the grid: body and label.
function box(c: Component): Bounds {
  const b = c.bounds;
  const v = c.visualBounds ?? b;
  const x = down(Math.min(b.x, v.x));
  const y = down(Math.min(b.y, v.y));
  return {
    x,
    y,
    width: up(Math.max(b.x + b.width, v.x + v.width)) - x,
    height: up(Math.max(b.y + b.height, v.y + v.height)) - y,
  };
}

// The edge of the body a port leaves through.
function sideOf(c: Component, e: End): string {
  const facing = attr(c, "facing") ?? "east";
  if (c.factoryName === "Pin") return SIDE[facing] ?? "EAST";
  if (c.factoryName === "Splitter") {
    // the bit ends fan out toward the facing; the combined end is opposite
    const bits = SIDE[facing] ?? "EAST";
    return e.index === 0 ? OPPOSITE_SIDE[bits] : bits;
  }
  const b = c.bounds;
  const p = e.location;
  const distances: [string, number][] = [
    ["WEST", Math.abs(p.x - b.x)],
    ["EAST", Math.abs(b.x + b.width - p.x)],
    ["NORTH", Math.abs(p.y - b.y)],
    ["SOUTH", Math.abs(b.y + b.height - p.y)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

// Ports of one net: the one that drives it first.
function driverFirst(ends: [Component, End][]): [Component, End][] {
  const rank = (e: End) =>
    e.direction === "output" ? 0 : e.direction === "inout" ? 1 : 2;
  return [...ends].sort(
    ([c1, e1], [c2, e2]) =>
      rank(e1) - rank(e2) ||
      c1.location.x - c2.location.x ||
      c1.location.y - c2.location.y ||
      e1.index - e2.index,
  );
}

// Parts in the order ELK should meet them: inputs, then the signal flow with
// storage outputs that close a loop treated as feedback, then outputs. ELK
// breaks cycles against this order, so a register's output wire goes back
// around to the logic before it, the way a counter is drawn.
function flowOrder(parts: Component[], links: [string, string][]): Component[] {
  const byId = new Map(parts.map((c) => [c.componentId, c]));
  const next = new Map<string, Set<string>>();
  for (const [a, b] of links) {
    if (a === b) continue;
    if (!next.has(a)) next.set(a, new Set());
    next.get(a)!.add(b);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const v = stack.pop()!;
      if (v === to) return true;
      for (const w of next.get(v) ?? [])
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
    }
    return false;
  };
  const forward: [string, string][] = [];
  for (const [a, b] of links) {
    if (a === b) continue;
    if (byId.get(a)?.storage && reaches(b, a)) continue;
    forward.push([a, b]);
  }
  const indegree = new Map(parts.map((c) => [c.componentId, 0]));
  const successors = new Map<string, string[]>();
  for (const [a, b] of forward) {
    indegree.set(b, (indegree.get(b) ?? 0) + 1);
    if (!successors.has(a)) successors.set(a, []);
    successors.get(a)!.push(b);
  }
  const priority = (c: Component): [number, number, number] =>
    isInputPin(c)
      ? [0, c.location.y, c.location.x]
      : isOutputPin(c)
        ? [2, c.location.y, c.location.x]
        : [1, c.location.x, c.location.y];
  const before = (a: Component, b: Component) => {
    const [p, q] = [priority(a), priority(b)];
    return p[0] - q[0] || p[1] - q[1] || p[2] - q[2];
  };
  const order: Component[] = [];
  const placed = new Set<string>();
  while (order.length < parts.length) {
    const ready = parts.filter(
      (c) => !placed.has(c.componentId) && indegree.get(c.componentId) === 0,
    );
    // a loop without storage: enter it at its first part
    const pool = ready.length
      ? ready
      : parts.filter((c) => !placed.has(c.componentId));
    const c = [...pool].sort(before)[0];
    placed.add(c.componentId);
    order.push(c);
    for (const b of successors.get(c.componentId) ?? [])
      indegree.set(b, (indegree.get(b) ?? 0) - 1);
    if (!ready.length) indegree.set(c.componentId, 0);
  }
  return order;
}

// One net's copper as 10 px units: "h:x:y" runs (x,y)-(x+10,y), "v:x:y" runs
// (x,y)-(x,y+10).
type Units = Set<string>;

function addPolyline(units: Units, points: Point[]): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    if (ax === bx)
      for (let y = Math.min(ay, by); y < Math.max(ay, by); y += GRID)
        units.add(`v:${ax}:${y}`);
    else if (ay === by)
      for (let x = Math.min(ax, bx); x < Math.max(ax, bx); x += GRID)
        units.add(`h:${x}:${ay}`);
    else return false;
  }
  return true;
}

function unitEnds(unit: string): [string, string] {
  const [t, xs, ys] = unit.split(":");
  const x = Number(xs);
  const y = Number(ys);
  return [
    pointKey(x, y),
    t === "h" ? pointKey(x + GRID, y) : pointKey(x, y + GRID),
  ];
}

// The net's copper reduced to a tree joining its ports: loops broken
// breadth-first from the driver, stubs that lead nowhere removed. Null when
// the routes do not join every port.
function netTree(units: Units, terminals: string[]): Units | null {
  const adjacent = new Map<string, [string, string][]>();
  for (const u of [...units].sort()) {
    const [a, b] = unitEnds(u);
    if (!adjacent.has(a)) adjacent.set(a, []);
    if (!adjacent.has(b)) adjacent.set(b, []);
    adjacent.get(a)!.push([b, u]);
    adjacent.get(b)!.push([a, u]);
  }
  if (terminals.some((t) => !adjacent.has(t))) return null;
  const tree: Units = new Set();
  const seen = new Set([terminals[0]]);
  const queue = [terminals[0]];
  while (queue.length) {
    const p = queue.shift()!;
    for (const [q, u] of adjacent.get(p)!)
      if (!seen.has(q)) {
        seen.add(q);
        tree.add(u);
        queue.push(q);
      }
  }
  if (terminals.some((t) => !seen.has(t))) return null;
  const keep = new Set(terminals);
  for (;;) {
    const degree = new Map<string, number>();
    for (const u of tree)
      for (const p of unitEnds(u)) degree.set(p, (degree.get(p) ?? 0) + 1);
    const stubs = [...tree].filter((u) =>
      unitEnds(u).some((p) => degree.get(p) === 1 && !keep.has(p)),
    );
    if (!stubs.length) return tree;
    for (const u of stubs) tree.delete(u);
  }
}

// Straight runs of a tree, split at every bend, junction and end, which is
// how Logisim needs them: a wire that passes a junction does not join it.
function runsOf(units: Units): [Point, Point][] {
  const at = new Map<string, Set<string>>();
  for (const u of units) {
    const [a, b] = unitEnds(u);
    const t = u[0];
    if (!at.has(a)) at.set(a, new Set());
    if (!at.has(b)) at.set(b, new Set());
    at.get(a)!.add(t === "h" ? "E" : "S");
    at.get(b)!.add(t === "h" ? "W" : "N");
  }
  const through = (p: string, t: string) => {
    const d = at.get(p);
    if (!d || d.size !== 2) return false;
    return t === "h" ? d.has("E") && d.has("W") : d.has("N") && d.has("S");
  };
  const runs: [Point, Point][] = [];
  const used = new Set<string>();
  for (const u of [...units].sort()) {
    if (used.has(u)) continue;
    const t = u[0];
    const [, xs, ys] = u.split(":");
    let x0 = Number(xs);
    let y0 = Number(ys);
    // back to the start of the run
    while (through(pointKey(x0, y0), t)) {
      if (t === "h") x0 -= GRID;
      else y0 -= GRID;
    }
    let [x1, y1] = [x0, y0];
    for (;;) {
      const unit = `${t}:${x1}:${y1}`;
      if (!units.has(unit)) break;
      used.add(unit);
      if (t === "h") x1 += GRID;
      else y1 += GRID;
      if (!through(pointKey(x1, y1), t)) break;
    }
    runs.push([
      [x0, y0],
      [x1, y1],
    ]);
  }
  return runs;
}

function shifted(c: Component, dx: number, dy: number): Component {
  const move = <T extends { x: number; y: number }>(v: T): T => ({
    ...v,
    x: v.x + dx,
    y: v.y + dy,
  });
  return {
    ...c,
    location: move(c.location),
    bounds: move(c.bounds),
    ...(c.visualBounds ? { visualBounds: move(c.visualBounds) } : {}),
    ends: c.ends.map((e) => ({ ...e, location: move(e.location) })),
  };
}

// Lays out one definition by signal flow, or says why not: the definition
// is not a small sketch (flowIneligible) or the routes would not stand in
// Logisim as drawn.
export async function flowLayout(
  xml: string,
  circuit: string,
  focus: Focus,
  variant: FlowVariant = FLOW_VARIANTS[1],
): Promise<FlowLayout | { skipped: string }> {
  const ineligible = flowIneligible(focus);
  if (ineligible !== null) return { skipped: ineligible };
  const parts = focus.components.filter((c) => c.factoryName !== "Tunnel");
  if (!parts.length) return { skipped: "no parts" };

  // nets between parts; a Tunnel only names copper and becomes a wire
  const nets = new Map<string, [Component, End][]>();
  for (const c of parts)
    for (const e of c.ends) {
      if (!e.netBits?.length) continue;
      const k = netKey(e.netBits);
      if (!nets.has(k)) nets.set(k, []);
      nets.get(k)!.push([c, e]);
    }
  const wired = [...nets.values()]
    .filter((ends) => ends.length >= 2)
    .map(driverFirst);
  const links: [string, string][] = [];
  for (const [[source], ...targets] of wired)
    for (const [target] of targets)
      links.push([source.componentId, target.componentId]);
  const order = flowOrder(parts, links);
  const rankOf = new Map(order.map((c, i) => [c.componentId, i]));

  const boxes = new Map(parts.map((c) => [c.componentId, box(c)]));
  const children: ElkNode[] = order.map((c) => {
    const b = boxes.get(c.componentId)!;
    const options: Record<string, string> = {
      "elk.portConstraints": "FIXED_POS",
      "elk.alignment": "LEFT",
    };
    // a Pin whose port faces east sits left of the logic, one facing west
    // right of it; the facing is the interface and stays as drawn
    const facing = attr(c, "facing") ?? "east";
    if (c.factoryName === "Pin" && facing === "east")
      options["elk.layered.layering.layerConstraint"] = "FIRST";
    if (c.factoryName === "Pin" && facing === "west")
      options["elk.layered.layering.layerConstraint"] = "LAST";
    // pins keep their order (the instance's interface): ELK orders nodes
    // that carry a position by it and places the rest freely
    if (c.factoryName === "Pin")
      options["elk.position"] = `(${c.location.x},${c.location.y})`;
    return {
      id: c.componentId,
      // where it was drawn: the interactive strategies keep that order
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      layoutOptions: options,
      ports: c.ends.map((e) => ({
        id: portId(c, e),
        x: e.location.x - b.x,
        y: e.location.y - b.y,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": sideOf(c, e) },
      })),
    };
  });
  const netOfEdge = new Map<string, number>();
  const endsOfEdge = new Map<string, [Component, End][]>();
  const edges: ElkExtendedEdge[] = [];
  wired.forEach(([[sc, se], ...targets], n) => {
    for (const [tc, te] of [...targets].sort(
      ([a], [b]) => rankOf.get(a.componentId)! - rankOf.get(b.componentId)!,
    )) {
      const id = `e${edges.length}`;
      netOfEdge.set(id, n);
      endsOfEdge.set(id, [
        [sc, se],
        [tc, te],
      ]);
      edges.push({
        id,
        sources: [portId(sc, se)],
        targets: [portId(tc, te)],
        // a thick edge offsets its route by half the thickness: off the grid
        layoutOptions: { "elk.edge.thickness": "0" },
      });
    }
  });
  edges.sort(
    (a, b) =>
      rankOf.get(a.sources[0].split(":")[0])! -
        rankOf.get(b.sources[0].split(":")[0])! ||
      Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
  const started = performance.now();
  let laid: ElkNode;
  try {
    laid = await elk.layout({
      id: "root",
      layoutOptions: { ...OPTIONS, ...variant.options },
      children,
      edges,
    });
  } catch (error) {
    return {
      skipped: `layout failed: ${error instanceof Error ? error.message : error}`,
    };
  }
  const elkMs = Math.round(performance.now() - started);

  // place the drawing where the old one started
  const originX = Math.max(
    20,
    down(Math.min(...parts.map((c) => boxes.get(c.componentId)!.x))),
  );
  const originY = Math.max(
    20,
    down(Math.min(...parts.map((c) => boxes.get(c.componentId)!.y))),
  );
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of laid.children ?? []) {
    xs.push(n.x ?? 0);
    ys.push(n.y ?? 0);
  }
  const polylines: [string, Point[]][] = [];
  for (const e of (laid.edges ?? []) as ElkExtendedEdge[])
    for (const s of e.sections ?? []) {
      // ELK may keep a bend point in the middle of a straight run
      const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].filter(
        (p, i, all) =>
          i === 0 ||
          i === all.length - 1 ||
          !(
            (all[i - 1].x === p.x && p.x === all[i + 1].x) ||
            (all[i - 1].y === p.y && p.y === all[i + 1].y)
          ),
      );
      for (const p of points) {
        xs.push(p.x);
        ys.push(p.y);
      }
      polylines.push([e.id, points.map((p): Point => [p.x, p.y])]);
    }
  const dx0 = originX - Math.min(...xs);
  const dy0 = originY - Math.min(...ys);
  const onGrid = (v: number) => Number.isInteger(v) && v % GRID === 0;
  const offGrid = [dx0, dy0, ...xs, ...ys].find(
    (v) => !onGrid(Math.round(v * 1e6) / 1e6),
  );
  if (offGrid !== undefined) return { skipped: `off the grid (${offGrid})` };

  const placement = new Map<string, Point>();
  const moved = new Map<string, Component>();
  for (const n of laid.children ?? []) {
    const c = parts.find((p) => p.componentId === n.id)!;
    const b = boxes.get(c.componentId)!;
    const dx = Math.round((n.x ?? 0) + dx0 - b.x);
    const dy = Math.round((n.y ?? 0) + dy0 - b.y);
    placement.set(c.componentId, [dx, dy]);
    moved.set(c.componentId, shifted(c, dx, dy));
  }

  // the routes, net by net, as trees of grid units; ELK ends a route on the
  // box, so it is carried on to a port that sits inside its part's box (a
  // label wider than the body, a select input on a slanted edge)
  const copper = wired.map((): Units => new Set());
  const at = (c: Component, e: End): Point => {
    const p = moved.get(c.componentId)!.ends[c.ends.indexOf(e)].location;
    return [p.x, p.y];
  };
  for (const [id, raw] of polylines) {
    const points = raw.map(([x, y]): Point => [
      Math.round(x + dx0),
      Math.round(y + dy0),
    ]);
    const [[sc, se], [tc, te]] = endsOfEdge.get(id)!;
    const start = at(sc, se);
    const end = at(tc, te);
    if (start[0] !== points[0][0] || start[1] !== points[0][1])
      points.unshift(start);
    const last = points[points.length - 1];
    if (end[0] !== last[0] || end[1] !== last[1]) points.push(end);
    if (!addPolyline(copper[netOfEdge.get(id)!], points))
      return { skipped: "a route misses its port" };
  }
  const trees: Units[] = [];
  for (let n = 0; n < wired.length; n++) {
    const terminals = wired[n].map(([c, e]) => pointKey(...at(c, e)));
    const tree = netTree(copper[n], terminals);
    if (tree === null)
      return { skipped: `a net left unjoined at ${terminals[0]}` };
    trees.push(tree);
  }
  const conflict = standsAsDrawn(trees, wired, [...moved.values()]);
  if (conflict !== null) return { skipped: conflict };
  if (!pinOrderKept(parts, placement))
    return { skipped: "pin order would change" };

  // write it
  const tree = parseXml(xml);
  const element = tree
    .findall("circuit")
    .find((c) => c.get("name") === circuit);
  if (!element) return { skipped: "definition not found" };
  const elements = new Map<string, XmlElement>();
  for (const el of element.findall("comp")) {
    const [x, y] = loc(el.get("loc"));
    elements.set(`${x},${y},${el.get("name")}`, el);
  }
  const movedPins = new Map<string, Point>();
  for (const c of parts) {
    const el =
      elements.get(`${c.location.x},${c.location.y},${c.factoryName}`) ??
      [...elements.entries()].find(([k]) =>
        k.startsWith(`${c.location.x},${c.location.y},`),
      )?.[1];
    if (!el) return { skipped: `no element for ${c.componentId}` };
    const [dx, dy] = placement.get(c.componentId)!;
    const x = c.location.x + dx;
    const y = c.location.y + dy;
    el.set("loc", `(${x},${y})`);
    if (c.factoryName === "Pin")
      movedPins.set(`${c.location.x},${c.location.y}`, [x, y]);
  }
  const appearancePortsRepointed = repointPins(element, movedPins);
  for (const el of element.findall("wire")) element.remove(el);
  for (const el of element.findall("comp"))
    if (el.get("name") === "Tunnel") element.remove(el);
  const runs = trees
    .flatMap((t) => runsOf(t))
    .sort(
      ([a, b], [c, d]) =>
        a[1] - c[1] || a[0] - c[0] || b[1] - d[1] || b[0] - d[0],
    );
  const indent = element.children.length
    ? (element.children[0].tail ?? null)
    : null;
  for (const [a, b] of runs) {
    const last = element.children.at(-1);
    const closing = last?.tail ?? null;
    if (last && indent !== null) last.tail = indent;
    const w = subElement(element, "wire", {
      from: `(${a[0]},${a[1]})`,
      to: `(${b[0]},${b[1]})`,
    });
    w.tail = closing;
  }
  const after = spliceCircuit(xml, circuit, element);
  const wires: Wire[] = runs.map(([a, b]) => ({
    from: { x: a[0], y: a[1] },
    to: { x: b[0], y: b[1] },
  }));
  return {
    xml: after,
    placement,
    predicted: {
      ...focus,
      components: [...moved.values()],
      wires,
      wireBundles: [],
    },
    report: {
      engine: "flow",
      variant: variant.name,
      parts: parts.length,
      nets: wired.length,
      layers: new Set([...moved.values()].map((c) => c.bounds.x)).size,
      wires: runs.length,
      tunnelsRemoved: focus.components.length - parts.length,
      appearancePortsRepointed,
      elkMs,
    },
  };
}

// Whether the wires join exactly the ports they should in Logisim: nets meet
// only where one passes straight across the other, no wire touches a port of
// another net, and no wire runs through a body.
function standsAsDrawn(
  trees: Units[],
  wired: [Component, End][][],
  parts: Component[],
): string | null {
  const at = new Map<string, Map<number, Set<string>>>();
  trees.forEach((tree, n) => {
    for (const u of tree) {
      const [a, b] = unitEnds(u);
      const t = u[0];
      for (const [p, d] of [
        [a, t === "h" ? "E" : "S"],
        [b, t === "h" ? "W" : "N"],
      ]) {
        if (!at.has(p)) at.set(p, new Map());
        const nets = at.get(p)!;
        if (!nets.has(n)) nets.set(n, new Set());
        nets.get(n)!.add(d);
      }
    }
  });
  for (const [p, nets] of at) {
    if (nets.size < 2) continue;
    if (nets.size > 2) return `three nets meet at ${p}`;
    const [d1, d2] = [...nets.values()].map((d) => [...d].sort().join(""));
    const crossing =
      (d1 === "EW" && d2 === "NS") || (d1 === "NS" && d2 === "EW");
    if (!crossing) return `two nets touch at ${p}`;
  }
  // ports: on their own net's copper or on none
  const netOfPort = new Map<string, number>();
  wired.forEach((ends, n) => {
    for (const [c, e] of ends) netOfPort.set(portId(c, e), n);
  });
  for (const c of parts)
    for (const e of c.ends) {
      const nets = at.get(pointKey(e.location.x, e.location.y));
      if (!nets) continue;
      const own = netOfPort.get(portId(c, e));
      if ([...nets.keys()].some((n) => n !== own))
        return `a wire touches ${portId(c, e)}`;
    }
  // bodies: no unit inside one (edges may touch), except the straight lead
  // from a port inside the body (a select input under a slanted edge) out
  // through the side it leaves by
  const leads = new Set<string>();
  for (const c of parts)
    for (const e of c.ends) {
      const n = netOfPort.get(portId(c, e));
      if (n === undefined) continue;
      const b = c.bounds;
      const inside = (x: number, y: number) =>
        x > b.x && x < b.x + b.width && y > b.y && y < b.y + b.height;
      const [sx, sy] = {
        EAST: [GRID, 0],
        WEST: [-GRID, 0],
        NORTH: [0, -GRID],
        SOUTH: [0, GRID],
      }[sideOf(c, e)]!;
      let { x, y } = e.location;
      while (inside(x, y)) {
        const unit =
          sy === 0
            ? `h:${Math.min(x, x + sx)}:${y}`
            : `v:${x}:${Math.min(y, y + sy)}`;
        leads.add(`${c.componentId}|${n}|${unit}`);
        x += sx;
        y += sy;
      }
    }
  for (const [n, tree] of trees.entries())
    for (const u of tree) {
      const [a, b] = unitEnds(u);
      const [ax, ay] = a.split(",").map(Number);
      const [bx, by] = b.split(",").map(Number);
      for (const c of parts) {
        const r = c.bounds;
        const x0 = r.x + 1;
        const x1 = r.x + r.width - 1;
        const y0 = r.y + 1;
        const y1 = r.y + r.height - 1;
        const through =
          ay === by
            ? ay > y0 &&
              ay < y1 &&
              Math.max(ax, bx) > x0 &&
              Math.min(ax, bx) < x1
            : ax > x0 &&
              ax < x1 &&
              Math.max(ay, by) > y0 &&
              Math.min(ay, by) < y1;
        if (through && !leads.has(`${c.componentId}|${n}|${u}`))
          return `a wire crosses ${c.componentId}`;
      }
    }
  return null;
}

// Without a custom appearance the instance orders its ports by the Pins'
// positions per facing; the layout must not reorder them.
function pinOrderKept(
  parts: Component[],
  placement: Map<string, Point>,
): boolean {
  const groups = new Map<string, Component[]>();
  for (const c of parts)
    if (c.factoryName === "Pin") {
      const f = attr(c, "facing") ?? "east";
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f)!.push(c);
    }
  for (const [facing, pins] of groups) {
    const key = pinOrderKey(facing);
    const sortedBy = (where: (c: Component) => Point) =>
      [...pins]
        .sort((a, b) => {
          const [p, q] = [key(where(a)), key(where(b))];
          return p[0] - q[0] || p[1] - q[1];
        })
        .map((c) => c.componentId)
        .join("|");
    const before = sortedBy((c) => [c.location.x, c.location.y]);
    const after = sortedBy((c) => {
      const [dx, dy] = placement.get(c.componentId)!;
      return [c.location.x + dx, c.location.y + dy];
    });
    if (before !== after) return false;
  }
  return true;
}
