// Re-place and physically wire a tunnel-only circuit into a readable schematic.
//
// Methodology (this is the part an LLM should not improvise per wire):
//
// 1. The observed netlist is the specification. Every port belongs to a net
//    (the observer's per-bit netIds). Nothing below may change which ports
//    share a net; that is verified after emission by re-observing the result.
// 2. Two kinds of objects: a *fixed panel* (observation Pins, Probes,
//    displays, text, anything the caller pins) that must not move, and the
//    *body* that is free to be re-placed. Panel<->body links stay tunnels;
//    body<->body links become wires.
// 3. Net classes: globals (huge fan-out: clock/reset/run) stay tunnels, as any
//    human schematic does; constant drivers (Constant, Ground, Power) get a
//    private copy next to each consumer instead of a tunnel; everything else
//    is wired.
// 4. Placement is a layered drawing (Sugiyama): layer = longest path from
//    sources in the signal-flow DAG with register outputs starting a new
//    layer (a pipeline stage), barycenter sweeps to reduce crossings, parts
//    wired output to input across neighbouring columns aligned into blocks so
//    those wires are straight, then tight grid-snapped coordinate assignment
//    in sub-columns of bounded height, every channel wide enough for the
//    Tunnel labels that face each other across it.
// 5. Routing is global and ordered: short nets first, then longer ones detour
//    around them, using the grid A* router that already knows Logisim's rules
//    (never end or bend on foreign copper, never pass through a foreign port,
//    prefer a cell of clearance, keep out of Tunnel labels); nets that found
//    no way through are routed again first.
//
// Connectivity contract (what makes the result provably equivalent):
//
// - Body copper is rebuilt from scratch; only copper that touches the panel
//   and no body port survives. Every real port of a net that is not joined by
//   new copper is joined by a labelled Tunnel instead: the net's own label
//   when the author gave it one, otherwise a label synthesised from the
//   Pin/part it serves (unique within the definition). A hand-drawn net with
//   no label is therefore never lost -- it is wired, and if the router cannot
//   reach one of its ports that port gets a Tunnel that still names the same
//   net.
// - A panel port whose copper was rebuilt gets a Tunnel of the same label on
//   the panel side, so the fixed panel never needs to move.
// - A port of unknown width (a Probe) belongs to the net of the copper it
//   stands on, like any other port (resolveUnknownWidths).
// - Circuits that use this one see the same instance: a custom appearance's
//   ports follow their Pins; without one, the Pins of each facing keep their
//   order, which is what the default appearance is built from
//   (interfaceSignature). Only this definition is rewritten in the file.
import { compactX } from "./compaction.mts";
import type { CompactWire, KeepOrder } from "./compaction.mts";
import { fixedCopper } from "./fixed-geometry.mts";
import { looseWireGeometry } from "./loose-wires.mts";
import {
  IntSet,
  KeyMap,
  KeySet,
  PY_WHITESPACE,
  PyKeyError,
  PyValueError,
  StopIteration,
  cmp,
  codePoints,
  count,
  cpSlice,
  deepCopy,
  floorDiv,
  getOr,
  item,
  maxBy,
  maxOf,
  minBy,
  minOf,
  pyEq,
  pyInt,
  pyRepr,
  pyRound,
  pyStr,
  range,
  sortBy,
  sortInPlace,
  sorted,
  strip,
  sum,
} from "./py.mts";
import type { Point } from "./py.mts";
import { sharedRail } from "./control-routing.mts";
import type { Corridor } from "./control-routing.mts";
import { Partition, Router, busKey, pk } from "./routing.mts";
import type {
  Bounds,
  Component,
  End,
  Focus,
  NetBit,
  Wire,
  WireBundle,
  XY,
} from "./types.mts";
import { subtractSegments } from "./wire-geometry.mts";
import {
  XmlElement,
  circuitSpan,
  parseXml,
  serialize,
  subElement,
} from "./xml.mts";

export const GRID = 10;
const PANEL_FACTORIES = new Set([
  "Pin",
  "Probe",
  "Hex Digit Display",
  "LED",
  "Button",
  "Text",
  "Clock",
  "Pull Resistor",
  "RiscV Probe",
  "Counter",
  "D Flip-Flop",
  "Controlled Buffer",
  "NAND Gate",
]);
const GLOBAL_FANOUT = 12; // >= this many ports: keep as tunnel (clock/reset/run)
const CROSSINGS_PER_CONSUMER = 2; // a named net whose copper crosses more wires than this per consumer becomes Tunnels
const CROSSINGS_MIN = 6; // ... and at least this many
const ABUT_MIN = 3; // parts joined by this many two-port nets whose ports line up are drawn port to port
const SATELLITE_GAP = 30; // a Pin facing north (south) stands this far below (above) the port it feeds
const SATELLITES = new Set([
  "Pin",
  "Clock",
  "Probe",
  "Button",
  "LED",
  "Constant",
]);
const STAIR_DEPTH = 640; // ... and a staircase of them under ports 10 px apart reaches at most this far
export const CONSTANT_SOURCES: readonly string[] = [
  "Constant",
  "Ground",
  "Power",
]; // one-port drivers of a fixed value: a private copy on every consumer port
const ROW_GAP = 50; // vertical air between stacked components (registers carry 4 side pins + tunnels)
const COLUMN_GAP = 160; // horizontal air between layers (routing channel)
const MAX_STACK = 2400; // split a layer into sub-columns beyond this height
const GAP_CAP = 200; // a column may grow by this much (plus STACK_SLACK) to line ports up with neighbours
const STACK_SLACK = 1.4; // ... and by this factor of its compact height
const CHANNEL_MIN = 60; // narrowest routing channel between two columns
const CHANNEL_PER_WIRE = 8; // extra channel width per wire that passes through it
const SUBCOLUMN_GAP = 120; // between sub-columns of one layer
const TARGET_ASPECT = 1.5; // width/height the column packing aims at (hand-drawn sheets: about 1.5-1.8)
const COLUMN_HEIGHT_MIN = 200; // a packed column is never shorter than this
const STAGGER = 30; // x step between successive depths packed into one column
const ROW_SNAP = 20; // a part moves at most this far to share a top with a part in another column
const LEVEL_REACH = 100; // ... and this far to put a port level with the port it is wired to (a straight wire)
const STAGE_MIN_PARTS = 3; // a pipeline stage holds at least this many parts ...
const STAGE_MIN_SHARE = 0.1; // ... and this share of the body before the sheet is laid out stage by stage
const COMPACT_GAP = 60; // air right of a part after compaction (the usual gap to the right neighbour)
const LAYER_SPLIT = 2.5; // a layer this many times taller than the column budget becomes side-by-side columns
const LEAD_MAX = 8; // a Tunnel's lead grows up to this many grid steps to clear the flags beside it
const V_LEAD_MAX = 32; // ... and in a V of sideways flags under a long row of ports (placement leaves room for it)
const FAN_COLUMNS = 4; // Pins level with the ports they are wired to stand at most this many abreast
// Readable sheets are no denser than this (bodies per million px², by body
// count: a small circuit gets more air than a CPU); compaction stops there.
const DENSITY_MAX: readonly (readonly [number, number])[] = [
  [12, 210],
  [20, 165],
  [100, 100],
  [Infinity, 75],
];
// driver->consumer distance (px) above which a named net is tunnelled, by fan-out
export const TUNNEL_SPAN = new Map([
  [1, 800],
  [2, 600],
  [3, 500],
]);
const UNNAMED_SPAN_FACTOR = 2; // an unnamed net (label synthesised) is wired up to this multiple of the limit
const CROSSING_COST = 100; // router cost of crossing a foreign wire during a re-layout (manual edits keep 24)
const BEND_COST = 100; // ... and of a corner (manual edits keep 18): about as dear as a crossing, so two corners round a label cost less than a step through it
const FLAG_COST = 300; // ... and of a step into a Tunnel's label (a wire there crosses the name out)
const SHELF_WIDTH = 400; // a part at least this wide and 4x wider than tall goes on the shelf above the body
const SHELF_GAP = 120; // between the shelf and the body
const ROUTER_VISIT_CAP = 600000; // A* budget per route on a re-layout (sheets are wider than a manual edit)
const SWEEPS = 24; // barycenter sweeps (down, up, ...)
const TRANSPOSE_ROUNDS = 12; // adjacent-swap rounds after the sweeps
const PANEL_MIN_GAP = 40; // whitespace between the panel's last row and the body's first row
const PANEL_MIN_PARTS = 12; // a panel is a substantial cluster
const PANEL_IO_SHARE = 0.6; // ... made mostly of I/O and annotation (a logic slice stays under 0.3)
// ... that shows or drives something for a person; a column of interface
// Pins above the logic of a helper circuit is its inputs, not a panel.
const PANEL_DISPLAYS = new Set([
  "Probe",
  "Hex Digit Display",
  "LED",
  "Button",
  "RiscV Probe",
  "7-Segment Display",
  "DotMatrix",
  "TTY",
  "Keyboard",
  "Joystick",
  "DIP Switch",
]);
const PANEL_MIN_DISPLAYS = 4;
const TEXT_ATTACH_DISTANCE = 60; // a Text this close to a body part is its caption and moves with it
const LABEL_ABBREVIATIONS = new Map([
  ["Multiplexer", "MUX"],
  ["Demultiplexer", "DMX"],
  ["Decoder", "DEC"],
  ["Priority Encoder", "ENC"],
  ["Adder", "ADD"],
  ["Subtractor", "SUB"],
  ["Multiplier", "MUL"],
  ["Divider", "DIV"],
  ["Negator", "NEG"],
  ["Comparator", "CMP"],
  ["Shifter", "SHL"],
  ["Bit Extender", "EXT"],
  ["Splitter", "SPL"],
  ["Register", "REG"],
  ["Counter", "CNT"],
  ["ROM", "ROM"],
  ["RAM", "RAM"],
  ["AND Gate", "AND"],
  ["OR Gate", "OR"],
  ["NOT Gate", "NOT"],
  ["NAND Gate", "NAND"],
  ["NOR Gate", "NOR"],
  ["XOR Gate", "XOR"],
  ["XNOR Gate", "XNOR"],
  ["Buffer", "BUF"],
  ["Controlled Buffer", "CBUF"],
  ["D Flip-Flop", "DFF"],
  ["Constant", "CONST"],
  ["Clock", "CLK"],
]);
const LABELLED_IO = new Set([
  "Pin",
  "Probe",
  "LED",
  "Hex Digit Display",
  "Button",
]);
const PORT_WORD_RE = new RegExp(
  `^[${PY_WHITESPACE}]*([\\p{L}\\p{Nl}\\p{No}][\\p{L}\\p{N}_]*)`,
  "u",
);

// A port: (componentId, end index).
export type Port = readonly [string, number];
// A net's identity: its ordered (bit, thread) vector (see netKey).
export type NetKey = string;
// [x0, y0, x1, y1]
export type Box = readonly [number, number, number, number];
export type Report = Record<string, any>;

export const portId = (p: Port): string => p[0] + "\u0000" + p[1];
export const portMap = <V,>(
  entries?: Iterable<readonly [Port, V]>,
): KeyMap<Port, V> => new KeyMap<Port, V>(portId, entries);
export const portSet = (items?: Iterable<Port>): KeySet<Port> =>
  new KeySet<Port>(portId, items);
const samePort = (a: Port, b: Port): boolean => a[0] === b[0] && a[1] === b[1];

export interface PlacementStrategy {
  place(layout: SchematicLayout): Promise<Map<string, Point>>;
  prepareRouting?(layout: SchematicLayout): void;
}

export interface LayoutOptions {
  pinnedIds?: Iterable<string>;
  keepTunnels?: Iterable<string>;
  localiseConstants?: boolean;
  panelBelowY?: number | null;
  placementStrategy?: PlacementStrategy | null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function loc(text: string | null): Point {
  if (text === null)
    throw new TypeError("expected string or bytes-like object, got 'NoneType'");
  const values = text.match(/-?[0-9]+/g) ?? [];
  if (values.length > 2)
    throw new PyValueError("too many values to unpack (expected 2)");
  if (values.length < 2)
    throw new PyValueError(
      `not enough values to unpack (expected 2, got ${values.length})`,
    );
  return [pyInt(values[0] as string), pyInt(values[1] as string)];
}

// An attribute of a <comp> element as written in the file.
export function attrOf(element: XmlElement, name: string): string | null {
  for (const a of element.findall("a"))
    if (a.get("name") === name) return a.get("val");
  return null;
}

// Rough width of a label in Logisim's default font (CJK about twice as wide).
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text)
    width += (ch.codePointAt(0) as number) > 0x2e80 ? 12 : 7;
  return width + 10;
}

// The box a Tunnel's label covers, from the point it stands on: 20 px tall
// beside a sideways flag, as wide as the label under or over an upright one.
export function labelBox(
  tip: Point,
  facing: string | null,
  label: string,
): Box {
  const w = textWidth(label);
  const [x, y] = tip;
  if (facing === "east") return [x - w, y - 10, x, y + 10];
  if (facing === "west") return [x, y - 10, x + w, y + 10];
  if (facing === "north")
    return [x - floorDiv(w, 2), y - 1, x + floorDiv(w, 2), y + 23];
  if (facing === "south")
    return [x - floorDiv(w, 2), y - 23, x + floorDiv(w, 2), y + 1];
  throw new PyKeyError(pyRepr(facing));
}

// Successive alias flags need their text width, not a 10 px overlap.
export function chainOffsets(labels: readonly string[], step: Point): number[] {
  const offsets = [0];
  for (const label of labels.slice(0, -1))
    offsets.push(
      offsets[offsets.length - 1] +
        Math.ceil(((step[0] ? textWidth(label) : 20) + 10) / GRID),
    );
  return offsets;
}

// A row of one-label Tunnels on a part's top or bottom edge, as (x, label,
// ...) in x order, cut into the runs that turn sideways together in a V (see
// planLeadSteps): the end flags of two runs point at each other, so runs
// closer than both labels stay one.
function fanRuns<T extends readonly [number, string, ...unknown[]]>(
  row: readonly T[],
): T[][] {
  const runs: T[][] = [[row[0]]];
  for (const p of row.slice(1)) {
    const run = runs[runs.length - 1];
    const last = run[run.length - 1];
    if (p[0] - last[0] < textWidth(last[1]) + textWidth(p[1]) + GRID)
      run.push(p);
    else runs.push([p]);
  }
  return runs;
}

// Grid points inside a box (3 px clear of its edge): a wire there runs through it.
function* boxPoints(b: readonly number[]): Generator<Point> {
  const xStop = Math.trunc(b[2] - 3) + 1;
  const yStop = Math.trunc(b[3] - 3) + 1;
  for (let x = GRID * Math.ceil((b[0] + 3) / GRID); x < xStop; x += GRID)
    for (let y = GRID * Math.ceil((b[1] + 3) / GRID); y < yStop; y += GRID)
      yield [x, y];
}

// One side of a column for channelRoom: (y0, y1, reach, is a flag).
export type ChannelSide = readonly [number, number, number, unknown];

// Width a channel needs between the right side of one column and the left
// side of the next (see flagSides): wherever a flag is level with a flag or a
// body across it, both fit with a grid step between them.
function channelRoom(
  right: readonly ChannelSide[],
  left: readonly ChannelSide[],
): number {
  let best = 0;
  let any = false;
  for (const a of right)
    for (const b of left)
      if ((a[3] || b[3]) && Math.min(a[1], b[1]) - Math.max(a[0], b[0]) >= 3) {
        const v = a[2] + b[2] + GRID;
        if (!any || v > best) best = v;
        any = true;
      }
  return any ? best : 0;
}

const OPPOSITE = new Map([
  ["east", "west"],
  ["west", "east"],
  ["north", "south"],
  ["south", "north"],
]);

// The grid step out of a part through each edge of its bounds.
const OUTWARD = new Map<string, Point>([
  ["west", [-GRID, 0]],
  ["east", [GRID, 0]],
  ["north", [0, -GRID]],
  ["south", [0, GRID]],
]);

// A wired connection between two ports, as placement weighs it.
type Edge = readonly [Port, Port];
const NO_EDGES: readonly Edge[] = [];

// An edge as (the end on cid, the other end).
const ends = (e: Edge, cid: string): readonly [Port, Port] =>
  e[0][0] === cid ? e : [e[1], e[0]];

// An edge as a straight segment between columns: (layer of a, port y of a,
// layer of b, port y of b) with layer a <= layer b.
type Seg = readonly [number, number, number, number];

function segAt(sg: Seg, l: number): number {
  const [la, ya, lb, yb] = sg;
  return lb === la ? ya : ya + ((yb - ya) * (l - la)) / (lb - la);
}

function crosses(s1: Seg, s2: Seg): boolean {
  const lo = Math.max(s1[0], s2[0]);
  const hi = Math.min(s1[2], s2[2]);
  if (lo >= hi) return false;
  return (segAt(s1, lo) - segAt(s2, lo)) * (segAt(s1, hi) - segAt(s2, hi)) < 0;
}

// The bounds a part is drawn in (its label included), else its bounds.
function visualOf(c: Component): Bounds {
  return hasOwn(c, "visualBounds") ? (c.visualBounds as Bounds) : c.bounds;
}

// The 100 px cells a box touches, x cells outer.
function cellsOf(b: readonly number[]): number[] {
  const out: number[] = [];
  for (
    let bx = floorDiv(Math.trunc(b[0]), 100);
    bx < floorDiv(Math.trunc(b[2]), 100) + 1;
    bx++
  )
    for (
      let by = floorDiv(Math.trunc(b[1]), 100);
      by < floorDiv(Math.trunc(b[3]), 100) + 1;
      by++
    )
      out.push(pk(bx, by));
  return out;
}

// A localised Constant stands this way out of the consumer's edge, facing back.
const CONSTANT_SIDE = new Map<string, readonly [number, number, string]>([
  ["west", [-1, 0, "east"]],
  ["east", [1, 0, "west"]],
  ["north", [0, -1, "south"]],
  ["south", [0, 1, "north"]],
]);

// A routing job: (more than two ports, span, identity, ports). The identity
// is the net's key, or one tree of it: a Splitter copy's ("copy", net, i), a
// local tree's ("local", net, i), a localised Constant's ("const", id).
type Job = [boolean, number, string, Port[]];

export const jobKey = (kind: string, key: NetKey, i: number): string =>
  JSON.stringify([kind, JSON.parse(key), i]);

// The net a job routes (a const job is its own).
function jobNet(job: string): string {
  const parsed = JSON.parse(job);
  return parsed[0] === "copy" || parsed[0] === "local"
    ? JSON.stringify(parsed[1])
    : job;
}

// A control tree (see grouped geometry): ports that would rather share one rail.
export interface ControlTree extends Corridor {
  ports: Port[];
  groupId: string;
  column: number;
}

// One pass of the router over every job (see route).
interface RouteAttempt {
  router: Router;
  reserved: Set<number>;
  wires: [Point, Point][];
  failedPorts: Map<NetKey, Port[]>;
  failedConsts: KeySet<Port>;
  unrouted: Report[];
  failedJobs: Set<string>;
  wireNets: string[];
  leads: KeyMap<Port, number>;
  turned: KeyMap<Port, string>;
  controlRoutes: Report[];
  controlFallbacks: Set<string>;
}

interface SettledRoutes extends RouteAttempt {
  anchors: KeyMap<Port, string[]>;
}

// Points the custom appearance's ports at the Pins that moved (old location
// to new); returns how many it repointed.
export function repointPins(
  circuit: XmlElement,
  moved: ReadonlyMap<string, Point>,
): number {
  const appear = circuit.find("appear");
  if (appear === null) return 0;
  let repointed = 0;
  for (const port of appear.iter("circ-port")) {
    let old: number[];
    try {
      old = port.get("pin", "").split(",").map(pyInt);
    } catch (error) {
      if (!(error instanceof PyValueError)) throw error;
      continue;
    }
    const target =
      old.length === 2 ? moved.get(`${old[0]},${old[1]}`) : undefined;
    if (target !== undefined) {
      port.set("pin", `${target[0]},${target[1]}`);
      repointed += 1;
    }
  }
  return repointed;
}

// Boxes and ports of a component written by the layout itself (a Tunnel or
// Constant has no observation yet): Logisim draws a Tunnel's or Constant's
// body on the side opposite its facing, from the connection point.
export function estimatedGeometry(
  element: XmlElement,
  x: number,
  y: number,
): [Box[], Point[]] {
  const name = element.get("name");
  let facing: string = attrOf(element, "facing") || "east";
  let w: number;
  let h: number;
  if (name === "Tunnel") {
    w = textWidth(attrOf(element, "label") || "");
    h = 20;
  } else if (name === "Constant") {
    const raw = attrOf(element, "width");
    const bits = raw ? pyInt(raw) : 1;
    w = 16 + 10 * Math.max(0, floorDiv(bits + 3, 4) - 2);
    h = 16;
  } else if (name === "Ground" || name === "Power") {
    // drawn on the side it faces (14-15 px deep, 16 across)
    w = 16;
    h = 16;
    facing = item(OPPOSITE, facing);
  } else {
    return [[[x - 10, y - 10, x + 10, y + 10]], [[x, y]]];
  }
  let box: Box;
  if (facing === "east")
    box = [x - w, y - floorDiv(h, 2), x, y + floorDiv(h, 2)];
  else if (facing === "west")
    box = [x, y - floorDiv(h, 2), x + w, y + floorDiv(h, 2)];
  else if (facing === "north")
    box = [x - floorDiv(w, 2), y, x + floorDiv(w, 2), y + h];
  else box = [x - floorDiv(w, 2), y - h, x + floorDiv(w, 2), y];
  return [[box], [[x, y]]];
}

function edgeDistances(component: Component, idx: number): [string, number][] {
  const b = component.bounds;
  const e = component.ends[idx].location;
  return [
    ["west", e.x - b.x],
    ["east", b.x + b.width - e.x],
    ["north", e.y - b.y],
    ["south", b.y + b.height - e.y],
  ];
}

// The edge of the part's bounds its port idx is on (the nearest one).
function edgeOf(component: Component, idx: number): string {
  return minBy(edgeDistances(component, idx), (d) => d[1])[0];
}

// Every edge of the part's bounds nearest to its port idx: two for a port on
// a corner (a Splitter's last bit end).
function edgesAt(component: Component, idx: number): Set<string> {
  const d = edgeDistances(component, idx);
  const near = minOf(d.map((v) => v[1]));
  return new Set(d.filter((v) => v[1] === near).map((v) => v[0]));
}

function intersection<T>(sets: readonly ReadonlySet<T>[]): Set<T> {
  const out = new Set(sets[0]);
  for (const s of sets.slice(1))
    for (const v of out) if (!s.has(v)) out.delete(v);
  return out;
}

export function attr(component: Component, name: string): string | null {
  for (const a of component.attributes) {
    if (a.name === name)
      return ((hasOwn(a, "value") ? a.value : a.standard) ?? null) as
        string | null;
  }
  return null;
}

export function snap(value: number): number {
  return pyRound(value / GRID) * GRID;
}

// Identity of a port's net: the ordered (bit, thread) vector. Two ports are
// the same net only if bit i is the same thread for every i. The unordered
// set is not enough: a splitter re-combining IR[31:25]++IR[11:7] and a
// splitter selecting bits 7-11,25-31 carry the same threads in a different
// order, and wiring them together would short the threads.
export function netKey(bits: readonly NetBit[]): NetKey {
  return JSON.stringify(
    sortBy(bits, (b) => b.bit).map((b) => [b.bit, b.netId]),
  );
}

function sanitizeLabel(text: unknown): string {
  const cleaned = strip(pyStr(text).replace(/[^\p{L}\p{N}_.\-]+/gu, "_"), "_");
  return cpSlice(cleaned, 0, 32) || "NET";
}

class UnionFind {
  parent = new Map<string, string>();

  root(p: string): string {
    if (!this.parent.has(p)) this.parent.set(p, p);
    while (this.parent.get(p) !== p) {
      this.parent.set(
        p,
        this.parent.get(this.parent.get(p) as string) as string,
      );
      p = this.parent.get(p) as string;
    }
    return p;
  }

  join(a: string, b: string): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// Give ports of unknown width the net of the copper they stand on.
//
// The observer reports a port's net bits per declared bit, so a port whose
// width is only settled at run time -- a Probe, typically a panel display
// wired to a statistics Counter -- comes back with none. Such a port looks
// unconnected: a re-layout would delete its copper without replacing it and
// a netlist comparison would not notice. Logisim gives it the width of the
// bundle it touches, and so does this: the bits of the wire bundle through
// the port's point, else those of another port on the same point. Ends that
// touch nothing stay empty. Idempotent; returns the number of ends resolved.
export function resolveUnknownWidths(focus: Focus): number {
  const atPoint = new Map<number, NetBit[]>();
  for (const bundle of focus.wireBundles ?? []) {
    const bits = (bundle.bitNets ?? []).filter((b) => b.netId);
    if (bits.length && (hasOwn(bundle, "valid") ? bundle.valid : true))
      for (const p of bundle.points ?? []) atPoint.set(pk(p.x, p.y), bits);
  }
  for (const c of focus.components)
    for (const e of c.ends)
      if (e.netBits && e.netBits.length) {
        const key = pk(e.location.x, e.location.y);
        if (!atPoint.has(key)) atPoint.set(key, e.netBits);
      }
  let resolved = 0;
  for (const c of focus.components)
    for (const e of c.ends) {
      if (
        (e.width === undefined || e.width === null) &&
        !(e.netBits && e.netBits.length)
      ) {
        const bits = atPoint.get(pk(e.location.x, e.location.y));
        if (bits && bits.length) {
          e.netBits = bits.map((b) => ({ bit: b.bit, netId: b.netId }));
          e.width = maxOf(bits.map((b) => b.bit)) + 1;
          resolved += 1;
        }
      }
    }
  return resolved;
}

function facingOf(element: XmlElement): string | null {
  const a = element.find("a[@name='facing']");
  return a !== null ? a.get("val") : "east";
}

// Logisim's default appearance puts the Pins of one facing on one edge of the
// instance, in the order of their y (x for north- and south-facing Pins).
export function pinOrderKey(facing: string | null): (p: Point) => Point {
  if (facing === "north" || facing === "south") return (p) => [p[0], p[1]];
  return (p) => [p[1], p[0]];
}

// What an instance of this circuit looks like from outside, as far as moving
// its parts can change it. `circuit` is the <circuit> element; `identify` maps
// a Pin location to a stable identity (the original location, for a
// re-laid-out circuit).
//
// A custom appearance (<appear>) fixes every port on the instance and names
// its Pin by location: the pairs (port position, Pin). Without one, Logisim
// derives the instance from the Pins themselves: per facing, the Pins in
// order. Moving a Pin past another of the same facing swaps two ports in
// every circuit that uses this one, without changing a single connection
// inside it. The result compares with pyEq.
export function interfaceSignature(
  circuit: XmlElement,
  identify: (p: Point) => unknown = (p) => p,
): unknown[] {
  const pins: [Point, string | null][] = circuit
    .findall("comp")
    .filter((e) => e.get("name") === "Pin")
    .map((e) => [loc(e.get("loc")), facingOf(e)]);
  const appear = circuit.find("appear");
  if (appear !== null) {
    const ports: unknown[][] = [];
    for (const port of appear.iter("circ-port")) {
      let p: number[] | null;
      try {
        p = port.get("pin", "").split(",").map(pyInt);
      } catch (error) {
        if (!(error instanceof PyValueError)) throw error;
        p = null;
      }
      ports.push([
        port.get("x"),
        port.get("y"),
        p && p.length === 2 ? identify(p as unknown as Point) : null,
      ]);
    }
    return [
      "custom",
      sortBy(ports, (v) => pyRepr(v)),
      sortBy(
        pins.map(([p]) => identify(p)),
        (v) => pyStr(v),
      ),
    ];
  }
  const groups = new Map<string | null, Point[]>();
  for (const [p, f] of pins) getOr(groups, f, () => []).push(p);
  return [
    "default",
    sorted(
      [...groups].map(([f, ps]) => [
        f,
        sortBy(ps, pinOrderKey(f)).map((p) => identify(p)),
      ]),
    ),
  ];
}

// The file text with only this <circuit> replaced by `circuit`. The XML
// declaration, libraries, options, toolbar and every other definition stay
// byte for byte what the author (or their Logisim) wrote.
export function spliceCircuit(
  source: string,
  name: string,
  circuit: XmlElement,
): string {
  const tail = circuit.tail;
  circuit.tail = null;
  let text: string;
  try {
    text = serialize(circuit).replaceAll(" />", "/>");
  } finally {
    circuit.tail = tail;
  }
  const span = circuitSpan(source, name);
  if (span === null)
    throw new PyValueError(
      `circuit ${pyRepr(name)} not found in the source text`,
    );
  if (source.slice(span[0], span[1]).includes("\r\n"))
    text = text.replaceAll("\n", "\r\n");
  return source.slice(0, span[0]) + text + source.slice(span[1]);
}

export class SchematicLayout {
  declare placementStrategy: PlacementStrategy | null;
  declare source: string;
  declare circuitName: string;
  declare tree: XmlElement;
  declare circuit: XmlElement;
  declare wiringLib: string | null;
  declare focus: Focus;
  declare components: Component[];
  declare byId: Map<string, Component>;
  declare looseWires: Wire[];
  declare pinned: Set<string>;
  declare keepTunnels: Set<string>;
  declare localiseConstants: boolean;
  declare report: Report;
  declare columnGap: number;
  declare maxLayerSpan: number;
  declare crossingCost: number;
  declare bendCost: number;
  declare flagCost: number;
  declare routeOrder: string;
  declare columnHeight: number | null;
  declare stagger: number;
  declare tunnelSpanScale: number;
  declare rowGap: number;
  declare balance: string;
  declare evenMoves: number;
  declare channelMin: number;
  declare stackSlack: number;
  declare gapCap: number;
  declare sheetGap: number;
  declare panelBelowY: number | null;
  declare elementOf: Map<string, XmlElement>;
  // plan
  declare nets: Map<NetKey, Port[]>;
  declare bitsOf: Map<NetKey, NetBit[]>;
  declare classes: Map<NetKey, string>;
  declare labelOfNet: Map<NetKey, string>;
  declare labelsOfNet: Map<NetKey, Set<string>>;
  declare tunnels: Map<string, Component>;
  declare body: Component[];
  declare constants: Map<string, Component>;
  declare bodyIds: Set<string>;
  declare copies: Map<NetKey, [Port, Port[]][]>;
  declare fused: Map<string, string>;
  declare relocated: Map<string, Point>;
  declare usedLabels: Set<string>;
  declare synthesized: Map<NetKey, string>;
  declare abbrCounter: Map<string, number>;
  declare satelliteWires: KeyMap<Port, Port>;
  declare piecePort: KeyMap<Port, Port>;
  // placement
  declare looseConstants: Set<string>;
  declare shelf: string[];
  declare pinRank: Map<string, [string, number]>;
  declare pinoutLayers: boolean;
  declare footer: { x: number; y: number; row: number; right: number };
  declare fanWires: KeyMap<Port, Port>;
  declare layer: Map<string, number>;
  declare depthLayer: Map<string, number>;
  declare captions: Map<string, string>;
  declare bodyBottom: number;
  declare placement: Map<string, Point>;
  declare labelPaddingPorts: KeySet<Port>;
  declare wireTrees: Map<NetKey, Port[][]>;
  declare controlTrees: Map<string, ControlTree>;
  // routing
  declare anchors: KeyMap<Port, string[]>;
  declare sourceOf: Map<NetKey, Port>;
  declare leadSteps: KeyMap<Port, number>;
  declare leadFacing: KeyMap<Port, string>;
  declare boundaryBridges: {
    key: NetKey;
    x: number;
    y: number;
    labels: string[];
    width: number;
  }[];
  declare keptWires: Wire[];
  declare panelSideTunnels: Set<string>;
  declare syntheticConstants: [
    string,
    number,
    number,
    string,
    number,
    string,
    Port,
  ][];
  declare syntheticFactory: Map<string, string>;
  declare failedConstantConsumers: KeySet<Port>;
  declare reserved: Set<number>;
  declare failedPorts: Map<NetKey, Port[]>;
  declare routed: [[Point, Point], string][];
  declare wires: [Point, Point][];
  declare dropTunnels: Set<string>;
  declare moved: Map<string, Component>;
  declare router: Router;

  constructor(
    xmlText: string,
    circuitName: string,
    focus: Focus,
    options: LayoutOptions = {},
  ) {
    this.placementStrategy = options.placementStrategy ?? null;
    this.source = xmlText;
    this.circuitName = circuitName;
    this.tree = parseXml(xmlText);
    const root = this.tree;
    const circuit = root
      .findall("circuit")
      .find((c) => c.get("name") === circuitName);
    if (circuit === undefined) throw new StopIteration();
    this.circuit = circuit;
    const lib = root.findall("lib").find((l) => l.get("desc") === "#Wiring");
    this.wiringLib = lib !== undefined ? lib.get("name") : "0";
    const resolved = resolveUnknownWidths(focus);
    this.focus = focus;
    this.components = focus.components;
    this.byId = new Map(this.components.map((c) => [c.componentId, c]));
    const [looseWires, looseAnchors] = looseWireGeometry(focus);
    this.looseWires = looseWires;
    this.pinned = new Set([...(options.pinnedIds ?? []), ...looseAnchors]);
    this.keepTunnels = new Set(options.keepTunnels ?? []);
    this.localiseConstants = options.localiseConstants ?? true;
    this.report = {
      nets: {},
      moved: 0,
      wires: 0,
      tunnelsRemoved: 0,
      tunnelsKept: 0,
      constantsPlaced: 0,
      unrouted: [],
      synthesizedLabels: [],
      portsWidthFromNet: resolved,
      preservedLooseWireSegments: looseWires.length,
      pinnedForLooseWires: sorted(looseAnchors),
    };
    this.columnGap = COLUMN_GAP;
    // A named net that runs backwards (consumer left of its driver: write-
    // back, branch target, feedback) keeps its Tunnels, as in any hand-drawn
    // schematic; a forward net is wired unless it spans more than this many
    // columns. Unnamed nets are always wired (see place).
    this.maxLayerSpan = 8;
    this.crossingCost = CROSSING_COST;
    this.bendCost = BEND_COST;
    this.flagCost = FLAG_COST;
    this.routeOrder = "short"; // short nets first (long ones detour around them) | "long"
    this.columnHeight = null; // packed-column height budget; null = from TARGET_ASPECT (see packColumns)
    this.stagger = STAGGER;
    this.tunnelSpanScale = 1.0; // multiplies TUNNEL_SPAN
    this.rowGap = ROW_GAP;
    this.balance = "even"; // balanceLayers rule of the drawing being made (see arrange)
    this.evenMoves = 0;
    this.channelMin = CHANNEL_MIN;
    this.stackSlack = STACK_SLACK;
    this.gapCap = GAP_CAP;
    this.sheetGap = COMPACT_GAP; // least air between parts on the routed sheet (see compactSheet); 0 turns that off
    this.panelBelowY = options.panelBelowY ?? this.detectPanel();
    this.report.panelBelowY = this.panelBelowY;
    this.bindXml();
  }

  // The fixed observation panel is the top band of the drawing that is made
  // mostly of I/O and annotation and is separated from the body by a row of
  // whitespace. Returns the y below which components are free to move; null =
  // no panel (small circuits, or a panel interleaved with the body, whose Pins
  // then take their natural place as sources and sinks).
  //
  // Composition, not size ratio or gap size, is the criterion: an 80-part
  // panel over a 330-part CPU is still a panel, and so is one separated from
  // the body by 60 px instead of 250. A sparse first stage of pure logic is
  // body, and so is a column of interface Pins over the logic of a helper
  // circuit: a panel shows something (probes, displays, buttons). A sheet
  // where nothing but the panel has been drawn yet is all panel; nothing on
  // it moves.
  detectPanel(): number | null {
    const real = sortBy(
      this.components.filter((c) => c.factoryName !== "Tunnel"),
      (c) => c.bounds.y,
    );
    if (real.length < 40 || new Set(real.map((c) => c.bounds.y)).size < 4)
      return null;
    const bands: [Component[], number][] = [];
    let current: Component[] = [];
    let bottom: number | null = null;
    for (const c of real) {
      if (current.length && c.bounds.y - (bottom as number) >= PANEL_MIN_GAP) {
        bands.push([current, bottom as number]);
        current = [];
        bottom = null;
      }
      current.push(c);
      bottom = Math.max(
        bottom !== null ? bottom : -(10 ** 9),
        c.bounds.y + c.bounds.height,
      );
    }
    bands.push([current, bottom as number]);
    let best: number | null = null;
    const cluster: Component[] = [];
    for (let i = 0; i < bands.length; i++) {
      const [band, bandBottom] = bands[i];
      const ioBand = count(band, (c) => PANEL_FACTORIES.has(c.factoryName));
      if (ioBand < PANEL_IO_SHARE * band.length) break; // a logic row: the body starts here
      cluster.push(...band);
      const io = count(cluster, (c) => PANEL_FACTORIES.has(c.factoryName));
      const shows = count(cluster, (c) => PANEL_DISPLAYS.has(c.factoryName));
      if (
        cluster.length >= PANEL_MIN_PARTS &&
        io >= PANEL_IO_SHARE * cluster.length &&
        shows >= PANEL_MIN_DISPLAYS
      ) {
        const below =
          i + 1 < bands.length
            ? bands[i + 1][0][0].bounds.y
            : bandBottom + PANEL_MIN_GAP;
        best = floorDiv(bandBottom + below, 2);
      }
    }
    return best;
  }

  // ---- observation -> model -------------------------------------------------

  // Pair each observed component with its XML element by location+factory.
  bindXml(): void {
    const elements = new Map<string, { at: Point; list: XmlElement[] }>();
    for (const element of this.circuit.findall("comp")) {
      const at = loc(element.get("loc"));
      const id = JSON.stringify([at[0], at[1], element.get("name")]);
      let entry = elements.get(id);
      if (entry === undefined) {
        entry = { at, list: [] };
        elements.set(id, entry);
      }
      entry.list.push(element);
    }
    this.elementOf = new Map();
    for (const c of this.components) {
      const at: Point = [c.location.x, c.location.y];
      let candidates = elements.get(
        JSON.stringify([at[0], at[1], c.factoryName]),
      )?.list;
      if (!candidates || !candidates.length)
        candidates = elements.get(
          JSON.stringify([at[0], at[1], c.displayName ?? null]),
        )?.list;
      if (!candidates || !candidates.length) {
        // Subcircuit instances are named after the definition.
        candidates = [];
        for (const entry of elements.values())
          if (entry.at[0] === at[0] && entry.at[1] === at[1])
            candidates.push(...entry.list);
      }
      if (!candidates.length)
        throw new PyValueError(
          `cannot bind observed component ${c.componentId} at ${pyRepr([at, c.factoryName])}`,
        );
      this.elementOf.set(c.componentId, candidates.shift() as XmlElement);
    }
  }

  collectNets(): [Map<NetKey, Port[]>, Map<NetKey, NetBit[]>] {
    const nets = new Map<NetKey, Port[]>(); // netKey -> [(componentId, endIndex)]
    const bitsOf = new Map<NetKey, NetBit[]>();
    for (const c of this.components)
      for (const e of c.ends) {
        const bits = e.netBits || [];
        if (!bits.length) continue;
        const key = netKey(bits);
        getOr(nets, key, () => []).push([c.componentId, e.index]);
        if (!bitsOf.has(key))
          bitsOf.set(
            key,
            sortBy(bits, (b) => b.bit),
          );
      }
    return [nets, bitsOf];
  }

  isPanel(c: Component): boolean {
    if (this.pinned.has(c.componentId)) return true;
    if (this.panelBelowY !== null) return c.bounds.y < this.panelBelowY;
    // No detected panel: everything is body. Input/output Pins then take
    // their natural place as sources on the left and sinks on the right.
    return false;
  }

  // A clocked state element, as the observer read it from the netlist: a
  // built-in register or flip-flop, a counter, or a subcircuit whose every
  // input only reaches storage inside (a pipeline register, a program counter
  // with its incrementer). Names play no part. ROM/RAM read asynchronously
  // and are lookups, not storage.
  isStorage(cid: string): boolean {
    return item(this.byId, cid).storage != null;
  }

  // Storage that changes on its own or feeds itself through logic (a counter,
  // a PC with its +4 adder, a state machine's register): where a machine
  // starts its cycle, so the natural roots of the flow.
  isStateful(cid: string, outEdges: Map<string, Set<string>>): boolean {
    const c = item(this.byId, cid);
    if (c.storage === "state") return true;
    if (c.storage == null) return false;
    const seen = new Set<string>();
    const stack = [...(outEdges.get(cid) ?? [])];
    while (stack.length) {
      const v = stack.pop() as string;
      if (v === cid) return true;
      if (seen.has(v) || this.isStorage(v)) continue;
      seen.add(v);
      stack.push(...(outEdges.get(v) ?? []));
    }
    return false;
  }

  plan(): Map<NetKey, string> {
    const [nets, bitsOf] = this.collectNets();
    const tunnels = new Map(
      this.components
        .filter((c) => c.factoryName === "Tunnel")
        .map((c) => [c.componentId, c]),
    );
    const labelsOfNet = new Map<NetKey, Set<string>>();
    for (const [key, ports] of nets)
      for (const [cid] of ports) {
        const tunnel = tunnels.get(cid);
        if (tunnel !== undefined && attr(tunnel, "label"))
          getOr(labelsOfNet, key, () => new Set()).add(
            attr(tunnel, "label") as string,
          );
      }
    const labelOfNet = new Map(
      [...labelsOfNet].map(([key, labels]) => [key, sorted(labels)[0]]),
    );
    const body = this.components.filter(
      (c) => c.factoryName !== "Tunnel" && !this.isPanel(c),
    );
    const bodyIds = new Set(body.map((c) => c.componentId));
    const constants = new Map(
      body
        .filter((c) => CONSTANT_SOURCES.includes(c.factoryName))
        .map((c) => [c.componentId, c]),
    );

    const classes = new Map<NetKey, string>();
    for (const [key, ports] of nets) {
      const real = ports.filter(([cid]) => !tunnels.has(cid));
      const bodyPorts = real.filter(([cid]) => bodyIds.has(cid));
      const drivers = real.filter(([cid]) => constants.has(cid));
      const labels = labelsOfNet.get(key);
      if (labels && [...labels].some((label) => this.keepTunnels.has(label))) {
        classes.set(key, "global");
      } else if (
        this.localiseConstants &&
        drivers.length === 1 &&
        real.length >= 2 &&
        real.every(
          ([cid, idx]) =>
            item(this.byId, cid).ends[idx].direction !== "output" ||
            constants.has(cid),
        )
      ) {
        // one Constant, only consumers: each consumer gets a private Constant
        // on its port (a single consumer too -- a Constant two columns away
        // from the mux select it feeds is a long wire for nothing)
        classes.set(key, "constant");
      } else if (real.length >= GLOBAL_FANOUT) {
        classes.set(key, "global");
      } else if (bodyPorts.length >= 2) {
        classes.set(key, "wire");
      } else {
        classes.set(key, "tunnel");
      }
    }
    this.nets = nets;
    this.bitsOf = bitsOf;
    this.classes = classes;
    this.labelOfNet = labelOfNet;
    this.labelsOfNet = labelsOfNet;
    this.tunnels = tunnels;
    this.body = body;
    this.constants = constants;
    this.bodyIds = bodyIds;
    this.copies = this.splitterCopies();
    this.fused = this.contactGroups();
    this.relocated = new Map();
    const abutted = this.abutments();
    const satellites = this.satellites();
    for (const [cid, [host, offset]] of new Map([...abutted, ...satellites])) {
      this.fused.set(cid, this.fused.get(host) ?? host);
      this.relocated.set(cid, offset);
    }
    // Labels already used by any Tunnel of this definition (case-insensitive):
    // a synthesised label must not merge a net into an existing one.
    this.usedLabels = new Set();
    for (const el of this.circuit.findall("comp")) {
      const label = el.find("a[@name='label']");
      if (el.get("name") === "Tunnel" && label !== null)
        this.usedLabels.add(pyStr(label.get("val")).toLowerCase());
    }
    this.synthesized = new Map();
    this.abbrCounter = new Map();
    const summary: Record<string, number> = {};
    for (const v of classes.values()) summary[v] = (summary[v] ?? 0) + 1;
    this.report.nets = summary;
    return classes;
  }

  // Nets that reach several copies of one Splitter: split ends of Splitters
  // whose combined ends hang on the same bus. Those ends are connected through
  // the bus already, so every other port of the net needs copper to one copy
  // only -- the one the author drew it nearest to -- and the net is drawn as
  // one tree per copy. People split a bus again beside each part it feeds
  // rather than run the bit wires of one Splitter across the sheet; joining
  // the copies bit by bit undoes that. Returns {net: [(copy port, [ports it
  // serves])]}.
  splitterCopies(): Map<NetKey, [Port, Port[]][]> {
    const busOf = new Map<string, NetKey>();
    for (const [key, ports] of this.nets)
      for (const [cid, idx] of ports)
        if (
          idx === 0 &&
          item(this.byId, cid).factoryName === "Splitter" &&
          this.classes.get(key) !== "constant"
        )
          busOf.set(cid, key);

    const centre = (cid: string): Point => {
      const b = item(this.byId, cid).bounds;
      return [b.x + b.width / 2, b.y + b.height / 2];
    };
    const distance = (a: string, b: string): number => {
      const [ax, ay] = centre(a);
      const [bx, by] = centre(b);
      return Math.abs(ax - bx) + Math.abs(ay - by);
    };

    const found: [NetKey, Port[], Port[]][] = [];
    for (const [key, ports] of this.nets) {
      const real = ports.filter(([cid]) => !this.tunnels.has(cid));
      if (real.some(([cid]) => !this.bodyIds.has(cid))) continue; // a panel port: the net bridges by label (see route)
      const byBus = new Map<NetKey, Port[]>();
      for (const [cid, idx] of real)
        if (idx > 0 && busOf.has(cid))
          getOr(byBus, busOf.get(cid) as NetKey, () => []).push([cid, idx]);
      const group = byBus.size ? maxBy(byBus.values(), (g) => g.length) : [];
      if (group.length >= 2) found.push([key, real, group]);
    }
    // Each part the copies feed gets one copy for every bit of the bus (a
    // part fed some bits by one copy and some by another draws two bundles
    // that cross): the nearest free copy, nearest pairs first, as long as
    // copies are free; the author put each copy by its part.
    const copiesId = (group: Port[]): string =>
      JSON.stringify(sorted(new Set(group.map(([cid]) => cid))));
    const consumers = new Map<
      string,
      { copies: Set<string>; parts: Set<string> }
    >();
    for (const [, real, group] of found) {
      const copiesOf = new Set(group.map(([cid]) => cid));
      const entry = getOr(consumers, copiesId(group), () => ({
        copies: copiesOf,
        parts: new Set<string>(),
      }));
      for (const [cid] of real) if (!copiesOf.has(cid)) entry.parts.add(cid);
    }
    const pairing = new Map<string, Map<string, string>>();
    for (const [id, { copies, parts }] of consumers) {
      const free = new Set(copies);
      const chosen = new Map<string, string>();
      const pairs: [number, string, string][] = [];
      for (const part of parts)
        for (const copy of copies)
          pairs.push([distance(part, copy), part, copy]);
      for (const [, part, copy] of sorted(pairs))
        if (!chosen.has(part) && free.has(copy)) {
          chosen.set(part, copy);
          free.delete(copy);
        }
      for (const part of parts)
        if (!chosen.has(part))
          chosen.set(
            part,
            minBy(copies, (c) => [distance(part, c), c]),
          );
      pairing.set(id, chosen);
    }
    const copies = new Map<NetKey, [Port, Port[]][]>();
    for (const [key, real, group] of found) {
      const served = portMap<Port[]>(group.map((port) => [port, []]));
      const copyPort = new Map(
        group.map(([cid, idx]) => [cid, [cid, idx] as Port]),
      );
      const chosen = item(pairing, copiesId(group));
      for (const port of real)
        if (!served.has(port))
          (served.get(item(copyPort, item(chosen, port[0]))) as Port[]).push(
            port,
          );
      copies.set(
        key,
        [...served].filter(([, rest]) => rest.length),
      );
    }
    return copies;
  }

  // Parts drawn port to port on two or more ports -- a Splitter set on a
  // decoder's outputs, a bus split right at a display -- are one rigid piece:
  // moved apart, every shared port becomes a wire of its own (a decoder and
  // its Splitter, 32 ports, drawn as 32 crossing wires). Returns {part: the
  // part it moves with}. That host is a clocked part when there is one (it
  // stays a stage boundary), else the largest part that is not a Splitter.
  contactGroups(): Map<string, string> {
    const at = new Map<number, Set<string>>();
    for (const c of this.body) {
      if (c.factoryName === "Text" || CONSTANT_SOURCES.includes(c.factoryName))
        continue;
      for (const e of c.ends)
        getOr(at, pk(e.location.x, e.location.y), () => new Set()).add(
          c.componentId,
        );
    }
    const shared = new Map<string, [string, string, number]>();
    for (const cids of at.values()) {
      const ordered = sorted(cids);
      for (let i = 0; i < ordered.length; i++)
        for (const b of ordered.slice(i + 1))
          getOr(
            shared,
            JSON.stringify([ordered[i], b]),
            (): [string, string, number] => [ordered[i], b, 0],
          )[2]++;
    }
    const pieces = new UnionFind();
    const members = new Set<string>();
    for (const [a, b, n] of shared.values())
      if (n >= 2) {
        pieces.join(a, b);
        members.add(a);
        members.add(b);
      }
    const byPiece = new Map<string, string[]>();
    for (const cid of sorted(members))
      getOr(byPiece, pieces.root(cid), () => []).push(cid);

    const rank = (cid: string): unknown[] => {
      const c = item(this.byId, cid);
      return [
        this.isStorage(cid),
        c.factoryName !== "Splitter",
        c.bounds.width * c.bounds.height,
        cid,
      ];
    };

    const fused = new Map<string, string>();
    for (const cids of byPiece.values()) {
      const host = maxBy(cids, rank);
      for (const cid of cids) if (cid !== host) fused.set(cid, host);
    }
    return fused;
  }

  // A Splitter joined to a part by ABUT_MIN or more two-port nets whose ports
  // have the same spacing on one edge of the part -- its bit ends and a
  // decoder's outputs, both 10 px apart -- is drawn port to port, the way
  // people draw it: those nets then need no wire at all (moved apart, 32 of
  // them run as a bundle across the sheet). The Splitter moves onto the part,
  // never onto a port of another net nor into its body. So does a smaller
  // part whose ports meet the larger one's top to bottom (a driver under the
  // display it feeds): side by side, the flow lines such ports up with
  // straight wires anyway, and a clocked part is a stage boundary that stays
  // a column of its own. Returns {moved part: (host, (dx, dy) from where it
  // was)}.
  abutments(): Map<string, [string, Point]> {
    const links = new Map<string, [string, string, [number, number][]]>();
    const notJoinable = ["Text", ...CONSTANT_SOURCES];
    for (const [key, ports] of this.nets) {
      if (this.classes.get(key) !== "wire") continue;
      let pairs: Port[][];
      const copies = this.copies.get(key);
      if (copies !== undefined) {
        // a copy of a Splitter that serves one port is a two-port link
        pairs = copies
          .filter(([, served]) => served.length === 1)
          .map(([copy, served]) => [copy, served[0]]);
      } else {
        pairs = [ports.filter(([cid]) => !this.tunnels.has(cid))];
      }
      for (const real of pairs) {
        if (real.length !== 2 || real[0][0] === real[1][0]) continue;
        if (
          !real.every(
            ([cid]) =>
              this.bodyIds.has(cid) &&
              !this.fused.has(cid) &&
              !notJoinable.includes(item(this.byId, cid).factoryName),
          )
        )
          continue;
        const [[a, i], [b, j]] = sorted(real);
        getOr(
          links,
          JSON.stringify([a, b]),
          (): [string, string, [number, number][]] => [a, b, []],
        )[2].push([i, j]);
      }
    }

    const area = (cid: string): number => {
      const b = item(this.byId, cid).bounds;
      return b.width * b.height;
    };

    const out = new Map<string, [string, Point]>();
    const hosts = new Set<string>();
    for (const [a, b, pairs] of sortBy(links.values(), ([a, b, pairs]) => [
      -pairs.length,
      [a, b],
    ])) {
      if (pairs.length < ABUT_MIN) continue;
      const [host, part] =
        cmp([area(a), a], [area(b), b]) >= 0 ? [a, b] : [b, a];
      if (out.has(part) || hosts.has(part) || out.has(host)) continue;
      const h = item(this.byId, host);
      const m = item(this.byId, part);
      const ports = pairs.map(([i, j]) => (host === a ? [i, j] : [j, i])); // (host port, part port)
      const offsets = new Map<string, Point>();
      for (const [hi, mi] of ports) {
        const offset: Point = [
          h.ends[hi].location.x - m.ends[mi].location.x,
          h.ends[hi].location.y - m.ends[mi].location.y,
        ];
        offsets.set(JSON.stringify(offset), offset);
      }
      const hostEdges = intersection(ports.map(([hi]) => edgesAt(h, hi)));
      if (offsets.size !== 1 || !hostEdges.size) continue; // not one edge of the host, or the spacings differ
      if (m.factoryName !== "Splitter") {
        const facingEdges = new Set(
          [...hostEdges]
            .filter((e) => e === "north" || e === "south")
            .map((e) => item(OPPOSITE, e)),
        );
        const partEdges = intersection(ports.map(([, mi]) => edgesAt(m, mi)));
        if (
          this.isStorage(host) ||
          this.isStorage(part) ||
          ![...facingEdges].some((e) => partEdges.has(e))
        )
          continue; // two parts meet top to bottom (a driver under a display), never at a stage boundary
      }
      const [dx, dy] = offsets.values().next().value as Point;
      const hb = h.bounds;
      const mb = m.bounds;
      const overX =
        Math.min(hb.x + hb.width, mb.x + dx + mb.width) -
        Math.max(hb.x, mb.x + dx);
      const overY =
        Math.min(hb.y + hb.height, mb.y + dy + mb.height) -
        Math.max(hb.y, mb.y + dy);
      if (overX >= GRID && overY >= GRID) continue; // the bodies would overlap
      const netsAt = new Map<number, NetKey>();
      for (const e of h.ends)
        netsAt.set(pk(e.location.x, e.location.y), netKey(e.netBits || []));
      if (
        m.ends.some((e) => {
          const own = netKey(e.netBits || []);
          return (
            (netsAt.get(pk(e.location.x + dx, e.location.y + dy)) ?? own) !==
            own
          );
        })
      )
        continue; // a port would land on a port of another net
      out.set(part, [host, [dx, dy]]);
      hosts.add(host);
    }
    return out;
  }

  // One-port parts facing north or south (a Pin with its port on top) whose
  // only wire runs to a port on the facing edge of one other part: they stand
  // right below (or above) that port, the way people draw the address and
  // enable Pins of a register file, instead of in the input column with a
  // wire round the part. Several on one edge stand in a row in the order of
  // their ports, moved sideways as little as their widths need. Where ports
  // 10 px apart (a Splitter's fan) would move one sideways -- no room for a
  // wire to jog between them -- every part stands right below its own port
  // instead, each a step further out than its neighbour where their bodies or
  // labels would meet -- the staircase people draw under a fan -- and its wire
  // runs straight along the edge of the part before it (laid before routing,
  // see this.satelliteWires and route). Returns {part: (host, (dx, dy) from
  // where the author drew it)}.
  satellites(): Map<string, [string, Point]> {
    this.satelliteWires = portMap();
    const netOf = portMap<NetKey>();
    for (const [key, ports] of this.nets)
      for (const port of ports) netOf.set(port, key);

    // How far the part's label reaches past its box, left and right.
    const reach = (c: Component): Point => {
      const label = attr(c, "label");
      if (!label) return [0, 0];
      const side = attr(c, "labelloc") || "west";
      if (side === "west") return [textWidth(label), 0];
      if (side === "east") return [0, textWidth(label)];
      return [0, 0];
    };

    // {part: y of its port} with each part right below (above) its port, or
    // null when no staircase within STAIR_DEPTH fits. Tried stepping out to
    // the right and to the left (the side the labels leave free), the
    // shallower kept.
    const staircase = (
      edge: string,
      row: [XY, string][],
    ): Map<string, number> | null => {
      const out = edge === "south" ? 1 : -1;
      let best: [number, Map<string, number>] | null = null;
      for (const order of [row, [...row].reverse()]) {
        const placed: [Box, readonly [number, number, number]][] = [];
        const ys = new Map<string, number>();
        let floor = SATELLITE_GAP;
        for (const [port, cid] of order) {
          const c = item(this.byId, cid);
          const own = c.ends[0].location;
          const b = c.bounds;
          const [left, right] = reach(c);
          const x0 = b.x + port.x - own.x - left;
          const x1 = b.x + b.width + port.x - own.x + right;
          let fits = false;
          let depth = floor;
          let y = 0;
          let box: Box = [0, 0, 0, 0];
          let wire: readonly [number, number, number] = [0, 0, 0];
          for (; depth < STAIR_DEPTH + 1; depth += GRID) {
            // never back up: one way down
            y = port.y + out * depth;
            const bx: Box = [
              x0,
              b.y + y - own.y,
              x1,
              b.y + b.height + y - own.y,
            ];
            const w = [
              port.x,
              Math.min(port.y, y),
              Math.max(port.y, y),
            ] as const;
            if (
              placed.some(
                ([q]) =>
                  bx[0] < q[2] + GRID &&
                  q[0] < bx[2] + GRID &&
                  bx[1] < q[3] &&
                  q[1] < bx[3],
              )
            )
              continue; // meets a part (or its label) beside it
            if (
              placed.some(
                ([q]) =>
                  q[0] < w[0] && w[0] < q[2] && q[1] < w[2] && w[1] < q[3],
              )
            )
              continue; // its wire would run through a nearer part
            if (
              placed.some(
                ([, v]) =>
                  bx[0] < v[0] && v[0] < bx[2] && bx[1] < v[2] && v[1] < bx[3],
              )
            )
              continue; // a farther part's wire would run through it
            box = bx;
            wire = w;
            fits = true;
            break;
          }
          if (!fits) break;
          placed.push([box, wire]);
          ys.set(cid, y);
          floor = depth;
        }
        if (ys.size === row.length) {
          const deepest = maxOf(
            row.map(([port, cid]) =>
              Math.abs((ys.get(cid) as number) - port.y),
            ),
          );
          if (best === null || deepest < best[0]) best = [deepest, ys];
        }
      }
      return best && best[1];
    };

    const rows = new Map<string, [string, string, [XY, string][]]>();
    for (const c of this.body) {
      const cid = c.componentId;
      const facing = attr(c, "facing");
      if (
        !SATELLITES.has(c.factoryName) ||
        c.ends.length !== 1 ||
        (facing !== "north" && facing !== "south") ||
        this.fused.has(cid)
      )
        continue;
      const key = netOf.get([cid, 0]);
      if (key === undefined || this.classes.get(key) !== "wire") continue;
      const others = item(this.nets, key).filter(
        ([o]) => o !== cid && !this.tunnels.has(o),
      );
      if (
        others.length !== 1 ||
        !this.bodyIds.has(others[0][0]) ||
        SATELLITES.has(item(this.byId, others[0][0]).factoryName)
      )
        continue;
      const [host, idx] = others[0];
      const edge = edgeOf(item(this.byId, host), idx);
      if (edge === (facing === "north" ? "south" : "north"))
        getOr(
          rows,
          JSON.stringify([host, edge]),
          (): [string, string, [XY, string][]] => [host, edge, []],
        )[2].push([item(this.byId, host).ends[idx].location, cid]);
    }
    const out = new Map<string, [string, Point]>();
    for (const [host, edge, unordered] of rows.values()) {
      const row = sortBy(unordered, (r) => [r[0].x, r[1]]);
      let right = -Infinity;
      let shifted = false;
      const placed = new Map<string, Point>();
      for (const [port, cid] of row) {
        const c = item(this.byId, cid);
        const own = c.ends[0].location;
        const b = c.bounds;
        const leftOf = own.x - b.x;
        const rightOf = b.x + b.width - own.x;
        const x =
          right === -Infinity
            ? port.x
            : Math.max(
                port.x,
                GRID * Math.ceil((right + GRID + leftOf) / GRID),
              );
        shifted = shifted || x !== port.x;
        right = x + rightOf;
        placed.set(cid, [
          x,
          port.y + (edge === "south" ? SATELLITE_GAP : -SATELLITE_GAP),
        ]);
      }
      let close = false;
      for (let k = 0; k + 1 < row.length; k++)
        if (row[k + 1][0].x - row[k][0].x < 2 * GRID) close = true;
      const stairs = shifted && close ? staircase(edge, row) : null;
      for (const [port, cid] of row) {
        const own = item(this.byId, cid).ends[0].location;
        const [x, y] = stairs
          ? [port.x, stairs.get(cid) as number]
          : (placed.get(cid) as Point);
        out.set(cid, [host, [x - own.x, y - own.y]]);
        if (stairs) {
          const wired = item(this.nets, netOf.get([cid, 0]) as NetKey).find(
            ([o]) => o === host,
          );
          if (wired === undefined) throw new StopIteration();
          this.satelliteWires.set([cid, 0], [wired[0], wired[1]]);
        }
      }
    }
    return out;
  }

  // byId, nets, body, bodyIds and copies as placement sees them: each fused
  // piece (see contactGroups) is its host with the members' union box and all
  // their ports, a net inside one piece has one port.
  fusedView(): [
    Map<string, Component>,
    Map<NetKey, Port[]>,
    Component[],
    Set<string>,
    Map<NetKey, [Port, Port[]][]>,
  ] {
    const byId = new Map(this.byId);
    const remap = portMap<Port>();
    for (const host of new Set(this.fused.values())) {
      const parts = [
        host,
        ...sorted(
          [...this.fused].filter(([, h]) => h === host).map(([p]) => p),
        ),
      ];

      const box = (m: string, visual = false) => {
        const c = item(this.byId, m);
        const b = visual
          ? hasOwn(c, "visualBounds")
            ? c.visualBounds
            : c.bounds
          : c.bounds;
        const [dx, dy] = this.relocated.get(m) ?? [0, 0];
        return {
          x: b!.x + dx,
          y: b!.y + dy,
          width: b!.width,
          height: b!.height,
        };
      };

      const boxes = parts.map((m) => box(m));
      const x0 = minOf(boxes.map((b) => b.x));
      const y0 = minOf(boxes.map((b) => b.y));
      const x1 = maxOf(boxes.map((b) => b.x + b.width));
      const y1 = maxOf(boxes.map((b) => b.y + b.height));
      const ends: End[] = [];
      const seen = new Map<string, number>();
      for (const m of parts) {
        const [dx, dy] = this.relocated.get(m) ?? [0, 0];
        for (const e of item(this.byId, m).ends) {
          const at = { x: e.location.x + dx, y: e.location.y + dy };
          const id = JSON.stringify([at.x, at.y, netKey(e.netBits || [])]);
          if (!seen.has(id)) {
            // ports drawn onto each other are one port of the piece
            seen.set(id, ends.length);
            ends.push({ ...e, index: ends.length, location: at });
          }
          remap.set([m, e.index], [host, seen.get(id) as number]);
        }
      }
      const visual = parts.map((m) => box(m, true));
      const vx = minOf(visual.map((b) => b.x));
      const vy = minOf(visual.map((b) => b.y));
      const vb = {
        x: vx,
        y: vy,
        width: maxOf(visual.map((b) => b.x + b.width)) - vx,
        height: maxOf(visual.map((b) => b.y + b.height)) - vy,
      };
      byId.set(host, {
        ...item(this.byId, host),
        visualBounds: vb,
        bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        ends,
      });
    }
    const nets = new Map<NetKey, Port[]>();
    for (const [key, ports] of this.nets) {
      const mapped: Port[] = [];
      for (const original of ports) {
        const port = remap.get(original) ?? original;
        if (!mapped.some((p) => samePort(p, port))) mapped.push(port);
      }
      nets.set(key, mapped);
    }
    const body = this.body
      .filter((c) => !this.fused.has(c.componentId))
      .map((c) => byId.get(c.componentId) as Component);
    const copies = new Map<NetKey, [Port, Port[]][]>(
      [...this.copies].map(([key, groups]) => [
        key,
        groups.map(([copy, served]) => [
          remap.get(copy) ?? copy,
          served.map((p) => remap.get(p) ?? p),
        ]),
      ]),
    );
    this.piecePort = remap;
    return [
      byId,
      nets,
      body,
      new Set([...this.bodyIds].filter((cid) => !this.fused.has(cid))),
      copies,
    ];
  }

  // ---- labels ------------------------------------------------------------------

  // The label set that names a net: the author's Tunnel labels, else one
  // synthesised label (Pin/Probe label > driver label[.port] > consumer
  // label.port > factory abbreviation + ordinal), unique in the definition.
  labelsFor(key: NetKey): string[] {
    const labels = this.labelsOfNet.get(key);
    if (labels && labels.size) return sorted(labels);
    const known = this.synthesized.get(key);
    if (known !== undefined) return [known];
    const base = this.deriveLabel(key);
    let label = base;
    let k = 2;
    while (this.usedLabels.has(label.toLowerCase())) {
      label = `${base}_${k}`;
      k += 1;
    }
    this.usedLabels.add(label.toLowerCase());
    this.synthesized.set(key, label);
    this.report.synthesizedLabels.push(label);
    return [label];
  }

  deriveLabel(key: NetKey): string {
    const ports = item(this.nets, key).filter(
      ([cid]) => !this.tunnels.has(cid),
    );

    const portWord = (c: Component, idx: number): string => {
      const tip = c.ends[idx].runtimeTooltip || "";
      const m = PORT_WORD_RE.exec(tip);
      return m !== null ? m[1] : `p${idx}`;
    };

    for (const [cid] of ports) {
      const c = item(this.byId, cid);
      if (LABELLED_IO.has(c.factoryName) && attr(c, "label"))
        return sanitizeLabel(attr(c, "label"));
    }
    const outputs = ports.filter(
      ([cid, idx]) => item(this.byId, cid).ends[idx].direction === "output",
    );
    if (outputs.some(([cid]) => item(this.byId, cid).factoryName === "Clock"))
      return "CLK";
    for (const [cid, idx] of outputs) {
      const c = item(this.byId, cid);
      const label = attr(c, "label");
      if (label) {
        const nOut = count(c.ends, (e) => e.direction === "output");
        return sanitizeLabel(
          nOut === 1 ? label : `${label}.${portWord(c, idx)}`,
        );
      }
    }
    for (const [cid, idx] of ports) {
      const c = item(this.byId, cid);
      const label = attr(c, "label");
      if (label && c.ends[idx].direction === "input")
        return sanitizeLabel(`${label}.${portWord(c, idx)}`);
    }
    const [cid] = (outputs.length ? outputs : ports)[0];
    const c = item(this.byId, cid);
    const abbr =
      LABEL_ABBREVIATIONS.get(c.factoryName) ||
      cpSlice(c.factoryName.replace(/[^A-Za-z]/g, ""), 0, 4).toUpperCase() ||
      "NET";
    const n = (this.abbrCounter.get(abbr) ?? 0) + 1;
    this.abbrCounter.set(abbr, n);
    return `${abbr}${n}`;
  }

  // ---- placement -------------------------------------------------------------

  // Directed signal flow among body components.
  //
  // With allNets the graph includes nets that stay Tunnels (globals like the
  // instruction word) so stage inference sees the real dependencies;
  // clock/reset/enable style nets (fan-out >= GLOBAL_FANOUT of 1-bit inputs)
  // are still skipped because they do not define data-flow order. Splitter
  // ports are 'inout': a splitter is a pass-through node, so an edge is added
  // from every driver on its nets to it and from it to every consumer on its
  // nets. An input the observer marked registered on a part that is not
  // storage as a whole (the write port of a register file) takes its value
  // for the next cycle: it does not order the part after its driver, so no
  // edge is added for it and the write-back net runs backwards.
  graph(allNets = false): Map<string, Set<string>> {
    const bodyIds = this.bodyIds;
    const outEdges = new Map<string, Set<string>>();
    const direction = ([cid, idx]: Port) =>
      item(this.byId, cid).ends[idx].direction;
    const registered = ([cid, idx]: Port): boolean => {
      const c = item(this.byId, cid);
      return c.storage == null && c.ends[idx].registered === true;
    };
    for (const [key, cls] of this.classes) {
      if (cls === "constant") continue;
      if (!allNets && cls !== "wire") continue;
      const ports = item(this.nets, key).filter(([cid]) => bodyIds.has(cid));
      if (ports.length < 2) continue;
      const bits = this.bitsOf.get(key);
      const width = bits && bits.length ? bits[bits.length - 1].bit + 1 : 1;
      if (cls === "global" && width === 1) continue;
      const srcs = ports
        .filter((p) => direction(p) === "output")
        .map(([cid]) => cid);
      const dsts = ports
        .filter((p) => direction(p) === "input" && !registered(p))
        .map(([cid]) => cid);
      const passThrough = ports
        .filter((p) => direction(p) !== "output" && direction(p) !== "input")
        .map(([cid]) => cid);
      for (const s of srcs)
        for (const d of [...dsts, ...passThrough])
          if (s !== d) getOr(outEdges, s, () => new Set()).add(d);
      for (const p of passThrough)
        for (const d of dsts)
          if (p !== d) getOr(outEdges, p, () => new Set()).add(d);
    }
    return outEdges;
  }

  // Signal-flow layering.
  //
  // Longest path from sources over the body graph (all nets, splitters as
  // pass-through, back-edges cut by DFS) gives every part a depth. Registers
  // are stage boundaries: stage(r) = longest register-to-register path, and a
  // combinational part belongs to the earliest stage that drives it. Layers,
  // when the registers really split the sheet into stages (see below):
  //     pre-register logic .......... its depth (0..K)
  //     register of stage s ......... K+1 + 2s
  //     logic driven by stage s ..... K+1 + 2s + 1
  // Pure combinational circuits have no registers, so layer == depth. Text
  // has no ports and is not layered (see place).
  layers(): Map<string, number> {
    const outEdges = this.graph(true);
    // A Constant whose only net is localised (a private copy lands on every
    // consumer port, see route) has no place in the flow; it goes to the
    // footer with the loose Text instead of opening a column of its own.
    this.looseConstants = new Set();
    for (const [cid, c] of this.constants)
      if (
        c.ends
          .filter((e) => e.netBits && e.netBits.length)
          .every(
            (e) => this.classes.get(this.netKeyOf(e) as NetKey) === "constant",
          )
      )
        this.looseConstants.add(cid);
    const ids = this.body
      .filter(
        (c) =>
          c.factoryName !== "Text" && !this.looseConstants.has(c.componentId),
      )
      .map((c) => c.componentId);
    // Clocked state elements are stage boundaries. ROM/RAM read
    // asynchronously (address in, data out in the same cycle), so they are
    // combinational lookups inside a stage, not boundaries.
    const storage = new Set(ids.filter((cid) => this.isStorage(cid)));
    const stateful = new Set(
      [...storage].filter((cid) => this.isStateful(cid, outEdges)),
    );
    const indeg = new Map(ids.map((u) => [u, 0]));
    for (const vs of outEdges.values())
      for (const v of vs)
        if (indeg.has(v)) indeg.set(v, (indeg.get(v) as number) + 1);
    // DFS from sources (registers first so feedback into them is the cut edge)
    const state = new Map<string, number>();
    const order: string[] = [];
    const forward = new Map<string, Set<string>>();
    const dfs = (start: string): void => {
      state.set(start, 1);
      const stack: [string, string[], number][] = [
        [start, sorted(outEdges.get(start) ?? []), 0],
      ];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const [u, successors] = frame;
        if (frame[2] < successors.length) {
          const v = successors[frame[2]++];
          if (!indeg.has(v) || state.get(v) === 1) continue;
          getOr(forward, u, () => new Set()).add(v);
          if (!state.has(v)) {
            state.set(v, 1);
            stack.push([v, sorted(outEdges.get(v) ?? []), 0]);
          }
        } else {
          state.set(u, 2);
          order.push(u);
          stack.pop();
        }
      }
    };
    // Registers first, and among them the ones that drive themselves (the PC
    // with its incrementer, a counter): the walk then enters the datapath
    // where the machine starts a cycle, so the cycles IF -> ... -> WB -> IF
    // and write-back -> register file are cut on their closing edges and not
    // wherever component ids happen to start the walk.
    const rootKey = (u: string): unknown[] => [
      !storage.has(u),
      !stateful.has(u),
      indeg.get(u),
      u,
    ];
    for (const u of sortBy(ids, rootKey)) if (!state.has(u)) dfs(u);
    const depth = new Map(ids.map((u) => [u, 0]));
    const reversedOrder = [...order].reverse();
    for (const u of reversedOrder)
      for (const v of forward.get(u) ?? [])
        depth.set(
          v,
          Math.max(depth.get(v) as number, (depth.get(u) as number) + 1),
        );
    // register stages: longest register->register path over the cut DAG
    const reach = new Map<string, Set<string>>();
    for (const r of storage) {
      const seen = new Set<string>();
      const stack = [...(forward.get(r) ?? [])];
      while (stack.length) {
        const v = stack.pop() as string;
        if (seen.has(v)) continue;
        seen.add(v);
        if (storage.has(v)) getOr(reach, r, () => new Set()).add(v);
        else stack.push(...(forward.get(v) ?? []));
      }
    }
    const stage = new Map([...storage].map((r) => [r, 0]));
    for (const u of reversedOrder)
      if (storage.has(u))
        for (const v of reach.get(u) ?? [])
          stage.set(
            v,
            Math.max(stage.get(v) as number, (stage.get(u) as number) + 1),
          );
    // Every combinational node belongs to the earliest register stage that
    // drives it; inside the stage it keeps its longest-path depth from that
    // stage's registers (a single-cycle datapath is one stage with a deep
    // combinational chain: ROM -> splitter -> regfile -> ALU -> mux, and it
    // must not collapse into one column). Stage s occupies
    //     K+1+base(s) ................ its registers
    //     K+1+base(s)+d, d>=1 ........ logic at depth d
    // with base(s+1) = base(s) + max depth of stage s + 1.
    const preds = new Map<string, Set<string>>();
    for (const [u, vs] of forward)
      for (const v of vs) getOr(preds, v, () => new Set()).add(u);
    const stageOf = new Map<string, number>();
    const localDepth = new Map<string, number>();
    for (const u of reversedOrder) {
      if (storage.has(u)) {
        stageOf.set(u, stage.get(u) as number);
        localDepth.set(u, 0);
        continue;
      }
      const staged = [...(preds.get(u) ?? [])].filter((p) => stageOf.has(p));
      if (!staged.length) continue;
      const s = minOf(staged.map((p) => stageOf.get(p) as number));
      stageOf.set(u, s);
      let d = 1;
      for (const p of staged)
        if (stageOf.get(p) === s)
          d = Math.max(
            d,
            !storage.has(p) ? (localDepth.get(p) as number) + 1 : 1,
          );
      localDepth.set(u, d);
    }
    // A sheet is laid out stage by stage only when its registers really split
    // it into stages: at least two stages each hold a real share of the parts.
    // Otherwise (a single-cycle CPU, whose PC, interrupt and status registers
    // would string into a column each -- 15 columns for 141 parts where the
    // author used 6 -- a counter, a datapath of plain Registers) registers are
    // ordinary nodes of the flow and stand where their producers and consumers
    // are. The DFS above still cut the cycles at registers, so write-back
    // paths run right to left and keep their labels (see demote).
    const members = new Map<number, number>();
    for (const s of stageOf.values()) members.set(s, (members.get(s) ?? 0) + 1);
    const stageMin = Math.max(
      STAGE_MIN_PARTS,
      Math.ceil(STAGE_MIN_SHARE * ids.length),
    );
    if (count(members.values(), (n) => n >= stageMin) < 2) {
      this.balanceLayers(depth, forward);
      return SchematicLayout.compact(depth);
    }
    const pre = ids.filter((u) => !stageOf.has(u));
    const K = maxOf(
      pre.map((u) => depth.get(u) as number),
      -1,
    );
    const base = new Map<number, number>();
    let offset = 0;
    for (const s of sorted(new Set(stageOf.values()))) {
      base.set(s, offset);
      offset +=
        maxOf(
          ids
            .filter((u) => stageOf.get(u) === s)
            .map((u) => localDepth.get(u) as number),
          0,
        ) + 1;
    }
    const layer = new Map<string, number>();
    for (const u of ids) {
      const s = stageOf.get(u);
      layer.set(
        u,
        s !== undefined
          ? K + 1 + (base.get(s) as number) + (localDepth.get(u) as number)
          : (depth.get(u) as number),
      );
    }
    return SchematicLayout.compact(layer);
  }

  // Longest-path depth puts every part as far left as its inputs allow: a
  // source, or a part fed only by sources, lands in the first columns however
  // far away its consumers are (an immediate extender next to the instruction
  // splitter, its mux eight columns on). Right to left, a part moves up to
  // just before its nearest consumer when that makes its wires shorter in
  // total: it has more consumers than producers, or it is a one-in, one-out
  // link of a chain that starts at a part free to follow (the chain ends up
  // beside the part it feeds). With this.balance "even", every part with at
  // least as many consumers as producers moves too: no wire gets longer in
  // total, and the rest of the drawing decides whether that helps (see
  // arrange). Input Pins stay where a reader looks for them. Only for
  // circuits without pipeline stages (whose columns are the stages).
  balanceLayers(
    depth: Map<string, number>,
    forward: Map<string, Set<string>>,
  ): void {
    const preds = new Map<string, Set<string>>();
    for (const [u, vs] of forward)
      for (const v of vs)
        if (depth.has(v) && depth.has(u))
          getOr(preds, v, () => new Set()).add(u);
    const predsOf = (u: string): Set<string> =>
      getOr(preds, u, () => new Set());

    const consumers = (u: string): string[] =>
      [...(forward.get(u) ?? [])].filter((v) => depth.has(v));

    const shortens = (u: string): boolean => {
      if (consumers(u).length > predsOf(u).size) return true;
      if (consumers(u).length !== 1 || predsOf(u).size !== 1) return false;
      // one wire in, one out: moving is worth it only when the chain feeding
      // u starts at a part that can follow it
      let p = u;
      const seen = new Set([u]);
      while (predsOf(p).size) {
        const [q] = predsOf(p);
        if (
          seen.has(q) ||
          consumers(q).length !== 1 ||
          predsOf(q).size > 1 ||
          item(this.byId, q).factoryName === "Pin"
        )
          return false;
        seen.add(q);
        p = q;
      }
      return true;
    };

    for (let round = 0; round < depth.size; round++) {
      let changed = false;
      for (const u of sortBy(depth.keys(), (v) => -(depth.get(v) as number))) {
        const succ = consumers(u);
        if (!succ.length || item(this.byId, u).factoryName === "Pin") continue;
        const hi = minOf(succ.map((v) => depth.get(v) as number)) - 1;
        if (hi <= (depth.get(u) as number)) continue;
        if (shortens(u)) {
          depth.set(u, hi);
          changed = true;
        } else if (this.balance === "even" && succ.length >= predsOf(u).size) {
          depth.set(u, hi);
          changed = true;
          this.evenMoves += 1;
        }
      }
      if (!changed) break;
    }
  }

  // Renumber the layers densely. Every depth keeps a column of its own: a
  // part merged into the layer before it stood above or below the parts that
  // feed it, their wire going round it (a register file under the Pins it
  // reads), and a stage boundary with one part lost its column. packColumns
  // still shares columns where the budget allows, staggering each depth to
  // the right so wires run left to right.
  static compact(layer: Map<string, number>): Map<string, number> {
    const dense = new Map(
      sorted(new Set(layer.values())).map((l, i) => [l, i]),
    );
    return new Map([...layer].map(([cid, l]) => [cid, dense.get(l) as number]));
  }

  // Min-width layering. Consecutive combinational layers share one column
  // while their stacked height stays under a budget, each part staggered
  // right by its depth inside the column so wires still run left to right; a
  // register layer is always a column of its own (the stage boundary a reader
  // looks for). The budget follows the size of the circuit: with H the total
  // stacked height of all layers and P the column pitch, packing into columns
  // of height B gives a sheet about (H/B)*P wide and B tall, so B =
  // sqrt(H*P/TARGET_ASPECT) lands near the aspect people draw (1.5). A
  // 10-part adder then keeps one layer per column with real channels between
  // them instead of one staggered column its wires have to thread through; a
  // 370-part CPU packs its thin layers into ~2000 px columns as before. The
  // tallest register column is a floor (it cannot be split), MAX_STACK the
  // ceiling; this.columnHeight overrides. Returns (column of part, x offset).
  packColumns(
    depthLayer: Map<string, number>,
  ): [Map<string, number>, Map<string, number>] {
    // A very wide, flat part (a hazard/bubble unit drawn as a 1800 x 40
    // subcircuit with all its pins on one long edge) cannot stand in a
    // column: it goes on a shelf across the top of the body instead.
    this.shelf = [...depthLayer.keys()].filter((cid) => {
      const b = item(this.byId, cid).bounds;
      return b.width >= SHELF_WIDTH && b.height * 4 <= b.width;
    });
    const layer = new Map(
      [...depthLayer].filter(([cid]) => !this.shelf.includes(cid)),
    );
    const byLayer = new Map<number, string[]>();
    for (const [cid, l] of layer) getOr(byLayer, l, () => []).push(cid);
    const storage = new Set(
      [...layer.keys()].filter((cid) => this.isStorage(cid)),
    );
    const stackHeight = (ids: readonly string[]): number =>
      sum(ids.map((cid) => item(this.byId, cid).bounds.height + this.rowGap));
    const width = (cid: string): number => item(this.byId, cid).bounds.width;
    const tallestRegister = maxOf(
      [...byLayer.values()].map((ids) =>
        stackHeight(ids.filter((cid) => storage.has(cid))),
      ),
      0,
    );
    let budget: number;
    if (this.columnHeight !== null) {
      budget = Math.max(this.columnHeight, tallestRegister);
    } else {
      const total = sum([...byLayer.values()].map(stackHeight));
      let widthsAll = sorted([...layer.keys()].map(width));
      if (!widthsAll.length) widthsAll = [40];
      const pitch =
        widthsAll[floorDiv(widthsAll.length, 2)] +
        this.channelMin +
        2 * this.stagger;
      const auto = Math.sqrt((total * pitch) / TARGET_ASPECT);
      budget = Math.max(
        tallestRegister,
        Math.min(MAX_STACK, Math.max(COLUMN_HEIGHT_MIN, auto)),
      );
    }
    this.report.columnBudget = Math.trunc(budget);
    const column = new Map<string, number>();
    const offset = new Map<string, number>();
    let col = -1;
    let members: string[] = [];
    const widths: number[] = [];
    for (const l of sorted(byLayer.keys())) {
      const ids = byLayer.get(l) as string[];
      if (
        stackHeight(ids) > budget * LAYER_SPLIT &&
        !ids.some((cid) => this.pinRank.has(cid))
      ) {
        // Parts of one depth do not feed each other, so a layer of many (six
        // processor instances side by side on a test sheet) need not be one
        // column 20 times taller than wide: it becomes columns of the
        // budget's height, filled in the author's top-to-bottom order. Pins
        // whose order is the instance's port order stay one column (side by
        // side they would interleave).
        let chunk: string[] = [];
        const pins = ids.filter(
          (cid) => item(this.byId, cid).factoryName === "Pin",
        );
        if (pins.length) {
          // the Pins of the layer stay one column: fanned out to several,
          // their wires cross each other on the way
          col += 1;
          widths.push(maxOf(pins.map(width)));
          for (const c of pins) {
            column.set(c, col);
            offset.set(c, 0);
          }
        }
        const rest = sortBy(
          ids.filter((c) => !pins.includes(c)),
          (c) => [item(this.byId, c).location.y, item(this.byId, c).location.x],
        );
        for (const cid of [...rest, null]) {
          if (
            chunk.length &&
            (cid === null || stackHeight([...chunk, cid]) > budget)
          ) {
            col += 1;
            widths.push(maxOf(chunk.map(width)));
            for (const c of chunk) {
              column.set(c, col);
              offset.set(c, 0);
            }
            chunk = [];
          }
          if (cid !== null) chunk.push(cid);
        }
        members = [...ids];
        continue;
      }
      const isReg = ids.some((cid) => storage.has(cid));
      let x: number;
      if (
        col < 0 ||
        isReg ||
        members.some((cid) => storage.has(cid)) ||
        stackHeight([...members, ...ids]) > budget
      ) {
        col += 1;
        members = [];
        x = 0;
        widths.push(0);
      } else {
        x = widths[col] + this.stagger;
      }
      for (const cid of ids) {
        column.set(cid, col);
        offset.set(cid, x);
      }
      widths[col] = Math.max(widths[col], x + maxOf(ids.map(width)));
      members = [...members, ...ids];
    }
    return [column, offset];
  }

  // Nets that stay Tunnels although both ends are in the body.
  //
  // Hand-drawn CPUs switch from wire to tunnel by distance: a net whose
  // consumer sits 600 px or more from its driver is tunnelled in more than two
  // thirds of them, one under 200 px almost never; fan-out lowers the distance
  // (a control signal with three consumers is tunnelled from ~300 px). A named
  // net that runs backwards (consumer left of its driver: write-back, branch
  // target, feedback) keeps its Tunnels regardless. An unnamed net has no
  // label to read, so it stays a wire unless it would cross half the sheet.
  // Distances are estimated from the column packing before routing (channels
  // at their upper bound), so the rule is deterministic and needs no
  // iteration.
  demote(
    depthLayer: Map<string, number>,
    column: Map<string, number>,
    xOffset: Map<string, number>,
  ): void {
    const byCol = new Map<number, string[]>();
    for (const [cid, col] of column) getOr(byCol, col, () => []).push(cid);
    const widths = new Map(
      [...byCol].map(([col, ids]) => [
        col,
        maxOf(
          ids.map(
            (c) => (xOffset.get(c) as number) + item(this.byId, c).bounds.width,
          ),
        ),
      ]),
    );
    const channel = this.channels(
      column,
      [...this.classes]
        .filter(([, cls]) => cls === "wire")
        .map(([key]) => item(this.nets, key)),
    );
    const xOf = new Map<number, number>();
    let cursor = 0;
    for (const col of sorted(byCol.keys())) {
      xOf.set(col, cursor);
      cursor += (widths.get(col) as number) + channel(col);
    }

    const px = (cid: string, idx: number): number => {
      const c = item(this.byId, cid);
      return (
        (xOf.get(column.get(cid) as number) as number) +
        (xOffset.get(cid) as number) +
        c.ends[idx].location.x -
        c.bounds.x
      );
    };

    let demoted = 0;
    for (const [key, cls] of [...this.classes]) {
      if (cls !== "wire") continue;
      const ports = item(this.nets, key).filter(([cid]) => column.has(cid));
      if (ports.length < 2) continue;
      const labels = this.labelsOfNet.get(key);
      const named = !!(labels && labels.size);
      let drivers = ports.filter(
        ([cid, idx]) => item(this.byId, cid).ends[idx].direction === "output",
      );
      let consumers = ports.filter(
        ([cid, idx]) => item(this.byId, cid).ends[idx].direction === "input",
      );
      if (!drivers.length || !consumers.length) {
        drivers = ports.slice(0, 1);
        consumers = ports.slice(1);
      }
      const backward =
        minOf(consumers.map(([c]) => item(depthLayer, c))) <
        maxOf(drivers.map(([c]) => item(depthLayer, c)));
      let span = -Infinity;
      for (const [d, j] of drivers)
        for (const [c, i] of consumers)
          span = Math.max(span, px(c, i) - px(d, j));
      const cols = ports.map(([c]) => column.get(c) as number);
      const columnsSpanned = maxOf(cols) - minOf(cols);
      const limit =
        (TUNNEL_SPAN.get(Math.min(consumers.length, 3)) as number) *
        this.tunnelSpanScale *
        (named ? 1 : UNNAMED_SPAN_FACTOR);
      if (
        (named && backward) ||
        span > limit ||
        columnsSpanned > this.maxLayerSpan
      ) {
        this.classes.set(key, "tunnel");
        demoted += 1;
      }
    }
    this.report.nets.demotedToTunnel = demoted;
  }

  // Width of the routing channel right of each column: channelMin plus
  // CHANNEL_PER_WIRE for every wired net that spans it (once per net, however
  // many consumers), capped at columnGap. Counting only the nets that turn in
  // a channel draws a narrower sheet but crowds the channels next to busy
  // columns: more crossings.
  channels(
    column: Map<string, number>,
    nets: readonly Port[][],
  ): (l: number) => number {
    const need = new Map<number, number>();
    for (const ports of nets) {
      const cols = sorted(
        new Set(
          ports
            .filter(([cid]) => column.has(cid))
            .map(([cid]) => column.get(cid) as number),
        ),
      );
      if (cols.length >= 2)
        for (let l = cols[0]; l < cols[cols.length - 1]; l++)
          need.set(l, (need.get(l) ?? 0) + 1);
    }
    return (l) =>
      Math.min(
        this.columnGap,
        Math.max(
          this.channelMin,
          snap(this.channelMin + CHANNEL_PER_WIRE * (need.get(l) ?? 0)),
        ),
      );
  }

  // Top-left of the next free place in the footer (see placeOnce).
  footerSlot(width: number, height: number): Point {
    const f = this.footer;
    if (f.x > 100 && f.x + width > f.right) {
      f.x = 100;
      f.y = snap(f.y + f.row + 2 * GRID);
      f.row = 0;
    }
    const at: Point = [f.x, f.y];
    f.x += width + 40;
    f.row = Math.max(f.row, height);
    return at;
  }

  // Without a custom appearance an instance's ports are this circuit's Pins,
  // per facing in the order of their position (interfaceSignature):
  // re-ordering two Pins of one facing swaps two ports in every circuit that
  // uses this one. The Pins of one facing keep their order inside a layer
  // (holdPinout); with oneLayer they also share a layer -- the first when they
  // only drive (inputs), the last when any is driven (outputs, at the right
  // edge as drawn by hand) -- which makes the order hold across the sheet
  // (see place). Returns {cid: (facing, rank)}, empty for a custom
  // appearance, which fixes its ports itself.
  pinoutRanks(
    layer: Map<string, number>,
    oneLayer: boolean,
  ): Map<string, [string, number]> {
    if (this.circuit.find("appear") !== null) return new Map();
    const groups = new Map<string, string[]>();
    for (const cid of layer.keys()) {
      const c = item(this.byId, cid);
      if (c.factoryName === "Pin")
        getOr(groups, attr(c, "facing") || "east", () => []).push(cid);
    }
    const ranks = new Map<string, [string, number]>();
    for (const [facing, unordered] of groups) {
      const key = pinOrderKey(facing);
      const cids = sortBy(unordered, (cid) => {
        const at = item(this.byId, cid).location;
        return key([at.x, at.y]);
      });
      const driven = cids.some((cid) =>
        item(this.byId, cid).ends.some((e) => e.direction === "input"),
      );
      const values = cids.map((cid) => layer.get(cid) as number);
      const target = driven ? maxOf(values) : minOf(values);
      cids.forEach((cid, rank) => {
        if (oneLayer) layer.set(cid, target);
        ranks.set(cid, [facing, rank]);
      });
    }
    return ranks;
  }

  // Do the Pins of every facing still come in their original order?
  pinoutKept(
    placement: Map<string, Point>,
    ranks: Map<string, [string, number]> | null = null,
  ): boolean {
    const seen = new Map<string, [Point, number][]>();
    for (const [cid, [facing, rank]] of ranks ?? this.pinRank) {
      const [dx, dy] = placement.get(cid) ?? [0, 0];
      const at = item(this.byId, cid).location;
      getOr(seen, facing, () => []).push([
        pinOrderKey(facing)([at.x + dx, at.y + dy]),
        rank,
      ]);
    }
    return [...seen.values()].every((pins) =>
      pyEq(
        sorted(pins).map(([, rank]) => rank),
        sorted(pins.map(([, rank]) => rank)),
      ),
    );
  }

  // Put the Pins of each facing back in their original order in `ids` (one
  // layer, top to bottom), in the slots they occupy; other parts keep their
  // places.
  holdPinout(ids: string[]): void {
    const slots = new Map<string, number[]>();
    ids.forEach((cid, i) => {
      const rank = this.pinRank.get(cid);
      if (rank !== undefined) getOr(slots, rank[0], () => []).push(i);
    });
    for (const positions of slots.values()) {
      const order = sortBy(
        positions.map((i) => ids[i]),
        (cid) => (this.pinRank.get(cid) as [string, number])[1],
      );
      positions.forEach((i, k) => {
        ids[i] = order[k];
      });
    }
  }

  // Placement of the fused pieces (see contactGroups): each is placed as one
  // part and all its members move with it, so the ports drawn onto each other
  // stay on each other and need no wire.
  async place(): Promise<Map<string, Point>> {
    if (!this.fused.size) return this.placePieces();
    const own = [
      this.byId,
      this.nets,
      this.body,
      this.bodyIds,
      this.copies,
    ] as const;
    [this.byId, this.nets, this.body, this.bodyIds, this.copies] =
      this.fusedView();
    let placement: Map<string, Point>;
    try {
      placement = await this.placePieces();
    } finally {
      [this.byId, this.nets, this.body, this.bodyIds, this.copies] = own;
    }
    // the Pins' straight wires were found on the pieces: a piece's port
    // numbers are not its host's, so each end goes back to the port of the
    // same net it stands for
    const at = portMap<Map<NetKey, Port>>();
    for (const [key, ports] of this.nets)
      for (const port of ports) {
        const piece = this.piecePort.get(port) ?? port;
        let nets = at.get(piece);
        if (nets === undefined) {
          nets = new Map();
          at.set(piece, nets);
        }
        nets.set(key, port);
      }
    const fanWires = portMap<Port>();
    for (const [pin, driver] of this.fanWires) {
      const pinNets = at.get(pin) ?? new Map<NetKey, Port>();
      const driverNets = at.get(driver) ?? new Map<NetKey, Port>();
      for (const [key, port] of pinNets)
        if (driverNets.has(key))
          fanWires.set(port, driverNets.get(key) as Port);
    }
    this.fanWires = fanWires;
    for (const [part, host] of this.fused) {
      const [dx, dy] = this.relocated.get(part) ?? [0, 0];
      const origin = item(placement, host);
      placement.set(part, [origin[0] + dx, origin[1] + dy]);
      this.layer.set(part, item(this.layer, host));
    }
    if (
      this.relocated.size &&
      !this.pinoutKept(
        placement,
        this.pinoutRanks(
          new Map([...this.bodyIds].map((cid) => [cid, 0])),
          false,
        ),
      )
    ) {
      // standing below their ports put two Pins of the pinout out of order: without satellites
      this.fused = new Map(
        [...this.fused].filter(([part]) => !this.relocated.has(part)),
      );
      this.relocated = new Map();
      return this.place();
    }
    // a staircase under a fan: each wire straight down the edge of the part before it
    for (const [pin, port] of this.satelliteWires)
      if (this.relocated.has(pin[0])) this.fanWires.set(pin, port);
    return placement;
  }

  // Placement, keeping the pinout (pinoutRanks). Output Pins usually stand in
  // different columns, next to what drives them; when that puts two of one
  // facing out of order, the placement is redone with every facing's Pins in
  // one column (costlier: long nets to the right edge become Tunnels).
  async placePieces(): Promise<Map<string, Point>> {
    if (this.placementStrategy !== null)
      return this.placementStrategy.place(this);
    const classes = new Map(this.classes);
    let placement = this.placeOnce(false);
    if (!this.pinoutKept(placement)) {
      this.classes = classes; // demote re-classifies on each pass
      placement = this.placeOnce(true);
    }
    this.report.pinsOneColumn = this.pinoutLayers;
    return placement;
  }

  placeOnce(oneLayer: boolean): Map<string, Point> {
    const depthLayer = this.layers();
    this.pinRank = this.pinoutRanks(depthLayer, oneLayer);
    this.pinoutLayers = oneLayer;
    const [column, xOffset] = this.packColumns(depthLayer);
    this.demote(depthLayer, column, xOffset);
    const layer = column; // shelf parts are not in it (see packColumns)
    this.depthLayer = depthLayer;
    const byLayer = new Map<number, string[]>();
    for (const [cid, l] of layer) getOr(byLayer, l, () => []).push(cid);
    // Port-level edges of the nets that will be wired: (source port, sink
    // port). A net with several drivers or no driver contributes edges from
    // its first port to the others. A wire inside one fused piece (a Pin
    // standing under its port, a copy docked on the part it serves) is
    // not an edge: it moves with the piece, and as one it would pull the
    // piece after its own ports sweep after sweep.
    const edges: Edge[] = [];
    for (const [key, cls] of this.classes) {
      if (cls !== "wire") continue;
      const copies = this.copies.get(key);
      if (copies !== undefined) {
        for (const [copy, served] of copies)
          for (const port of served)
            if (layer.has(copy[0]) && layer.has(port[0]) && copy[0] !== port[0])
              edges.push([copy, port]);
        continue;
      }
      const ports = item(this.nets, key).filter(([cid]) => layer.has(cid));
      if (ports.length < 2) continue;
      const outs = ports.filter(
        ([cid, idx]) => item(this.byId, cid).ends[idx].direction === "output",
      );
      const src = (outs.length ? outs : ports)[0];
      for (const p of ports) if (p[0] !== src[0]) edges.push([src, p]);
    }
    const touching = new Map<string, Edge[]>();
    for (const e of edges)
      for (const [cid] of e) getOr(touching, cid, () => []).push(e);
    const touchingOf = (cid: string): readonly Edge[] =>
      touching.get(cid) ?? NO_EDGES;

    const portDy = (cid: string, idx: number): number => {
      const c = item(this.byId, cid);
      return c.ends[idx].location.y - c.bounds.y;
    };

    const height = (cid: string): number => item(this.byId, cid).bounds.height;

    // The top nearest y at which the part's loc (and so every port) is on the
    // grid. A 30 px gate's top is 15 above its loc: snapping the top instead
    // would put its ports 5 px off the neighbour ports they were placed to
    // meet, and the final rounding would pick a side.
    const onGrid = (cid: string, y: number): number => {
      const c = item(this.byId, cid);
      const below = c.location.y - c.bounds.y;
      return snap(y + below) - below;
    };

    // Ports that will carry Tunnels (every body port of a net drawn by label).
    const flagLabels = portMap<string[]>();
    for (const [key, cls] of this.classes) {
      const real = item(this.nets, key).filter(
        ([cid]) => !this.tunnels.has(cid),
      );
      if (
        (cls === "tunnel" || cls === "global") &&
        (real.length >= 2 || this.labelsOfNet.get(key)?.size)
      ) {
        const ports = real.filter(
          ([cid]) =>
            layer.has(cid) && item(this.byId, cid).factoryName !== "Text",
        );
        if (ports.length) {
          const labels = this.labelsFor(key);
          for (const port of ports) flagLabels.set(port, labels);
        }
      }
    }

    // (above, below): how far the Tunnels on a part's top and bottom edges
    // reach past its body -- one cell out and a 20 px upright label (more
    // labels chained outward), or, where the labels of a row would overlap,
    // turned sideways in a V whose middle lead is the longest (see
    // leadSteps).
    const edgeRoom = (cid: string): [number, number] => {
      const c = item(this.byId, cid);
      const rows = new Map<boolean, [number, string, string[]][]>();
      c.ends.forEach((_end, idx) => {
        const labels = flagLabels.get([cid, idx]);
        if (labels && labels.length) {
          const [[px], facing, [, sy]] = this.portEdge(c, idx);
          if (sy) getOr(rows, sy < 0, () => []).push([px, facing, labels]);
        }
      });
      const room = new Map([
        [true, 0],
        [false, 0],
      ]);
      for (const [up, ports] of rows) {
        // chained labels stand upright one after another
        room.set(
          up,
          maxOf(ports.map(([, , labels]) => GRID * labels.length + 20)),
        );
        const single = sorted(
          ports
            .filter(([, , labels]) => labels.length === 1)
            .map(([px, facing, labels]): [number, string, string] => [
              px,
              labels[0],
              facing,
            ]),
        );
        for (const run of single.length ? fanRuns(single) : []) {
          const boxes = run.map(([px, label, facing]) =>
            labelBox([px, 0], facing, label),
          );
          const lead = 2 * floorDiv(run.length + 1, 2) - 1;
          let stacked = false;
          for (let k = 0; k + 1 < boxes.length; k++)
            if (
              Math.min(boxes[k][2], boxes[k + 1][2]) -
                Math.max(boxes[k][0], boxes[k + 1][0]) >=
              3
            )
              stacked = true;
          if (lead <= V_LEAD_MAX && stacked)
            room.set(up, Math.max(item(room, up), GRID * lead + 10));
        }
      }
      return [item(room, true), item(room, false)];
    };

    const room = new Map([...layer.keys()].map((cid) => [cid, edgeRoom(cid)]));

    // Air between part a and part b below it in a column: the Tunnels under
    // a and over b both fit, a grid step apart.
    const gap = (a: string, b: string): number =>
      Math.max(this.rowGap, item(room, a)[1] + item(room, b)[0] + GRID);

    // initial order: the author's y (their intent when it exists)
    const order = new Map<number, string[]>();
    for (const [l, ids] of byLayer) {
      sortInPlace(ids, (cid) => {
        const c = item(this.byId, cid);
        return [c.location.y, item(depthLayer, cid), c.location.x];
      });
      this.holdPinout(ids);
      order.set(l, [...ids]);
    }
    const layersSorted = sorted(byLayer.keys());
    const topY = new Map<number, Map<string, number>>();

    // Body tops for column l in its current order.
    //
    // Compact first (gap() between neighbours), then the whole column shifts
    // rigidly by the median offset to where its ports would like to be
    // (desired), then parts with the most connections move within their
    // slack towards their own desired y. The column may not grow beyond
    // compact height * this.stackSlack + this.gapCap, so one far-away
    // neighbour cannot stretch it and columns cannot drift apart.
    const stack = (
      l: number,
      desired: Map<string, number> | null = null,
    ): Map<string, number> => {
      const ids = item(order, l);
      if (!ids.length) return new Map();
      let tops = new Map<string, number>();
      let cursor = 0;
      ids.forEach((cid, i) => {
        tops.set(cid, cursor);
        cursor += height(cid) + (i + 1 < ids.length ? gap(cid, ids[i + 1]) : 0);
      });
      const compact = cursor;
      const wanted = new Map<string, number>();
      for (const [cid, y] of desired ?? [])
        if (tops.has(cid) && y !== null) wanted.set(cid, y);
      if (!wanted.size)
        return new Map([...tops].map(([cid, y]) => [cid, onGrid(cid, y)]));
      const offsets = sorted(
        [...wanted].map(([cid, y]) => y - item(tops, cid)),
      );
      const shift = offsets[floorDiv(offsets.length, 2)];
      tops = new Map([...tops].map(([cid, y]) => [cid, y + shift]));
      const budget = compact * this.stackSlack + this.gapCap;
      const loFrame = minOf(tops.values());
      const hiFrame = loFrame + budget;
      const index = new Map(ids.map((cid, i) => [cid, i]));
      for (const cid of sortBy(wanted.keys(), (c) => -touchingOf(c).length)) {
        const i = item(index, cid);
        const lo =
          i === 0
            ? loFrame
            : item(tops, ids[i - 1]) +
              height(ids[i - 1]) +
              gap(ids[i - 1], cid);
        let below = 0;
        for (let k = i; k + 1 < ids.length; k++)
          below += gap(ids[k], ids[k + 1]) + height(ids[k + 1]);
        let hi = hiFrame - below - height(cid);
        if (i + 1 < ids.length)
          hi = Math.min(
            hi,
            item(tops, ids[i + 1]) - gap(cid, ids[i + 1]) - height(cid),
          );
        if (hi < lo) continue;
        tops.set(cid, Math.min(Math.max(item(wanted, cid), lo), hi));
      }
      for (let i = 1; i < ids.length; i++) {
        // restore order if a clamp broke it
        const a = ids[i - 1];
        const b = ids[i];
        tops.set(
          b,
          Math.max(item(tops, b), item(tops, a) + height(a) + gap(a, b)),
        );
      }
      return new Map([...tops].map(([cid, y]) => [cid, onGrid(cid, y)]));
    };

    for (const l of layersSorted) topY.set(l, stack(l));

    const portY = (cid: string, idx: number): number =>
      item(item(topY, item(layer, cid)), cid) + portDy(cid, idx);

    // Where this part's ports would like to sit: the mean, over its wired
    // neighbours in other layers, of (neighbour port y - own port offset) so
    // that the two ports line up; nearer layers weigh more.
    const barycenter = (cid: string, l: number): number | null => {
      let num = 0.0;
      let den = 0.0;
      for (const e of touchingOf(cid)) {
        const [[me, mi], [other, oi]] = ends(e, cid);
        const lo = item(layer, other);
        const w = lo === l ? 0.5 : 1.0 / Math.abs(lo - l);
        num += w * (portY(other, oi) - portDy(me, mi));
        den += w;
      }
      return den ? num / den : null;
    };

    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      const seq = sweep % 2 === 0 ? layersSorted : [...layersSorted].reverse();
      for (const l of seq) {
        const cur = item(topY, l);
        const want = new Map<string, number>();
        for (const cid of item(order, l)) {
          const b = barycenter(cid, l);
          want.set(cid, b === null ? item(cur, cid) : b);
        }
        sortInPlace(item(order, l), (cid) => [want.get(cid), cur.get(cid)]);
        this.holdPinout(item(order, l));
        topY.set(l, stack(l, want));
      }
    }

    // Transposition: swap neighbours in a layer when the straight-line
    // segments of their nets cross less afterwards (segments are a proxy for
    // the orthogonal routes the router will draw).
    const seg = (e: Edge): Seg => {
      let [[a, ai], [b, bi]] = e;
      if (item(layer, a) > item(layer, b)) [[a, ai], [b, bi]] = [e[1], e[0]];
      return [item(layer, a), portY(a, ai), item(layer, b), portY(b, bi)];
    };

    const localCrossings = (cids: readonly string[]): number => {
      const mine = new Set<Edge>();
      for (const cid of cids) for (const e of touchingOf(cid)) mine.add(e);
      const own = [...mine].map(seg);
      let n = 0;
      for (const e of edges) {
        if (mine.has(e)) continue;
        const s2 = seg(e);
        for (const s1 of own) if (crosses(s1, s2)) n += 1;
      }
      for (let i = 0; i < own.length; i++)
        for (let j = i + 1; j < own.length; j++)
          if (crosses(own[i], own[j])) n += 1;
      return n;
    };

    const realign = (l: number): void => {
      const tops = item(topY, l);
      const want = new Map<string, number>();
      for (const cid of item(order, l)) {
        const b = touchingOf(cid).length ? barycenter(cid, l) : null;
        want.set(cid, b === null ? item(tops, cid) : b);
      }
      topY.set(l, stack(l, want));
    };

    for (let round = 0; round < TRANSPOSE_ROUNDS; round++) {
      let improved = false;
      for (const l of layersSorted) {
        const ids = item(order, l);
        for (let i = 0; i < ids.length - 1; i++) {
          const a = ids[i];
          const b = ids[i + 1];
          if (!touchingOf(a).length && !touchingOf(b).length) continue;
          const ra = this.pinRank.get(a);
          const rb = this.pinRank.get(b);
          if (ra !== undefined && rb !== undefined && ra[0] === rb[0]) continue; // two Pins of one facing: their order is the pinout
          const before = localCrossings([a, b]);
          const saved = item(topY, l);
          ids[i] = b;
          ids[i + 1] = a;
          realign(l);
          if (localCrossings([a, b]) < before) {
            improved = true;
          } else {
            ids[i] = a;
            ids[i + 1] = b;
            topY.set(l, saved);
          }
        }
      }
      if (!improved) break;
    }
    // final coordinates follow the neighbours once more (ports line up)
    for (const l of layersSorted) realign(l);

    const side = (cid: string, idx: number): string =>
      edgeOf(item(this.byId, cid), idx);

    // Straight wires between neighbouring columns. The barycenter puts a part
    // where its ports meet its neighbours' on average, which levels almost
    // none of them: each part is aligned instead with one part in the column
    // to its left (an output on that part's right edge wired to an input on
    // its own left edge, the one nearest to where it stands), without two
    // alignments crossing. Aligned parts form a block that moves as one;
    // blocks keep their order and gaps in every column and stay as near as
    // they can to where the barycenter put their parts.
    const alignBlocks = (): number => {
      const pos = new Map<string, number>();
      for (const l of layersSorted)
        item(order, l).forEach((cid, i) => pos.set(cid, i));
      const root = new Map<string, string>();
      const off = new Map<string, number>();
      for (const l of layersSorted)
        for (const cid of item(order, l)) {
          root.set(cid, cid);
          off.set(cid, 0);
        }
      const taken = new Set<string>();
      let aligned = 0;
      for (let li = 1; li < layersSorted.length; li++) {
        const l = layersSorted[li];
        const left = layersSorted[li - 1];
        if (left !== l - 1) continue;
        let last = -1;
        for (const v of item(order, l)) {
          if (this.pinRank.has(v)) continue;
          const options: [number, number, string, number, number][] = [];
          for (const e of touchingOf(v)) {
            const [[, mi], [u, ui]] = ends(e, v);
            if (
              u === v ||
              layer.get(u) !== left ||
              taken.has(u) ||
              this.pinRank.has(u) ||
              item(pos, u) <= last
            )
              continue;
            if (side(u, ui) !== "east" || side(v, mi) !== "west") continue;
            const want =
              item(item(topY, left), u) + portDy(u, ui) - portDy(v, mi);
            const here = item(item(topY, l), v);
            if (Math.abs(want - here) <= LEVEL_REACH)
              options.push([Math.abs(want - here), item(pos, u), u, ui, mi]);
          }
          if (!options.length) continue;
          const [, , u, ui, mi] = minBy(options, (o) => o);
          root.set(v, item(root, u));
          off.set(v, item(off, u) + portDy(u, ui) - portDy(v, mi));
          taken.add(u);
          last = item(pos, u);
          aligned += 1;
        }
      }
      const members = new Map<string, string[]>();
      for (const [cid, r] of root) getOr(members, r, () => []).push(cid);
      // separation constraints between blocks, from every column's order
      const after = new Map<string, [string, number][]>();
      const indeg = new Map<string, number>();
      for (const l of layersSorted) {
        const ids = item(order, l);
        for (let k = 0; k + 1 < ids.length; k++) {
          const a = ids[k];
          const b = ids[k + 1];
          const ra = item(root, a);
          const rb = item(root, b);
          getOr(after, ra, () => []).push([
            rb,
            item(off, a) + height(a) + gap(a, b) - item(off, b),
          ]);
          indeg.set(rb, (indeg.get(rb) ?? 0) + 1);
        }
      }
      const want = new Map<string, number>();
      for (const [r, ms] of members) {
        const ys = sorted(
          ms.map((m) => item(item(topY, item(layer, m)), m) - item(off, m)),
        );
        want.set(r, onGrid(r, ys[floorDiv(ys.length, 2)]));
      }
      const before = new Map<string, [string, number][]>();
      for (const [ra, succ] of after)
        for (const [rb, sep] of succ)
          getOr(before, rb, () => []).push([ra, sep]);
      const topo: string[] = [];
      const queue = [...members.keys()].filter((r) => !indeg.get(r));
      while (queue.length) {
        const r = queue.pop() as string;
        topo.push(r);
        for (const [rb] of after.get(r) ?? []) {
          indeg.set(rb, (indeg.get(rb) ?? 0) - 1);
          if (!indeg.get(rb)) queue.push(rb);
        }
      }
      if (topo.length < members.size) return 0; // a cycle (cannot happen with crossing-free alignments): keep the barycenter
      // Each block as near its wish as the blocks above it allow (pushing
      // down), and as the blocks below allow (pushing up); both satisfy every
      // gap, so their mean does too and splits the displacement.
      const down = new Map<string, number>();
      const up = new Map<string, number>();
      for (const r of topo)
        down.set(
          r,
          maxOf([
            item(want, r),
            ...(before.get(r) ?? []).map(([ra, sep]) => item(down, ra) + sep),
          ]),
        );
      for (const r of [...topo].reverse())
        up.set(
          r,
          minOf([
            item(want, r),
            ...(after.get(r) ?? []).map(([rb, sep]) => item(up, rb) - sep),
          ]),
        );
      const y = new Map<string, number>();
      for (const r of topo) {
        // on the grid; the rounding may take at most one step off a gap
        let at = onGrid(r, (item(down, r) + item(up, r)) / 2);
        for (const [ra, sep] of before.get(r) ?? [])
          while (at < item(y, ra) + sep - GRID) at += GRID;
        y.set(r, at);
      }
      for (const l of layersSorted) {
        const tops = item(topY, l);
        for (const cid of item(order, l))
          tops.set(cid, item(y, item(root, cid)) + item(off, cid));
      }
      return aligned;
    };

    this.report.alignedPairs = alignBlocks();

    // Wires of this part that are one horizontal segment with it at top.
    const straight = (cid: string, top: number): number => {
      let n = 0;
      for (const e of touchingOf(cid)) {
        const [[me, mi], [other, oi]] = ends(e, cid);
        if (
          other !== cid &&
          item(layer, other) !== item(layer, cid) &&
          top + portDy(me, mi) === portY(other, oi)
        )
          n += 1;
      }
      return n;
    };

    // Rows across columns. The barycenter puts a part where its ports meet
    // its neighbours' on average, which leaves most tops 5-10 px from the top
    // of a part in the next column; readable sheets put most parts on a top
    // shared with another. Each part may move inside the free space of its
    // column onto another part's top (up to ROW_SNAP away) or onto the height
    // where one of its ports meets the port it is wired to (up to LEVEL_REACH
    // away), keeping every such straight wire it has; among the choices with
    // the most straight wires, the one that lets more parts share a top, then
    // the nearest.
    const shareRows = (): number => {
      const tally = new Map<number, number>();
      const tallyOf = (t: number): number => {
        const n = tally.get(t);
        if (n !== undefined) return n;
        tally.set(t, 0);
        return 0;
      };
      for (const l of layersSorted) {
        const tops = item(topY, l);
        for (const cid of item(order, l)) {
          const t = item(tops, cid);
          tally.set(t, tallyOf(t) + 1);
        }
      }
      const sharing = (n: number): number => (n >= 2 ? n : 0);
      const ranked = new Map<string, [number, string][]>(); // facing -> Pins in pinout order
      for (const [cid, [facing, rank]] of this.pinRank)
        if (layer.has(cid)) getOr(ranked, facing, () => []).push([rank, cid]);
      for (const pins of ranked.values()) sortInPlace(pins, (p) => p);

      const locY = (cid: string): number => {
        const c = item(this.byId, cid);
        return (
          item(item(topY, item(layer, cid)), cid) + c.location.y - c.bounds.y
        );
      };

      let snaps = 0;
      for (let round = 0; round < 3; round++) {
        let changed = false;
        for (const l of layersSorted) {
          const ids = item(order, l);
          const tops = item(topY, l);
          ids.forEach((cid, i) => {
            const cur = item(tops, cid);
            let lo = -Infinity;
            let hi = Infinity;
            if (i)
              lo =
                item(tops, ids[i - 1]) +
                height(ids[i - 1]) +
                gap(ids[i - 1], cid);
            if (i + 1 < ids.length)
              hi = item(tops, ids[i + 1]) - gap(cid, ids[i + 1]) - height(cid);
            const rank = this.pinRank.get(cid);
            if (
              rank !== undefined &&
              (rank[0] === "east" || rank[0] === "west")
            ) {
              // a Pin keeps its place in the pinout: strictly between the
              // Pins ranked before and after it
              const pins = getOr(ranked, rank[0], () => []).map(([, c]) => c);
              const k = pins.indexOf(cid);
              if (k < 0)
                throw new PyValueError(`${pyRepr(cid)} is not in list`);
              const c = item(this.byId, cid);
              const below = c.location.y - c.bounds.y;
              if (k) lo = Math.max(lo, locY(pins[k - 1]) + GRID - below);
              if (k + 1 < pins.length)
                hi = Math.min(hi, locY(pins[k + 1]) - GRID - below);
            }
            const options = new IntSet();
            for (const [t, n] of tally)
              if (
                n &&
                Math.max(lo, cur - ROW_SNAP) <= t &&
                t <= Math.min(hi, cur + ROW_SNAP)
              )
                options.add(t);
            for (const e of touchingOf(cid)) {
              const [[me, mi], [other, oi]] = ends(e, cid);
              if (other !== cid && item(layer, other) !== l) {
                const t = portY(other, oi) - portDy(me, mi);
                if (
                  Math.max(lo, cur - LEVEL_REACH) <= t &&
                  t <= Math.min(hi, cur + LEVEL_REACH)
                )
                  options.add(t);
              }
            }
            let best = cur;
            let bestKey = [straight(cid, cur), 0, 0];
            for (const t of options) {
              if (t === cur || onGrid(cid, t) !== t) continue;
              const gain =
                sharing(tallyOf(cur) - 1) +
                sharing(tallyOf(t) + 1) -
                (sharing(tallyOf(cur)) + sharing(tallyOf(t)));
              const k = [straight(cid, t), gain, -Math.abs(t - cur)];
              if (cmp(k, bestKey) > 0) {
                best = t;
                bestKey = k;
              }
            }
            if (best !== cur) {
              tally.set(cur, tallyOf(cur) - 1);
              tally.set(best, tallyOf(best) + 1);
              tops.set(cid, best);
              snaps += 1;
              changed = true;
            }
          });
        }
        if (!changed) break;
      }
      return snaps;
    };

    this.report.rowSnaps = shareRows();

    // How far the part's label reaches past its box, left and right.
    const labelReach = (cid: string): [number, number] => {
      const c = item(this.byId, cid);
      const label = attr(c, "label");
      if (!label) return [0, 0];
      const w = textWidth(label);
      const where = attr(c, "labelloc") || "west";
      if (where === "west" || where === "east")
        return where === "west" ? [w, 0] : [0, w];
      const over = Math.max(0, (w - c.bounds.width) / 2);
      return [over, over];
    };

    const pinoutHolds = (): boolean => {
      const ranked = new Map<string, [Point, number][]>();
      for (const [cid, [facing, rank]] of this.pinRank) {
        if (!layer.has(cid)) continue;
        const c = item(this.byId, cid);
        const y =
          item(item(topY, item(layer, cid)), cid) + c.location.y - c.bounds.y;
        getOr(ranked, facing, () => []).push([
          facing === "east" || facing === "west"
            ? [y, c.location.x]
            : [c.location.x, y],
          rank,
        ]);
      }
      return [...ranked.values()].every((pins) =>
        pyEq(
          sorted(pins).map(([, r]) => r),
          sorted(pins.map(([, r]) => r)),
        ),
      );
    };

    // Pins wired one to one to ports on the facing edge of the next column
    // stand level with those ports. A tall part's ports are 20 px apart and a
    // column of Pins needs 70, so otherwise all but a few of those wires jog;
    // Pins that would touch stand abreast instead, the farther one's wire
    // passing between the nearer ones -- how people draw the control lines
    // out of a decoder. Ports 10 px apart leave no room to pass between Pins:
    // the Pins then stand in a staircase, each wire running along the edge of
    // the Pin before it, as people draw the outputs of a subcircuit (those
    // wires are laid before routing, see route). Only where nothing else in
    // the column is in the way and the pinout keeps its order. Returns {pin: x
    // offset inside its column}; this.fanWires holds {pin port: driver port}.
    const fanPins = (): Map<string, number> => {
      const fanDx = new Map<string, number>();
      this.fanWires = portMap();
      for (let li = 0; li < layersSorted.length; li++) {
        const l = layersSorted[li];
        for (const [edge, ni] of [
          ["east", li + 1],
          ["west", li - 1],
        ] as const) {
          if (!(0 <= ni && ni < layersSorted.length)) continue;
          const pins: [number, string, number][] = [];
          for (const cid of item(order, l)) {
            if (
              item(this.byId, cid).factoryName !== "Pin" ||
              touchingOf(cid).length !== 1 ||
              fanDx.has(cid)
            )
              continue;
            const [[, mi], [u, ui]] = ends(touchingOf(cid)[0], cid);
            if (
              layer.get(u) === layersSorted[ni] &&
              side(cid, mi) === edge &&
              side(u, ui) === item(OPPOSITE, edge)
            )
              pins.push([portY(u, ui) - portDy(cid, mi), cid, portY(u, ui)]);
          }
          if (
            pins.length < 2 ||
            pins.every(([t, cid]) => item(item(topY, l), cid) === t)
          )
            continue;
          let placed: [number, number, number, number][] = [];
          let lane = new Map<string, number>();
          for (const [t, cid, wire] of sorted(pins)) {
            const top = t;
            const bottom = t + height(cid);
            let free = -1;
            for (let j = 0; j < FAN_COLUMNS; j++) {
              if (
                placed.some(
                  ([pj, pt, pb]) =>
                    pj === j && top < pb + GRID && pt < bottom + GRID,
                )
              )
                continue; // touches the Pin before it in that column
              if (
                placed.some(
                  ([pj, pt, pb]) =>
                    pj < j && pt - GRID < wire && wire < pb + GRID,
                )
              )
                continue; // its wire would run through a nearer Pin
              if (
                placed.some(
                  ([pj, , , pw]) =>
                    pj > j && top - GRID < pw && pw < bottom + GRID,
                )
              )
                continue; // a farther Pin's wire would run through it
              free = j;
              break;
            }
            if (free < 0) break;
            lane.set(cid, free);
            placed.push([free, top, bottom, wire]);
          }
          let staircase: boolean;
          if (lane.size < pins.length) {
            // the staircase: the top Pin nearest, each next one a step further out
            const wiresY = sorted(pins.map(([, , w]) => w));
            let tight = false;
            for (let k = 0; k + 1 < wiresY.length; k++)
              if (wiresY[k + 1] - wiresY[k] < GRID) tight = true;
            if (tight) continue;
            const ranked = sorted(pins);
            lane = new Map(ranked.map(([, cid], j) => [cid, j]));
            placed = ranked.map(([t, cid, w], j) => [j, t, t + height(cid), w]);
            staircase = true;
          } else {
            staircase = false;
          }
          const lo = minOf(placed.map(([, pt]) => pt)) - this.rowGap;
          const hi = maxOf(placed.map(([, , pb]) => pb)) + this.rowGap;
          const tops = item(topY, l);
          if (
            item(order, l).some(
              (c) =>
                !lane.has(c) &&
                lo < item(tops, c) + height(c) &&
                item(tops, c) < hi,
            )
          )
            continue; // another part of the column is in the way
          const saved = new Map(tops);
          for (const [t, cid] of pins) tops.set(cid, t);
          if (!pinoutHolds()) {
            topY.set(l, saved);
            continue;
          }

          // x from the left Pin's box to the right one's, labels clear.
          const pinRoom = (left: string, right: string): number =>
            GRID *
            Math.ceil(
              (item(this.byId, left).bounds.width +
                labelReach(left)[1] +
                labelReach(right)[0] +
                2 * GRID) /
                GRID,
            );

          if (staircase) {
            // each Pin one step further out than the one above it
            let x = 0;
            const xs = new Map<string, number>();
            const ranked = sorted(pins).map(([, cid]) => cid);
            ranked.forEach((cid, k) => {
              if (k)
                x +=
                  edge === "west"
                    ? pinRoom(ranked[k - 1], cid)
                    : -pinRoom(cid, ranked[k - 1]);
              xs.set(cid, x);
            });
            for (const [cid, v] of xs) fanDx.set(cid, v - minOf(xs.values()));
          } else {
            const lanes = maxOf(lane.values()) + 1;
            let step = -Infinity;
            for (const a of lane.keys())
              for (const b of lane.keys()) step = Math.max(step, pinRoom(a, b));
            for (const [cid, j] of lane)
              fanDx.set(
                cid,
                edge === "east" ? (lanes - 1 - j) * step : j * step,
              );
          }
          for (const [, cid] of pins) {
            const [mine, other] = ends(touchingOf(cid)[0], cid);
            this.fanWires.set(mine, other);
          }
          sortInPlace(item(order, l), (c) => item(item(topY, l), c));
        }
      }
      return fanDx;
    };

    this.fanWires = portMap();
    const fanDx = fanPins();
    this.report.fannedPins = fanDx.size;
    const segs = edges.map(seg);
    let crossings = 0;
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++)
        if (crosses(segs[i], segs[j])) crossings += 1;
    this.report.placementCrossings = crossings;
    // Channel widths: a channel between two columns is as wide as the wires
    // that run through it need (every wired net spanning it), never wider
    // than the caller's column gap (channels).
    const channel = this.channels(
      layer,
      [...this.classes]
        .filter(([, cls]) => cls === "wire")
        .map(([key]) => item(this.nets, key)),
    );

    // coordinate assignment: sub-columns of bounded height per layer
    let panelBottom = maxOf(
      this.components
        .filter((c) => this.isPanel(c))
        .map((c) => c.bounds.y + c.bounds.height),
      0,
    );
    panelBottom = Math.max(panelBottom, this.panelBelowY || 0);
    let top = snap(panelBottom + 120);
    // Keep the author's panel/body split when the body already starts just
    // below the panel (e.g. a panel above 600, the body from ~630); anything
    // judging "the panel region" by that line then still sees the same body.
    const bodyTop = layer.size
      ? minOf([...layer.keys()].map((cid) => item(this.byId, cid).bounds.y))
      : null;
    if (
      bodyTop !== null &&
      this.panelBelowY !== null &&
      panelBottom + 60 <= bodyTop &&
      bodyTop <= panelBottom + 300
    )
      top = snap(bodyTop);
    const shelfY = top;
    if (this.shelf.length) {
      const shelfH = maxOf(
        this.shelf.map((cid) => item(this.byId, cid).bounds.height),
      );
      top = snap(shelfY + shelfH + SHELF_GAP);
    }
    let xCursor = 100;
    const placement = new Map<string, Point>();
    let bodyBottom = top;
    // a whole number of grid steps, so every part keeps its grid phase (onGrid)
    const allTops: number[] = [];
    for (const l of layersSorted) allTops.push(...item(topY, l).values());
    const frame = GRID * Math.floor(minOf(allTops, 0) / GRID);
    // Tunnels on the right edge of one column and on the left edge of the
    // next face each other across the channel; where they are level, both
    // labels need room in it, or they are drawn on top of each other (a label
    // running into the part across the channel reads as badly).
    let before: ChannelSide[] = []; // the right side of the column placed last
    let planned = 0; // ... and the gap planned after it
    for (const l of layersSorted) {
      const ids = item(order, l);
      const tops = item(topY, l);
      const columns: string[][] = [[]];
      for (const cid of ids) {
        const last = columns[columns.length - 1];
        if (
          last.length &&
          item(tops, cid) + height(cid) - item(tops, last[0]) > MAX_STACK
        )
          columns.push([]);
        columns[columns.length - 1].push(cid);
      }
      for (let k = 0; k < columns.length; k++) {
        const members = columns[k];
        const width = maxOf(
          members.map(
            (cid) =>
              item(xOffset, cid) +
              (fanDx.get(cid) ?? 0) +
              item(this.byId, cid).bounds.width,
          ),
        );
        const left: ChannelSide[] = [];
        const right: ChannelSide[] = [];
        for (const cid of members) {
          const inset = item(xOffset, cid) + (fanDx.get(cid) ?? 0);
          const c = item(this.byId, cid);
          const [l0, r0] = this.flagSides(
            c,
            top + item(tops, cid) - frame,
            inset,
            width - inset - c.bounds.width,
            flagLabels,
          );
          left.push(...l0);
          right.push(...r0);
        }
        if (before.length)
          xCursor += Math.max(
            0,
            GRID * Math.ceil((channelRoom(before, left) - planned) / GRID),
          );
        before = right;
        for (const cid of members) {
          const b = item(this.byId, cid).bounds;
          const y = top + item(tops, cid) - frame;
          // the body's left edge sits on xCursor (+ its depth stagger); the
          // component's own loc stays on the 10-grid
          const dx = snap(
            xCursor + item(xOffset, cid) + (fanDx.get(cid) ?? 0) - b.x,
          );
          const dy = snap(y - b.y);
          placement.set(cid, [dx, dy]);
          bodyBottom = Math.max(
            bodyBottom,
            snap(
              y + b.height + Math.max(this.rowGap, item(room, cid)[1] + GRID),
            ),
          );
        }
        planned = k + 1 < columns.length ? SUBCOLUMN_GAP : channel(l);
        xCursor += width + planned;
      }
    }
    let shelfX = 100;
    for (const cid of sortBy(this.shelf, (c) => item(this.byId, c).bounds.x)) {
      const b = item(this.byId, cid).bounds;
      placement.set(cid, [snap(shelfX - b.x), snap(shelfY - b.y)]);
      layer.set(cid, -1);
      shelfX += b.width + 60;
    }
    // Text annotations have no ports. One that sits next to a body part is
    // its caption and moves with it; the rest are collected in a footer row
    // below the body instead of being deleted or left over the new body.
    const boxGap = (a: Bounds, b: Bounds): number => {
      const dx = Math.max(
        0,
        Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width),
      );
      const dy = Math.max(
        0,
        Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height),
      );
      return dx + dy;
    };
    // The footer wraps at the body's right edge: a row of 30 loose Constants
    // must not make the sheet twice as wide as the drawing.
    const right = maxOf(
      [...placement].map(
        ([cid, [dx]]) =>
          item(this.byId, cid).bounds.x +
          dx +
          item(this.byId, cid).bounds.width,
      ),
      0,
    );
    this.footer = {
      x: 100,
      y: snap(bodyBottom + 60),
      row: 0,
      right: Math.max(right, 800),
    };
    const texts = sortBy(
      this.body.filter((c) => !layer.has(c.componentId)),
      (c) => [c.bounds.x, c.bounds.y],
    );
    this.captions = new Map(); // caption -> its part, held together by compactSheet too
    for (const t of texts) {
      const nearest = layer.size
        ? minBy(
            [...layer.keys()].map((cid): [number, string] => [
              boxGap(t.bounds, item(this.byId, cid).bounds),
              cid,
            ]),
            (v) => v,
          )
        : null;
      if (
        t.factoryName === "Text" &&
        nearest !== null &&
        nearest[0] <= TEXT_ATTACH_DISTANCE
      ) {
        const [dx, dy] = item(placement, nearest[1]);
        placement.set(t.componentId, [dx, dy]);
        this.captions.set(t.componentId, nearest[1]);
      } else {
        const [x, y] = this.footerSlot(t.bounds.width, t.bounds.height);
        placement.set(t.componentId, [
          snap(x - t.bounds.x),
          snap(y - t.bounds.y),
        ]);
      }
    }
    this.bodyBottom = bodyBottom;
    this.placement = placement;
    this.layer = layer;
    this.report.moved = count(placement.values(), ([dx, dy]) => dx || dy);
    return placement;
  }

  // (left, right): what a part puts beside its column, as (y0, y1, px past
  // the column's edge, is a flag) -- its body, inset from the edge of a
  // wider column, and every sideways flag of its ports with the lead and the
  // label chain. On one edge a wide label beside a narrow one stands out past
  // it (leadSteps gives the narrow labels the short leads).
  flagSides(
    c: Component,
    top: number,
    insetLeft: number,
    insetRight: number,
    flagLabels: KeyMap<Port, string[]>,
  ): [ChannelSide[], ChannelSide[]] {
    const b = c.bounds;
    const left: ChannelSide[] = [[top, top + b.height, -insetLeft, false]];
    const right: ChannelSide[] = [[top, top + b.height, -insetRight, false]];
    const edge = new Map<string, [number, string[]][]>(); // facing -> (port y, labels) of the sideways flags
    c.ends.forEach((_end, idx) => {
      const labels = flagLabels.get([c.componentId, idx]);
      if (labels && labels.length) {
        const [[, py], facing] = this.portEdge(c, idx);
        if (facing === "east" || facing === "west")
          getOr(edge, facing, () => []).push([py, labels]);
      }
    });
    for (const [facing, flags] of edge) {
      for (const [py, labels] of flags) {
        const w = textWidth(labels[0]);
        const past = flags
          .filter(
            ([oy, other]) =>
              0 < Math.abs(oy - py) &&
              Math.abs(oy - py) < 20 &&
              textWidth(other[0]) <= w,
          )
          .map(([, other]) => textWidth(other[0]));
        let out = maxOf(
          labels.map((label, k) => GRID * (k + 1) + textWidth(label)),
        );
        if (past.length) out += GRID * Math.ceil((maxOf(past) + 3) / GRID);
        const y = top + py - b.y;
        if (facing === "east")
          left.push([y - 10, y + 10, out - insetLeft, true]);
        else right.push([y - 10, y + 10, out - insetRight, true]);
      }
    }
    return [left, right];
  }

  // ---- routing ---------------------------------------------------------------

  movedComponent(c: Component): Component {
    const [dx, dy] = this.placement.get(c.componentId) ?? [0, 0];
    const m = deepCopy(c);
    m.location = { x: c.location.x + dx, y: c.location.y + dy };
    m.bounds = { ...c.bounds, x: c.bounds.x + dx, y: c.bounds.y + dy };
    if (hasOwn(c, "visualBounds")) {
      const v = c.visualBounds as Bounds;
      m.visualBounds = { ...v, x: v.x + dx, y: v.y + dy };
    }
    for (const e of m.ends)
      e.location = { x: e.location.x + dx, y: e.location.y + dy };
    return m;
  }

  // Grid steps from every anchored port to its first Tunnel. A flag is 20 px
  // tall (a north or south one as wide as its label), so on ports 10 px
  // apart, flags one cell off every port lie on top of each other. Port by
  // port along each edge, the narrowest labels first, a lead grows until its
  // flag clears the flags placed before it: on a column of inputs every
  // other flag stands a label further out, its lead in the gap between two
  // flags, and a wide label stands out past the narrow ones (the other way
  // round the lead past a wide label would run longer than LEAD_MAX).
  // A lead never runs through a flag, a body, a foreign port or the cell in
  // front of one. It is the shortest whose flags run into nothing (no flag,
  // body or lead) up to LEAD_MAX, failing that the one whose flags run into
  // the least.
  // A row of Tunnels on a north or south edge (a Splitter's fan) cannot do
  // that: an upright flag is as wide as its label and covers the
  // neighbours' leads however long they are. Its flags turn sideways in a V
  // -- the left half pointing left with leads growing towards the middle,
  // the right half pointing right -- so every lead ends above the flags
  // beside it (up to V_LEAD_MAX steps: placeOnce leaves the room under the
  // part), unless the V runs into more than the upright row would.
  // `late` plans only those ports (labelled after routing, where a route
  // could not reach them) around the flags already standing and the copper:
  // a lead never runs over a wire or the edge of a body, a wire under a flag
  // counts as running into it, and a Tunnel whose flags run into something
  // on every lead stays on the port (0 steps) when its flag runs into less
  // there. Returns ({port: steps}, {port: turned facing}).
  planLeadSteps(
    moved: Map<string, Component>,
    router: Router,
    lateIn: Iterable<Port> | null = null,
  ): [KeyMap<Port, number>, KeyMap<Port, string>] {
    const fronts = new Map<number, Port>();
    for (const c of moved.values()) {
      if (
        c.factoryName === "Tunnel" ||
        c.factoryName === "Text" ||
        !this.layer.has(c.componentId)
      )
        continue;
      c.ends.forEach((_end, idx) => {
        const [[px, py], , [sx, sy]] = this.portEdge(c, idx);
        fronts.set(pk(px + sx, py + sy), [c.componentId, idx]);
      });
    }

    const inside = (q: Point, b: Box): boolean =>
      b[0] + 3 <= q[0] &&
      q[0] <= b[2] - 3 &&
      b[1] + 3 <= q[1] &&
      q[1] <= b[3] - 3;

    const overlap = (a: Box, b: Box): boolean =>
      Math.min(a[2], b[2]) - Math.max(a[0], b[0]) >= 3 &&
      Math.min(a[3], b[3]) - Math.max(a[1], b[1]) >= 3;

    const buckets = new Map<number, Box[]>(); // 100 px cells -> flags placed there
    const parts = new Map<number, Box[]>(); // 100 px cells -> bodies there (localised Constants too)
    for (const c of moved.values()) {
      const b = visualOf(c);
      if (
        c.factoryName !== "Tunnel" &&
        c.factoryName !== "Text" &&
        b.width > 0 &&
        b.height > 0
      )
        for (const cell of cellsOf([b.x, b.y, b.x + b.width, b.y + b.height]))
          getOr(parts, cell, () => []).push([
            b.x,
            b.y,
            b.x + b.width,
            b.y + b.height,
          ]);
    }

    // Everything in the cells of b, each object once (a body is one box per
    // cell, so a body across several cells is met once in each).
    function* near(
      b: readonly number[],
      grid: Map<number, Box[]> = buckets,
    ): Generator<Box> {
      const seen = new Set<Box>();
      for (const cell of cellsOf(b))
        for (const f of grid.get(cell) ?? [])
          if (!seen.has(f)) {
            seen.add(f);
            yield f;
          }
    }

    const taken = new Set<number>();
    const steps = portMap<number>();
    const turned = portMap<string>();
    const copper = new Set<number>();
    if (lateIn !== null)
      for (const [q, segments] of router.at) if (segments.length) copper.add(q);

    // after routing, a wire, or a body's edge (emit puts no lead there)
    const walled = (q: Point): boolean => {
      if (copper.has(pk(q[0], q[1]))) return true;
      for (const b of near([q[0], q[1], q[0], q[1]], parts))
        if (b[0] <= q[0] && q[0] <= b[2] && b[1] <= q[1] && q[1] <= b[3])
          return true;
      return false;
    };

    const crowd = (flags: readonly Box[]): number => {
      let n = 0;
      for (const f of flags) for (const b of near(f)) if (overlap(f, b)) n += 1;
      for (const f of flags)
        for (const b of near(f, parts)) if (overlap(f, b)) n += 1;
      for (const f of flags)
        for (const q of boxPoints(f)) {
          const key = pk(q[0], q[1]);
          if (taken.has(key) || copper.has(key)) n += 1;
        }
      return n;
    };

    const late = lateIn === null ? null : portSet(lateIn);

    const flagsAt = (
      labels: readonly string[],
      offsets: readonly number[],
      tip: (k: number) => Point,
      facing: string,
    ): Box[] =>
      labels.map((label, i) => labelBox(tip(offsets[i]), facing, label));

    // (lead and chain cells, flags, clutter) of the port's Tunnels n steps
    // out, clutter counting the flags and bodies their labels run into and
    // the leads through them; null when a Tunnel's point is taken, false when
    // the lead cannot get there (a longer one could not either).
    const fits = (
      port: Port,
      n: number,
      facing: string,
    ): [Point[], Box[], number] | null | false => {
      const [cid, idx] = port;
      const labels = this.anchors.get(port) as string[];
      const c = item(moved, cid);
      const [[px, py], , [sx, sy]] = this.portEdge(c, idx);
      const owner = router.owner(c.ends[idx].netBits || []);
      const offsets = chainOffsets(labels, [sx, sy]);
      const cells: Point[] = [];
      for (let k = 1; k < n + offsets[offsets.length - 1] + 1; k++)
        cells.push([px + sx * k, py + sy * k]);
      const stops = (q: Point): boolean => {
        const key = pk(q[0], q[1]);
        if (router.blocked.has(key) || taken.has(key)) return true;
        for (const own of router.owners(key)) if (own !== owner) return true;
        const front = fronts.get(key);
        return front !== undefined && !samePort(front, port);
      };
      for (const q of cells.slice(0, n - 1)) {
        if (stops(q)) return false;
        for (const f of near([q[0], q[1], q[0], q[1]]))
          if (inside(q, f)) return false;
        if (late !== null && walled(q)) return false;
      }
      for (const q of cells.slice(n - 1))
        if (stops(q) || (late !== null && walled(q))) return null;
      const flags = flagsAt(
        labels,
        offsets,
        (k) => [px + sx * (n + k), py + sy * (n + k)],
        facing,
      );
      return [cells, flags, crowd(flags)];
    };

    const place = (
      port: Port,
      n: number,
      cells: readonly Point[],
      flags: readonly Box[],
    ): void => {
      steps.set(port, n);
      for (const f of flags)
        for (const cell of cellsOf(f)) getOr(buckets, cell, () => []).push(f);
      for (const q of cells) taken.add(pk(q[0], q[1]));
    };

    if (late !== null) {
      for (const [port, labels] of this.anchors) {
        if (late.has(port)) continue;
        const [[px, py], facing, [sx, sy]] = this.portEdge(
          item(moved, port[0]),
          port[1],
        );
        const n = this.leadSteps.get(port) ?? 1;
        const offsets = chainOffsets(labels, [sx, sy]);
        const cells: Point[] = [];
        for (let k = 1; k < n + offsets[offsets.length - 1] + 1; k++)
          cells.push([px + sx * k, py + sy * k]);
        const turnedTo = this.leadFacing.get(port) ?? facing;
        place(
          port,
          n,
          cells,
          flagsAt(
            labels,
            offsets,
            (k) => [px + sx * (n + k), py + sy * (n + k)],
            turnedTo,
          ),
        );
      }
      steps.clear();
    }

    const rows = new Map<string, [string, number, [number, Port][]]>(); // (cid, facing, py) -> (px, port)
    for (const [port, labels] of this.anchors) {
      if (late !== null && !late.has(port)) continue;
      const [[px, py], facing] = this.portEdge(item(moved, port[0]), port[1]);
      if ((facing === "north" || facing === "south") && labels.length === 1)
        getOr(
          rows,
          pyRepr([port[0], facing, py]),
          (): [string, number, [number, Port][]] => [facing, py, []],
        )[2].push([px, port]);
    }
    const firstLabel = (port: Port): string =>
      (this.anchors.get(port) as string[])[0];
    for (const [, [facing, py, members]] of sortBy(rows, ([key]) => key)) {
      sortInPlace(members, (m) => m);
      for (const labelled of fanRuns(
        members.map(([px, port]): [number, string, Port] => [
          px,
          firstLabel(port),
          port,
        ]),
      )) {
        const run = labelled.map(([px, , port]): [number, Port] => [px, port]);
        const upright = run.map(([px, port]) =>
          labelBox(
            [px, py + (facing === "north" ? GRID : -GRID)],
            facing,
            firstLabel(port),
          ),
        );
        let stacked = 0;
        for (let i = 0; i < upright.length; i++)
          for (let j = i + 1; j < upright.length; j++)
            if (overlap(upright[i], upright[j])) stacked += 1;
        if (!stacked) continue;
        const half = floorDiv(run.length + 1, 2);
        const plan = run.map(([, port], rank): [Port, number, string] =>
          rank < half
            ? [port, 1 + 2 * rank, "east"]
            : [port, 1 + 2 * (run.length - 1 - rank), "west"],
        );
        if (maxOf(plan.map(([, n]) => n)) > V_LEAD_MAX) continue;
        const done: [Port, string, Point[], Box[], number][] = [];
        for (const [port, n, side] of plan) {
          const fit = fits(port, n, side);
          if (!fit) break;
          done.push([port, side, ...fit]);
          place(port, n, fit[0], fit[1]);
        }
        if (
          done.length < plan.length ||
          sum(done.map((d) => d[4])) >= stacked
        ) {
          for (const [port, , cells, flags] of done) {
            // the row stays upright
            steps.delete(port);
            for (const q of cells) taken.delete(pk(q[0], q[1]));
            for (const f of flags)
              for (const cell of cellsOf(f)) {
                const list = getOr(buckets, cell, () => []);
                const at = list.findIndex((g) => pyEq(g, f));
                if (at < 0)
                  throw new PyValueError("list.remove(x): x not in list");
                list.splice(at, 1);
              }
          }
          continue;
        }
        for (const [port, side] of done) turned.set(port, side);
      }
    }

    const edgeKey = (port: Port): unknown => {
      const [cid, idx] = port;
      const [[px, py], facing] = this.portEdge(item(moved, cid), idx);
      return [cid, facing, textWidth(firstLabel(port)), py, px];
    };

    for (const port of sortBy(this.anchors.keys(), edgeKey)) {
      if (steps.has(port) || (late !== null && !late.has(port))) continue;
      const [cid, idx] = port;
      const labels = this.anchors.get(port) as string[];
      const [[px, py], facing, [sx, sy]] = this.portEdge(item(moved, cid), idx);
      // the shortest lead whose labels run into nothing; failing that the
      // one with the least clutter
      let best: {
        n: number;
        cells: Point[];
        flags: Box[];
        clutter: number;
      } | null = null;
      for (let n = 1; n <= LEAD_MAX; n++) {
        const fit = fits(port, n, facing);
        if (fit === false) break; // the lead cannot pass a cell
        if (fit !== null && (best === null || fit[2] < best.clutter)) {
          best = { n, cells: fit[0], flags: fit[1], clutter: fit[2] };
          if (!fit[2]) break;
        }
      }
      if (
        late !== null &&
        best !== null &&
        best.clutter &&
        labels.length === 1
      ) {
        // a port labelled late may keep its Tunnel on the port itself (what
        // the router left in front of it is copper or crowded)
        const flags = [labelBox([px, py], facing, labels[0])];
        if (crowd(flags) < best.clutter)
          best = { n: 0, cells: [], flags, clutter: 0 };
      }
      // Bounded local repair for organized drawings. Keep the native port
      // and lead direction; only turn the Tunnel's flag if its ordinary
      // orientation still collides. The router subsequently reserves and
      // prices exactly this geometry and the native checks remain.
      if (
        this.placementStrategy !== null &&
        late === null &&
        best !== null &&
        best.clutter
      ) {
        for (const side of ["east", "west", "north", "south"]) {
          if (side === facing) continue;
          for (let n = 1; n <= LEAD_MAX; n++) {
            const fit = fits(port, n, side);
            if (fit === false) break;
            if (fit !== null && fit[2] < best.clutter) {
              best = { n, cells: fit[0], flags: fit[1], clutter: fit[2] };
              turned.set(port, side);
            }
            if (best.clutter === 0) break;
          }
          if (best.clutter === 0) break;
        }
      }
      if (best === null) {
        const offsets = chainOffsets(labels, [sx, sy]);
        const cells: Point[] = [];
        for (let k = 1; k < offsets[offsets.length - 1] + 2; k++)
          cells.push([px + sx * k, py + sy * k]);
        const flags = flagsAt(
          labels,
          offsets,
          (k) => [px + sx * (1 + k), py + sy * (1 + k)],
          facing,
        );
        best = { n: 1, cells, flags, clutter: 0 };
      }
      place(port, best.n, best.cells, best.flags);
    }
    return [steps, turned];
  }

  // A wire through a Tunnel's label crosses the name out, and people route
  // around the flags: every step into a label costs flagCost. Leads are as
  // long as planLeadSteps made them (one cell otherwise), flags turned where
  // it turned a row; the net's own lead and chain cells (reserved) are left
  // alone.
  priceLabels(
    router: Router,
    moved: Map<string, Component>,
    leads: KeyMap<Port, number>,
    turned: KeyMap<Port, string>,
    reserved: ReadonlySet<number> = new Set(),
  ): void {
    const price = (q: Point): void => {
      for (const axis of [0, 1]) {
        const key = pk(q[0], q[1]) * 2 + axis;
        router.clearanceCost.set(
          key,
          Math.max(router.clearanceCost.get(key) ?? 0, this.flagCost),
        );
      }
    };
    for (const c of moved.values()) {
      const b = c.bounds;
      const v = visualOf(c);
      for (const q of boxPoints([v.x, v.y, v.x + v.width, v.y + v.height]))
        if (
          !(
            b.x <= q[0] &&
            q[0] <= b.x + b.width &&
            b.y <= q[1] &&
            q[1] <= b.y + b.height
          ) &&
          !reserved.has(pk(q[0], q[1]))
        )
          price(q);
    }
    for (const [port, labels] of this.anchors) {
      const [[px, py], facing, [sx, sy]] = this.portEdge(
        item(moved, port[0]),
        port[1],
      );
      const turnedTo = turned.get(port) ?? facing;
      const n = leads.get(port) ?? 1;
      const offsets = chainOffsets(labels, [sx, sy]);
      labels.forEach((label, i) => {
        const k = offsets[i];
        for (const q of boxPoints(
          labelBox([px + sx * (n + k), py + sy * (n + k)], turnedTo, label),
        ))
          if (!reserved.has(pk(q[0], q[1]))) price(q);
      });
    }
  }

  // The body edge a port sits on (as its outward Tunnel facing and the
  // outward grid step), in moved coordinates.
  portEdge(movedComponent: Component, idx: number): [Point, string, Point] {
    const at = movedComponent.ends[idx].location;
    const edge = edgeOf(movedComponent, idx);
    return [[at.x, at.y], item(OPPOSITE, edge), item(OUTWARD, edge)];
  }

  // Split every segment at the interior points where another segment ends.
  // Logisim merges two collinear wires that meet at a point where no third
  // wire ends, so a '+' made of two branches leaving a trunk from opposite
  // sides loses its junction on load; a trunk split there is a real 4-way
  // node instead.
  static splitAtEndpoints(
    wires: Iterable<readonly [Point, Point]>,
  ): [Point, Point][] {
    const list = [...wires];
    const endsX = new Map<number, Set<number>>();
    const endsY = new Map<number, Set<number>>();
    for (const [a, b] of list)
      for (const p of [a, b]) {
        getOr(endsX, p[0], () => new Set()).add(p[1]);
        getOr(endsY, p[1], () => new Set()).add(p[0]);
      }
    const out: [Point, Point][] = [];
    for (const [a, b] of list) {
      let pts: Point[];
      if (a[0] === b[0]) {
        const [lo, hi] = a[1] <= b[1] ? [a[1], b[1]] : [b[1], a[1]];
        const cuts = [...(endsX.get(a[0]) ?? [])]
          .filter((y) => lo < y && y < hi)
          .sort((p, q) => p - q);
        pts = [lo, ...cuts, hi].map((y): Point => [a[0], y]);
      } else {
        const [lo, hi] = a[0] <= b[0] ? [a[0], b[0]] : [b[0], a[0]];
        const cuts = [...(endsY.get(a[1]) ?? [])]
          .filter((x) => lo < x && x < hi)
          .sort((p, q) => p - q);
        pts = [lo, ...cuts, hi].map((x): Point => [x, a[1]]);
      }
      for (let k = 0; k + 1 < pts.length; k++) out.push([pts[k], pts[k + 1]]);
    }
    return out;
  }

  netKeyOf(end: End): NetKey | null {
    const bits = end.netBits || [];
    return bits.length ? netKey(bits) : null;
  }

  route(): [Point, Point][] {
    const moved = new Map(
      this.components.map((c): [string, Component] => [
        c.componentId,
        this.movedComponent(c),
      ]),
    );
    const bodyIds = this.bodyIds;
    // Protect physical islands and geometric regions. A native bundle can
    // include distant body ports joined only by a Tunnel name.
    const fixedIds = new Set(
      this.components.filter((c) => this.isPanel(c)).map((c) => c.componentId),
    );
    const [keptWires, cuts] = fixedCopper(
      this.focus,
      fixedIds,
      this.panelBelowY,
    );
    // Port equivalence cannot account for half-built routes or drawings.
    // Keep their physical geometry and anchors; arrange the remaining body.
    for (const wire of this.looseWires)
      if (!keptWires.some((w) => pyEq(w, wire))) keptWires.push(wire);
    const bundleById = new Map(
      (this.focus.wireBundles ?? []).map((b): [string, WireBundle] => [
        b.bundleId,
        b,
      ]),
    );
    this.boundaryBridges = [];
    for (const cut of cuts) {
      const bundle = item(bundleById, cut.bundleId as string);
      const key = netKey(bundle.bitNets ?? []);
      if (!this.nets.has(key)) continue; // floating decoration has no signal to bridge
      const [x, y] = cut.point;
      const labels = this.labelsFor(key);
      // Put the new endpoint outside the fixed region. The whole original
      // in-region portion remains exactly covered.
      keptWires.push({
        from: { x, y },
        to: { x, y: y + 30 },
        bundleId: cut.bundleId,
      });
      this.boundaryBridges.push({
        key,
        x,
        y: y + 30,
        labels,
        width: item(this.bitsOf, key).length,
      });
    }
    const keptIds = new Set(keptWires.map((w) => w.bundleId));
    const keptBundles = (this.focus.wireBundles ?? []).filter((b) =>
      keptIds.has(b.bundleId),
    );
    const keptPoints = new Set<number>();
    for (const w of keptWires)
      for (const end of [w.from, w.to]) keptPoints.add(pk(end.x, end.y));
    this.keptWires = keptWires;
    // Tunnels: panel-side ones (in the panel, or standing on kept copper) stay
    // exactly where they are. Body-side ones of every net that has a body port
    // go: the port moved, and emit re-anchors the labels on the moved port.
    const panelSide = new Set<string>();
    for (const [cid, t] of this.tunnels)
      if (this.isPanel(t) || keptPoints.has(pk(t.location.x, t.location.y)))
        panelSide.add(cid);
    const dropTunnels = new Set<string>();
    for (const ports of this.nets.values())
      if (ports.some(([cid]) => bodyIds.has(cid)))
        for (const [cid] of ports)
          if (this.tunnels.has(cid) && !panelSide.has(cid))
            dropTunnels.add(cid);
    this.panelSideTunnels = panelSide;
    // Router view. The observer already merged every tunnel into its net, so
    // all ports of a wired net carry identical netIds; the router would call
    // them "already connected" and route nothing. Give each port a private
    // bus id, and fold those ids back onto the real net in the ownership
    // partition so same-net copper is never treated as foreign.
    const partition = new Partition();
    for (const [cid, c] of moved)
      for (const e of c.ends) {
        const bits = e.netBits || [];
        const key = bits.length ? netKey(bits) : null;
        if (
          key !== null &&
          this.classes.get(key) === "wire" &&
          bodyIds.has(cid)
        ) {
          const fresh: NetBit[] = [];
          for (const b of sortBy(bits, (b) => b.bit)) {
            const synthetic = `${b.netId}#${cid}:${e.index}`;
            partition.join(b.netId, synthetic);
            fresh.push({ bit: b.bit, netId: synthetic });
          }
          e.netBits = fresh;
        } else {
          e.netBits = Array.from(range(Math.max(1, e.width || 1)), (i) => ({
            bit: i,
            netId: `x:${cid}:${e.index}:${i}`,
          }));
        }
      }
    // Localised constants become synthetic components the router knows about:
    // one per consumer port, one grid step outward from the port along the
    // edge normal (further out when that cell is taken), carrying the
    // consumer's net bits so the stub is routed as a normal 2-pin net.
    this.syntheticConstants = [];
    this.syntheticFactory = new Map();
    const occupied: Bounds[] = [];
    const visualOccupied: Bounds[] = [];
    for (const [cid, c] of moved)
      if (
        !this.tunnels.has(cid) &&
        c.factoryName !== "Text" &&
        c.factoryName !== "Tunnel"
      ) {
        occupied.push(c.bounds);
        visualOccupied.push(visualOf(c));
      }

    const collides = (
      rect: Bounds,
      skip: Bounds | null = null,
      visual = false,
    ): boolean =>
      (visual ? [...visualOccupied, ...occupied] : occupied).some(
        (o) =>
          o !== skip &&
          rect.x < o.x + o.width &&
          o.x < rect.x + rect.width &&
          rect.y < o.y + o.height &&
          o.y < rect.y + rect.height,
      );

    // Logisim draws a Constant entirely behind its output port: facing east
    // the body spans [cx-body, cx], facing west [cx, cx+body]; the port is on
    // the body's edge, so the stub cell in front stays free.
    const constantBounds = (
      cx: number,
      cy: number,
      facing: string,
      body: number,
    ): Bounds => {
      if (facing === "east")
        return { x: cx - body, y: cy - 8, width: body, height: 16 };
      if (facing === "west")
        return { x: cx, y: cy - 8, width: body, height: 16 };
      if (facing === "south")
        return {
          x: cx - floorDiv(body, 2),
          y: cy - 16,
          width: body,
          height: 16,
        };
      // north: the observer reports the body hanging below the port
      // (200,500 -> y 500..516), i.e. the label box, not the arrow side.
      return { x: cx - floorDiv(body, 2), y: cy, width: body, height: 16 };
    };

    // The straight stub from the port to the Constant, one grid cell thick,
    // excluding the port cell itself (which sits on the consumer's edge).
    const stubBounds = (
      px: number,
      py: number,
      cx: number,
      cy: number,
    ): Bounds => {
      const [x0, x1] = px <= cx ? [px, cx] : [cx, px];
      const [y0, y1] = py <= cy ? [py, cy] : [cy, py];
      if (x0 === x1)
        return {
          x: x0 - 4,
          y: py === y0 ? y0 + 1 : y0,
          width: 8,
          height: Math.max(1, y1 - y0 - 1),
        };
      return {
        x: px === x0 ? x0 + 1 : x0,
        y: y0 - 4,
        width: Math.max(1, x1 - x0 - 1),
        height: 8,
      };
    };

    // Consumer ports that get no local Constant (boxed in, or the stub failed
    // to route) reach the shared Constant through its label instead: emit
    // puts a labelled Tunnel on the port and on the driver.
    this.failedConstantConsumers = portSet();
    for (const [key, cls] of this.classes) {
      if (cls !== "constant") continue;
      const driver = this.constantDriver(key);
      const drv = item(this.byId, driver);
      const value = attr(drv, "value") || "0x0";
      const width = drv.ends[0].width || 1;
      const factory = drv.factoryName;
      for (const [cid, idx] of item(this.nets, key)) {
        if (this.tunnels.has(cid) || cid === driver || !bodyIds.has(cid))
          continue;
        const consumer = item(moved, cid);
        const end = consumer.ends[idx];
        const px = end.location.x;
        const py = end.location.y;
        const b = consumer.bounds;
        const [dx, dy, facing] = item(CONSTANT_SIDE, edgeOf(consumer, idx));
        // Native Constant body: 16 px up to 8 bits, then 10 px per further
        // hex digit of the bit width (26 px at 9-12 bits ... 76 px at 29-32),
        // regardless of the value printed (measured with the observer).
        // A Ground or Power symbol is 14-15 px deep whatever its width.
        const bodyPx =
          factory === "Constant"
            ? 16 + 10 * Math.max(0, floorDiv(width + 3, 4) - 2)
            : 16;
        let placed: [number, number, Bounds] | null = null;
        for (let step = 1; step < 16; step++) {
          const cx = px + dx * step * GRID;
          const cy = py + dy * step * GRID;
          const bounds = constantBounds(cx, cy, facing, bodyPx);
          if (
            !collides(bounds, null, true) &&
            !collides(stubBounds(px, py, cx, cy), b)
          ) {
            placed = [cx, cy, bounds];
            break;
          }
        }
        if (placed === null) {
          this.failedConstantConsumers.add([cid, idx]);
          continue;
        }
        const [cx, cy, bounds] = placed;
        const sid = `const:${cid}:${idx}`;
        const bits = Array.from(range(width), (i) => ({
          bit: i,
          netId: `${sid}:b${i}`,
        }));
        const consumerBits = Array.from(range(width), (i) => ({
          bit: i,
          netId: `${sid}:b${i}#consumer`,
        }));
        for (let i = 0; i < width; i++)
          partition.join(`${sid}:b${i}`, `${sid}:b${i}#consumer`);
        end.netBits = consumerBits;
        moved.set(sid, {
          componentId: sid,
          factoryName: factory,
          location: { x: cx, y: cy },
          bounds,
          attributes: [],
          ends: [
            {
              index: 0,
              location: { x: cx, y: cy },
              width,
              direction: "output",
              netBits: bits,
            },
          ],
        });
        occupied.push(bounds);
        occupied.push(stubBounds(px, py, cx, cy));
        this.syntheticConstants.push([
          sid,
          cx,
          cy,
          facing,
          width,
          value,
          [cid, idx],
        ]);
        this.syntheticFactory.set(sid, factory);
      }
    }
    // Which body ports will carry Tunnels (decided before routing where
    // possible, so the router keeps their chain cells free):
    //   tunnel/global nets: every body port, all labels of the net;
    //   wire nets with panel ports: the routing source port (the bridge);
    //   constant nets with panel consumers: the driver's output.
    this.anchors = portMap();
    this.sourceOf = new Map();
    const wireTrees = this.wireTrees ?? new Map<NetKey, Port[][]>();
    for (const [key, cls] of this.classes) {
      const real = item(this.nets, key).filter(
        ([cid]) => !this.tunnels.has(cid),
      );
      const bodyPorts = real.filter(([cid]) => bodyIds.has(cid));
      const panelPorts = real.filter(([cid]) => !bodyIds.has(cid));
      if (cls === "tunnel" || cls === "global") {
        if (
          bodyPorts.length &&
          (real.length >= 2 || this.labelsOfNet.get(key)?.size)
        ) {
          const labels = this.labelsFor(key);
          for (const port of bodyPorts) this.anchors.set(port, labels);
        }
      } else if (cls === "wire") {
        const outputs = bodyPorts.filter(
          (p) => item(this.byId, p[0]).ends[p[1]].direction === "output",
        );
        const source = (outputs.length ? outputs : bodyPorts)[0];
        if (source === undefined) throw new Error("list index out of range");
        this.sourceOf.set(key, source);
        if (panelPorts.length) this.anchors.set(source, this.labelsFor(key));
        const trees = wireTrees.get(key);
        if (
          trees !== undefined &&
          (trees.length > 1 ||
            panelPorts.length ||
            this.labelsOfNet.get(key)?.size)
        ) {
          const labels = this.labelsFor(key);
          for (const tree of trees) this.anchors.set(tree[0], labels);
        }
      } else if (cls === "constant") {
        const driver = this.constantDriver(key);
        // a consumer boxed in without a local copy reaches the shared
        // Constant by its label (known now, so its Tunnel gets a lead)
        const boxed = bodyPorts.filter((port) =>
          this.failedConstantConsumers.has(port),
        );
        if (panelPorts.length || boxed.length) {
          const labels = this.labelsFor(key);
          this.anchors.set([driver, 0], labels);
          for (const port of boxed) this.anchors.set(port, labels);
        }
      }
    }
    const focusComponents = [...moved]
      .filter(([cid]) => !dropTunnels.has(cid))
      .map(([, c]) => c);
    for (const g of [
      ...(this.report.layoutGroups ?? []),
      ...(this.report.layoutStages ?? []),
    ])
      focusComponents.push({
        componentId: "heading:" + g.id,
        factoryName: "Text",
        ends: [],
        location: { x: g.x + 20, y: g.y + 20 },
        bounds: {
          x: g.x + 15,
          y: g.y,
          width: Math.min(
            g.width - 20,
            codePoints(g.heading || g.label).length * 20,
          ),
          height: 38,
        },
        attributes: [],
      });
    const jobs: Job[] = [];
    for (const [key, cls] of this.classes) {
      if (cls !== "wire") continue;
      const ports = item(this.nets, key).filter(([cid]) => bodyIds.has(cid));
      if (ports.length < 2) continue;
      // one tree per Splitter copy (see splitterCopies), each from its copy
      let trees: [string, Port[]][] = this.copies.has(key)
        ? item(this.copies, key).map(([copy, served], i): [string, Port[]] => [
            jobKey("copy", key, i),
            [copy, ...served],
          ])
        : [[key, ports]];
      const local = wireTrees.get(key);
      if (local !== undefined)
        trees = local.flatMap((tree, i): [string, Port[]][] =>
          tree.length > 1 ? [[jobKey("local", key, i), tree]] : [],
        );
      for (const [job, treePorts] of trees) {
        const xs = treePorts.map(
          ([cid, idx]) => item(moved, cid).ends[idx].location.x,
        );
        const ys = treePorts.map(
          ([cid, idx]) => item(moved, cid).ends[idx].location.y,
        );
        jobs.push([
          treePorts.length > 2,
          maxOf(xs) - minOf(xs) + (maxOf(ys) - minOf(ys)),
          job,
          treePorts,
        ]);
      }
    }
    for (const [sid, , , , , , consumer] of this.syntheticConstants)
      jobs.push([
        false,
        20,
        JSON.stringify(["const", sid]),
        [[sid, 0], consumer],
      ]);
    sortInPlace(jobs, (j) => [j[0], j[1]], this.routeOrder === "long");

    const namedControlJobs = new Set<string>();
    const controlTrees = this.controlTrees ?? new Map<string, ControlTree>();

    // Every job on a fresh router, the nets in `first` before the rest;
    // Tunnel leads staggered (see planLeadSteps) unless `stagger` is off.
    const routeAll = (
      first: ReadonlySet<string>,
      stagger = true,
    ): RouteAttempt => {
      const router = new Router(
        {
          components: focusComponents,
          wires: keptWires,
          wireBundles: keptBundles,
        },
        partition,
        {
          crossingCost: this.crossingCost,
          visitCap: ROUTER_VISIT_CAP,
          bendCost: this.bendCost,
        },
      );
      // Every anchored Tunnel stands one cell off its port on a 10 px lead
      // (as hand-drawn schematics do: hardly any Tunnel sits on the port
      // itself), further labels chain outward on 10 px stubs (see emit).
      // Those cells are copper of that net; no other route may run through
      // them. They are remembered so emit can tell them from real obstacles.
      const reserved = new Set<number>();
      const [leads, turned] = stagger
        ? this.planLeadSteps(moved, router)
        : [portMap<number>(), portMap<string>()];
      for (const [[cid, idx], labels] of this.anchors) {
        const c = item(moved, cid);
        const [[px, py], , [sx, sy]] = this.portEdge(c, idx);
        const n = leads.get([cid, idx]) ?? 1;
        for (let k = 1; k <= n; k++) {
          const lead = pk(px + sx * k, py + sy * k);
          reserved.add(lead);
          // the lead belongs to the port's net (its own route may still
          // leave through it: a bridge port is both routed and labelled)
          getOr(router.portOwners, lead, () => new Set()).add(
            router.owner(c.ends[idx].netBits || []),
          );
        }
        const offsets = chainOffsets(labels, [sx, sy]);
        for (let k = n + 1; k < n + offsets[offsets.length - 1] + 1; k++) {
          const q = pk(px + sx * k, py + sy * k);
          reserved.add(q);
          router.blocked.add(q);
        }
      }
      if (this.flagCost)
        this.priceLabels(router, moved, leads, turned, reserved);
      // Every other body port keeps the cell in front of it for its own net
      // too. Pins of a tall pipeline register sit 30 px apart on one edge; a
      // neighbour's route that runs vertically along that edge would box in
      // the ports it passes (the router never ends a route on foreign
      // copper), which is how tall registers lost 3-8 nets to "no room".
      // Hand-drawn schematics have the same short lead before any bend or
      // junction. Splitters are excluded: their pins are not on a body edge.
      const claims = new Map<number, Set<string>>(); // lead cell -> nets of the ports it fronts
      for (const c of focusComponents) {
        if (
          c.factoryName === "Tunnel" ||
          c.factoryName === "Text" ||
          c.factoryName === "Splitter"
        )
          continue;
        c.ends.forEach((end, idx) => {
          if (this.anchors.has([c.componentId, idx])) return;
          const [[px, py], , [sx, sy]] = this.portEdge(c, idx);
          const owner = router.owner(end.netBits || []);
          getOr(claims, pk(px + sx, py + sy), () => new Set()).add(
            owner !== "[]"
              ? owner
              : JSON.stringify(["lead", c.componentId, idx]),
          );
        });
      }
      for (const [lead, nets] of claims)
        // two ports of different nets facing each other across one cell: the
        // cell stays free, or neither port could be reached
        if (
          nets.size === 1 &&
          !router.portOwners.has(lead) &&
          !router.blocked.has(lead)
        )
          getOr(router.portOwners, lead, () => new Set()).add([...nets][0]);
      const wires: [Point, Point][] = [];
      const failedPorts = new Map<NetKey, Port[]>();
      const failedConsts = portSet();
      const unrouted: Report[] = [];
      const failedJobs = new Set<string>();
      const wireNets: string[] = []; // the net of every segment in wires
      // A Pin standing level with its port (see fanPins), or right below it
      // in a staircase (see satellites), gets its straight wire as it is,
      // before anything is routed: in a staircase that wire runs along the
      // edge of the Pin before it, which the router's clearance cost would
      // rather bend around.
      const netOfPort = portMap<NetKey>();
      for (const [key, ports] of this.nets)
        for (const port of ports) netOfPort.set(port, key);
      for (const [pinPort, driverPort] of this.fanWires) {
        const key = netOfPort.get(pinPort);
        if (
          key === undefined ||
          this.classes.get(key) !== "wire" ||
          this.copies.has(key)
        )
          continue;
        const pinEnd = item(moved, pinPort[0]).ends[pinPort[1]];
        const driverEnd = item(moved, driverPort[0]).ends[driverPort[1]];
        const a: Point = [driverEnd.location.x, driverEnd.location.y];
        const b: Point = [pinEnd.location.x, pinEnd.location.y];
        const owner = router.owner(driverEnd.netBits || []);
        if (a[0] !== b[0] && a[1] !== b[1]) continue;
        if (a[0] === b[0] && a[1] === b[1]) continue;
        const foreign = (q: Point): boolean => {
          const at = pk(q[0], q[1]);
          if (router.blocked.has(at)) return true;
          for (const own of router.owners(at)) if (own !== owner) return true;
          return router.occupants(at).some((s) => s.owner !== owner);
        };
        if (Router.grid(a, b).some(foreign)) continue;
        const bus = busKey((driverEnd.netBits || []).map((bit) => bit.netId));
        router.add(a, b, owner, bus);
        router.connected.join(
          bus,
          busKey((pinEnd.netBits || []).map((bit) => bit.netId)),
        );
        wires.push([a, b]);
        wireNets.push(key);
      }
      const controlRoutes: Report[] = [];
      const controlFallbacks = new Set<string>();
      const labelBoxes: [string, Box][] = [];
      if (controlTrees.size)
        for (const [port, labels] of this.anchors) {
          const c = item(moved, port[0]);
          const [[px, py], facing, step] = this.portEdge(c, port[1]);
          const turnedTo = turned.get(port) ?? facing;
          const n = leads.get(port) ?? 1;
          const owner = router.owner(c.ends[port[1]].netBits as NetBit[]);
          const offsets = chainOffsets(labels, step);
          labels.forEach((label, i) => {
            const k = offsets[i];
            labelBoxes.push([
              owner,
              labelBox(
                [px + step[0] * (n + k), py + step[1] * (n + k)],
                turnedTo,
                label,
              ),
            ]);
          });
        }
      const priority = (job: Job): number[] => {
        const later = first.has(job[2]) ? 0 : 1;
        if (!controlTrees.has(job[2])) return [1, 0, later];
        const [cid, idx] = job[3][0];
        // Keep established top/bottom rails ahead of side controls.
        return [0, this.portEdge(item(moved, cid), idx)[2][0] ? 1 : 0, later];
      };
      for (const [, , key, ports] of sortBy(jobs, priority)) {
        if (
          !controlTrees.has(key) &&
          [...controlFallbacks].some((k) => !namedControlJobs.has(k))
        )
          break; // re-plan labels before spending time routing data wires
        let sourcePort: Port;
        let remaining: Port[];
        if (this.nets.has(key)) {
          sourcePort = item(this.sourceOf, key);
          remaining = ports.filter((p) => !samePort(p, sourcePort));
        } else {
          sourcePort = ports[0];
          remaining = ports.slice(1);
        }
        const source = item(moved, sourcePort[0]).ends[sourcePort[1]];
        sortInPlace(remaining, (p) => {
          const at = item(moved, p[0]).ends[p[1]].location;
          return (
            Math.abs(at.x - source.location.x) +
            Math.abs(at.y - source.location.y)
          );
        });
        const net = jobNet(key);
        const tree = controlTrees.get(key);
        if (tree !== undefined) {
          const rail = namedControlJobs.has(key)
            ? null
            : sharedRail(
                router,
                moved,
                ports,
                (c, i) => this.portEdge(c, i),
                leads,
                tree,
                labelBoxes,
              );
          controlRoutes.push({
            label: this.labelOfNet.get(net) ?? null,
            ports: ports.length,
            groupId: tree.groupId,
            column: tree.column,
            method: rail !== null ? "shared-rail" : "named-fallback",
          });
          if (rail !== null) {
            wires.push(...rail);
            for (let i = 0; i < rail.length; i++) wireNets.push(net);
            continue;
          }
          // A control rail is a readability preference, not a demand to
          // connect the column through an arbitrary winding tree. Emission
          // puts the same verified net label at every port.
          controlFallbacks.add(key);
          continue;
        }
        for (const port of remaining) {
          const target = item(moved, port[0]).ends[port[1]];
          try {
            const found = router.route(source, target);
            wires.push(...found);
            for (let i = 0; i < found.length; i++) wireNets.push(net);
          } catch (error) {
            if (!(error instanceof PyValueError)) throw error;
            unrouted.push({
              label: this.nets.has(net)
                ? (this.labelOfNet.get(net) ?? null)
                : JSON.parse(key)[1],
              ports: ports.length,
              reason: cpSlice(error.message, 0, 120),
            });
            failedJobs.add(key);
            if (this.nets.has(net))
              getOr(failedPorts, net, () => []).push(port);
            // constant stub: this consumer falls back to the shared Constant's label
            else failedConsts.add(port);
          }
        }
      }
      return {
        router,
        reserved,
        wires,
        failedPorts,
        failedConsts,
        unrouted,
        failedJobs,
        wireNets,
        leads,
        turned,
        controlRoutes,
        controlFallbacks,
      };
    };

    // Failed combs become named connections before planning label leads, not
    // after ordinary wires have occupied their text space. The fallback set
    // only grows, so this is bounded by the number of control trees, with no
    // geometry search.
    const settledRoutes = (
      first: ReadonlySet<string>,
      stagger = true,
    ): SettledRoutes => {
      for (let round = 0; round < controlTrees.size + 1; round++) {
        const result = routeAll(first, stagger);
        const pending = [...result.controlFallbacks].filter(
          (key) => !namedControlJobs.has(key),
        );
        if (!pending.length)
          return { ...result, anchors: portMap(this.anchors) };
        for (const key of pending) namedControlJobs.add(key);
        // Anchor insertion order affects label staggering, so the pending
        // trees are labelled in a fixed order.
        for (const key of sortBy(pending, (k) => pyRepr(JSON.parse(k)))) {
          const net = jobNet(key);
          for (const port of item(controlTrees, key).ports)
            this.anchors.set(port, this.labelsFor(net));
        }
      }
      throw new Error("Control label fallback did not converge");
    };

    // Ports the router could not reach keep the net by label: emit puts the
    // net's Tunnel on them and on the routing source, the copper that did
    // route stays. A route that cannot reach its port was usually boxed in
    // by nets routed before it (a jog right in front of a dense port edge
    // such as a multiplexer's inputs 10 px apart); routing the failed nets
    // first frees most of them.
    let attempt = settledRoutes(new Set());
    if (attempt.unrouted.length) {
      const retry = settledRoutes(attempt.failedJobs);
      if (retry.unrouted.length < attempt.unrouted.length) attempt = retry;
    }
    if (attempt.unrouted.length) {
      // a long lead narrows the way into the wired port beside it
      const plain = settledRoutes(attempt.failedJobs, false);
      if (plain.unrouted.length < attempt.unrouted.length) attempt = plain;
    }
    const router = attempt.router;
    this.reserved = attempt.reserved;
    let wires = attempt.wires;
    this.failedPorts = attempt.failedPorts;
    this.leadSteps = attempt.leads;
    this.leadFacing = attempt.turned;
    this.anchors = attempt.anchors;
    if (controlTrees.size) {
      const routes = attempt.controlRoutes;
      Object.assign(this.report.sharedControls, {
        routes,
        routedLabelReduction: sum(
          routes
            .filter((r) => r.method === "shared-rail")
            .map((r) => r.ports - 1),
        ),
        namedFallbackTrees: count(routes, (r) => r.method === "named-fallback"),
      });
    }
    this.routed = wires.map((w, i): [[Point, Point], string] => [
      w,
      attempt.wireNets[i],
    ]);
    this.report.unrouted.push(...attempt.unrouted);
    for (const port of attempt.failedConsts)
      this.failedConstantConsumers.add(port);
    for (const [key, ports] of this.failedPorts) {
      const labels = this.labelsFor(key);
      this.anchors.set(item(this.sourceOf, key), labels);
      for (const port of ports) this.anchors.set(port, labels);
    }
    for (const [key, cls] of this.classes) {
      if (cls !== "constant") continue;
      const failed = item(this.nets, key).filter((port) =>
        this.failedConstantConsumers.has(port),
      );
      if (failed.length) {
        const labels = this.labelsFor(key);
        this.anchors.set([this.constantDriver(key), 0], labels);
        for (const port of failed) this.anchors.set(port, labels);
      }
    }
    // the ports labelled only now get their leads around what is drawn
    const late = [...this.anchors.keys()].filter(
      (port) => !this.leadSteps.has(port),
    );
    if (late.length) {
      const [steps, turned] = this.planLeadSteps(moved, router, late);
      const leadSteps = portMap(this.leadSteps);
      for (const [port, n] of steps) leadSteps.set(port, n);
      const leadFacing = portMap(this.leadFacing);
      for (const [port, facing] of turned) leadFacing.set(port, facing);
      this.leadSteps = leadSteps;
      this.leadFacing = leadFacing;
    }
    wires = SchematicLayout.splitAtEndpoints(wires);
    this.wires = wires;
    this.dropTunnels = dropTunnels;
    this.moved = moved;
    this.router = router;
    this.report.wires = wires.length;
    return wires;
  }

  // The part driving a constant net.
  constantDriver(key: NetKey): string {
    const driver = item(this.nets, key).find(([cid]) =>
      this.constants.has(cid),
    );
    if (driver === undefined) throw new StopIteration();
    return driver[0];
  }

  // ---- emission --------------------------------------------------------------

  // What a reader pays for the routed drawing: one crossing, five bends, a
  // metre of wire and two Tunnels count about the same.
  drawingCost(): number {
    const horizontal = this.wires
      .filter(([a, b]) => a[1] === b[1])
      .map(
        ([a, b]) => [Math.min(a[0], b[0]), Math.max(a[0], b[0]), a[1]] as const,
      );
    const vertical = this.wires
      .filter(([a, b]) => a[0] === b[0])
      .map(
        ([a, b]) => [Math.min(a[1], b[1]), Math.max(a[1], b[1]), a[0]] as const,
      );
    let crossings = 0;
    for (const [x1, x2, y] of horizontal)
      for (const [y1, y2, x] of vertical)
        if (x1 < x && x < x2 && y1 < y && y < y2) crossings += 1;
    const axes = new Map<number, Set<boolean>>();
    for (const [a, b] of this.wires)
      for (const q of [a, b])
        getOr(axes, pk(q[0], q[1]), () => new Set()).add(a[1] === b[1]);
    const bends = count(axes.values(), (seen) => seen.size === 2);
    const length = sum(
      this.wires.map(([a, b]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])),
    );
    const tunnels = sum(
      [...this.anchors.values()].map((labels) => labels.length),
    );
    return crossings + bends / 5 + length / 1000 + tunnels / 2;
  }

  // Place and route. Without pipeline stages the columns can be balanced two
  // ways (balanceLayers) and neither wins everywhere: on large processor
  // sheets each draws some with 20-30 crossings fewer than the other. Both are
  // drawn and the cheaper drawing is kept (drawingCost); when the even rule
  // moves nothing more than the chain rule, one drawing is enough.
  async arrange(): Promise<void> {
    if (this.placementStrategy !== null) {
      // An explicit organization must not be replaced by a cheaper flat
      // drawing. The strategy owns placement; native routing/emit and the
      // caller's connectivity/interface checks remain the same.
      const start = deepCopy({ ...this });
      const { preserveInterfaceOrder, labelFeedback } =
        await import("./grouped-geometry.mts");
      await this.place();
      preserveInterfaceOrder(this);
      this.placementStrategy.prepareRouting?.(this);
      this.route();
      labelFeedback(this);
      const initial = this.report.labelGeometry.remainingCollisions;
      if (initial) {
        const padding = portSet();
        const piecePorts = this.piecePort ?? portMap<Port>();
        for (const issue of this.report.labelGeometry.examples) {
          const port: Port = [issue.componentId, issue.port];
          padding.add(piecePorts.get(port) ?? port);
          if (issue.kind === "label-label") {
            const other: Port = [issue.otherComponentId, issue.otherPort];
            padding.add(piecePorts.get(other) ?? other);
          }
        }
        for (const key of Object.keys(this))
          delete (this as Record<string, unknown>)[key];
        Object.assign(this, start);
        this.labelPaddingPorts = padding;
        await this.place();
        preserveInterfaceOrder(this);
        this.placementStrategy.prepareRouting?.(this);
        this.route();
        labelFeedback(this);
      }
      this.report.labelGeometry.repair = {
        initialCollisions: initial,
        paddingPasses: initial ? 1 : 0,
        remainingCollisions: this.report.labelGeometry.remainingCollisions,
      };
      this.report.tunnelledForCrossings = 0;
      return;
    }
    const start: Record<string, any> = { ...this };
    let best = await this.arrangeOnce(start, new Map(start.classes));
    // A net whose copper crosses many others is drawn with Tunnels when its
    // label means something to a reader (see crossingHeavy); the sheet is
    // placed and routed again around what is left, and kept when it reads
    // better. Repeated while it helps: the next heaviest nets show only once
    // the first ones are gone.
    let tunnelled = new Set<NetKey>();
    for (let round = 0; round < 3; round++) {
      Object.assign(this, best[2]);
      const heavy = this.crossingHeavy();
      if (!heavy.size) break;
      const classes = new Map<NetKey, string>(start.classes);
      for (const key of new Set([...tunnelled, ...heavy]))
        classes.set(key, "tunnel");
      const again = await this.arrangeOnce(start, classes);
      if (again[0] >= best[0]) break;
      best = again;
      tunnelled = new Set([...tunnelled, ...heavy]);
    }
    Object.assign(this, best[2]);
    this.report.tunnelledForCrossings = tunnelled.size;
  }

  async arrangeOnce(
    start: Record<string, any>,
    classes: ReadonlyMap<NetKey, string>,
  ): Promise<[number, number, Record<string, any>]> {
    const attempts: [number, number, Record<string, any>][] = [];
    for (const balance of ["even", "chains"]) {
      Object.assign(this, start);
      this.classes = new Map(classes);
      this.report = deepCopy(start.report);
      this.synthesized = new Map(start.synthesized);
      this.usedLabels = new Set(start.usedLabels);
      this.abbrCounter = new Map(start.abbrCounter);
      this.balance = balance;
      this.evenMoves = 0;
      await this.place();
      this.route();
      attempts.push([this.drawingCost(), attempts.length, { ...this }]);
      if (!this.evenMoves) break;
    }
    return minBy(attempts, (a) => [a[0], a[1]]);
  }

  // Wired nets whose copper crosses more than CROSSINGS_PER_CONSUMER other
  // wires per consumer (and at least CROSSINGS_MIN) and that have a name a
  // reader knows (the author's Tunnel label, a labelled Pin or part on the
  // net, a clock). Hand-drawn schematics tolerate a few crossings per
  // consumer -- nine in ten wired nets stay within two -- and switch to
  // Tunnels beyond; a net known only by a made-up name stays a wire.
  crossingHeavy(): Set<NetKey> {
    const horizontal = this.routed
      .filter(([[a, b]]) => a[1] === b[1] && a[0] !== b[0])
      .map(
        ([[a, b], k]) =>
          [Math.min(a[0], b[0]), Math.max(a[0], b[0]), a[1], k] as const,
      );
    const vertical = this.routed
      .filter(([[a, b]]) => a[0] === b[0] && a[1] !== b[1])
      .map(
        ([[a, b], k]) =>
          [Math.min(a[1], b[1]), Math.max(a[1], b[1]), a[0], k] as const,
      );
    const crossings = new Map<string, number>();
    for (const [x0, x1, y, k] of horizontal)
      for (const [y0, y1, x, j] of vertical)
        if (k !== j && x0 < x && x < x1 && y0 < y && y < y1) {
          crossings.set(k, (crossings.get(k) ?? 0) + 1);
          crossings.set(j, (crossings.get(j) ?? 0) + 1);
        }
    const heavy = new Set<NetKey>();
    for (const [key, n] of crossings) {
      if (
        !this.nets.has(key) ||
        this.classes.get(key) !== "wire" ||
        n < CROSSINGS_MIN
      )
        continue;
      const ports = item(this.nets, key).filter(([cid]) =>
        this.bodyIds.has(cid),
      );
      if (n > CROSSINGS_PER_CONSUMER * (ports.length - 1) && this.nameable(key))
        heavy.add(key);
    }
    return heavy;
  }

  // Would this net's Tunnels carry a name a reader knows?
  nameable(key: NetKey): boolean {
    if (this.labelsOfNet.get(key)?.size) return true;
    return item(this.nets, key).some(([cid]) => {
      if (this.tunnels.has(cid)) return false;
      const c = item(this.byId, cid);
      return attr(c, "label") || c.factoryName === "Clock";
    });
  }

  async emit(): Promise<string> {
    this.plan();
    await this.arrange();
    const circuit = this.circuit;
    const movedPins = new Map<string, Point>();
    for (const [cid, element] of this.elementOf) {
      const [dx, dy] = this.placement.get(cid) ?? [0, 0];
      if (dx || dy) {
        const [x, y] = loc(element.get("loc"));
        element.set("loc", `(${x + dx},${y + dy})`);
        if (element.get("name") === "Pin")
          movedPins.set(`${x},${y}`, [x + dx, y + dy]);
      }
    }
    // A custom appearance names the Pin behind each of its ports by the Pin's
    // location. Left pointing at the old spot, the port is gone: the file no
    // longer loads ("Appearance element circ-port not found"), or the instance
    // loses that connection in every circuit using it. The port stays where it
    // is on the instance; only the reference follows.
    this.report.appearancePortsRepointed = repointPins(circuit, movedPins);
    // Old body wiring goes; panel copper (unchanged coordinates) stays.
    // Logisim normalises wires on load -- collinear pieces that meet are
    // merged, a wire is split where another one ends -- so the observed wires
    // are not always the file's <wire> elements (a 10 px lead drawn onto the
    // end of a longer wire is one observed wire). A file wire stays when it
    // lies on kept copper.
    const keptH = new Map<number, [number, number][]>();
    const keptV = new Map<number, [number, number][]>();
    for (const kw of this.keptWires) {
      const [ax, ay, bx, by] = [kw.from.x, kw.from.y, kw.to.x, kw.to.y];
      if (ay === by)
        getOr(keptH, ay, () => []).push([Math.min(ax, bx), Math.max(ax, bx)]);
      if (ax === bx)
        getOr(keptV, ax, () => []).push([Math.min(ay, by), Math.max(ay, by)]);
    }
    const onKeptCopper = (a: Point, b: Point): boolean => {
      if (
        a[1] === b[1] &&
        (keptH.get(a[1]) ?? []).some(
          ([lo, hi]) =>
            lo <= Math.min(a[0], b[0]) && Math.max(a[0], b[0]) <= hi,
        )
      )
        return true;
      return (
        a[0] === b[0] &&
        (keptV.get(a[0]) ?? []).some(
          ([lo, hi]) =>
            lo <= Math.min(a[1], b[1]) && Math.max(a[1], b[1]) <= hi,
        )
      );
    };
    for (const w of circuit.findall("wire"))
      if (!onKeptCopper(loc(w.get("from")), loc(w.get("to"))))
        circuit.remove(w);
    const existing = circuit
      .findall("wire")
      .map((w): [Point, Point] => [loc(w.get("from")), loc(w.get("to"))]);
    for (const w of this.keptWires)
      for (const [p, q] of subtractSegments(
        [w.from.x, w.from.y],
        [w.to.x, w.to.y],
        existing,
      )) {
        subElement(circuit, "wire", {
          from: `(${p[0]},${p[1]})`,
          to: `(${q[0]},${q[1]})`,
        });
        existing.push([p, q]);
      }
    for (const cid of this.dropTunnels) {
      const element = this.elementOf.get(cid);
      if (element !== undefined && circuit.children.includes(element))
        circuit.remove(element);
    }
    // A body-side Tunnel of a net without body ports (label-only copper) keeps
    // its coordinates unless the new body now sits there; then it goes to the
    // footer rather than onto a foreign port.
    const movedBodies = [...this.layer.keys()].map(
      (cid) => item(this.moved, cid).bounds,
    );
    const movedPorts = new Set<number>();
    for (const cid of this.layer.keys())
      for (const e of item(this.moved, cid).ends)
        movedPorts.add(pk(e.location.x, e.location.y));
    const onBody = (q: Point): boolean =>
      movedBodies.some(
        (b) =>
          b.x <= q[0] &&
          q[0] <= b.x + b.width &&
          b.y <= q[1] &&
          q[1] <= b.y + b.height,
      );
    for (const [cid, t] of this.tunnels) {
      if (this.dropTunnels.has(cid) || this.panelSideTunnels.has(cid)) continue;
      const p: Point = [t.location.x, t.location.y];
      if (movedPorts.has(pk(p[0], p[1])) || onBody(p)) {
        const [footerX, footerY] = this.footerSlot(20, 20);
        item(this.elementOf, cid).set("loc", `(${footerX},${footerY})`);
        item(this.moved, cid).location = { x: footerX, y: footerY };
      }
    }
    // Tunnels on moved body ports (see route: this.anchors) and on panel ports
    // whose copper was rebuilt. The first label sits on the port; further
    // labels chain outward on 10 px stubs (cells the router kept free); if a
    // late anchor finds its chain cell taken, the labels stack on the port
    // instead (distinct labels on one point are all read).
    const copper = new Set<number>();
    for (const [a, b] of this.wires)
      for (const q of Router.grid(a, b)) copper.add(pk(q[0], q[1]));
    for (const kw of this.keptWires)
      for (const q of Router.grid([kw.from.x, kw.from.y], [kw.to.x, kw.to.y]))
        copper.add(pk(q[0], q[1]));
    let reanchored = 0;
    const router = this.router;
    const reserved = this.reserved;
    const lib = this.wiringLib as string;

    // The router kept the cell for a Tunnel (a recessed port's lead starts on
    // its body's edge), or holds it for the port's own net. The flag may sit
    // on its own tree's copper: treating all routed copper as foreign silently
    // collapses planned alias chains onto the port during emission. A crossing
    // with any foreign owner is still forbidden; unknown copper also remains
    // an obstacle.
    const free = (q: Point, owner: string): boolean => {
      const key = pk(q[0], q[1]);
      const at = router.at.get(key);
      const ownCopper =
        this.placementStrategy !== null &&
        at !== undefined &&
        at.length > 0 &&
        at.every((s) => s.owner === owner);
      if (copper.has(key) && !ownCopper) return false;
      const owners = router.portOwners.get(key);
      if (
        owners !== undefined &&
        !reserved.has(key) &&
        ![...owners].every((o) => o === owner)
      )
        return false;
      if (router.blocked.has(key) && !reserved.has(key)) return false;
      return reserved.has(key) || !onBody(q);
    };

    const anchorTunnels = (
      cid: string,
      idx: number,
      labels: readonly string[],
    ): number => {
      const comp = item(this.moved, cid);
      const [[px, py], natural, step] = this.portEdge(comp, idx);
      const facing = this.leadFacing.get([cid, idx]) ?? natural;
      const width = comp.ends[idx].width || 1;
      const owner = router.owner(comp.ends[idx].netBits || []);
      // The first label one cell off the port on a lead (a Tunnel on the
      // port itself is what a reader of hand-drawn work never sees), further
      // labels chained outward; a taken cell ends the chain and the remaining
      // labels stack on the last free point (distinct labels on one point are
      // all read by Logisim).
      let n = this.leadSteps.get([cid, idx]) ?? 1;
      for (let k = 1; k < n; k++)
        if (!free([px + step[0] * k, py + step[1] * k], owner)) {
          n = 1;
          break;
        }
      const chain: Point[] = [];
      const targets = new Set(chainOffsets(labels, step).map((k) => n + k));
      for (let k = n; k < maxOf(targets) + 1; k++) {
        const q: Point = [px + step[0] * k, py + step[1] * k];
        if (!free(q, owner)) break;
        if (targets.has(k)) chain.push(q);
      }
      if (!chain.length) chain.push([px, py]);
      while (chain.length < labels.length) chain.push(chain[chain.length - 1]);
      let previous: Point = [px, py];
      labels.forEach((label, i) => {
        const [tx, ty] = chain[i];
        const el = subElement(circuit, "comp", {
          lib,
          name: "Tunnel",
          loc: `(${tx},${ty})`,
        });
        subElement(el, "a", { name: "facing", val: facing });
        subElement(el, "a", { name: "width", val: String(width) });
        subElement(el, "a", { name: "label", val: label });
        if (tx !== previous[0] || ty !== previous[1]) {
          const [ax, ay] = previous;
          subElement(circuit, "wire", {
            from: `(${Math.min(ax, tx)},${Math.min(ay, ty)})`,
            to: `(${Math.max(ax, tx)},${Math.max(ay, ty)})`,
          });
          for (const q of Router.grid(previous, [tx, ty]))
            copper.add(pk(q[0], q[1]));
        }
        previous = [tx, ty];
      });
      return labels.length;
    };

    for (const [[cid, idx], labels] of this.anchors)
      reanchored += anchorTunnels(cid, idx, labels);
    // Panel side: every panel port of a net that now depends on a label must
    // reach a Tunnel of that net over kept copper (or stand on one).
    const joined = new UnionFind();
    const at = (x: number, y: number): string => `${x},${y}`;
    for (const kw of this.keptWires)
      joined.join(at(kw.from.x, kw.from.y), at(kw.to.x, kw.to.y));
    const tunnelRoots = new Map<NetKey, Set<string>>();
    for (const bridge of this.boundaryBridges) {
      for (const label of bridge.labels) {
        const node = subElement(circuit, "comp", {
          lib,
          name: "Tunnel",
          loc: `(${bridge.x},${bridge.y})`,
        });
        subElement(node, "a", { name: "facing", val: "west" });
        subElement(node, "a", { name: "width", val: String(bridge.width) });
        subElement(node, "a", { name: "label", val: label });
        reanchored += 1;
      }
      getOr(tunnelRoots, bridge.key, () => new Set()).add(
        joined.root(at(bridge.x, bridge.y)),
      );
    }
    for (const [cid, t] of this.tunnels) {
      if (this.dropTunnels.has(cid)) continue;
      const key = t.ends.length ? this.netKeyOf(t.ends[0]) : null;
      if (key !== null)
        getOr(tunnelRoots, key, () => new Set()).add(
          joined.root(at(t.location.x, t.location.y)),
        );
    }
    const anchoredKeys = new Set<NetKey | null>();
    for (const [cid, idx] of this.anchors.keys())
      anchoredKeys.add(this.netKeyOf(item(this.byId, cid).ends[idx]));
    // in the observed net order
    for (const [key, ports] of this.nets) {
      if (!anchoredKeys.has(key)) continue;
      const labels = this.labelsFor(key);
      for (const [cid, idx] of ports) {
        if (this.tunnels.has(cid) || this.bodyIds.has(cid)) continue;
        const p = item(this.byId, cid).ends[idx].location;
        const roots = getOr(tunnelRoots, key, () => new Set());
        if (roots.has(joined.root(at(p.x, p.y)))) continue;
        reanchored += anchorTunnels(cid, idx, labels);
        roots.add(joined.root(at(p.x, p.y)));
      }
    }
    this.report.tunnelsReanchored = reanchored;
    this.report.tunnelsRemoved = this.dropTunnels.size;
    this.report.tunnelsKept =
      this.tunnels.size - this.dropTunnels.size + reanchored;
    // Localised constants: emit the synthetic components the router placed.
    for (const [sid, cx, cy, facing, width, value, consumer] of this
      .syntheticConstants) {
      if (this.failedConstantConsumers.has(consumer)) continue;
      const factory = this.syntheticFactory.get(sid) ?? "Constant";
      const el = subElement(circuit, "comp", {
        lib,
        name: factory,
        loc: `(${cx},${cy})`,
      });
      // a Constant faces its consumer; a Ground or Power symbol faces away
      subElement(el, "a", {
        name: "facing",
        val: factory === "Constant" ? facing : item(OPPOSITE, facing),
      });
      subElement(el, "a", { name: "width", val: String(width) });
      if (factory === "Constant")
        subElement(el, "a", { name: "value", val: value });
      this.report.constantsPlaced += 1;
    }
    // The shared Constant itself stays only while something still reads it by
    // label (panel consumers, consumers without a private Constant).
    for (const [key, cls] of this.classes) {
      if (cls !== "constant") continue;
      const driver = this.constantDriver(key);
      if (!this.anchors.has([driver, 0])) {
        const element = this.elementOf.get(driver);
        if (element !== undefined && circuit.children.includes(element))
          circuit.remove(element);
      }
    }
    for (const [a, b] of this.wires)
      subElement(circuit, "wire", {
        from: `(${a[0]},${a[1]})`,
        to: `(${b[0]},${b[1]})`,
      });
    // Global compaction only anchors components; it can translate free copper
    // even when its owner is fixed. Leave that final pass off when preserving
    // unfinished routes or independent drawings.
    if (this.sheetGap && !this.looseWires.length) this.compactSheet(circuit);
    // Only this definition is rewritten; everything else in the file stays
    // byte for byte (a diff of the file shows one circuit change).
    return spliceCircuit(this.source, this.circuitName, circuit);
  }

  // Squeeze the air out of the routed sheet (compactX): everything below the
  // panel moves left as far as its neighbours at the same height allow,
  // keeping every left-to-right order where heights overlap, so crossings,
  // bends and connectivity stay exactly as routed; parts that share a left
  // edge move together and stay a column. Geometry of a part comes from its
  // observation; Tunnels and Constants written by emit are estimated from
  // their label and width.
  compactSheet(circuit: XmlElement): void {
    const cidOf = new Map<XmlElement, string>();
    for (const [cid, el] of this.elementOf) cidOf.set(el, cid);
    const panel = this.panelBelowY;
    const comps: {
      boxes: Box[];
      ports: Point[];
      fixed: boolean;
      cling: boolean;
    }[] = [];
    const elements: XmlElement[] = [];
    for (const el of circuit.findall("comp")) {
      const [x, y] = loc(el.get("loc"));
      const cid = cidOf.get(el);
      const c = cid !== undefined ? this.byId.get(cid) : undefined;
      let boxes: Box[];
      let ports: Point[];
      if (c !== undefined) {
        const ox = x - c.location.x;
        const oy = y - c.location.y;
        const b = c.bounds;
        boxes = [[b.x + ox, b.y + oy, b.x + ox + b.width, b.y + oy + b.height]];
        ports = c.ends.map((e): Point => [
          e.location.x + ox,
          e.location.y + oy,
        ]);
      } else {
        [boxes, ports] = estimatedGeometry(el, x, y);
      }
      const label = c !== undefined ? attr(c, "label") : null;
      if (label && c !== undefined && c.factoryName === "Pin") {
        const [x0, y0, x1, y1] = boxes[0];
        const w = textWidth(label);
        const side = attr(c, "labelloc") || "west";
        if (side === "west") boxes.push([x0 - w, y0, x0, y1]);
        else if (side === "east") boxes.push([x1, y0, x1 + w, y1]);
      }
      const name = el.get("name");
      comps.push({
        boxes,
        ports: ports.length ? ports : [[x, y]],
        fixed: panel !== null && maxOf(boxes.map((bx) => bx[3])) < panel,
        cling: name === "Tunnel" || CONSTANT_SOURCES.includes(name as string),
      });
      elements.push(el);
    }
    const wires: CompactWire[] = [];
    const wireElements: XmlElement[] = [];
    for (const w of circuit.findall("wire")) {
      const a = loc(w.get("from"));
      const b = loc(w.get("to"));
      wires.push([a, b, panel !== null && Math.max(a[1], b[1]) < panel]);
      wireElements.push(w);
    }
    // The Pins of a north or south edge are an instance's ports in x order,
    // and a consumer that read left to right from its driver keeps doing so
    // (over a label no wire holds them apart; a wire that turns back does not
    // either).
    const edgePins = sorted(
      elements.flatMap((el, i): [number, number][] =>
        el.get("name") === "Pin" &&
        ["north", "south"].includes(attrOf(el, "facing") as string)
          ? [[comps[i].ports[0][0], i]]
          : [],
      ),
    );
    const keep: KeepOrder[] = [];
    for (let k = 0; k + 1 < edgePins.length; k++) {
      const [xi, i] = edgePins[k];
      const [xj, j] = edgePins[k + 1];
      keep.push([
        [i, xi],
        [j, xj],
      ]);
    }
    const index = new Map<string, number>();
    elements.forEach((el, i) => {
      const cid = cidOf.get(el);
      if (cid !== undefined) index.set(cid, i);
    });
    for (const ports of this.nets.values()) {
      const ends = ports.filter(
        ([cid]) => index.has(cid) && this.moved.has(cid),
      );
      const side = (direction: string): [number, number][] =>
        ends
          .filter(
            ([cid, idx]) =>
              item(this.byId, cid).ends[idx].direction === direction,
          )
          .map(([cid, idx]) => [
            item(index, cid),
            item(this.moved, cid).ends[idx].location.x,
          ]);
      const drivers = side("output");
      const consumers = side("input");
      for (const d of drivers)
        for (const c of consumers) if (c[1] > d[1]) keep.push([d, c]);
    }
    const bodies = comps.flatMap((c, i) => {
      const name = elements[i].get("name");
      return !c.fixed && name !== "Tunnel" && name !== "Text" ? [i] : [];
    });
    if (!bodies.length) return;
    const boxes = bodies.map((i) => comps[i].boxes[0]);
    const width = maxOf(boxes.map((b) => b[2])) - minOf(boxes.map((b) => b[0]));
    const height =
      maxOf(boxes.map((b) => b[3])) - minOf(boxes.map((b) => b[1]));
    const cap = (
      DENSITY_MAX.find(([n]) => bodies.length < n) as readonly [number, number]
    )[1];
    const minWidth = (bodies.length * 1e6) / (cap * Math.max(height, 1));
    if (width <= minWidth) return; // already as dense as hand-drawn sheets get
    // Parts that share a left edge (a column, as placed) keep sharing it.
    const columns = new Map<number, number[]>();
    for (const i of bodies)
      if (!CONSTANT_SOURCES.includes(elements[i].get("name") as string))
        getOr(columns, comps[i].boxes[0][0], () => []).push(i);
    const together = [...columns.values()].filter(
      (members) => members.length > 1,
    );
    // A caption is read with its part: left free, a Text above or below a part
    // overlaps nothing at the part's height and slides off on its own.
    const moving = new Set(bodies);
    for (const [text, part] of this.captions ?? new Map<string, string>()) {
      const t = index.get(text);
      const p = index.get(part);
      if (
        t !== undefined &&
        p !== undefined &&
        moving.has(p) &&
        !comps[t].fixed
      )
        together.push([t, p]);
    }
    const [dx, movedWires] = compactX(comps, wires, {
      partGap: this.sheetGap,
      keepOrder: keep,
      minWidth,
      extentParts: bodies,
      together,
    });
    const pins = new Map<string, Point>();
    elements.forEach((el, k) => {
      const d = dx[k];
      if (!d) return;
      const [x, y] = loc(el.get("loc"));
      el.set("loc", `(${x + d},${y})`);
      if (el.get("name") === "Pin") pins.set(`${x},${y}`, [x + d, y]);
      const cid = cidOf.get(el);
      if (cid === undefined) return;
      const [px, py] = this.placement.get(cid) ?? [0, 0];
      this.placement.set(cid, [px + d, py]); // the whole move, as callers map parts by it
      const m = this.moved.get(cid);
      if (m !== undefined) {
        m.location = { x: m.location.x + d, y: m.location.y };
        m.bounds = { ...m.bounds, x: m.bounds.x + d };
        m.ends = m.ends.map((e) => ({
          ...e,
          location: { x: e.location.x + d, y: e.location.y },
        }));
      }
    });
    wireElements.forEach((w, k) => {
      const [a, b] = movedWires[k];
      w.set("from", `(${a[0]},${a[1]})`);
      w.set("to", `(${b[0]},${b[1]})`);
    });
    repointPins(circuit, pins);
    const before = maxOf(
      comps.flatMap((c) => c.boxes.map((bx) => bx[2])),
      0,
    );
    const after = maxOf(
      comps.flatMap((c, k) => c.boxes.map((bx) => bx[2] + dx[k])),
      0,
    );
    this.report.sheetCompactedPx = before - after;
  }
}
