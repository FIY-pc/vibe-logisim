// What the engine reads from a .circ file and its observation: attribute
// values, locations, net identity, the geometry Logisim gives the parts the
// engine writes itself, a definition's interface as other circuits see it,
// and replacing one definition's text in the file.
import type { Bounds, Component, Focus, NetBit } from "./types.mts";
import { circuitSpan, serialize } from "./xml.mts";
import type { XmlElement } from "./xml.mts";

export type Point = readonly [number, number];
// [x0, y0, x1, y1]
export type Box = readonly [number, number, number, number];
export type Report = Record<string, any>;

export const GRID = 10;

// One-port drivers of a fixed value.
export const CONSTANT_SOURCES: readonly string[] = [
  "Constant",
  "Ground",
  "Power",
];

export const OPPOSITE: Readonly<Record<string, string>> = {
  east: "west",
  west: "east",
  north: "south",
  south: "north",
};

export const down = (v: number, grid = GRID): number =>
  Math.floor(v / grid) * grid + 0;
export const up = (v: number, grid = GRID): number =>
  Math.ceil(v / grid) * grid + 0;

export const boxOf = (b: Bounds): Box => [b.x, b.y, b.x + b.width, b.y + b.height];
export const boundsOf = (b: Box): Bounds => ({
  x: b[0],
  y: b[1],
  width: b[2] - b[0],
  height: b[3] - b[1],
});
export const union = (a: Box, b: Box): Box => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

// An attribute as observed: the value written in the file, else the default.
export function attr(component: Component, name: string): string | null {
  for (const a of component.attributes)
    if (a.name === name)
      return ((Object.prototype.hasOwnProperty.call(a, "value")
        ? a.value
        : a.standard) ?? null) as string | null;
  return null;
}

// An attribute of a <comp> element as written in the file.
export function attrOf(element: XmlElement, name: string): string | null {
  for (const a of element.findall("a"))
    if (a.get("name") === name) return a.get("val");
  return null;
}

// "(x,y)" -> [x, y]
export function loc(text: string | null): Point {
  const values = (text ?? "").match(/-?[0-9]+/g) ?? [];
  if (values.length !== 2) throw new Error(`not a location: ${text}`);
  return [Number(values[0]), Number(values[1])];
}

// Identity of a port's net: the ordered (bit, thread) vector. Two ports are
// the same net only if bit i is the same thread for every i; the same threads
// in another order (a splitter recombining fields) are another net.
export function netKey(bits: readonly NetBit[]): string {
  return JSON.stringify(
    [...bits].sort((a, b) => a.bit - b.bit).map((b) => [b.bit, b.netId]),
  );
}

// Rough width of a label in Logisim's default font (CJK about twice as wide).
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch.codePointAt(0)! > 0x2e80 ? 12 : 7;
  return width + 10;
}

// The box of a Tunnel standing on (x, y) facing `facing`: Logisim draws the
// flag on the side opposite its facing, about 24 px thick and as long as the
// label.
export function tunnelBox(
  x: number,
  y: number,
  facing: string,
  label: string,
): Box {
  const w = textWidth(label);
  if (facing === "east") return [x - w, y - 11, x, y + 12];
  if (facing === "west") return [x, y - 11, x + w, y + 12];
  const half = Math.ceil(w / 2);
  if (facing === "north") return [x - half, y, x + half, y + 25];
  return [x - half, y - 25, x + half, y];
}

// The box of free text: `font` as Logisim writes it ("SansSerif bold 16"),
// anchored at (x, y) on its baseline, left or centred.
export function textBox(
  x: number,
  y: number,
  text: string,
  font: string,
  halign: string,
): Box {
  const size = Number(font.match(/(\d+)\s*$/)?.[1] ?? 12);
  let width = 0;
  for (const ch of text)
    width += ch.codePointAt(0)! > 0x2e80 ? size * 1.04 : size * 0.62;
  width = Math.ceil(width) + 4;
  const x0 =
    halign === "left"
      ? x
      : halign === "right"
        ? x - width
        : x - Math.floor(width / 2);
  return [x0, y - size - 5, x0 + width, y + 8];
}

// Boxes and ports of a component written by the engine itself (a Tunnel,
// Constant, Ground, Power or Text has no observation yet): Logisim draws its
// body on the side opposite its facing, from the connection point.
export function estimatedGeometry(
  element: XmlElement,
  x: number,
  y: number,
): [Box[], Point[]] {
  const name = element.get("name");
  const facing = attrOf(element, "facing") || "east";
  if (name === "Tunnel")
    return [[tunnelBox(x, y, facing, attrOf(element, "label") || "")], [[x, y]]];
  if (name === "Text")
    return [
      [
        textBox(
          x,
          y,
          attrOf(element, "text") || "",
          attrOf(element, "font") || "SansSerif plain 12",
          attrOf(element, "halign") || "center",
        ),
      ],
      [],
    ];
  let w: number;
  let h: number;
  let toward = facing;
  if (name === "Constant") {
    const bits = Number(attrOf(element, "width") || 1);
    w = 16 + 10 * Math.max(0, Math.floor((bits + 3) / 4) - 2);
    h = 16;
  } else if (name === "Ground" || name === "Power") {
    // drawn on the side it faces (14-15 px deep, 16 across)
    w = 16;
    h = 16;
    toward = OPPOSITE[facing] ?? facing;
  } else {
    return [[[x - 10, y - 10, x + 10, y + 10]], [[x, y]]];
  }
  let box: Box;
  if (toward === "east")
    box = [x - w, y - Math.floor(h / 2), x, y + Math.floor(h / 2)];
  else if (toward === "west")
    box = [x, y - Math.floor(h / 2), x + w, y + Math.floor(h / 2)];
  else if (toward === "north")
    box = [x - Math.floor(w / 2), y, x + Math.floor(w / 2), y + h];
  else box = [x - Math.floor(w / 2), y - h, x + Math.floor(w / 2), y];
  return [[box], [[x, y]]];
}

// Give ports of unknown width the net of the copper they stand on.
//
// The observer reports a port's net bits per declared bit, so a port whose
// width is only settled at run time (a Probe) comes back with none and would
// look unconnected. Logisim gives it the bits of the bundle it touches, and
// so does this: the bundle through the port's point, else another port on the
// same point. Idempotent; returns the number of ends resolved.
export function resolveUnknownWidths(focus: Focus): number {
  const atPoint = new Map<string, NetBit[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (const bundle of focus.wireBundles ?? []) {
    const bits = (bundle.bitNets ?? []).filter((b) => b.netId);
    const valid = Object.prototype.hasOwnProperty.call(bundle, "valid")
      ? bundle.valid
      : true;
    if (bits.length && valid)
      for (const p of bundle.points ?? []) atPoint.set(key(p.x, p.y), bits);
  }
  for (const c of focus.components)
    for (const e of c.ends)
      if (e.netBits && e.netBits.length) {
        const k = key(e.location.x, e.location.y);
        if (!atPoint.has(k)) atPoint.set(k, e.netBits);
      }
  let resolved = 0;
  for (const c of focus.components)
    for (const e of c.ends) {
      if (
        (e.width === undefined || e.width === null) &&
        !(e.netBits && e.netBits.length)
      ) {
        const bits = atPoint.get(key(e.location.x, e.location.y));
        if (bits && bits.length) {
          e.netBits = bits.map((b) => ({ bit: b.bit, netId: b.netId }));
          e.width = Math.max(...bits.map((b) => b.bit)) + 1;
          resolved += 1;
        }
      }
    }
  return resolved;
}

// Logisim's default appearance puts the Pins of one facing on one edge of the
// instance, in the order of their y (x for north- and south-facing Pins).
export function pinOrderKey(facing: string | null): (p: Point) => Point {
  if (facing === "north" || facing === "south") return (p) => [p[0], p[1]];
  return (p) => [p[1], p[0]];
}

const facingOf = (element: XmlElement): string =>
  element.find("a[@name='facing']")?.get("val") ?? "east";

const compareJson = (a: unknown, b: unknown): number => {
  const [p, q] = [JSON.stringify(a), JSON.stringify(b)];
  return p < q ? -1 : p > q ? 1 : 0;
};

// What an instance of this definition looks like from outside, as far as
// moving its parts can change it; equal results (JSON) mean every circuit
// using it sees the same ports. `identify` maps a Pin location to a stable
// identity (the original location, for a re-laid-out definition).
//
// A custom appearance (<appear>) fixes every port on the instance and names
// its Pin by location. Without one, Logisim derives the instance from the
// Pins themselves: per facing, the Pins in order, so moving a Pin past
// another of the same facing swaps two ports in every circuit using this one.
export function interfaceSignature(
  circuit: XmlElement,
  identify: (p: Point) => unknown = (p) => p,
): unknown[] {
  const pins: [Point, string][] = circuit
    .findall("comp")
    .filter((e) => e.get("name") === "Pin")
    .map((e) => [loc(e.get("loc")), facingOf(e)]);
  const appear = circuit.find("appear");
  if (appear !== null) {
    const ports: unknown[] = [];
    for (const port of appear.iter("circ-port")) {
      const p = (port.get("pin") ?? "").split(",").map(Number);
      ports.push([
        port.get("x"),
        port.get("y"),
        p.length === 2 && p.every(Number.isInteger)
          ? identify([p[0], p[1]])
          : null,
      ]);
    }
    return [
      "custom",
      ports.sort(compareJson),
      pins.map(([p]) => identify(p)).sort(compareJson),
    ];
  }
  const groups = new Map<string, Point[]>();
  for (const [p, f] of pins) {
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f)!.push(p);
  }
  return [
    "default",
    [...groups]
      .map(([f, ps]) => {
        const order = pinOrderKey(f);
        const sortedPins = [...ps].sort((a, b) => {
          const [p, q] = [order(a), order(b)];
          return p[0] - q[0] || p[1] - q[1];
        });
        return [f, sortedPins.map((p) => identify(p))];
      })
      .sort(compareJson),
  ];
}

// Points the custom appearance's ports at the Pins that moved ("x,y" of the
// old location to the new one); returns how many it repointed.
export function repointPins(
  circuit: XmlElement,
  moved: ReadonlyMap<string, Point>,
): number {
  const appear = circuit.find("appear");
  if (appear === null) return 0;
  let repointed = 0;
  for (const port of appear.iter("circ-port")) {
    const target = moved.get((port.get("pin") ?? "").replace(/\s+/g, ""));
    if (target !== undefined) {
      port.set("pin", `${target[0]},${target[1]}`);
      repointed += 1;
    }
  }
  return repointed;
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
  if (span === null) throw new Error(`circuit "${name}" not found in the file`);
  if (source.slice(span[0], span[1]).includes("\r\n"))
    text = text.replaceAll("\n", "\r\n");
  return source.slice(0, span[0]) + text + source.slice(span[1]);
}
