// How easy a drawing is to read, measured on the drawing as Logisim loads
// it: the native observation of a definition, or the observation an arranged
// file is predicted to load as. Every measure counts something a reader trips
// over in a Logisim schematic; `score` weighs them into one number, lower is
// clearer. Arranging uses it twice: to choose among candidate layouts, and to
// keep a layout only when it reads better than the drawing it replaces.
import type { Point } from "./py.mts";
import { attr, estimatedGeometry, loc, netKey } from "./schematic-layout.mts";
import type { Bounds, Component, Focus, Wire } from "./types.mts";
import { parseXml } from "./xml.mts";

export interface Readability {
  // parts other than Tunnels, and Tunnels
  components: number;
  tunnels: number;
  // wires as loaded, and their length without overlaps
  wireSegments: number;
  wireLength: number;
  // the box around bodies, labels and wires
  extent: { width: number; height: number };
  // a wire passing straight across another
  crossings: number;
  // a wire turning a corner, with nothing else at the corner
  bends: number;
  // two wires of different nets 10 px apart side by side for 10 px or more
  // (wires fed into neighbouring ports of one part excepted: the ports force it)
  closeParallels: number;
  // a wire across a body it does not connect to, or within 2 px of it
  wireOverBody: number;
  // a wire of another net within 10 px of a port, where the eye reads a junction
  portGrazes: number;
  // a wire through a label (a part's label, a Tunnel, free text)
  labelsOnWires: number;
  // bodies overlapping 10 px both ways (a Pin on a part)
  overlaps: number;
  // a label on a body or on another label by 3 px both ways
  labelOverlaps: number;
  // a Pin facing away from what it connects to: an east-facing Pin (port on
  // its east edge) with a part of its net to its west, and so on
  pinsOffSide: number;
  // the weighted sum (READABILITY_WEIGHTS, plus one per 200 px of wire)
  score: number;
}

export const READABILITY_WEIGHTS = {
  overlaps: 20,
  wireOverBody: 10,
  portGrazes: 6,
  labelsOnWires: 4,
  closeParallels: 4,
  pinsOffSide: 4,
  labelOverlaps: 3,
  crossings: 3,
  bends: 1,
} as const;
const WIRE_PER_POINT = 200;

type Metric = keyof typeof READABILITY_WEIGHTS;

// A maximal straight piece of copper: collinear wires that touch are one run.
interface Run {
  h: boolean;
  line: number;
  lo: number;
  hi: number;
  net: number;
}

const key = (x: number, y: number) => `${x},${y}`;

function runsOf(wires: readonly Wire[]): Run[] {
  const lines = new Map<string, [number, number][]>();
  for (const w of wires) {
    const { from: a, to: b } = w;
    let k: string;
    let span: [number, number];
    if (a.y === b.y && a.x !== b.x) {
      k = `h${a.y}`;
      span = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    } else if (a.x === b.x && a.y !== b.y) {
      k = `v${a.x}`;
      span = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    } else continue;
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k)!.push(span);
  }
  const runs: Run[] = [];
  for (const [k, spans] of [...lines].sort(([a], [b]) => (a < b ? -1 : 1))) {
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const h = k[0] === "h";
    const line = Number(k.slice(1));
    let [lo, hi] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      if (a <= hi) hi = Math.max(hi, b);
      else {
        runs.push({ h, line, lo, hi, net: -1 });
        [lo, hi] = [a, b];
      }
    }
    runs.push({ h, line, lo, hi, net: -1 });
  }
  return runs;
}

const contains = (r: Run, x: number, y: number) =>
  r.h
    ? y === r.line && r.lo <= x && x <= r.hi
    : x === r.line && r.lo <= y && y <= r.hi;
const ends = (r: Run): [Point, Point] =>
  r.h
    ? [
        [r.lo, r.line],
        [r.hi, r.line],
      ]
    : [
        [r.line, r.lo],
        [r.line, r.hi],
      ];

// Whether the run passes through the box (x0, y0)-(x1, y1) for some length.
function crossesBox(
  r: Run,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if (r.h)
    return (
      y0 <= r.line &&
      r.line <= y1 &&
      Math.min(r.hi, x1) - Math.max(r.lo, x0) > 0
    );
  return (
    x0 <= r.line && r.line <= x1 && Math.min(r.hi, y1) - Math.max(r.lo, y0) > 0
  );
}

// The boxes of a part's label: Tunnels and free text are all label; any
// other part's label is the part of its drawing outside its body.
function labelBoxes(c: Component): Bounds[] {
  if (c.factoryName === "Tunnel" || c.factoryName === "Text") return [c.bounds];
  const label = attr(c, "label");
  if (!label || !c.visualBounds) return [];
  const b = c.bounds;
  const v = c.visualBounds;
  const boxes: Bounds[] = [];
  if (v.y < b.y)
    boxes.push({ x: v.x, y: v.y, width: v.width, height: b.y - v.y });
  if (v.y + v.height > b.y + b.height)
    boxes.push({
      x: v.x,
      y: b.y + b.height,
      width: v.width,
      height: v.y + v.height - b.y - b.height,
    });
  if (v.x < b.x)
    boxes.push({ x: v.x, y: v.y, width: b.x - v.x, height: v.height });
  if (v.x + v.width > b.x + b.width)
    boxes.push({
      x: b.x + b.width,
      y: v.y,
      width: v.x + v.width - b.x - b.width,
      height: v.height,
    });
  return boxes.filter((box) => box.width > 0 && box.height > 0);
}

const overlap = (a: Bounds, b: Bounds): [number, number] => [
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
];

const isBody = (c: Component) =>
  c.factoryName !== "Tunnel" && c.factoryName !== "Text";

export function readability(focus: Focus): Readability {
  const parts = focus.components;
  const wires = focus.wires ?? [];
  const runs = runsOf(wires);
  const hLines = new Map<number, Run[]>();
  const vLines = new Map<number, Run[]>();
  for (const r of runs) {
    const lines = r.h ? hLines : vLines;
    if (!lines.has(r.line)) lines.set(r.line, []);
    lines.get(r.line)!.push(r);
  }
  const runsAt = (x: number, y: number): Run[] => [
    ...(hLines.get(y) ?? []).filter((r) => contains(r, x, y)),
    ...(vLines.get(x) ?? []).filter((r) => contains(r, x, y)),
  ];

  // nets: runs joined where one ends on another
  const parent = runs.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const index = new Map(runs.map((r, i) => [r, i]));
  const endAt = new Map<string, Run[]>();
  for (const r of runs)
    for (const [x, y] of ends(r)) {
      const k = key(x, y);
      if (!endAt.has(k)) endAt.set(k, []);
      endAt.get(k)!.push(r);
      for (const other of runsAt(x, y))
        parent[root(index.get(other)!)] = root(index.get(r)!);
    }
  for (const r of runs) r.net = root(index.get(r)!);

  // ports by point, and the parts whose ports a run ends on
  const portsAt = new Map<string, number[]>();
  parts.forEach((c, i) => {
    for (const e of c.ends) {
      const k = key(e.location.x, e.location.y);
      if (!portsAt.has(k)) portsAt.set(k, []);
      portsAt.get(k)!.push(i);
    }
  });
  const fedParts = new Map<Run, Set<number>>();
  for (const r of runs) {
    const fed = new Set<number>();
    for (const [x, y] of ends(r))
      for (const i of portsAt.get(key(x, y)) ?? []) fed.add(i);
    fedParts.set(r, fed);
  }

  let crossings = 0;
  const horizontal = runs.filter((r) => r.h);
  const vertical = runs.filter((r) => !r.h);
  for (const h of horizontal)
    for (const v of vertical)
      if (h.lo < v.line && v.line < h.hi && v.lo < h.line && h.line < v.hi)
        crossings += 1;

  let bends = 0;
  for (const [k, at] of endAt) {
    if (at.length !== 2 || at[0].h === at[1].h || portsAt.has(k)) continue;
    const [x, y] = k.split(",").map(Number);
    if (runsAt(x, y).length === 2) bends += 1;
  }

  let closeParallels = 0;
  for (const [lines, step] of [
    [hLines, 10],
    [vLines, 10],
  ] as const)
    for (const [line, here] of lines)
      for (const b of lines.get(line + step) ?? [])
        for (const a of here) {
          if (a.net === b.net) continue;
          if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) < 10) continue;
          const fa = fedParts.get(a)!;
          if ([...fedParts.get(b)!].some((i) => fa.has(i))) continue;
          closeParallels += 1;
        }

  let wireOverBody = 0;
  parts.forEach((c, i) => {
    if (!isBody(c)) return;
    const b = c.bounds;
    if (b.width <= 0 || b.height <= 0) return;
    for (const r of runs)
      if (
        !fedParts.get(r)!.has(i) &&
        crossesBox(r, b.x - 2, b.y - 2, b.x + b.width + 2, b.y + b.height + 2)
      )
        wireOverBody += 1;
  });

  let portGrazes = 0;
  parts.forEach((c, i) => {
    if (c.factoryName === "Tunnel") return;
    for (const e of c.ends) {
      const { x, y } = e.location;
      const own = new Set(runsAt(x, y).map((r) => r.net));
      const near = new Set<Run>();
      for (const d of [-10, 0, 10]) {
        for (const r of hLines.get(y + d) ?? [])
          if (r.lo <= x + 10 && r.hi >= x - 10) near.add(r);
        for (const r of vLines.get(x + d) ?? [])
          if (r.lo <= y + 10 && r.hi >= y - 10) near.add(r);
      }
      for (const r of near)
        if (!contains(r, x, y) && !own.has(r.net) && !fedParts.get(r)!.has(i))
          portGrazes += 1;
    }
  });

  let labelsOnWires = 0;
  const labels = parts.map(labelBoxes);
  labels.forEach((boxes, i) => {
    for (const b of boxes)
      for (const r of runs)
        if (
          !fedParts.get(r)!.has(i) &&
          crossesBox(r, b.x + 1, b.y + 1, b.x + b.width - 1, b.y + b.height - 1)
        )
          labelsOnWires += 1;
  });

  let overlaps = 0;
  let labelOverlaps = 0;
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      const [a, b] = [parts[i], parts[j]];
      if (isBody(a) && isBody(b)) {
        const [w, h] = overlap(a.bounds, b.bounds);
        if (w >= 10 && h >= 10) overlaps += 1;
      }
      // stacked Tunnels on one point are all read
      if (
        a.factoryName === "Tunnel" &&
        b.factoryName === "Tunnel" &&
        a.location.x === b.location.x &&
        a.location.y === b.location.y
      )
        continue;
      const touches = (boxes: Bounds[], others: Bounds[]) =>
        boxes.some((box) =>
          others.some((o) => {
            const [w, h] = overlap(box, o);
            return w >= 3 && h >= 3;
          }),
        );
      if (
        touches(labels[i], [...(isBody(b) ? [b.bounds] : []), ...labels[j]]) ||
        touches(labels[j], isBody(a) ? [a.bounds] : [])
      )
        labelOverlaps += 1;
    }

  // pins: each against the other ports of its net
  const portsOfNet = new Map<string, Point[]>();
  for (const c of parts) {
    if (c.factoryName === "Tunnel") continue;
    for (const e of c.ends) {
      if (!e.netBits?.length) continue;
      const k = netKey(e.netBits);
      if (!portsOfNet.has(k)) portsOfNet.set(k, []);
      portsOfNet.get(k)!.push([e.location.x, e.location.y]);
    }
  }
  let pinsOffSide = 0;
  for (const c of parts) {
    if (c.factoryName !== "Pin" || !c.ends[0]?.netBits?.length) continue;
    const { x, y } = c.ends[0].location;
    const facing = attr(c, "facing") ?? "east";
    const behind = (portsOfNet.get(netKey(c.ends[0].netBits)) ?? []).some(
      ([px, py]) =>
        facing === "west"
          ? px > x
          : facing === "south"
            ? py < y
            : facing === "north"
              ? py > y
              : px < x,
    );
    if (behind) pinsOffSide += 1;
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of parts)
    for (const b of [c.bounds, c.visualBounds ?? c.bounds]) {
      xs.push(b.x, b.x + b.width);
      ys.push(b.y, b.y + b.height);
    }
  for (const w of wires) {
    xs.push(w.from.x, w.to.x);
    ys.push(w.from.y, w.to.y);
  }
  const wireLength = runs.reduce((sum, r) => sum + r.hi - r.lo, 0);
  const measures: Record<Metric, number> = {
    overlaps,
    labelOverlaps,
    wireOverBody,
    labelsOnWires,
    portGrazes,
    closeParallels,
    pinsOffSide,
    crossings,
    bends,
  };
  let score = wireLength / WIRE_PER_POINT;
  for (const [k, w] of Object.entries(READABILITY_WEIGHTS))
    score += w * measures[k as Metric];
  return {
    components: parts.filter((c) => c.factoryName !== "Tunnel").length,
    tunnels: parts.filter((c) => c.factoryName === "Tunnel").length,
    wireSegments: wires.length,
    wireLength,
    extent: {
      width: xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
      height: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
    },
    ...measures,
    score: Math.round(score * 10) / 10,
  };
}

export interface ReadabilityComparison {
  // the second drawing scores lower (reads more easily) than the first
  clearer: boolean;
  // measures that grew, and that shrank
  worse: Metric[];
  better: Metric[];
}

export function compareReadability(
  before: Readability,
  after: Readability,
): ReadabilityComparison {
  const names = Object.keys(READABILITY_WEIGHTS) as Metric[];
  return {
    clearer: after.score < before.score,
    worse: names.filter((k) => after[k] > before[k]),
    better: names.filter((k) => after[k] < before[k]),
  };
}

// Chinese names of the measures, for messages to the user and the model.
export const READABILITY_NAMES: Record<Metric, string> = {
  overlaps: "元件重叠",
  labelOverlaps: "标签重叠",
  wireOverBody: "导线压过元件",
  labelsOnWires: "标签压线",
  portGrazes: "导线擦过端口",
  closeParallels: "平行导线过近",
  pinsOffSide: "引脚朝向反了",
  crossings: "交叉",
  bends: "拐弯",
};

// The observation an arranged file should load as: the parts the layout
// moved where it put them, the parts it wrote (Tunnels, Constants) estimated
// from their attributes, and its wires. For scoring a candidate before the
// host has seen it.
export function predictedFocus(
  xml: string,
  circuit: string,
  before: Focus,
  placement: ReadonlyMap<string, Point>,
): Focus {
  const element = parseXml(xml)
    .findall("circuit")
    .find((c) => c.get("name") === circuit);
  if (!element) return { ...before, components: [], wires: [] };
  const free = new Map<string, ReturnType<typeof element.findall>>();
  for (const el of element.findall("comp")) {
    const [x, y] = loc(el.get("loc"));
    const k = `${x},${y},${el.get("name")}`;
    if (!free.has(k)) free.set(k, []);
    free.get(k)!.push(el);
  }
  const components: Component[] = [];
  for (const c of before.components) {
    const [dx, dy] = placement.get(c.componentId) ?? [0, 0];
    const k = `${c.location.x + dx},${c.location.y + dy},${c.factoryName}`;
    if (!free.get(k)?.length) continue;
    free.get(k)!.shift();
    const move = <T extends { x: number; y: number }>(v: T): T => ({
      ...v,
      x: v.x + dx,
      y: v.y + dy,
    });
    components.push({
      ...c,
      location: move(c.location),
      bounds: move(c.bounds),
      ...(c.visualBounds ? { visualBounds: move(c.visualBounds) } : {}),
      ends: c.ends.map((e) => ({ ...e, location: move(e.location) })),
    });
  }
  let n = 0;
  for (const elements of free.values())
    for (const el of elements) {
      const [x, y] = loc(el.get("loc"));
      const [[box]] = estimatedGeometry(el, x, y);
      const bounds = {
        x: box[0],
        y: box[1],
        width: box[2] - box[0],
        height: box[3] - box[1],
      };
      components.push({
        componentId: `predicted-${n++}`,
        factoryName: el.get("name") ?? "",
        location: { x, y },
        bounds,
        visualBounds: bounds,
        attributes: el
          .findall("a")
          .map((a) => ({
            name: a.get("name") ?? "",
            value: a.get("val") ?? "",
          })),
        ends: [{ index: 0, location: { x, y }, direction: "inout" }],
      });
    }
  const wires: Wire[] = element.findall("wire").map((w) => {
    const [ax, ay] = loc(w.get("from"));
    const [bx, by] = loc(w.get("to"));
    return { from: { x: ax, y: ay }, to: { x: bx, y: by } };
  });
  return { ...before, components, wires, wireBundles: [] };
}
