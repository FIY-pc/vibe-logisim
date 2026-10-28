// The netlist a layout is made of, read from one definition's observation.
//
// Parts that stay where they are: pinned ones, the parts standing on
// unfinished or independent copper, the observation panel at the top of a
// sheet, everything inside a frame drawn with wires, and empty text. The rest
// moves in units: parts touching port to port move together, and a caption
// moves with the part it labels. Every net is one record (driver, sinks,
// width, name), not one per bit, and says how it will be drawn: a wire, a
// Tunnel at each port, a private constant at each port, or untouched.
import { fixedCopper } from "./fixed-geometry.mts";
import { looseWireGeometry, wireIslands } from "./loose-wires.mts";
import {
  attr,
  boxOf,
  CONSTANT_SOURCES,
  down,
  GRID,
  netKey,
  OPPOSITE,
  up,
} from "./circuit.mts";
import type { Box, Point, Report } from "./circuit.mts";
import type { Component, End, Focus, Wire } from "./types.mts";
import { parseXml } from "./xml.mts";
import type { XmlElement } from "./xml.mts";

// A net with at least this many ports is a global control (clock, reset,
// enable) and is drawn with Tunnels.
const GLOBAL_FANOUT = 12;
// A Text this close to a part is its caption and moves with it.
const CAPTION_DISTANCE = 60;
const PANEL_MIN_GAP = 40;
const PANEL_MIN_PARTS = 12;
const PANEL_IO_SHARE = 0.6;
const PANEL_MIN_DISPLAYS = 4;
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
const ABBREVIATIONS: Record<string, string> = {
  Multiplexer: "MUX",
  Demultiplexer: "DMX",
  Decoder: "DEC",
  "Priority Encoder": "ENC",
  Adder: "ADD",
  Subtractor: "SUB",
  Multiplier: "MUL",
  Divider: "DIV",
  Negator: "NEG",
  Comparator: "CMP",
  Shifter: "SHF",
  "Bit Extender": "EXT",
  Splitter: "SPL",
  Register: "REG",
  Counter: "CNT",
  ROM: "ROM",
  RAM: "RAM",
  "AND Gate": "AND",
  "OR Gate": "OR",
  "NOT Gate": "NOT",
  "NAND Gate": "NAND",
  "NOR Gate": "NOR",
  "XOR Gate": "XOR",
  "XNOR Gate": "XNOR",
  Buffer: "BUF",
  "Controlled Buffer": "CBUF",
  "D Flip-Flop": "DFF",
  Clock: "CLK",
};
const LABELLED_IO = new Set(["Pin", "Probe", "LED", "Hex Digit Display", "Button"]);

export type Side = "EAST" | "WEST" | "NORTH" | "SOUTH";
export const STEP: Record<Side, Point> = {
  EAST: [GRID, 0],
  WEST: [-GRID, 0],
  NORTH: [0, -GRID],
  SOUTH: [0, GRID],
};
// The facing of something attached to a port on this side that points back
// at the port (a Tunnel or Constant drawn away from the part).
export const FACING_TOWARD: Record<Side, string> = {
  EAST: "west",
  WEST: "east",
  NORTH: "south",
  SOUTH: "north",
};
const SIDE_OF_FACING: Record<string, Side> = {
  east: "EAST",
  west: "WEST",
  north: "NORTH",
  south: "SOUTH",
};

export interface Port {
  part: Component;
  end: End;
}
export const portId = (c: Component, e: End): string =>
  `${c.componentId}:${e.index}`;

// Where a net meets a unit: one point (ports touching there are one terminal).
export interface Terminal {
  unit: Unit;
  point: Point;
  side: Side;
  ports: Port[];
  direction: "output" | "inout" | "input";
}

export type NetKind = "wire" | "tunnel" | "constant" | "fixed";

export interface Net {
  index: number;
  key: string;
  width: number;
  ports: Port[];
  terminals: Terminal[];
  // ports on parts that stay, and the Tunnels kept with them
  fixed: Port[];
  keptTunnels: Component[];
  // the constant driving it (a private copy goes on each terminal)
  constant: Component | null;
  // Tunnels drawn on it, and their labels
  tunnels: Component[];
  labels: string[];
  kind: NetKind;
  // the Tunnel label it is drawn with
  label: string | null;
  // why it is drawn with Tunnels (report)
  reason?: string;
}

export interface Unit {
  id: string;
  index: number;
  parts: Component[];
  captions: Component[];
  terminals: Terminal[];
  // the original box of its parts and captions
  box: Box;
}

export interface ArrangeOptions {
  pinned: Set<string>;
  keepTunnels: Set<string>;
  localiseConstants: boolean;
  panelBelowY: number | null;
  organization: Report | null;
}

export interface Model {
  xml: string;
  circuit: string;
  focus: Focus;
  root: XmlElement;
  element: XmlElement;
  options: ArrangeOptions;
  byId: Map<string, Component>;
  elementOf: Map<string, XmlElement>;
  // parts (Tunnels excluded) and Tunnels
  parts: Component[];
  tunnels: Component[];
  // parts that stay, and why
  fixed: Map<string, string>;
  keptWires: Wire[];
  keptTunnels: Set<string>;
  panelBelowY: number | null;
  frames: Box[];
  units: Unit[];
  unitOf: Map<string, Unit>;
  notes: Component[];
  localized: Set<string>;
  nets: Net[];
  netOfPort: Map<string, Net>;
  // labels in use (lower case), for new ones
  usedLabels: Set<string>;
  // drawn mostly with Tunnels: Tunnels the author drew stay Tunnels
  tunnelPage: boolean;
  wiringLib: string | null;
  baseLib: string | null;
  report: Report;
}

function listOf(value: unknown): string[] {
  if (value === undefined || value === null || value === false) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

export function arrangeOptions(args: Report): ArrangeOptions {
  const below = args.panelBelowY;
  return {
    pinned: new Set(listOf(args.pinnedComponentIds)),
    keepTunnels: new Set(listOf(args.keepTunnels)),
    localiseConstants:
      args.localiseConstants === undefined || args.localiseConstants === null
        ? true
        : Boolean(args.localiseConstants),
    panelBelowY:
      below === undefined || below === null ? null : Math.trunc(Number(below)),
    organization: args.organization ?? null,
  };
}

// The part's footprint on the grid: body and label.
export function footprint(c: Component): Box {
  const b = c.bounds;
  const v = c.visualBounds ?? b;
  return [
    down(Math.min(b.x, v.x)),
    down(Math.min(b.y, v.y)),
    up(Math.max(b.x + b.width, v.x + v.width)),
    up(Math.max(b.y + b.height, v.y + v.height)),
  ];
}

// The edge of the body a port leaves through.
export function sideOf(c: Component, e: End): Side {
  const facing = attr(c, "facing") ?? "east";
  if (c.factoryName === "Pin" || c.factoryName === "Clock" || CONSTANT_SOURCES.includes(c.factoryName)) {
    if (c.factoryName === "Ground" || c.factoryName === "Power")
      return SIDE_OF_FACING[OPPOSITE[facing] ?? "south"] ?? "NORTH";
    return SIDE_OF_FACING[facing] ?? "EAST";
  }
  if (c.factoryName === "Splitter") {
    const bits = SIDE_OF_FACING[facing] ?? "EAST";
    return e.index === 0
      ? (SIDE_OF_FACING[OPPOSITE[facing] ?? "west"] ?? "WEST")
      : bits;
  }
  const b = c.bounds;
  const p = e.location;
  const distances: [Side, number][] = [
    ["WEST", Math.abs(p.x - b.x)],
    ["EAST", Math.abs(b.x + b.width - p.x)],
    ["NORTH", Math.abs(p.y - b.y)],
    ["SOUTH", Math.abs(b.y + b.height - p.y)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

const isText = (c: Component) => c.factoryName === "Text";
const isEmptyText = (c: Component) =>
  isText(c) && (!(attr(c, "text") ?? "").trim() || c.bounds.width <= 0);

// Pairs each observed component with its <comp> element: by location and
// factory, else by location alone (a subcircuit instance is named after its
// definition).
function bindElements(
  element: XmlElement,
  components: Component[],
): Map<string, XmlElement> {
  const byKey = new Map<string, XmlElement[]>();
  const byPoint = new Map<string, XmlElement[]>();
  for (const el of element.findall("comp")) {
    const text = el.get("loc") ?? "";
    const m = text.match(/-?[0-9]+/g);
    if (!m || m.length !== 2) continue;
    const p = `${Number(m[0])},${Number(m[1])}`;
    const k = `${p},${el.get("name")}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(el);
    if (!byPoint.has(p)) byPoint.set(p, []);
    byPoint.get(p)!.push(el);
  }
  const used = new Set<XmlElement>();
  const result = new Map<string, XmlElement>();
  for (const c of components) {
    const p = `${c.location.x},${c.location.y}`;
    const pick = (list: XmlElement[] | undefined) =>
      list?.find((el) => !used.has(el));
    const el =
      pick(byKey.get(`${p},${c.factoryName}`)) ??
      pick(byKey.get(`${p},${(c as { displayName?: string }).displayName ?? ""}`)) ??
      pick(byPoint.get(p));
    if (!el) throw new Error(`no element for ${c.componentId} at (${p})`);
    used.add(el);
    result.set(c.componentId, el);
  }
  return result;
}

// The observation panel: the top band of a sheet made mostly of I/O and
// annotation, showing something to a person, and separated from the body by
// a row of whitespace. Returns the y below which parts may move, or null.
function detectPanel(parts: Component[]): number | null {
  const real = [...parts].sort((a, b) => a.bounds.y - b.bounds.y);
  if (real.length < 40 || new Set(real.map((c) => c.bounds.y)).size < 4)
    return null;
  const bands: [Component[], number][] = [];
  let current: Component[] = [];
  let bottom = -Infinity;
  for (const c of real) {
    if (current.length && c.bounds.y - bottom >= PANEL_MIN_GAP) {
      bands.push([current, bottom]);
      current = [];
      bottom = -Infinity;
    }
    current.push(c);
    bottom = Math.max(bottom, c.bounds.y + c.bounds.height);
  }
  bands.push([current, bottom]);
  let best: number | null = null;
  const cluster: Component[] = [];
  const count = (list: Component[], f: (c: Component) => boolean) =>
    list.filter(f).length;
  for (let i = 0; i < bands.length; i++) {
    const [band, bandBottom] = bands[i];
    if (
      count(band, (c) => PANEL_FACTORIES.has(c.factoryName)) <
      PANEL_IO_SHARE * band.length
    )
      break;
    cluster.push(...band);
    const io = count(cluster, (c) => PANEL_FACTORIES.has(c.factoryName));
    const shows = count(cluster, (c) => PANEL_DISPLAYS.has(c.factoryName));
    if (
      cluster.length >= PANEL_MIN_PARTS &&
      io >= PANEL_IO_SHARE * cluster.length &&
      shows >= PANEL_MIN_DISPLAYS
    ) {
      const below =
        i + 1 < bands.length ? bands[i + 1][0][0].bounds.y : bandBottom + PANEL_MIN_GAP;
      best = Math.floor((bandBottom + below) / 2);
    }
  }
  return best;
}

function sanitizeLabel(text: string): string {
  const cleaned = text
    .replace(/[^\p{L}\p{N}_.\-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return Array.from(cleaned).slice(0, 32).join("") || "NET";
}

const PORT_WORD = /^\s*([\p{L}\p{Nl}\p{No}][\p{L}\p{N}_]*)/u;

export function buildModel(
  xml: string,
  circuit: string,
  focus: Focus,
  options: ArrangeOptions,
): Model {
  const root = parseXml(xml);
  const element = root.findall("circuit").find((c) => c.get("name") === circuit);
  if (!element) throw new Error(`circuit "${circuit}" not found in the file`);
  const libName = (desc: string) =>
    root.findall("lib").find((lib) => lib.get("desc") === desc)?.get("name") ?? null;
  const byId = new Map(focus.components.map((c) => [c.componentId, c]));
  const elementOf = bindElements(element, focus.components);
  const parts = focus.components.filter((c) => c.factoryName !== "Tunnel");
  const tunnels = focus.components.filter((c) => c.factoryName === "Tunnel");
  const report: Report = {};

  // what stays
  const fixed = new Map<string, string>();
  for (const id of options.pinned) if (byId.has(id)) fixed.set(id, "pinned");
  const [looseWires, anchors] = looseWireGeometry(focus);
  for (const id of anchors)
    if (byId.get(id)?.factoryName !== "Tunnel" && !fixed.has(id))
      fixed.set(id, "loose wires");
  const panelBelowY = options.panelBelowY ?? detectPanel(parts);
  if (panelBelowY !== null)
    for (const c of parts)
      if (c.bounds.y < panelBelowY && !fixed.has(c.componentId))
        fixed.set(c.componentId, "panel");
  // closed drawings without ports are frames: what is inside stays inside
  const frames: Box[] = [];
  for (const island of wireIslands(focus)) {
    if (island.ports.size || island.wires.length < island.points.size) continue;
    const xs = island.wires.flatMap((w) => [w.from.x, w.to.x]);
    const ys = island.wires.flatMap((w) => [w.from.y, w.to.y]);
    const box: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (box[2] - box[0] >= 40 && box[3] - box[1] >= 40) frames.push(box);
  }
  const inside = (c: Component, f: Box) => {
    const cx = c.bounds.x + c.bounds.width / 2;
    const cy = c.bounds.y + c.bounds.height / 2;
    return cx > f[0] && cx < f[2] && cy > f[1] && cy < f[3];
  };
  for (const c of parts)
    if (!fixed.has(c.componentId) && frames.some((f) => inside(c, f)))
      fixed.set(c.componentId, "frame");
  for (const c of parts)
    if (isEmptyText(c) && !fixed.has(c.componentId)) fixed.set(c.componentId, "empty text");

  // constants that become a private copy on every port they drive
  const portsAt = new Map<string, Port[]>();
  for (const c of parts)
    for (const e of c.ends) {
      const k = `${e.location.x},${e.location.y}`;
      if (!portsAt.has(k)) portsAt.set(k, []);
      portsAt.get(k)!.push({ part: c, end: e });
    }

  // parts touching port to port move together; touching a part that stays
  // keeps them in place too
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let x = a;
    while (parent.has(x) && parent.get(x) !== r) {
      const n = parent.get(x)!;
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  const join = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  const constantNet = new Set<string>();
  const netsByKey = new Map<string, Port[]>();
  for (const c of parts)
    for (const e of c.ends) {
      if (!e.netBits?.length) continue;
      const k = netKey(e.netBits);
      if (!netsByKey.has(k)) netsByKey.set(k, []);
      netsByKey.get(k)!.push({ part: c, end: e });
    }
  const localized = new Set<string>();
  if (options.localiseConstants)
    for (const [k, ports] of netsByKey) {
      const sources = ports.filter((p) => CONSTANT_SOURCES.includes(p.part.factoryName));
      if (!sources.length) continue;
      const others = ports.filter((p) => !CONSTANT_SOURCES.includes(p.part.factoryName));
      if (others.some((p) => p.end.direction === "output")) continue;
      const value = (c: Component) =>
        c.factoryName === "Constant"
          ? `${attr(c, "value")}`.toLowerCase()
          : c.factoryName;
      if (new Set(sources.map((p) => value(p.part))).size !== 1) continue;
      constantNet.add(k);
      for (const p of sources)
        if (!fixed.has(p.part.componentId) && p.part.ends.length === 1)
          localized.add(p.part.componentId);
    }
  const movable = (c: Component) =>
    !fixed.has(c.componentId) && !localized.has(c.componentId) && !isText(c);
  for (;;) {
    let changed = false;
    for (const ports of portsAt.values()) {
      const ids = ports
        .map((p) => p.part)
        .filter((c) => !localized.has(c.componentId) && !isText(c));
      if (ids.length < 2) continue;
      const anyFixed = ids.find((c) => fixed.has(c.componentId));
      if (anyFixed)
        for (const c of ids)
          if (!fixed.has(c.componentId)) {
            fixed.set(c.componentId, "touches a fixed part");
            changed = true;
          }
    }
    if (!changed) break;
  }
  for (const ports of portsAt.values()) {
    const ids = ports.map((p) => p.part).filter(movable);
    for (let i = 1; i < ids.length; i++) join(ids[0].componentId, ids[i].componentId);
  }

  const groups = new Map<string, Component[]>();
  for (const c of parts) {
    if (!movable(c)) continue;
    const r = find(c.componentId);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(c);
  }
  const units: Unit[] = [];
  const unitOf = new Map<string, Unit>();
  for (const members of groups.values()) {
    members.sort((a, b) => a.location.x - b.location.x || a.location.y - b.location.y);
    const box = members
      .map(footprint)
      .reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    const unit: Unit = {
      id: `u${units.length}`,
      index: units.length,
      parts: members,
      captions: [],
      terminals: [],
      box,
    };
    units.push(unit);
    for (const c of members) unitOf.set(c.componentId, unit);
  }

  // captions follow the nearest part, and stay by a part that stays; other
  // free text becomes a note
  const notes: Component[] = [];
  const staying = parts.filter((c) => fixed.has(c.componentId) && !isText(c));
  for (const t of parts) {
    if (!isText(t) || fixed.has(t.componentId)) continue;
    const tb = boxOf(t.bounds);
    const gapTo = (c: Component) => {
      const b = boxOf(c.visualBounds ?? c.bounds);
      return Math.max(b[0] - tb[2], tb[0] - b[2], b[1] - tb[3], tb[1] - b[3], 0);
    };
    let best: [number, Unit | null] | null = null;
    for (const [u, c] of [...units.flatMap((u) => u.parts.map((c) => [u, c] as const)), ...staying.map((c) => [null, c] as const)]) {
      const gap = gapTo(c);
      if (gap <= CAPTION_DISTANCE && (!best || gap < best[0])) best = [gap, u];
    }
    if (best && best[1] === null) fixed.set(t.componentId, "caption of a fixed part");
    else if (best && best[1]) {
      best[1].captions.push(t);
      unitOf.set(t.componentId, best[1]);
      const cb = footprint(t);
      const u = best[1];
      u.box = [Math.min(u.box[0], cb[0]), Math.min(u.box[1], cb[1]), Math.max(u.box[2], cb[2]), Math.max(u.box[3], cb[3])];
    } else notes.push(t);
  }

  // copper and Tunnels that stay
  const fixedIds = new Set(fixed.keys());
  const [regionWires] = fixedCopper(focus, fixedIds, panelBelowY);
  const keptWires: Wire[] = [];
  const seenWire = new Set<string>();
  for (const w of [...regionWires, ...looseWires]) {
    const k = `${w.from.x},${w.from.y},${w.to.x},${w.to.y}`;
    if (seenWire.has(k)) continue;
    seenWire.add(k);
    keptWires.push({ from: { ...w.from }, to: { ...w.to } });
  }
  const onKept = (p: Point) =>
    keptWires.some((w) =>
      w.from.x === w.to.x
        ? p[0] === w.from.x && p[1] >= Math.min(w.from.y, w.to.y) && p[1] <= Math.max(w.from.y, w.to.y)
        : p[1] === w.from.y && p[0] >= Math.min(w.from.x, w.to.x) && p[0] <= Math.max(w.from.x, w.to.x),
    );
  const keptTunnels = new Set<string>();
  for (const t of tunnels) {
    const p: Point = [t.location.x, t.location.y];
    const atFixed = (portsAt.get(`${p[0]},${p[1]}`) ?? []).some((q) => fixed.has(q.part.componentId));
    if (
      atFixed ||
      onKept(p) ||
      (panelBelowY !== null && t.bounds.y < panelBelowY) ||
      frames.some((f) => inside(t, f))
    )
      keptTunnels.add(t.componentId);
  }

  // nets
  const usedLabels = new Set<string>();
  const tunnelsOf = new Map<string, Component[]>();
  for (const t of tunnels) {
    const label = attr(t, "label") ?? "";
    if (label) usedLabels.add(label.toLowerCase());
    const e = t.ends[0];
    if (!e?.netBits?.length) continue;
    const k = netKey(e.netBits);
    if (!tunnelsOf.has(k)) tunnelsOf.set(k, []);
    tunnelsOf.get(k)!.push(t);
  }
  const nets: Net[] = [];
  const netOfPort = new Map<string, Net>();
  // A net the author drew in pieces that each reach it through a Splitter
  // (a bus taken apart again at each consumer) keeps its pieces: the
  // Splitters already join them, and copper between them would only add
  // wire across the drawing.
  const islandOf = new Map<string, number>();
  wireIslands(focus).forEach((island, i) => {
    for (const p of island.points) islandOf.set(p, i);
  });
  const piecesOf = (k: string, ports: Port[]): Port[][] => {
    if (constantNet.has(k) || tunnelsOf.has(k) || ports.some((p) => fixed.has(p.part.componentId)))
      return [ports];
    const byIsland = new Map<string, Port[]>();
    for (const p of ports) {
      const at = `${p.end.location.x},${p.end.location.y}`;
      const island = islandOf.has(at) ? `i${islandOf.get(at)}` : at;
      if (!byIsland.has(island)) byIsland.set(island, []);
      byIsland.get(island)!.push(p);
    }
    const pieces = [...byIsland.values()];
    return pieces.length > 1 && pieces.every((piece) => piece.some((p) => p.part.factoryName === "Splitter"))
      ? pieces
      : [ports];
  };
  for (const [k, ports] of [...netsByKey].flatMap(([k, all]) => piecesOf(k, all).map((ports) => [k, ports] as const))) {
    const width = Math.max(...ports.map((p) => (p.end.netBits ?? []).length), 1);
    const onNet = tunnelsOf.get(k) ?? [];
    const net: Net = {
      index: nets.length,
      key: k,
      width,
      ports,
      terminals: [],
      fixed: ports.filter((p) => fixed.has(p.part.componentId)),
      keptTunnels: onNet.filter((t) => keptTunnels.has(t.componentId)),
      constant: null,
      tunnels: onNet,
      labels: [...new Set(onNet.map((t) => attr(t, "label") ?? "").filter(Boolean))].sort(),
      kind: "fixed",
      label: null,
    };
    if (constantNet.has(k))
      net.constant =
        ports.find((p) => CONSTANT_SOURCES.includes(p.part.factoryName))?.part ?? null;
    // terminals: one per (unit, point)
    const at = new Map<string, Terminal>();
    for (const p of ports) {
      const unit = unitOf.get(p.part.componentId);
      if (!unit || localized.has(p.part.componentId)) continue;
      const point: Point = [p.end.location.x, p.end.location.y];
      const tk = `${unit.id}|${point[0]},${point[1]}`;
      const direction = p.end.direction === "output" ? "output" : p.end.direction === "inout" ? "inout" : "input";
      let t = at.get(tk);
      if (!t) {
        t = { unit, point, side: sideOf(p.part, p.end), ports: [], direction };
        at.set(tk, t);
        net.terminals.push(t);
        unit.terminals.push(t);
      }
      t.ports.push(p);
      if (direction === "output" || (direction === "inout" && t.direction === "input"))
        t.direction = direction;
    }
    nets.push(net);
    for (const p of ports) netOfPort.set(portId(p.part, p.end), net);
  }
  const sourceTunnels = tunnels.length;
  const tunnelPage = sourceTunnels > Math.max(2, (parts.length - localized.size) / 10);

  const model: Model = {
    xml,
    circuit,
    focus,
    root,
    element,
    options,
    byId,
    elementOf,
    parts,
    tunnels,
    fixed,
    keptWires,
    keptTunnels,
    panelBelowY,
    frames,
    units,
    unitOf,
    notes,
    localized,
    nets,
    netOfPort,
    usedLabels,
    tunnelPage,
    wiringLib: libName("#Wiring"),
    baseLib: libName("#Base"),
    report,
  };
  classifyNets(model);
  return model;
}

// How each net is drawn. A net reaching a part that stays, or a Tunnel kept
// with it, keeps its name: a Tunnel at each moved port. A constant net gets a
// private constant at each port. Tunnels the author drew stay Tunnels on a
// sheet drawn with them, and on any sheet for the labels kept on request or
// for a control reaching a dozen ports; everything else is a wire.
export function classifyNets(model: Model): void {
  const org = model.options.organization ?? {};
  const local = new Set(listOf(org.localSignals));
  const named = new Map<string, string>();
  for (const link of (org.namedLinks ?? []) as Report[]) {
    const label = String(link.label ?? "").trim();
    if (!label) continue;
    named.set(`${link.componentId}:${link.port}`, label);
    model.usedLabels.add(label.toLowerCase());
  }
  for (const net of model.nets) {
    if (!net.terminals.length) {
      net.kind = "fixed";
      continue;
    }
    if (net.constant && (net.fixed.length === 0 || model.localized.has(net.constant.componentId) || model.fixed.has(net.constant.componentId))) {
      net.kind = "constant";
      continue;
    }
    const link = net.ports.map((p) => named.get(portId(p.part, p.end))).find(Boolean);
    const boundary = net.fixed.length > 0 || net.keptTunnels.length > 0;
    const keep = net.labels.find((l) => model.options.keepTunnels.has(l));
    const isLocal = net.labels.some((l) => local.has(l));
    const fanout = net.terminals.length + net.fixed.length - 1;
    if (boundary) {
      net.kind = "tunnel";
      net.reason = "reaches a part that stays";
      net.label =
        (net.keptTunnels.map((t) => attr(t, "label")).find(Boolean) as string | undefined) ??
        link ??
        net.labels[0] ??
        null;
    } else if (link) {
      net.kind = "tunnel";
      net.reason = "named link";
      net.label = link;
    } else if (keep) {
      net.kind = "tunnel";
      net.reason = "kept";
      net.label = keep;
    } else if (net.terminals.length < 2) {
      net.kind = "fixed";
      continue;
    } else if (!isLocal && model.tunnelPage && net.labels.length) {
      net.kind = "tunnel";
      net.reason = "drawn with tunnels";
      net.label = net.labels[0];
    } else if (!isLocal && fanout >= GLOBAL_FANOUT) {
      net.kind = "tunnel";
      net.reason = "global";
      net.label = net.labels[0] ?? null;
    } else {
      net.kind = "wire";
    }
    if (net.kind === "tunnel" && !net.label) net.label = newLabel(model, net);
  }
}

// A new Tunnel label for a net: its Pin's label, its driver's label (with
// the port's name when the driver has several outputs), a consumer's
// label.port, else the factory's abbreviation and a number; unique.
export function newLabel(model: Model, net: Net): string {
  const ports = net.ports;
  const word = (p: Port) => {
    const m = PORT_WORD.exec(p.end.runtimeTooltip || "");
    return m ? m[1] : `p${p.end.index}`;
  };
  let base: string | null = null;
  for (const p of ports)
    if (LABELLED_IO.has(p.part.factoryName) && attr(p.part, "label")) {
      base = sanitizeLabel(attr(p.part, "label")!);
      break;
    }
  const outputs = ports.filter((p) => p.end.direction === "output");
  if (!base && outputs.some((p) => p.part.factoryName === "Clock")) base = "CLK";
  if (!base)
    for (const p of outputs) {
      const label = attr(p.part, "label");
      if (!label) continue;
      const n = p.part.ends.filter((e) => e.direction === "output").length;
      base = sanitizeLabel(n === 1 ? label : `${label}.${word(p)}`);
      break;
    }
  if (!base)
    for (const p of ports) {
      const label = attr(p.part, "label");
      if (label && p.end.direction === "input") {
        base = sanitizeLabel(`${label}.${word(p)}`);
        break;
      }
    }
  if (!base) {
    const p = (outputs.length ? outputs : ports)[0];
    const abbr =
      ABBREVIATIONS[p.part.factoryName] ||
      p.part.factoryName.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase() ||
      "NET";
    let n = 1;
    while (model.usedLabels.has(`${abbr}${n}`.toLowerCase())) n++;
    base = `${abbr}${n}`;
  }
  let label = base;
  for (let k = 2; model.usedLabels.has(label.toLowerCase()); k++) label = `${base}_${k}`;
  model.usedLabels.add(label.toLowerCase());
  return label;
}
