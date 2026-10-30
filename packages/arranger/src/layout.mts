// Placement and routing with ELK's layered algorithm: Sugiyama layering with
// port constraints and orthogonal hyperedge routing, the method netlistsvg
// and most schematic generators use.
//
// Each unit is one node: its parts, its captions, and the Tunnels and
// constants its ports carry (they stand just outside the port, so the node
// holds them and nothing is placed or routed over them). A wired net is a
// hyperedge from its driver to its sinks: ELK gives it one vertical trunk per
// channel, ordered with the others by crossing minimisation. Ports keep their
// real offsets (FIXED_POS); Pins facing east take the first layer and Pins
// facing west the last, in their original order. A group of the caller's
// organization is a compound node with its heading in the top padding, a row
// of groups is one graph, and rows stack from the top. Every size, offset
// and spacing is a multiple of the 10 px grid, so the drawing comes back on
// it.
//
// The routes are held against Logisim's connection rules (wiring.mts); a net
// whose copper would join another net, touch a foreign port or cross a body
// is drawn with Tunnels instead and the layout runs again, as is a wire net
// stretched across most of a large sheet.
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import { elk } from "./elk-worker.mts";
import {
  attr,
  down,
  GRID,
  pinOrderKey,
  textWidth,
  tunnelBox,
  up,
} from "./circuit.mts";
import type { Box, Point, Report } from "./circuit.mts";
import { FACING_TOWARD, footprint, newLabel, portId, STEP } from "./model.mts";
import type { Model, Net, Side, Terminal, Unit } from "./model.mts";
import type { Component } from "./types.mts";
import { compactX } from "./compaction.mts";
import { addPolyline, conflicts, netTree, pointKey, runsOf } from "./wiring.mts";
import type { Obstacle, PortMark, Units } from "./wiring.mts";

export interface Satellite {
  kind: "tunnel" | "constant";
  net: Net;
  // the terminals it serves (several for a comb of constants)
  terminals: Terminal[];
  // connection point, in the unit's original coordinates
  point: Point;
  facing: string;
  label: string | null;
  box: Box;
  // copper from the ports to the connection point
  leads: Point[][];
  // stepped aside of a wired port's lead
  aside?: boolean;
}

export interface Shape {
  unit: Unit;
  // the node: parts, captions, satellites, on the grid
  box: Box;
  satellites: Satellite[];
  satelliteOf: Map<Terminal, Satellite>;
  // where each wired terminal's wire leaves the box
  anchors: Map<Terminal, Point>;
  // captions moved out of the satellites' way, and by how much
  captionShift: Map<Component, Point>;
}

export interface Heading {
  text: string;
  font: string;
  // the source Text that heads the group instead, if any
  sourceId: string | null;
  width: number;
  height: number;
}

// A group or a stage of the caller's organization.
export interface Container {
  id: string;
  heading: Heading | null;
  children: Block[];
}
export type Block = Unit | Container;
export const isUnit = (b: Block): b is Unit => "parts" in b;

export interface Variant {
  name: string;
  options: Record<string, string>;
}

// A heading where it was drawn: the Text's location and box.
export interface PlacedHeading {
  heading: Heading;
  container: string;
  at: Point;
  box: Box;
}

export interface Drawing {
  variant: string;
  // junctions of rails drawn
  rails: number;
  shapes: Map<Unit, Shape>;
  // how far each unit moved
  shift: Map<Unit, Point>;
  // copper of each wired net, and of each net's satellite leads
  wires: Map<Net, Units>;
  leads: Map<Net, Units>;
  headings: PlacedHeading[];
  // the box of each group and stage, by its node id
  containers: Map<string, Box>;
  // how far each note moved, by id
  notesShift: Map<string, Point>;
  demoted: Report[];
  rounds: number;
  elkMs: number;
  extent: Box;
}

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
  "elk.json.edgeCoords": "ROOT",
};
const INTERACTIVE = {
  "elk.layered.layering.strategy": "INTERACTIVE",
  "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
  "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
};
const UNORDERED = { "elk.layered.considerModelOrder.strategy": "NONE" };
// the layers kept, the order within them found again
const RESWEEP = {
  ...INTERACTIVE,
  ...UNORDERED,
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
};

// Ways to choose the columns and the order within them. None suits every
// circuit, so a small definition is laid out several ways and the drawing
// that reads best is kept: network-simplex layering with a few seeds for
// crossing minimisation, the sketch's own columns and order, with and
// without the parts' given order, and longest-path layering.
export const VARIANTS: readonly Variant[] = [
  { name: "flow", options: {} },
  { name: "sketch", options: INTERACTIVE },
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

// The variants worth their time: about 400 unit-layouts in all.
export function variantsFor(units: number): Variant[] {
  return VARIANTS.slice(0, Math.max(1, Math.floor(400 / Math.max(units, 1))));
}

const ROW_GAP = 60;
const NOTE_GAP = 30;
const MARGIN = 40;
const MAX_ROUNDS = 6;
// A wire net longer than this (px from its driver to its farthest sink, by
// width) is drawn with Tunnels on a sheet; twice as long when it has no name.
const TUNNEL_SPAN = (width: number) => (width <= 1 ? 800 : width === 2 ? 600 : 500);

const constantSize = (net: Net): [number, number] => {
  const c = net.constant!;
  if (c.factoryName === "Constant") {
    const bits = Number(attr(c, "width") || 1);
    return [16 + 10 * Math.max(0, Math.floor((bits + 3) / 4) - 2), 16];
  }
  return [16, 16];
};

// The box of something drawn away from a port on `side`, standing on `q`:
// `length` along the side's direction, `thick` across it.
function awayBox(q: Point, side: Side, length: number, thick: number): Box {
  const h = Math.floor(thick / 2);
  if (side === "WEST") return [q[0] - length, q[1] - h, q[0], q[1] + h];
  if (side === "EAST") return [q[0], q[1] - h, q[0] + length, q[1] + h];
  if (side === "NORTH") return [q[0] - h, q[1] - length, q[0] + h, q[1]];
  return [q[0] - h, q[1], q[0] + h, q[1] + length];
}

const overlapBy = (a: Box, b: Box, min: number): boolean =>
  Math.min(a[2], b[2]) - Math.max(a[0], b[0]) >= min &&
  Math.min(a[3], b[3]) - Math.max(a[1], b[1]) >= min;

// Whether the straight lead p-q passes through the box.
const leadThrough = (p: Point, q: Point, b: Box): boolean => {
  if (p[1] === q[1])
    return (
      p[1] > b[1] &&
      p[1] < b[3] &&
      Math.max(p[0], q[0]) > b[0] &&
      Math.min(p[0], q[0]) < b[2]
    );
  return (
    p[0] > b[0] &&
    p[0] < b[2] &&
    Math.max(p[1], q[1]) > b[1] &&
    Math.min(p[1], q[1]) < b[3]
  );
};
const pathThrough = (path: Point[], b: Box): boolean =>
  path.some((p, i) => i > 0 && leadThrough(path[i - 1], p, b));
const lengthOf = (path: Point[]): number =>
  path.reduce((sum, p, i) => (i ? sum + Math.abs(p[0] - path[i - 1][0]) + Math.abs(p[1] - path[i - 1][1]) : 0), 0);

// Whether two axis-parallel paths touch anywhere (a crossing, a shared
// point, or one running along the other).
function pathsTouch(a: Point[], b: Point[]): boolean {
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, s] = [a[i - 1], a[i], b[j - 1], b[j]];
      if (
        Math.max(Math.min(p[0], q[0]), Math.min(r[0], s[0])) <= Math.min(Math.max(p[0], q[0]), Math.max(r[0], s[0])) &&
        Math.max(Math.min(p[1], q[1]), Math.min(r[1], s[1])) <= Math.min(Math.max(p[1], q[1]), Math.max(r[1], s[1]))
      )
        return true;
    }
  return false;
}

// Ports a path passes within 10 px of without ending on them, where the eye
// reads a junction (readability's port grazes).
function grazes(path: Point[], ports: Point[]): number {
  let n = 0;
  for (const [px, py] of ports)
    for (let i = 1; i < path.length; i++) {
      const [p, q] = [path[i - 1], path[i]];
      const on = (p[1] === q[1] ? py === p[1] : px === p[0]) &&
        Math.min(p[0], q[0]) <= px && px <= Math.max(p[0], q[0]) &&
        Math.min(p[1], q[1]) <= py && py <= Math.max(p[1], q[1]);
      if (on) continue;
      if (
        Math.min(p[0], q[0]) - 10 <= px &&
        px <= Math.max(p[0], q[0]) + 10 &&
        Math.min(p[1], q[1]) - 10 <= py &&
        py <= Math.max(p[1], q[1]) + 10
      ) {
        n += 1;
        break;
      }
    }
  return n;
}

const netOfTerminal = (model: Model, t: Terminal): Net =>
  model.netOfPort.get(portId(t.ports[0].part, t.ports[0].end))!;

// Constants that drive the same value; copper may join them.
export const constantKey = (net: Net): string => {
  const c = net.constant!;
  const value = c.factoryName === "Constant" ? `${attr(c, "value")}`.toLowerCase() : "";
  return `${c.factoryName}|${value}|${net.width}`;
};

// A constant standing on `q` with its body toward `dir`.
function constantAt(net: Net, q: Point, dir: Side): { facing: string; box: Box } {
  if (net.constant!.factoryName === "Constant") {
    const [w, h] = constantSize(net);
    const upright = dir === "NORTH" || dir === "SOUTH";
    return { facing: FACING_TOWARD[dir], box: upright ? awayBox(q, dir, h, w) : awayBox(q, dir, w, h) };
  }
  // Ground and Power are drawn toward their facing
  return { facing: dir.toLowerCase(), box: awayBox(q, dir, 16, 16) };
}

const union = (a: Box, b: Box): Box => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const CAPTION_GAP = 6;

const ALONG: Record<Side, [Side, Side]> = {
  WEST: ["NORTH", "SOUTH"],
  EAST: ["NORTH", "SOUTH"],
  NORTH: ["WEST", "EAST"],
  SOUTH: ["WEST", "EAST"],
};
const step = (p: Point, side: Side, n: number): Point => [p[0] + STEP[side][0] * n, p[1] + STEP[side][1] * n];

// The unit's node: its satellites placed clear of its parts, its captions
// and each other, and the points its wires leave by.
//
// Neighbouring ports tied to one constant value share one copy on a comb
// of copper. Neighbouring ports drawn with Tunnels closer than a flag is
// tall fan out: on the left or right of a part, the upper ones turn up and
// the lower ones down to flags standing side by side; above or below a
// part, a V of sideways flags. Every other satellite takes the shortest
// lead that keeps it clear.
export function shapeUnit(model: Model, unit: Unit): Shape {
  // a caption over or under the parts makes way for the satellites; one
  // beside them is in their way
  const partsBox = unit.parts.map(footprint).reduce(union);
  const below = unit.captions.filter((c) => footprint(c)[1] >= partsBox[3]);
  const above = unit.captions.filter((c) => footprint(c)[3] <= partsBox[1]);
  const solid: Box[] = [
    ...unit.parts.map(footprint),
    ...unit.captions.filter((c) => !below.includes(c) && !above.includes(c)).map(footprint),
  ];
  const satellites: Satellite[] = [];
  const satelliteOf = new Map<Terminal, Satellite>();
  const add = (s: Satellite) => {
    satellites.push(s);
    for (const t of s.terminals) satelliteOf.set(t, s);
  };
  const kindOf = (t: Terminal) => netOfTerminal(model, t).kind;
  const clear = (box: Box) => !solid.some((b) => overlapBy(box, b, 1)) && !satellites.some((s) => overlapBy(box, s.box, 1));
  // a wired port's lead runs straight out to the edge of the node
  const wiredLeads: Point[][] = unit.terminals
    .filter((t) => kindOf(t) === "wire")
    .map((t) => [t.point, step(t.point, t.side, 100)]);
  const onWiredLead = (box: Box) => wiredLeads.some((lead) => pathThrough(lead, box));
  const others = unit.terminals.map((t) => t.point);
  const bySide = new Map<Side, Terminal[]>();
  for (const t of unit.terminals) {
    if (!bySide.has(t.side)) bySide.set(t.side, []);
    bySide.get(t.side)!.push(t);
  }
  for (const [side, all] of [...bySide].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const axis = side === "WEST" || side === "EAST" ? 1 : 0;
    const along = (t: Terminal) => t.point[axis];
    all.sort((a, b) => along(a) - along(b) || a.point[1 - axis] - b.point[1 - axis]);
    // runs of neighbouring terminals in a line, by a key (null breaks a run)
    const runs = (keyOf: (t: Terminal) => string | null): Terminal[][] => {
      const result: Terminal[][] = [];
      let run: Terminal[] = [];
      let key: string | null = null;
      for (const t of all) {
        const k = keyOf(t);
        if (k !== null && k === key && t.point[1 - axis] === run[0].point[1 - axis]) run.push(t);
        else {
          if (run.length >= 2) result.push(run);
          run = k === null ? [] : [t];
          key = k;
        }
      }
      if (run.length >= 2) result.push(run);
      return result;
    };
    // the room beyond a run's end on this side: to the next terminal
    const room = (run: Terminal[], end: 0 | 1): number => {
      const i = all.indexOf(end ? run.at(-1)! : run[0]);
      const next = all[i + (end ? 1 : -1)];
      return next ? Math.abs(along(next) - along(end ? run.at(-1)! : run[0])) : Infinity;
    };
    const [before, after] = ALONG[side];

    // combs of constants
    for (const run of runs((t) => (kindOf(t) === "constant" ? constantKey(netOfTerminal(model, t)) : null))) {
      const net = netOfTerminal(model, run[0]);
      const stubs = run.map((t) => [t.point, step(t.point, side, 1)]);
      const bus = [stubs[0][1], stubs.at(-1)![1]];
      const power = net.constant!.factoryName === "Power";
      const options: [0 | 1, boolean][] = power
        ? [[0, false], [1, false], [0, true], [1, true]]
        : [[1, false], [0, false], [1, true], [0, true]];
      for (const [end, corner] of options) {
        const from = end ? bus[1] : bus[0];
        let q: Point;
        let dir: Side;
        if (corner) {
          q = step(from, side, 1);
          dir = side;
        } else {
          if (room(run, end) < 40) continue;
          dir = end ? after : before;
          q = step(from, dir, 1);
        }
        const { facing, box } = constantAt(net, q, dir);
        if (!clear(box)) continue;
        add({
          kind: "constant",
          net,
          terminals: run,
          point: q,
          facing,
          label: null,
          box,
          leads: [...stubs, bus, [from, q]],
        });
        break;
      }
    }

    // fans of Tunnels
    // too close for their flags: sideways flags 23 px tall, upright ones
    // as wide as their labels
    const flagWidth = (t: Terminal) => textWidth(netOfTerminal(model, t).label ?? "");
    const tooClose = (a: Terminal, b: Terminal) =>
      along(b) - along(a) < (axis === 1 ? 24 : (flagWidth(a) + flagWidth(b)) / 2 + 4);
    const dense = runs((t) => (kindOf(t) === "tunnel" && !satelliteOf.has(t) ? "tunnel" : null)).filter((run) =>
      run.some((t, i) => i > 0 && tooClose(run[i - 1], t)),
    );
    for (const run of dense) {
      if (axis === 0) {
        // above or below a part: a V of sideways flags, the outer ports
        // shortest, flags pointing out
        if (all.some((t) => kindOf(t) === "wire")) continue;
        const k = run.length;
        const half = Math.ceil(k / 2);
        run.forEach((t, i) => {
          const left = i < half;
          const q = step(t.point, side, 2 + 3 * (left ? i : k - 1 - i));
          const facing = left ? "east" : "west";
          const net = netOfTerminal(model, t);
          add({
            kind: "tunnel",
            net,
            terminals: [t],
            point: q,
            facing,
            label: net.label,
            box: tunnelBox(q[0], q[1], facing, net.label ?? ""),
            leads: [[t.point, q]],
          });
        });
        continue;
      }
      // left or right of a part: the upper ports turn up, the lower ones
      // down, each group's flags side by side, the turn nearest the part
      // for the outer port
      const upward = room(run, 0) >= 60;
      const downward = room(run, 1) >= 60;
      if (!upward && !downward) continue;
      const split = upward && downward ? Math.ceil(run.length / 2) : upward ? run.length : 0;
      const groups: [Terminal[], Side][] = [
        [run.slice(0, split), "NORTH"],
        [run.slice(split).reverse(), "SOUTH"],
      ];
      const placed: Satellite[] = [];
      for (const [group, dir] of groups) {
        let reach = 0;
        let previousHalf = 0;
        const edge = dir === "NORTH" ? along(group[0] ?? run[0]) - 20 : along(group[0] ?? run[0]) + 20;
        for (const t of group) {
          const net = netOfTerminal(model, t);
          const half = Math.ceil(textWidth(net.label ?? "") / 2);
          reach = up(reach ? reach + previousHalf + half + 10 : half + 10);
          previousHalf = half;
          const turn = step(t.point, side, reach / GRID);
          const q: Point = [turn[0], edge];
          const facing = FACING_TOWARD[dir];
          placed.push({
            kind: "tunnel",
            net,
            terminals: [t],
            point: q,
            facing,
            label: net.label,
            box: tunnelBox(q[0], q[1], facing, net.label ?? ""),
            leads: [[t.point, turn, q]],
          });
        }
      }
      if (placed.every((s) => clear(s.box) && !onWiredLead(s.box))) placed.forEach(add);
    }

    // the rest, one by one: the shortest lead straight out that keeps the
    // satellite clear; out and aside when every one straight out stands on
    // a wired port's lead (a Tunnel on a full adder's sum over its carry
    // wire) and the way aside is free
    for (const t of all) {
      const kind = kindOf(t);
      if ((kind !== "tunnel" && kind !== "constant") || satelliteOf.has(t)) continue;
      const net = netOfTerminal(model, t);
      const satelliteAt = (path: Point[]): Satellite => {
        const q = path.at(-1)!;
        const facing = kind === "tunnel" ? FACING_TOWARD[side] : constantAt(net, q, side).facing;
        return {
          kind: kind === "tunnel" ? "tunnel" : "constant",
          net,
          terminals: [t],
          point: q,
          facing,
          label: kind === "tunnel" ? net.label : null,
          box: kind === "tunnel" ? tunnelBox(q[0], q[1], facing, net.label ?? "") : constantAt(net, q, side).box,
          leads: [path],
        };
      };
      const costOf = (s: Satellite): number => {
        const path = s.leads[0];
        let cost = lengthOf(path) / 100 + (path.length - 2);
        for (const b of solid) if (overlapBy(s.box, b, 1)) cost += 20;
        for (const o of satellites) {
          if (overlapBy(s.box, o.box, 3)) cost += 3;
          if (pathThrough(path, o.box)) cost += 4;
          if (o.leads.some((lead) => pathThrough(lead, s.box))) cost += 4;
        }
        if (onWiredLead(s.box)) cost += 4;
        // past the turn the lead is no longer the port's own
        return cost + 6 * grazes(path.slice(1), others);
      };
      let best: { cost: number; s: Satellite } | null = null;
      for (const lead of [0, 10, 20, 30, 40]) {
        const s = satelliteAt([t.point, step(t.point, side, lead / GRID)]);
        const cost = costOf(s);
        if (!best || cost < best.cost) best = { cost, s };
      }
      if (model.stepAside && onWiredLead(best!.s.box))
        for (const out of [10, 20])
          for (const dir of ALONG[side])
            for (const aside of [10, 20]) {
              const turn = step(t.point, side, out / GRID);
              const path = [t.point, turn, step(turn, dir, aside / GRID)];
              const s = satelliteAt(path);
              if (!clear(s.box) || onWiredLead(s.box)) continue;
              // nothing else on the way aside: no port, satellite or wired lead
              const span = [path[1][axis], path[2][axis]].sort((a, b) => a - b);
              if (all.some((u) => u !== t && along(u) >= span[0] && along(u) <= span[1])) continue;
              if (others.some((o) => o !== t.point && pathsTouch(path, [o, o]))) continue;
              if (satellites.some((o) => o.leads.some((lead) => pathsTouch(path, lead)))) continue;
              if (wiredLeads.some((lead) => pathsTouch(path.slice(1), lead))) continue;
              const cost = costOf(s);
              if (cost < best!.cost) best = { cost, s: { ...s, aside: true } };
            }
      const chosen = best!.s;
      if (chosen.leads[0].length === 2) chosen.leads = [[t.point, chosen.point]];
      add(chosen);
    }
  }
  // what the satellites cover: flags, bodies and leads
  const covered: Box[] = satellites.flatMap((s) => [
    s.box,
    ...s.leads.flatMap((path) =>
      path.slice(1).map((q, i): Box => {
        const p = path[i];
        return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
      }),
    ),
  ]);
  const captionShift = new Map<Component, Point>();
  for (const [group, dir] of [
    [below, 1],
    [above, -1],
  ] as const) {
    let d = 0;
    for (const c of group) {
      const b = footprint(c);
      for (const k of covered)
        if (Math.min(k[2], b[2]) - Math.max(k[0], b[0]) > 0)
          d = Math.max(d, dir === 1 ? k[3] + CAPTION_GAP - b[1] : b[3] - (k[1] - CAPTION_GAP));
    }
    if (d > 0) for (const c of group) captionShift.set(c, [0, dir * up(d)]);
  }
  let box: Box = unit.parts.map(footprint).reduce(union);
  const grow = (b: Box) => {
    box = union(box, b);
  };
  for (const c of unit.captions) {
    const [dx, dy] = captionShift.get(c) ?? [0, 0];
    const b = footprint(c);
    grow([b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy]);
  }
  for (const k of covered) grow(k);
  for (const t of unit.terminals) grow([t.point[0], t.point[1], t.point[0], t.point[1]]);
  for (const lines of unit.copper?.values() ?? [])
    for (const line of lines) for (const [x, y] of line) grow([x, y, x, y]);
  box = [down(box[0]), down(box[1]), up(box[2]), up(box[3])];
  const anchors = new Map<Terminal, Point>();
  for (const t of unit.terminals) {
    if (kindOf(t) !== "wire") continue;
    const [x, y] = t.point;
    anchors.set(
      t,
      t.side === "WEST"
        ? [box[0], y]
        : t.side === "EAST"
          ? [box[2], y]
          : t.side === "NORTH"
            ? [x, box[1]]
            : [x, box[3]],
    );
  }
  return { unit, box, satellites, satelliteOf, anchors, captionShift };
}

// Units in the order ELK should meet them: input Pins, then the signal flow
// with a storage output that closes a loop to logic drawn before it treated
// as feedback, then output Pins. ELK breaks cycles against this order, so a
// register's output wire goes back around to the logic before it, the way a
// counter is drawn, and the stages of a pipeline stay in their order.
export function flowOrder(model: Model): Unit[] {
  const units = model.units;
  const links: [Unit, Unit][] = [];
  for (const net of model.nets) {
    if (net.terminals.length < 2) continue;
    const drivers = net.terminals.filter((t) => t.direction === "output");
    for (const d of drivers)
      for (const t of net.terminals)
        if (t.unit !== d.unit) links.push([d.unit, t.unit]);
  }
  const next = new Map<Unit, Set<Unit>>();
  for (const [a, b] of links) {
    if (!next.has(a)) next.set(a, new Set());
    next.get(a)!.add(b);
  }
  const reaches = (from: Unit, to: Unit): boolean => {
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
  const stores = (u: Unit) => u.parts.some((c) => c.storage);
  const indegree = new Map(units.map((u) => [u, 0]));
  const successors = new Map<Unit, Unit[]>();
  const seenLink = new Set<string>();
  for (const [a, b] of links) {
    const k = `${a.id}>${b.id}`;
    if (seenLink.has(k)) continue;
    seenLink.add(k);
    // a loop through storage is broken where the drawing goes back: a
    // pipeline register keeps its place between the stages it joins
    if (stores(a) && reaches(b, a) && b.box[0] <= a.box[0]) continue;
    indegree.set(b, indegree.get(b)! + 1);
    if (!successors.has(a)) successors.set(a, []);
    successors.get(a)!.push(b);
  }
  const kind = (u: Unit) => {
    const c = constraintOf(u);
    return c === "FIRST" ? 0 : c === "LAST" ? 2 : 1;
  };
  const priority = (u: Unit): [number, number, number] => {
    const k = kind(u);
    return k === 1 ? [1, u.box[0], u.box[1]] : [k, u.box[1], u.box[0]];
  };
  const sorted = [...units].sort((a, b) => {
    const [p, q] = [priority(a), priority(b)];
    return p[0] - q[0] || p[1] - q[1] || p[2] - q[2];
  });
  const order: Unit[] = [];
  const placed = new Set<Unit>();
  while (order.length < units.length) {
    const pick =
      sorted.find((u) => !placed.has(u) && indegree.get(u)! <= 0) ??
      sorted.find((u) => !placed.has(u))!;
    placed.add(pick);
    order.push(pick);
    for (const b of successors.get(pick) ?? []) indegree.set(b, indegree.get(b)! - 1);
  }
  return order;
}

// A unit holding Pins of one kind keeps to the edge of the drawing its
// Pins face from: east-facing Pins (and inputs facing up or down) in the
// first layer, west-facing Pins (and such outputs) in the last.
function constraintOf(u: Unit): "FIRST" | "LAST" | null {
  let result: "FIRST" | "LAST" | null = null;
  for (const c of u.parts) {
    if (c.factoryName !== "Pin") continue;
    const facing = attr(c, "facing") ?? "east";
    const output = attr(c, "output") === "true";
    const want =
      facing === "east" ? "FIRST" : facing === "west" ? "LAST" : output ? "LAST" : "FIRST";
    if (result && result !== want) return null;
    result = want;
  }
  return result;
}

// The order hint of a unit holding Pins: the y of its east- or west-facing
// Pin, the x of one facing up or down (the order Logisim numbers them in).
function pinPosition(u: Unit): Point | null {
  const pin = u.parts.find((c) => c.factoryName === "Pin");
  if (!pin) return null;
  const facing = attr(pin, "facing") ?? "east";
  const { x, y } = pin.location;
  return facing === "north" || facing === "south" ? [y, x] : [x, y];
}

interface Laid {
  // top-left of each unit's box, and the box of each container
  at: Map<Unit, Point>;
  boxes: Map<Container, Box>;
  routes: Map<Net, Point[][]>;
  // positions relative to the parent, for the next pass
  relative: Map<string, Point>;
  ms: number;
  // junctions of rails drawn
  rails: number;
}

// The air taken out of a laid-out row, across and then down, without
// changing what crosses what (compaction.mts). ELK makes a layer as wide as
// its widest node and spreads a layer's nodes to straighten edges, so a big
// row is mostly empty.
function compactRow(laid: Laid, shapes: Map<Unit, Shape>): void {
  const units = [...laid.at.keys()];
  const nets = [...laid.routes.keys()];
  for (const across of [true, false]) {
    const flip = (p: Point): Point => (across ? p : [p[1], p[0]]);
    const parts = units.map((u) => {
      const shape = shapes.get(u)!;
      const [x, y] = laid.at.get(u)!;
      const [x0, y0, x1, y1] = shape.box;
      const [a, b] = [flip([x, y]), flip([x + x1 - x0, y + y1 - y0])];
      return {
        boxes: [[a[0], a[1], b[0], b[1]] as const],
        ports: [...shape.anchors.values()].map(([px, py]) => flip([x + px - x0, y + py - y0])),
      };
    });
    const segmentNet: Net[] = [];
    const wires: [Point, Point, boolean][] = [];
    for (const net of nets) {
      const copper: Units = new Set();
      for (const line of laid.routes.get(net)!) addPolyline(copper, line);
      for (const [a, b] of runsOf(copper)) {
        segmentNet.push(net);
        wires.push([flip(a), flip(b), false]);
      }
    }
    const [shift, moved] = compactX(parts, wires, { partGap: 30, wireGap: 20 });
    units.forEach((u, i) => {
      const [x, y] = laid.at.get(u)!;
      laid.at.set(u, across ? [x + shift[i], y] : [x, y + shift[i]]);
    });
    laid.routes = new Map(nets.map((n) => [n, []]));
    moved.forEach(([a, b], k) => laid.routes.get(segmentNet[k])!.push([flip(a), flip(b)]));
  }
}

const unitsOf = (blocks: Block[]): Unit[] =>
  blocks.flatMap((b) => (isUnit(b) ? [b] : unitsOf(b.children)));

// One ELK run over a row of blocks. `nets` are its edges; only the routes of
// `wired` ones are kept. `hint` (positions relative to the parent) feeds the
// interactive strategies; without it the original drawing does.
async function runElk(
  shapes: Map<Unit, Shape>,
  blocks: Block[],
  rank: Map<Unit, number>,
  nets: Net[],
  wired: ReadonlySet<Net>,
  variant: Variant,
  hint: Map<string, Point> | null,
  rails: boolean,
): Promise<Laid | { failed: string }> {
  const units = unitsOf(blocks);
  const hierarchical = blocks.some((b) => !isUnit(b));
  const big = units.length > 150;
  const options: Record<string, string> = {
    ...OPTIONS,
    ...(big ? { "elk.layered.thoroughness": "7" } : {}),
    ...variant.options,
  };
  // On nested graphs ELK's interactive strategies do not finish and its
  // model-order cycle breaking fails on edges between groups
  if (hierarchical) {
    for (const key of Object.keys(INTERACTIVE))
      if (options[key] === "INTERACTIVE") delete options[key];
    options["elk.layered.cycleBreaking.strategy"] = "GREEDY";
    options["elk.layered.considerModelOrder.strategy"] = "NONE";
  }
  const inner = { ...options };
  delete inner["elk.json.edgeCoords"];
  if (hierarchical) options["elk.hierarchyHandling"] = "INCLUDE_CHILDREN";
  // where each net meets each unit, by the point its edge attaches at
  const portPoint = (t: Terminal): Point => {
    const shape = shapes.get(t.unit)!;
    const anchor = shape.anchors.get(t);
    if (anchor) return anchor;
    const s = shape.satelliteOf.get(t);
    const [x0, y0, x1, y1] = shape.box;
    const q = s?.point ?? t.point;
    return t.side === "WEST"
      ? [x0, q[1]]
      : t.side === "EAST"
        ? [x1, q[1]]
        : t.side === "NORTH"
          ? [q[0], y0]
          : [q[0], y1];
  };
  const terminalsOf = new Map<Unit, [Net, Terminal][]>();
  for (const net of nets)
    for (const t of net.terminals) {
      if (!rank.has(t.unit)) continue;
      if (!terminalsOf.has(t.unit)) terminalsOf.set(t.unit, []);
      terminalsOf.get(t.unit)!.push([net, t]);
    }
  const portOf = new Map<string, string>();
  const leaf = (u: Unit): ElkNode => {
    const shape = shapes.get(u)!;
    const [x0, y0, x1, y1] = shape.box;
    const nodeOptions: Record<string, string> = {
      "elk.portConstraints": "FIXED_POS",
      "elk.alignment": "LEFT",
    };
    const constraint = constraintOf(u);
    if (constraint) nodeOptions["elk.layered.layering.layerConstraint"] = constraint;
    const position = pinPosition(u);
    if (position) nodeOptions["elk.position"] = `(${position[0]},${position[1]})`;
    const ports: NonNullable<ElkNode["ports"]> = [];
    for (const [, t] of terminalsOf.get(u) ?? []) {
      const p = portPoint(t);
      const key = `${u.id}|${p[0]},${p[1]}`;
      if (portOf.has(key)) continue;
      const id = `${u.id}.${ports.length}`;
      portOf.set(key, id);
      ports.push({
        id,
        x: p[0] - x0,
        y: p[1] - y0,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": t.side },
      });
    }
    const at = hint?.get(u.id) ?? [x0, y0];
    return {
      id: u.id,
      x: at[0],
      y: at[1],
      width: x1 - x0,
      height: y1 - y0,
      layoutOptions: nodeOptions,
      ports,
    };
  };
  // boxes side by side keep the given order, left to right
  const ordered = (list: Block[], nodes: ElkNode[], options: Record<string, string>) => {
    if (list.filter((b) => !isUnit(b)).length < 2) return;
    options["elk.partitioning.activate"] = "true";
    nodes.forEach((n, i) => {
      n.layoutOptions = { ...n.layoutOptions, "elk.partitioning.partition": String(i) };
    });
  };
  const compound = (c: Container): ElkNode => {
    const top = c.heading ? up(c.heading.height + 10) : 20;
    const minimum = c.heading ? c.heading.width + 40 : 20;
    const at = hint?.get(c.id);
    const layoutOptions: Record<string, string> = {
      ...inner,
      "elk.padding": `[top=${top},left=20,bottom=20,right=20]`,
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${up(minimum)},${top + 20})`,
    };
    const nodes = c.children.map(build);
    ordered(c.children, nodes, layoutOptions);
    return {
      id: c.id,
      ...(at ? { x: at[0], y: at[1] } : {}),
      layoutOptions,
      children: nodes,
    };
  };
  const build = (b: Block): ElkNode => (isUnit(b) ? leaf(b) : compound(b));
  const children = blocks.map(build);
  ordered(blocks, children, options);
  // each net's driver and the ports it reaches in this row
  const ends = new Map<Net, { source: string; driver: Terminal; sinks: [Terminal, string][] }>();
  for (const net of nets) {
    const terms = net.terminals.filter((t) => rank.has(t.unit));
    if (terms.length < 2) continue;
    const byRank = [...terms].sort((a, b) => rank.get(a.unit)! - rank.get(b.unit)!);
    const driver =
      byRank.find((t) => t.direction === "output") ??
      byRank.find((t) => t.direction === "inout") ??
      byRank[0];
    const p = portPoint(driver);
    const source = portOf.get(`${driver.unit.id}|${p[0]},${p[1]}`)!;
    const sinks: [Terminal, string][] = [];
    for (const t of byRank) {
      if (t === driver) continue;
      const q = portPoint(t);
      const target = portOf.get(`${t.unit.id}|${q[0]},${q[1]}`)!;
      if (target === source || sinks.some(([, s]) => s === target)) continue;
      sinks.push([t, target]);
    }
    if (sinks.length) ends.set(net, { source, driver, sinks });
  }
  const graph = (junctions: Junction[]) => {
    const edges: ElkExtendedEdge[] = [];
    const netOfEdge = new Map<string, Net>();
    const edge = (net: Net, source: string, target: string) => {
      const id = `e${edges.length}n${net.index}`;
      netOfEdge.set(id, net);
      edges.push({ id, sources: [source], targets: [target], layoutOptions: { "elk.edge.thickness": "0" } });
    };
    const via = new Map<string, Junction>();
    for (const j of junctions) for (const s of j.sinks) via.set(`${j.net.index}|${s}`, j);
    for (const [net, { source, sinks }] of ends) {
      for (const j of junctions) if (j.net === net) edge(net, source, `${j.id}.w`);
      for (const [, target] of sinks) {
        const j = via.get(`${net.index}|${target}`);
        edge(net, j ? `${j.id}.e` : source, target);
      }
    }
    const nodes: ElkNode[] = junctions.map((j) => ({
      id: j.id,
      x: j.x,
      y: j.y,
      width: 0,
      height: 0,
      layoutOptions: { "elk.portConstraints": "FIXED_POS", "elk.alignment": "LEFT" },
      ports: [
        { id: `${j.id}.w`, x: 0, y: 0, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } },
        { id: `${j.id}.e`, x: 0, y: 0, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } },
      ],
    }));
    return { edges, netOfEdge, nodes };
  };
  const started = performance.now();
  let { edges, netOfEdge } = graph([]);
  let laid: ElkNode;
  let railCount = 0;
  try {
    laid = await elk.layout({ id: "root", layoutOptions: options, children, edges });
    // A net reaching several ports of one layer from further back gets one
    // trunk in the channel before them (a rail), from a junction in the
    // layer before, instead of a line per port through that layer.
    const junctions = rails && !hierarchical ? railsOf(laid, children, ends, wired) : [];
    railCount = junctions.length;
    if (junctions.length) {
      const placed = new Map((laid.children ?? []).map((n) => [n.id, n]));
      const again = graph(junctions);
      const moved = children.map((c) => ({ ...c, x: placed.get(c.id)?.x ?? c.x, y: placed.get(c.id)?.y ?? c.y }));
      // the junctions' own order, or the order crossing minimisation finds
      // with them in place, whichever crosses less
      let fewest = Infinity;
      for (const strategy of [INTERACTIVE, RESWEEP]) {
        const out = await elk.layout({
          id: "root",
          layoutOptions: { ...options, ...strategy },
          children: structuredClone([...moved, ...again.nodes]),
          edges: structuredClone(again.edges),
        });
        const n = crossingsOf(out, again.netOfEdge);
        if (n < fewest) {
          fewest = n;
          laid = out;
        }
      }
      laid.children = (laid.children ?? []).filter((n) => !n.id.startsWith("j"));
      ({ edges, netOfEdge } = again);
    }
  } catch (error) {
    return { failed: `layout failed: ${error instanceof Error ? error.message : error}` };
  }
  const ms = Math.round(performance.now() - started);
  const byId = new Map<string, Block>();
  const index = (b: Block) => {
    byId.set(b.id, b);
    if (!isUnit(b)) b.children.forEach(index);
  };
  blocks.forEach(index);
  const at = new Map<Unit, Point>();
  const boxes = new Map<Container, Box>();
  const relative = new Map<string, Point>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    const x = (n.x ?? 0) + ox;
    const y = (n.y ?? 0) + oy;
    relative.set(n.id, [n.x ?? 0, n.y ?? 0]);
    const b = byId.get(n.id)!;
    if (isUnit(b)) at.set(b, [x, y]);
    else {
      boxes.set(b, [x, y, x + (n.width ?? 0), y + (n.height ?? 0)]);
      for (const c of n.children ?? []) walk(c, x, y);
    }
  };
  for (const n of laid.children ?? []) walk(n, 0, 0);
  const routes = new Map<Net, Point[][]>();
  for (const e of (laid.edges ?? []) as ElkExtendedEdge[]) {
    const net = netOfEdge.get(e.id);
    if (!net || !wired.has(net)) continue;
    for (const s of e.sections ?? []) {
      // ELK keeps a bend point where a long edge passed a layer, in the
      // middle of a straight run (and off the grid when the layer is odd)
      const all = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      const points = all
        .filter(
          (p, i) =>
            i === 0 ||
            i === all.length - 1 ||
            !(
              (all[i - 1].x === p.x && p.x === all[i + 1].x) ||
              (all[i - 1].y === p.y && p.y === all[i + 1].y)
            ),
        )
        .map((p): Point => [p.x, p.y]);
      if (!routes.has(net)) routes.set(net, []);
      routes.get(net)!.push(points);
    }
  }
  return { at, boxes, routes, relative, ms, rails: railCount };
}

// Where routes of different nets cross, counted on ELK's output.
function crossingsOf(laid: ElkNode, netOfEdge: Map<string, Net>): number {
  const across: [number, number, number, Net][] = [];
  const along: [number, number, number, Net][] = [];
  for (const e of (laid.edges ?? []) as ElkExtendedEdge[]) {
    const net = netOfEdge.get(e.id)!;
    for (const s of e.sections ?? []) {
      const all = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      for (let i = 0; i + 1 < all.length; i++) {
        const [p, q] = [all[i], all[i + 1]];
        if (p.y === q.y && p.x !== q.x) across.push([Math.min(p.x, q.x), Math.max(p.x, q.x), p.y, net]);
        else if (p.x === q.x && p.y !== q.y) along.push([Math.min(p.y, q.y), Math.max(p.y, q.y), p.x, net]);
      }
    }
  }
  const points = new Set<string>();
  for (const [x0, x1, y, a] of across)
    for (const [y0, y1, x, b] of along)
      if (a !== b && x > x0 && x < x1 && y > y0 && y < y1) points.add(`${x},${y}`);
  return points.size;
}

interface Junction {
  id: string;
  net: Net;
  x: number;
  y: number;
  // the ports it feeds
  sinks: Set<string>;
}

// The rails a layout calls for: for each net, each layer holding two or more
// of its ports two or more layers after its driver. Layers are read off the
// laid-out nodes (aligned left within their layer).
function railsOf(
  laid: ElkNode,
  children: ElkNode[],
  ends: Map<Net, { source: string; driver: Terminal; sinks: [Terminal, string][] }>,
  wired: ReadonlySet<Net>,
): Junction[] {
  const nodes = laid.children ?? [];
  const xs = [...new Set(nodes.map((n) => n.x ?? 0))].sort((a, b) => a - b);
  const layerX: number[] = [];
  for (const x of xs) if (!layerX.length || x - layerX.at(-1)! > 1) layerX.push(x);
  const layerOf = new Map<string, number>();
  for (const n of nodes) layerOf.set(n.id, layerX.findIndex((x) => Math.abs(x - (n.x ?? 0)) <= 1));
  const portY = new Map<string, number>();
  const placed = new Map(nodes.map((n) => [n.id, n]));
  for (const c of children)
    for (const p of c.ports ?? []) portY.set(p.id, (placed.get(c.id)?.y ?? 0) + (p.y ?? 0));
  const junctions: Junction[] = [];
  for (const [net, { driver, sinks }] of ends) {
    if (!wired.has(net)) continue;
    const from = layerOf.get(driver.unit.id) ?? -1;
    const byLayer = new Map<number, string[]>();
    for (const [t, target] of sinks) {
      const l = layerOf.get(t.unit.id) ?? -1;
      if (l < from + 2) continue;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(target);
    }
    for (const [l, targets] of byLayer) {
      if (targets.length < 2) continue;
      const y = targets.reduce((sum, t) => sum + portY.get(t)!, 0) / targets.length;
      junctions.push({
        id: `j${net.index}.${l}`,
        net,
        x: layerX[l - 1],
        y: Math.round(y / GRID) * GRID,
        sinks: new Set(targets),
      });
    }
  }
  return junctions;
}

// Where the drawing goes: where its parts started, unless that covers
// something that stays; then below or right of what stays, whichever keeps
// the sheet smaller.
function chooseOrigin(model: Model, width: number, height: number): Point {
  const movable: Box[] = [...model.units.map((u) => u.box), ...model.notes.map(footprint)];
  const start: Point = movable.length
    ? [down(Math.min(...movable.map((b) => b[0]))), down(Math.min(...movable.map((b) => b[1])))]
    : [0, 0];
  const fixed: Box[] = [];
  for (const id of model.fixed.keys()) {
    const c = model.byId.get(id);
    if (c) fixed.push(footprint(c));
  }
  for (const t of model.tunnels)
    if (model.keptTunnels.has(t.componentId)) fixed.push(footprint(t));
  for (const w of model.keptWires)
    fixed.push([
      Math.min(w.from.x, w.to.x),
      Math.min(w.from.y, w.to.y),
      Math.max(w.from.x, w.to.x),
      Math.max(w.from.y, w.to.y),
    ]);
  fixed.push(...model.frames);
  if (model.panelBelowY !== null) fixed.push([-1e9, -1e9, 1e9, model.panelBelowY]);
  if (!fixed.length) return start;
  const clear = (o: Point) => {
    const b: Box = [o[0] - 20, o[1] - 20, o[0] + width + 20, o[1] + height + 20];
    return !fixed.some((f) => overlapBy(b, f, 0.5));
  };
  if (clear(start)) return start;
  const real = fixed.filter((f) => f[0] > -1e9);
  const fx1 = Math.max(...real.map((f) => f[2]), start[0]);
  const fy1 = Math.max(...real.map((f) => f[3]), model.panelBelowY ?? -1e9, start[1]);
  const below: Point = [start[0], up(fy1) + MARGIN];
  const right: Point = [up(fx1) + MARGIN, start[1]];
  if (model.panelBelowY !== null || !clear(right)) return below;
  const area = (o: Point) => {
    const xs = [...real.flatMap((f) => [f[0], f[2]]), o[0], o[0] + width];
    const ys = [...real.flatMap((f) => [f[1], f[3]]), o[1], o[1] + height];
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  };
  return area(right) < area(below) ? right : below;
}

const onGrid = (v: number) => Math.abs(v - Math.round(v / GRID) * GRID) < 1e-6;

// Notes in their order from the top, side by side as they were, long gaps
// between them shortened: each note's place in the block, and its size.
function stackNotes(notes: Component[]): { offsets: Map<Component, Point>; width: number; height: number } | null {
  if (!notes.length) return null;
  const sorted = [...notes].sort((a, b) => footprint(a)[1] - footprint(b)[1]);
  const left = Math.min(...sorted.map((c) => footprint(c)[0]));
  const top = footprint(sorted[0])[1];
  const offsets = new Map<Component, Point>();
  let bottom = top;
  let lift = 0;
  for (const c of sorted) {
    const b = footprint(c);
    if (b[1] - lift > bottom + NOTE_GAP) lift = b[1] - bottom - NOTE_GAP;
    offsets.set(c, [b[0] - left, b[1] - lift - top]);
    bottom = Math.max(bottom, b[3] - lift);
  }
  return { offsets, width: Math.max(...sorted.map((c) => footprint(c)[2])) - left, height: bottom - top };
}

function demote(model: Model, net: Net, reason: string): void {
  net.kind = "tunnel";
  net.reason = reason;
  net.label = net.labels[0] ?? newLabel(model, net);
}

// Lays the model out as rows of blocks (the whole definition as one row when
// there is no organization), drawing a net with Tunnels wherever its wire
// would not stand, until it does.
export async function drawModel(
  model: Model,
  variant: Variant,
  rows: Block[][],
  rails = true,
): Promise<Drawing | { failed: string }> {
  const order = flowOrder(model);
  const rank = new Map(order.map((u, i) => [u, i]));
  const rowOf = new Map<Unit, number>();
  rows.forEach((blocks, r) => {
    for (const u of unitsOf(blocks)) rowOf.set(u, r);
  });
  const demoted: Report[] = [];
  for (const net of model.nets)
    if (net.kind === "wire" && new Set(net.terminals.map((t) => rowOf.get(t.unit))).size > 1) {
      demote(model, net, "crosses rows");
      demoted.push({ label: net.label, reason: net.reason });
    }
  let elkMs = 0;
  for (let round = 1; ; round++) {
    const shapes = new Map(model.units.map((u) => [u, shapeUnit(model, u)]));
    const laidRows: Laid[] = [];
    for (const blocks of rows) {
      const inRow = new Map(unitsOf(blocks).map((u) => [u, rank.get(u)!]));
      const touches = (net: Net) =>
        new Set(net.terminals.filter((t) => inRow.has(t.unit)).map((t) => t.unit)).size >= 2;
      const wired = model.nets.filter((n) => n.kind === "wire" && touches(n));
      const hinted = model.nets.filter((n) => n.kind === "tunnel" && touches(n));
      let hint: Map<string, Point> | null = null;
      let pass = variant;
      const grouped = blocks.some((b) => !isUnit(b));
      if (hinted.length && !grouped) {
        // Tunnels say little about where a part belongs, so the row is laid
        // out first as if every net were a wire, and that order kept
        const first = await runElk(shapes, blocks, inRow, [...wired, ...hinted], new Set(), variant, null, false);
        if ("failed" in first) return first;
        elkMs += first.ms;
        hint = first.relative;
        pass = { name: variant.name, options: INTERACTIVE };
      }
      const laid = await runElk(shapes, blocks, inRow, wired, new Set(wired), pass, hint, rails);
      if ("failed" in laid) return laid;
      if (!grouped) compactRow(laid, shapes);
      elkMs += laid.ms;
      laidRows.push(laid);
    }
    // rows stacked under the notes, each from the left edge
    const extents = laidRows.map((laid) => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [u, [x, y]] of laid.at) {
        const b = shapes.get(u)!.box;
        xs.push(x, x + b[2] - b[0]);
        ys.push(y, y + b[3] - b[1]);
      }
      for (const b of laid.boxes.values()) xs.push(b[0], b[2]), ys.push(b[1], b[3]);
      for (const routes of laid.routes.values())
        for (const line of routes) for (const [x, y] of line) xs.push(x), ys.push(y);
      return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0];
    });
    // notes that stood over the parts go over the drawing, the rest under it
    const boxes = model.units.map((u) => u.box);
    const middle = boxes.length ? (Math.min(...boxes.map((b) => b[1])) + Math.max(...boxes.map((b) => b[3]))) / 2 : 0;
    const over = stackNotes(model.notes.filter((c) => (footprint(c)[1] + footprint(c)[3]) / 2 < middle));
    const under = stackNotes(model.notes.filter((c) => (footprint(c)[1] + footprint(c)[3]) / 2 >= middle));
    let height = over ? over.height + NOTE_GAP : 0;
    const rowTop: number[] = [];
    for (const e of extents) {
      rowTop.push(height);
      height += e[3] - e[1] + ROW_GAP;
    }
    if (extents.length) height -= ROW_GAP;
    const underTop = under ? (extents.length ? height + NOTE_GAP : height) : height;
    if (under) height = underTop + under.height;
    const width = Math.max(over?.width ?? 0, under?.width ?? 0, ...extents.map((e) => e[2] - e[0]));
    const origin = chooseOrigin(model, width, height);
    const notesShift = new Map<string, Point>();
    for (const [block, top] of [
      [over, 0],
      [under, underTop],
    ] as const)
      for (const [c, [x, y]] of block?.offsets ?? []) {
        const b = footprint(c);
        notesShift.set(c.componentId, [origin[0] + x - b[0], origin[1] + top + y - b[1]]);
      }
    const shift = new Map<Unit, Point>();
    const headings: PlacedHeading[] = [];
    const containers = new Map<string, Box>();
    const wires = new Map<Net, Units>();
    let offGrid: number | null = null;
    let offWhat = "";
    const check = (v: number, what = "") => {
      if (!onGrid(v) && offGrid === null) {
        offGrid = v;
        offWhat = what;
      }
      return Math.round(v);
    };
    const routes = new Map<Net, Point[][]>();
    laidRows.forEach((laid, r) => {
      const dx = origin[0] - extents[r][0];
      const dy = origin[1] + rowTop[r] - extents[r][1];
      for (const [u, [x, y]] of laid.at) {
        const b = shapes.get(u)!.box;
        shift.set(u, [check(x + dx - b[0], `${u.id} x ${x} box ${b}`), check(y + dy - b[1], `${u.id} y ${y} box ${b}`)]);
      }
      for (const [c, b] of laid.boxes) {
        containers.set(c.id, [check(b[0] + dx), check(b[1] + dy), check(b[2] + dx), check(b[3] + dy)]);
        if (c.heading) {
          const x = check(b[0] + dx);
          const y = check(b[1] + dy);
          headings.push({
            heading: c.heading,
            container: c.id,
            at: [x + 20, y + 5],
            box: [x + 20, y + 5, x + 20 + c.heading.width, y + 5 + c.heading.height],
          });
        }
      }
      for (const [net, lines] of laid.routes)
        routes.set(
          net,
          lines.map((line) => line.map(([x, y]): Point => [check(x + dx, `route ${net.index}`), check(y + dy, `route ${net.index}`)])),
        );
    });
    if (offGrid !== null) return { failed: `off the grid (${offGrid}: ${offWhat})` };
    const moved = (u: Unit, p: Point): Point => {
      const [dx, dy] = shift.get(u)!;
      return [p[0] + dx, p[1] + dy];
    };
    // copper: each wired net's routes carried on from the box to its ports,
    // reduced to a tree; each satellite's lead
    for (const net of model.nets) {
      if (net.kind !== "wire") continue;
      const units: Units = new Set();
      const shape = (t: Terminal) => shapes.get(t.unit)!;
      for (const t of net.terminals) {
        const a = shape(t).anchors.get(t)!;
        addPolyline(units, [moved(t.unit, t.point), moved(t.unit, a)]);
      }
      for (const line of routes.get(net) ?? [])
        if (!addPolyline(units, line)) return { failed: `a diagonal route for ${net.key}` };
      const tree = netTree(
        units,
        net.terminals.map((t) => {
          const p = moved(t.unit, t.point);
          return pointKey(p[0], p[1]);
        }),
      );
      if (tree === null) return { failed: `a net left unjoined (${net.label ?? net.index})` };
      wires.set(net, tree);
    }
    // the copper of nets drawn inside their unit, where the unit went
    for (const u of model.units)
      for (const [net, lines] of u.copper ?? []) {
        const units: Units = new Set();
        for (const line of lines)
          if (!addPolyline(units, line.map((p) => moved(u, p)))) return { failed: `a diagonal wire inside ${u.id}` };
        const tree = netTree(
          units,
          net.terminals.map((t) => {
            const p = moved(t.unit, t.point);
            return pointKey(p[0], p[1]);
          }),
        );
        if (tree === null) return { failed: `a net left unjoined inside ${u.id}` };
        wires.set(net, tree);
      }
    const leads = new Map<Net, Units>();
    for (const [u, s] of model.units.flatMap((u) => shapes.get(u)!.satellites.map((s) => [u, s] as const))) {
      if (!leads.has(s.net)) leads.set(s.net, new Set());
      for (const path of s.leads) addPolyline(leads.get(s.net)!, path.map((p) => moved(u, p)));
    }
    // held against Logisim's connection rules; constants of one value may
    // share copper
    const sameValue = new Map<string, number>();
    const alias = new Map<number, number>();
    for (const net of model.nets)
      if (net.kind === "constant") {
        const k = constantKey(net);
        if (!sameValue.has(k)) sameValue.set(k, net.index);
        alias.set(net.index, sameValue.get(k)!);
      }
    const indexOf = (net: Net) => alias.get(net.index) ?? net.index;
    const copper = new Map<number, Units>();
    for (const [net, units] of wires) copper.set(net.index, units);
    for (const [net, units] of leads) copper.set(indexOf(net), new Set([...(copper.get(indexOf(net)) ?? []), ...units]));
    const kept: Units = new Set();
    for (const w of model.keptWires) addPolyline(kept, [[w.from.x, w.from.y], [w.to.x, w.to.y]]);
    if (kept.size) copper.set(-1, kept);
    const ports: PortMark[] = [];
    const bodies: Obstacle[] = [];
    for (const u of model.units) {
      for (const c of u.parts) {
        for (const e of c.ends) {
          const net = model.netOfPort.get(portId(c, e));
          ports.push({ point: moved(u, [e.location.x, e.location.y]), net: net ? indexOf(net) : null });
        }
        if (c.factoryName === "Text") continue;
        const [dx, dy] = shift.get(u)!;
        const b = c.bounds;
        const box: Box = [b.x + dx, b.y + dy, b.x + b.width + dx, b.y + b.height + dy];
        bodies.push({ box, leads: ownLeads(model, c, box, dx, dy, indexOf) });
      }
      for (const s of shapes.get(u)!.satellites) ports.push({ point: moved(u, s.point), net: indexOf(s.net) });
    }
    for (const id of model.fixed.keys()) {
      const c = model.byId.get(id);
      if (!c) continue;
      for (const e of c.ends) ports.push({ point: [e.location.x, e.location.y], net: -1 });
      if (c.factoryName !== "Text")
        bodies.push({ box: [c.bounds.x, c.bounds.y, c.bounds.x + c.bounds.width, c.bounds.y + c.bounds.height] });
    }
    for (const t of model.tunnels)
      if (model.keptTunnels.has(t.componentId)) ports.push({ point: [t.location.x, t.location.y], net: -1 });
    const blamed = conflicts(copper, ports, bodies, (n) => n >= 0 && model.nets[n].kind === "wire");
    const long: Net[] = [];
    if (!blamed.size && model.units.length > 40)
      for (const net of wires.keys()) {
        const points = net.terminals.map((t) => moved(t.unit, t.point));
        const driver =
          net.terminals.findIndex((t) => t.direction === "output") >= 0
            ? points[net.terminals.findIndex((t) => t.direction === "output")]
            : points[0];
        const span = Math.max(...points.map((p) => Math.abs(p[0] - driver[0]) + Math.abs(p[1] - driver[1])));
        if (span > TUNNEL_SPAN(net.width) * (net.labels.length ? 1 : 2)) long.push(net);
      }
    // a long wire is a preference, not a clash: the last round keeps them
    if (!blamed.size && (!long.length || round >= MAX_ROUNDS)) {
      const order = pinOrderChanged(model, shift);
      if (order) return { failed: order };
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [u, [dx, dy]] of shift) {
        const b = shapes.get(u)!.box;
        xs.push(b[0] + dx, b[2] + dx);
        ys.push(b[1] + dy, b[3] + dy);
      }
      const railCount = laidRows.reduce((n, laid) => n + laid.rails, 0);
      return {
        variant: railCount ? `${variant.name}, rails` : variant.name,
        rails: railCount,
        shapes,
        shift,
        wires,
        leads,
        headings,
        containers,
        notesShift,
        demoted,
        rounds: round,
        elkMs,
        extent: xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0],
      };
    }
    if (round >= MAX_ROUNDS)
      return { failed: `wires still clash after ${round} rounds: ${[...blamed.values()][0] ?? "long nets"}` };
    for (const [n, why] of blamed) {
      if (n < 0 || model.nets[n].kind !== "wire") return { failed: why };
      demote(model, model.nets[n], why);
      demoted.push({ label: model.nets[n].label, reason: why });
    }
    for (const net of long) {
      demote(model, net, "long");
      demoted.push({ label: net.label, reason: "long" });
    }
  }
}

// The copper a part's own port may run inside its body: straight out from a
// port inside the bounds (a select input under a slanted edge, a port inside
// a label) through the side it leaves by.
function ownLeads(
  model: Model,
  c: Model["parts"][number],
  box: Box,
  dx: number,
  dy: number,
  indexOf: (net: Net) => number,
): Map<number, Units> {
  const leads = new Map<number, Units>();
  const inside = (x: number, y: number) => x > box[0] && x < box[2] && y > box[1] && y < box[3];
  for (const e of c.ends) {
    const net = model.netOfPort.get(portId(c, e));
    if (!net) continue;
    const unit = model.unitOf.get(c.componentId);
    const t = unit?.terminals.find((t) => t.ports.some((p) => p.part === c && p.end === e));
    if (!t) continue;
    const [sx, sy] = STEP[t.side];
    let x = e.location.x + dx;
    let y = e.location.y + dy;
    const units = leads.get(indexOf(net)) ?? new Set<string>();
    while (inside(x, y)) {
      units.add(sy === 0 ? `h:${Math.min(x, x + sx)}:${y}` : `v:${x}:${Math.min(y, y + sy)}`);
      x += sx;
      y += sy;
    }
    leads.set(indexOf(net), units);
  }
  return leads;
}

// Without a custom appearance an instance orders its ports by the Pins'
// places per facing; a layout must not reorder them.
function pinOrderChanged(model: Model, shift: Map<Unit, Point>): string | null {
  if (model.element.find("appear") !== null) return null;
  const groups = new Map<string, Model["parts"]>();
  for (const c of model.parts)
    if (c.factoryName === "Pin") {
      const f = attr(c, "facing") ?? "east";
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f)!.push(c);
    }
  for (const [facing, pins] of groups) {
    const key = pinOrderKey(facing);
    const sorted = (where: (c: Model["parts"][number]) => Point) =>
      [...pins]
        .sort((a, b) => {
          const [p, q] = [key(where(a)), key(where(b))];
          return p[0] - q[0] || p[1] - q[1];
        })
        .map((c) => c.componentId)
        .join("|");
    const before = sorted((c) => [c.location.x, c.location.y]);
    const after = sorted((c) => {
      const u = model.unitOf.get(c.componentId);
      const [dx, dy] = (u && shift.get(u)) ?? [0, 0];
      const [ox, oy] = u?.offsets?.get(c.componentId) ?? [0, 0];
      return [c.location.x + ox + dx, c.location.y + oy + dy];
    });
    if (before !== after) return `the order of the ${facing}-facing Pins would change`;
  }
  return null;
}
