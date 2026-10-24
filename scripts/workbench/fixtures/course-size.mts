/**
 * A synthetic project the size of a course CPU, for latency work: about 1 MB,
 * 23 circuits, pages of 350–710 components, written the way Logisim 2.15
 * saves (every attribute on every component, custom subcircuit symbols). It is
 * built from generic cells — gates, multiplexers, splitters, registers,
 * adders, comparators, decoders, bit extenders, constants, probes, captions
 * and subcircuit instances — with every port wired to a labelled tunnel, the
 * way hand-drawn CPU pages are. Generation is deterministic and checks that no
 * wire touches another net and that no point joins four wire ends.
 *
 *   node scripts/workbench/fixtures/course-size.mts /tmp/course-size.circ [--source 2.7.1] [--seed 7]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Width = 1 | 3 | 8 | 32;
type Attributes = [string, string | number | boolean][];
interface Point {
  x: number;
  y: number;
}
interface Spec {
  name: string;
  /** Components to aim for on the page. */
  components: number;
  inputs: Width[];
  outputs: Width[];
  /** Subcircuits placed on the page, with instance counts. */
  uses?: [string, number][];
  /** Share of cells that are registers. */
  registers?: number;
}
export interface CourseSizeProject {
  xml: string;
  circuits: { name: string; components: number; wires: number }[];
}

const core: [string, number][] = [
  ["regfile", 1],
  ["alu", 1],
  ["imm", 1],
  ["branch", 1],
  ["control", 1],
  ["stage_if", 1],
  ["stage_id", 1],
  ["stage_ex", 1],
  ["stage_mem", 1],
  ["stage_wb", 1],
];
/** Leaves first: a circuit only uses circuits listed before it. */
const SPECS: Spec[] = [
  {
    name: "mux4x32",
    components: 30,
    inputs: [32, 32, 32, 32, 1, 1],
    outputs: [32],
  },
  {
    name: "decoder3",
    components: 25,
    inputs: [1, 1, 1],
    outputs: [1, 1, 1, 1, 1, 1, 1, 1],
  },
  { name: "adder32", components: 40, inputs: [32, 32, 1], outputs: [32, 1] },
  {
    name: "counter",
    components: 30,
    inputs: [1, 1],
    outputs: [32],
    registers: 0.3,
  },
  { name: "compare", components: 35, inputs: [32, 32], outputs: [1, 1, 1] },
  {
    name: "shifter",
    components: 60,
    inputs: [32, 8, 1, 1],
    outputs: [32],
    uses: [["mux4x32", 2]],
  },
  { name: "imm", components: 70, inputs: [32, 1, 1, 1], outputs: [32] },
  {
    name: "branch",
    components: 55,
    inputs: [32, 32, 1, 1, 1],
    outputs: [1, 32],
    uses: [
      ["adder32", 1],
      ["compare", 1],
    ],
  },
  {
    name: "forward",
    components: 60,
    inputs: [8, 8, 8, 1, 1],
    outputs: [1, 1, 1, 1],
  },
  {
    name: "hazard",
    components: 55,
    inputs: [8, 8, 8, 1, 1],
    outputs: [1, 1, 1],
  },
  {
    name: "stage_if",
    components: 35,
    inputs: [32, 32, 1, 1, 1],
    outputs: [32, 32],
    registers: 0.3,
  },
  {
    name: "stage_id",
    components: 60,
    inputs: [32, 32, 32, 8, 1, 1, 1],
    outputs: [32, 32, 32, 8],
    registers: 0.3,
  },
  {
    name: "stage_ex",
    components: 55,
    inputs: [32, 32, 8, 1, 1, 1],
    outputs: [32, 32, 8],
    registers: 0.3,
  },
  {
    name: "stage_mem",
    components: 45,
    inputs: [32, 32, 8, 1, 1],
    outputs: [32, 32, 8],
    registers: 0.3,
  },
  {
    name: "stage_wb",
    components: 35,
    inputs: [32, 8, 1, 1],
    outputs: [32, 8],
    registers: 0.3,
  },
  {
    name: "display",
    components: 100,
    inputs: [32, 32, 1],
    outputs: [8, 8],
    uses: [["counter", 1]],
  },
  {
    name: "alu",
    components: 130,
    inputs: [32, 32, 8, 1],
    outputs: [32, 1, 1],
    uses: [
      ["shifter", 1],
      ["adder32", 2],
      ["mux4x32", 2],
      ["compare", 1],
    ],
  },
  {
    name: "regfile",
    components: 100,
    inputs: [8, 8, 8, 32, 1, 1],
    outputs: [32, 32],
    uses: [
      ["decoder3", 1],
      ["mux4x32", 4],
    ],
    registers: 0.15,
  },
  {
    name: "control",
    components: 140,
    inputs: [32, 1, 1],
    outputs: [8, 8, 1, 1, 1, 1, 1, 1],
    uses: [
      ["decoder3", 2],
      ["counter", 1],
    ],
  },
  {
    name: "core_a",
    components: 520,
    inputs: [1, 1, 1, 1],
    outputs: [32, 32, 32],
    uses: [...core, ["adder32", 2], ["mux4x32", 3]],
  },
  {
    name: "core_b",
    components: 640,
    inputs: [1, 1, 1, 1],
    outputs: [32, 32, 32],
    uses: [...core, ["forward", 1], ["mux4x32", 4]],
  },
  {
    name: "core_c",
    components: 710,
    inputs: [1, 1, 1, 1],
    outputs: [32, 32, 32],
    uses: [
      ...core,
      ["forward", 1],
      ["hazard", 1],
      ["adder32", 2],
      ["mux4x32", 4],
    ],
  },
  {
    name: "main",
    components: 350,
    inputs: [],
    outputs: [],
    uses: [
      ["core_a", 1],
      ["display", 1],
      ["counter", 2],
    ],
  },
];

const FONT = "Dialog plain 12";
const PREFIX: Record<Width, string> = { 1: "c", 3: "s", 8: "b", 32: "d" };
const COLUMN = 320;
const labelled: Attributes = [
  ["label", ""],
  ["labelfont", FONT],
  ["labelcolor", "#000000"],
];

/** Deterministic generator (mulberry32). */
function generator(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const at = (x: number, y: number): Point => ({ x, y });

class Page {
  name: string;
  random: () => number;
  height: number;
  components: string[] = [];
  wires: [Point, Point, string][] = [];
  /** Every component port with its net (or a private name when unconnected). */
  ports: [Point, string][] = [];
  nets = new Map<Width, string[]>();
  inputPins: Point[] = [];
  outputPins: Point[] = [];
  serial = 0;
  column = 0;
  cursor = 0;
  constructor(name: string, random: () => number, components: number) {
    this.name = name;
    this.random = random;
    // Columns of cells, the page about 1.6 times as wide as tall.
    this.height = Math.max(
      600,
      Math.round((Math.sqrt((components * 15.5) / 200) * 200) / 10) * 10,
    );
  }
  /** The top-left corner of a free cell slot of this height. */
  slot(height: number): Point {
    if (this.cursor > 0 && this.cursor + height > this.height) {
      this.column++;
      this.cursor = 0;
    }
    const origin = at(100 + this.column * COLUMN, 100 + this.cursor);
    this.cursor += height;
    return origin;
  }
  choose<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)];
  }
  place(
    lib: string | undefined,
    name: string,
    where: Point,
    attributes: Attributes,
    ports: Point[] = [],
  ) {
    const library = lib === undefined ? "" : ` lib="${lib}"`;
    const body = attributes
      .map(([key, value]) => `      <a name="${key}" val="${value}"/>\n`)
      .join("");
    this.components.push(
      `    <comp${library} loc="(${where.x},${where.y})" name="${name}">\n${body}    </comp>\n`,
    );
    // Ports nothing connects to still must not touch a wire.
    for (const port of ports)
      this.ports.push([port, `free${this.ports.length}`]);
  }
  /** Marks a port as connected to `net`. */
  connect(port: Point, net: string) {
    this.ports.push([port, net]);
  }
  path(points: Point[], net: string) {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      if (a.x !== b.x || a.y !== b.y) this.wires.push([a, b, net]);
    }
  }
  /** A tunnel whose body sits left or right of its port. */
  tunnel(where: Point, net: string, width: Width, body: "left" | "right") {
    this.place("0", "Tunnel", where, [
      ["facing", body === "left" ? "east" : "west"],
      ["width", width],
      ["label", net],
      ["labelfont", FONT],
    ]);
    this.connect(where, net);
  }
  fresh(width: Width): string {
    const net = `${PREFIX[width]}${++this.serial}`;
    const known = this.nets.get(width) ?? [];
    this.nets.set(width, [...known, net]);
    return net;
  }
  /** A net of this width that something already drives, or a new constant. */
  pick(width: Width): string {
    const known = this.nets.get(width) ?? [];
    if (known.length && this.random() < 0.92) return this.choose(known);
    const origin = this.slot(30);
    const constant = at(origin.x + 170, origin.y + 20);
    const limit = width === 32 ? 0x10000 : 2 ** width;
    const value = "0x" + Math.floor(this.random() * limit).toString(16);
    this.place("0", "Constant", constant, [
      ["facing", "east"],
      ["width", width],
      ["value", value],
    ]);
    return this.drive(origin, [constant], [width])[0];
  }
  /**
   * Wires ports on one vertical line to tunnels at `tunnelX`, one per row.
   * Bends nest (the port nearest its row turns first), so paths never touch.
   */
  fan(ports: Point[], rows: number[], tunnelX: number, nets: string[]) {
    const side = Math.sign(tunnelX - ports[0].x);
    const order = ports
      .map((_, i) => i)
      .sort((a, b) => ports[a].y - ports[b].y);
    const above = order.filter((i) => rows[i] < ports[i].y);
    const below = order.filter((i) => rows[i] > ports[i].y).reverse();
    const bend = new Map<number, number>();
    above.forEach((i, rank) =>
      bend.set(i, ports[i].x + side * 10 * (rank + 1)),
    );
    below.forEach((i, rank) =>
      bend.set(i, ports[i].x + side * 10 * (rank + 1)),
    );
    ports.forEach((port, i) => {
      const x = bend.get(i);
      const route =
        x === undefined ? [port] : [port, at(x, port.y), at(x, rows[i])];
      const points = [...route, at(tunnelX, rows[i])];
      this.path(side < 0 ? points.reverse() : points, nets[i]);
    });
  }
  /** Reads existing nets into input ports from tunnels at the slot's left edge. */
  feed(
    origin: Point,
    ports: Point[],
    widths: Width[],
    rows = ports.map((p) => p.y),
  ) {
    const nets = widths.map((width) => this.pick(width));
    ports.forEach((port, i) => {
      this.tunnel(at(origin.x + 70, rows[i]), nets[i], widths[i], "left");
      this.connect(port, nets[i]);
    });
    this.fan(ports, rows, origin.x + 70, nets);
    return nets;
  }
  /** Reads a net into a port from below or above, turning once. */
  feedVertical(origin: Point, port: Point, width: Width, row: number) {
    const net = this.pick(width);
    this.tunnel(at(origin.x + 70, row), net, width, "left");
    this.connect(port, net);
    this.path([at(origin.x + 70, row), at(port.x, row), port], net);
    return net;
  }
  /** Drives new nets from output ports to tunnels at the slot's right edge. */
  drive(
    origin: Point,
    ports: Point[],
    widths: Width[],
    rows = ports.map((p) => p.y),
  ) {
    const nets = widths.map((width) => this.fresh(width));
    ports.forEach((port, i) => {
      this.tunnel(at(origin.x + 250, rows[i]), nets[i], widths[i], "right");
      this.connect(port, nets[i]);
    });
    this.fan(ports, rows, origin.x + 250, nets);
    return nets;
  }
  /** Fails when a wire touches another net or four wire ends meet. */
  check() {
    const horizontal = new Map<number, [number, number, string][]>();
    const vertical = new Map<number, [number, number, string][]>();
    const ends = new Map<string, number>();
    const points: [Point, string][] = [...this.ports];
    for (const [a, b, net] of this.wires) {
      if (a.x !== b.x && a.y !== b.y)
        throw new Error(`${this.name}: diagonal wire on ${net}`);
      if (a.y === b.y) {
        const list = horizontal.get(a.y) ?? [];
        list.push([Math.min(a.x, b.x), Math.max(a.x, b.x), net]);
        horizontal.set(a.y, list);
      } else {
        const list = vertical.get(a.x) ?? [];
        list.push([Math.min(a.y, b.y), Math.max(a.y, b.y), net]);
        vertical.set(a.x, list);
      }
      for (const end of [a, b]) {
        const key = `${end.x},${end.y}`;
        ends.set(key, (ends.get(key) ?? 0) + 1);
        points.push([end, net]);
      }
    }
    for (const [key, count] of ends)
      if (count >= 4)
        throw new Error(`${this.name}: four wire ends meet at (${key})`);
    const occupied = new Map<string, string>();
    for (const [point, net] of this.ports) {
      const key = `${point.x},${point.y}`;
      const other = occupied.get(key);
      if (other !== undefined && other !== net)
        throw new Error(
          `${this.name}: ports of ${other} and ${net} share (${key})`,
        );
      occupied.set(key, net);
    }
    for (const [point, net] of points) {
      for (const [from, to, other] of horizontal.get(point.y) ?? [])
        if (other !== net && from <= point.x && point.x <= to)
          throw new Error(
            `${this.name}: ${net} at (${point.x},${point.y}) touches ${other}`,
          );
      for (const [from, to, other] of vertical.get(point.x) ?? [])
        if (other !== net && from <= point.y && point.y <= to)
          throw new Error(
            `${this.name}: ${net} at (${point.x},${point.y}) touches ${other}`,
          );
    }
  }
}

/** A subcircuit's symbol: a box with inputs on the left and outputs on the right. */
interface Symbol {
  name: string;
  inputs: Width[];
  outputs: Width[];
}
const rowsOf = (symbol: Symbol) =>
  Math.max(symbol.inputs.length, symbol.outputs.length, 1);
function appearance(symbol: Symbol, page: Page) {
  const height = 20 * rowsOf(symbol) + 10;
  const ports = [
    ...page.inputPins.map(
      (pin, i) =>
        `      <circ-port height="8" pin="${pin.x},${pin.y}" width="8" x="46" y="${56 + 20 * i}"/>\n`,
    ),
    ...page.outputPins.map(
      (pin, i) =>
        `      <circ-port height="10" pin="${pin.x},${pin.y}" width="10" x="145" y="${55 + 20 * i}"/>\n`,
    ),
  ];
  return (
    "    <appear>\n" +
    `      <rect fill="none" height="${height}" stroke="#000000" stroke-width="2" width="100" x="50" y="50"/>\n` +
    `      <text font-family="SansSerif" font-size="12" text-anchor="middle" x="100" y="${50 + height / 2 + 5}">${symbol.name}</text>\n` +
    ports.join("") +
    '      <circ-anchor facing="east" height="6" width="6" x="47" y="47"/>\n' +
    "    </appear>\n"
  );
}

function gate(page: Page, origin: Point) {
  const r = page.random;
  const name = page.choose([
    "AND Gate",
    "AND Gate",
    "OR Gate",
    "NAND Gate",
    "NOR Gate",
    "XOR Gate",
  ]);
  const width: Width = r() < 0.75 ? 1 : 32;
  const inputs = name !== "XOR Gate" && r() < 0.2 ? 3 : 2;
  const reach = name === "XOR Gate" ? 60 : 50;
  const g = at(origin.x + 190, origin.y + 40);
  const ins = inputs === 2 ? [-20, 20] : [-20, 0, 20];
  const ports = ins.map((dy) => at(g.x - reach, g.y + dy));
  page.place("1", name, g, [
    ["facing", "east"],
    ["width", width],
    ["size", 50],
    ["inputs", inputs],
    ["out", "01"],
    ...labelled,
    ...(name === "XOR Gate" ? ([["xor", "odd"]] as Attributes) : []),
    ...ins.map((_, i): [string, boolean] => [`negate${i}`, false]),
  ]);
  page.feed(
    origin,
    ports,
    ports.map(() => width),
  );
  page.drive(origin, [g], [width]);
}

function inverter(page: Page, origin: Point) {
  const not = page.random() < 0.5;
  const width: Width = page.random() < 0.7 ? 1 : 32;
  const g = at(origin.x + 180, origin.y + 20);
  page.place("1", not ? "NOT Gate" : "Buffer", g, [
    ["facing", "east"],
    ["width", width],
    ...(not ? ([["size", 30]] as Attributes) : []),
    ["out", "01"],
    ...labelled,
  ]);
  page.feed(origin, [at(g.x - (not ? 30 : 20), g.y)], [width]);
  page.drive(origin, [g], [width]);
}

function multiplexer(page: Page, origin: Point) {
  const width: Width = page.choose([32, 32, 8, 1] as const);
  const m = at(origin.x + 190, origin.y + 30);
  page.place("2", "Multiplexer", m, [
    ["facing", "east"],
    ["selloc", "bl"],
    ["select", 1],
    ["width", width],
    ["disabled", "Z"],
    ["enable", false],
  ]);
  page.feed(
    origin,
    [at(m.x - 30, m.y - 10), at(m.x - 30, m.y + 10)],
    [width, width],
  );
  page.feedVertical(origin, at(m.x - 20, m.y + 20), 1, m.y + 30);
  page.drive(origin, [m], [width]);
}

function splitter(page: Page, origin: Point, join: boolean) {
  const bits = Array.from({ length: 32 }, (_, i): [string, number] => [
    `bit${i}`,
    Math.floor(i / 8),
  ]);
  const rows = [10, 30, 50, 70].map((dy) => origin.y + dy);
  const bytes: Width[] = [8, 8, 8, 8];
  if (join) {
    const s = at(origin.x + 190, origin.y + 20);
    page.place("0", "Splitter", s, [
      ["facing", "west"],
      ["fanout", 4],
      ["incoming", 32],
      ["appear", "left"],
      ...bits,
    ]);
    page.feed(
      origin,
      [0, 1, 2, 3].map((k) => at(s.x - 20, s.y + 10 + 10 * k)),
      bytes,
      rows,
    );
    page.drive(origin, [s], [32]);
  } else {
    const s = at(origin.x + 140, origin.y + 70);
    page.place("0", "Splitter", s, [
      ["facing", "east"],
      ["fanout", 4],
      ["incoming", 32],
      ["appear", "left"],
      ...bits,
    ]);
    page.feed(origin, [s], [32]);
    page.drive(
      origin,
      [0, 1, 2, 3].map((k) => at(s.x + 20, s.y - 40 + 10 * k)),
      bytes,
      rows,
    );
  }
}

function register(page: Page, origin: Point) {
  const g = at(origin.x + 190, origin.y + 30);
  // The 2.15 register has two more inputs, at (-30,-10) and (-10,-20).
  page.place(
    "4",
    "Register",
    g,
    [["width", 32], ["trigger", "rising"], ...labelled],
    [at(g.x - 10, g.y + 20), at(g.x - 30, g.y - 10), at(g.x - 10, g.y - 20)],
  );
  page.feed(
    origin,
    [at(g.x - 30, g.y), at(g.x - 30, g.y + 10)],
    [32, 1],
    [g.y, g.y + 30],
  );
  page.feedVertical(origin, at(g.x - 20, g.y + 20), 1, g.y + 50);
  page.drive(origin, [g], [32]);
}

function arithmetic(page: Page, origin: Point) {
  const g = at(origin.x + 190, origin.y + 30);
  const adder = page.random() < 0.55;
  page.place(
    "3",
    adder ? "Adder" : "Comparator",
    g,
    adder
      ? [["width", 32]]
      : [
          ["width", 32],
          ["mode", "twosComplement"],
        ],
    adder ? [at(g.x - 20, g.y - 20), at(g.x - 20, g.y + 20)] : [],
  );
  page.feed(origin, [at(g.x - 40, g.y - 10), at(g.x - 40, g.y + 10)], [32, 32]);
  if (adder) page.drive(origin, [g], [32]);
  else
    page.drive(
      origin,
      [at(g.x, g.y - 10), g, at(g.x, g.y + 10)],
      [1, 1, 1],
      [g.y - 20, g.y, g.y + 20],
    );
}

function extender(page: Page, origin: Point) {
  const g = at(origin.x + 190, origin.y + 20);
  page.place("0", "Bit Extender", g, [
    ["in_width", 8],
    ["out_width", 32],
    ["type", "zero"],
  ]);
  page.feed(origin, [at(g.x - 40, g.y)], [8]);
  page.drive(origin, [g], [32]);
}

function probe(page: Page, origin: Point) {
  const width: Width = page.choose([1, 1, 8, 32] as const);
  const p = at(origin.x + 140, origin.y + 20);
  page.place("0", "Probe", p, [
    ["facing", "west"],
    ["radix", width === 1 ? "2" : "16"],
    ["label", ""],
    ["labelloc", "north"],
    ["labelfont", FONT],
    ["labelcolor", "#000000"],
  ]);
  page.feed(origin, [p], [width]);
}

function decoder(page: Page, origin: Point) {
  const d = at(origin.x + 150, origin.y + 90);
  const outputs = Array.from({ length: 8 }, (_, k) =>
    at(d.x + 20, d.y - 80 + 10 * k),
  );
  page.place(
    "2",
    "Decoder",
    d,
    [
      ["facing", "east"],
      ["selloc", "bl"],
      ["select", 3],
      ["tristate", false],
      ["disabled", "Z"],
      ["enable", false],
    ],
    outputs.filter((_, k) => k % 2 === 1),
  );
  const constant = at(origin.x + 110, origin.y + 110);
  const select = page.fresh(3);
  page.place("0", "Constant", constant, [
    ["facing", "east"],
    ["width", 3],
    ["value", "0x" + Math.floor(page.random() * 8).toString(16)],
  ]);
  page.connect(constant, select);
  page.connect(d, select);
  page.path([constant, at(d.x, constant.y), d], select);
  const used = outputs.filter((_, k) => k % 2 === 0);
  page.drive(
    origin,
    used,
    used.map(() => 1),
  );
}

function caption(page: Page, origin: Point) {
  page.place("6", "Text", at(origin.x + 150, origin.y + 20), [
    ["text", `${page.name} part ${page.components.length}`],
    ["font", "SansSerif plain 12"],
    ["halign", "center"],
    ["valign", "base"],
  ]);
}

function instance(page: Page, symbol: Symbol) {
  const origin = page.slot(20 * rowsOf(symbol) + 30);
  const g = at(origin.x + 130, origin.y + 10);
  page.place(undefined, symbol.name, g, [
    ["facing", "east"],
    ["label", ""],
    ["labelloc", "north"],
    ["labelfont", FONT],
    ["labelcolor", "#000000"],
  ]);
  const inputs = symbol.inputs.map((_, i) => at(g.x, g.y + 10 + 20 * i));
  const outputs = symbol.outputs.map((_, i) =>
    at(g.x + 100, g.y + 10 + 20 * i),
  );
  if (inputs.length) page.feed(origin, inputs, symbol.inputs);
  if (outputs.length) page.drive(origin, outputs, symbol.outputs);
}

function pin(page: Page, width: Width, index: number, output: boolean) {
  const origin = page.slot(width === 32 ? 100 : 40);
  const p = at(origin.x + 150, origin.y + (width === 32 ? 50 : 20));
  page.place("0", "Pin", p, [
    ["facing", output ? "west" : "east"],
    ["output", output],
    ["width", width],
    ["tristate", false],
    ["pull", "none"],
    ["label", `${output ? "out" : "in"}${index}`],
    ["labelloc", "north"],
    ["labelfont", FONT],
    ["labelcolor", "#000000"],
  ]);
  if (output) {
    page.feed(origin, [p], [width]);
    page.outputPins.push(p);
  } else {
    page.drive(origin, [p], [width]);
    page.inputPins.push(p);
  }
}

const CELLS: [number, (page: Page, origin: Point) => void, number][] = [
  // weight, cell, slot height
  [22, gate, 80],
  [10, inverter, 40],
  [8, multiplexer, 80],
  [10, (page, origin) => splitter(page, origin, false), 90],
  [6, (page, origin) => splitter(page, origin, true), 90],
  [9, arithmetic, 70],
  [5, extender, 40],
  [11, probe, 40],
  [3, decoder, 130],
  [6, caption, 30],
];

function circuit(
  spec: Spec,
  symbols: Map<string, Symbol>,
  random: () => number,
) {
  const page = new Page(spec.name, random, spec.components);
  spec.inputs.forEach((width, i) => pin(page, width, i, false));
  const pending = (spec.uses ?? []).flatMap(([name, count]) =>
    Array.from({ length: count }, () => symbols.get(name)!),
  );
  const total = CELLS.reduce((sum, [weight]) => sum + weight, 0);
  const budget = spec.components - 2 * spec.outputs.length;
  while (page.components.length < budget) {
    const left = Math.max(1, (budget - page.components.length) / 4);
    if (pending.length && random() < pending.length / left) {
      instance(
        page,
        pending.splice(Math.floor(random() * pending.length), 1)[0],
      );
      continue;
    }
    if (random() < (spec.registers ?? 0.05)) {
      register(page, page.slot(100));
      continue;
    }
    let roll = random() * total;
    const [, cell, height] =
      CELLS.find(([weight]) => (roll -= weight) < 0) ?? CELLS[0];
    cell(page, page.slot(height));
  }
  for (const symbol of pending) instance(page, symbol);
  spec.outputs.forEach((width, i) => pin(page, width, i, true));
  page.check();
  const symbol: Symbol = {
    name: spec.name,
    inputs: spec.inputs,
    outputs: spec.outputs,
  };
  symbols.set(spec.name, symbol);
  const wires = page.wires.map(
    ([a, b]) => `    <wire from="(${a.x},${a.y})" to="(${b.x},${b.y})"/>\n`,
  );
  const xml =
    `  <circuit name="${spec.name}">\n` +
    `    <a name="circuit" val="${spec.name}"/>\n` +
    '    <a name="clabel" val=""/>\n' +
    '    <a name="clabelup" val="east"/>\n' +
    '    <a name="clabelfont" val="SansSerif plain 12"/>\n' +
    '    <a name="clabelcolor" val="#000000"/>\n' +
    (spec.name === "main" ? "" : appearance(symbol, page)) +
    wires.join("") +
    page.components.join("") +
    "  </circuit>\n";
  return {
    xml,
    stats: {
      name: spec.name,
      components: page.components.length,
      wires: page.wires.length,
    },
  };
}

export function courseSizeProject(
  options: { source?: string; seed?: number } = {},
): CourseSizeProject {
  const random = generator(options.seed ?? 7);
  const symbols = new Map<string, Symbol>();
  const circuits = SPECS.map((spec) => circuit(spec, symbols, random));
  const libraries = [
    "#Wiring",
    "#Gates",
    "#Plexers",
    "#Arithmetic",
    "#Memory",
    "#I/O",
    "#Base",
  ]
    .map((desc, i) => `  <lib desc="${desc}" name="${i}"/>\n`)
    .join("");
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    `<project source="${options.source ?? "2.15.0"}" version="1.0">\n` +
    "  This file is intended to be loaded by Logisim (http://www.cburch.com/logisim/).\n" +
    libraries +
    '  <main name="main"/>\n' +
    '  <options>\n    <a name="gateUndefined" val="ignore"/>\n    <a name="simlimit" val="1000"/>\n    <a name="simrand" val="0"/>\n  </options>\n' +
    '  <mappings>\n    <tool lib="6" map="Button2" name="Menu Tool"/>\n    <tool lib="6" map="Button3" name="Menu Tool"/>\n    <tool lib="6" map="Ctrl Button1" name="Menu Tool"/>\n  </mappings>\n' +
    '  <toolbar>\n    <tool lib="6" name="Poke Tool"/>\n    <tool lib="6" name="Edit Tool"/>\n    <tool lib="6" name="Text Tool"/>\n  </toolbar>\n' +
    circuits.map((c) => c.xml).join("") +
    "</project>\n";
  return { xml, circuits: circuits.map((c) => c.stats) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const source = option("--source");
  const seed = option("--seed");
  const out = args[0] ?? "course-size.circ";
  const project = courseSizeProject({
    source,
    seed: seed === undefined ? undefined : Number(seed),
  });
  writeFileSync(out, project.xml);
  const components = project.circuits.reduce((sum, c) => sum + c.components, 0);
  const wires = project.circuits.reduce((sum, c) => sum + c.wires, 0);
  console.log(
    `${out}: ${project.xml.length} bytes, ${project.circuits.length} circuits, ${components} components, ${wires} wires`,
  );
  for (const c of project.circuits)
    console.log(`  ${c.name}: ${c.components} components, ${c.wires} wires`);
}
