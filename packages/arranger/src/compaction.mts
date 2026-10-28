// Topology-preserving horizontal compaction of a routed schematic.
//
// A laid-out sheet is mostly air: columns are as wide as their widest part
// and channels as wide as the wires estimated to cross them, so most of any
// row is empty. This pass removes that air after routing without changing
// the drawing: parts, Tunnels, Constants and vertical wire runs only move
// left, horizontal wires stretch or shrink, and any two things whose height
// ranges overlap keep their left-to-right order and at least a grid step
// between them. A wire that crossed another still crosses it, one that did
// not still does not, no bend is added or removed, and no two nets can come
// to touch (they could only meet where they overlap in height, and there
// they stay apart). The pass works on geometry alone.
//
// Classic 1-D constraint-graph compaction: every object gets a shift; each
// object is constrained only by its nearest neighbour to the left at each
// height (found with a sweep over the objects in x order), and the smallest
// shifts that satisfy all constraints are found by relaxation. Objects that
// are attached to each other (a part and its ports, a vertical run and the
// port it leaves from, collinear runs that meet) move as one group, and so do
// the parts of a column: parts that share a left edge move by one shift,
// since a column pulled into a stagger reads worse than the air it saves.
import type { Point } from "./circuit.mts";

function getOr<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = make()));
  return value;
}

export const GRID = 10;

export type Box = readonly [number, number, number, number];

export interface CompactPart {
  boxes: readonly Box[];
  ports: readonly Point[];
  fixed?: boolean;
  cling?: boolean;
}

export type CompactWire = readonly [Point, Point, boolean];

// A point at x = xi of part i that must stay at least a grid step left of a
// point at xj of part j whatever their heights.
export type KeepOrder = readonly [
  readonly [number, number],
  readonly [number, number],
];

export interface CompactOptions {
  partGap?: number;
  // between anything else: wire runs, wire ends, bodies
  wireGap?: number;
  grid?: number;
  keepOrder?: Iterable<KeepOrder>;
  minWidth?: number;
  extentParts?: Iterable<number> | null;
  together?: Iterable<readonly number[]>;
}

type Kind = "box" | "point" | "run";
type Obj = readonly [
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  kind: Kind,
  node: string,
];

interface Constraint {
  ga: string;
  gb: string;
  slack: number;
}

const pointKey = (p: Point): string => `${p[0]},${p[1]}`;

// The smallest multiple of grid at or above value.
export function up(value: number, grid: number): number {
  return Math.ceil(value / grid) * grid + 0;
}

// The largest multiple of grid at or below value.
export function down(value: number, grid: number): number {
  return Math.floor(value / grid) * grid + 0;
}

// Returns [dx, newWires]: the shift of every component (a multiple of grid,
// never positive) and the wires with their endpoints moved. `together` lists
// parts that move by one shift; `minWidth` keeps the boxes of `extentParts`
// (all when null) at least that wide, blending the shifts back towards zero.
export function compactX(
  components: readonly CompactPart[],
  wires: readonly CompactWire[],
  options: CompactOptions = {},
): [number[], [Point, Point][]] {
  const partGap = options.partGap ?? 30;
  const grid = options.grid ?? GRID;
  const minWidth = options.minWidth ?? 0;
  const parent = new Map<string, string>();

  const find = (start: string): string => {
    if (!parent.has(start)) parent.set(start, start);
    let root = start;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let a = start;
    while (parent.get(a) !== root) {
      const next = parent.get(a) as string;
      parent.set(a, root);
      a = next;
    }
    return root;
  };

  const join = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const fixedNodes = new Set<string>();
  const portPart = new Map<string, number>();
  const portPoint = new Map<string, Point>();
  components.forEach((c, i) => {
    find("c" + i);
    if (c.fixed) fixedNodes.add("c" + i);
    for (const p of c.ports) {
      const key = pointKey(p);
      const owner = portPart.get(key);
      if (owner !== undefined) {
        join("c" + owner, "c" + i); // parts touching port to port
      } else {
        portPart.set(key, i);
        portPoint.set(key, p);
      }
    }
  });
  const vertical: number[] = [];
  const horizontal: number[] = [];
  wires.forEach(([a, b], k) => {
    if (a[0] === b[0] && a[1] !== b[1]) vertical.push(k);
    if (a[1] === b[1] && a[0] !== b[0]) horizontal.push(k);
  });
  const byX = new Map<number, [number, number, number][]>(); // x -> vertical runs
  for (const k of vertical) {
    const [a, b, fixed] = wires[k];
    find("w" + k);
    if (fixed) fixedNodes.add("w" + k);
    getOr(byX, a[0], () => []).push([
      Math.min(a[1], b[1]),
      Math.max(a[1], b[1]),
      k,
    ]);
  }
  for (const runs of byX.values()) {
    runs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    let end: number | null = null;
    let first = -1;
    for (const [y0, y1, k] of runs) {
      if (end !== null && y0 <= end) {
        join("w" + first, "w" + k); // collinear runs that meet are one track
        end = Math.max(end, y1);
      } else {
        end = y1;
        first = k;
      }
    }
  }

  const verticalAt = (p: Point): number | null => {
    for (const [y0, y1, k] of byX.get(p[0]) ?? [])
      if (y0 <= p[1] && p[1] <= y1) return k;
    return null;
  };

  for (const [key, i] of portPart) {
    const k = verticalAt(portPoint.get(key) as Point);
    if (k !== null) join("w" + k, "c" + i); // a run leaving a port moves with the part
  }
  const pointNode = new Map<string, string>();
  const nodePoint = new Map<string, Point>();
  for (const k of horizontal) {
    const [a, b, fixed] = wires[k];
    for (const p of [a, b]) {
      const key = pointKey(p);
      let node = pointNode.get(key);
      if (node === undefined) {
        const owner = portPart.get(key);
        if (owner !== undefined) {
          node = "c" + owner;
        } else {
          const v = verticalAt(p);
          node = v !== null ? "w" + v : "p" + key;
        }
      }
      find(node);
      pointNode.set(key, node);
      if (!nodePoint.has(key)) nodePoint.set(key, p);
      if (fixed) fixedNodes.add(node);
    }
  }

  for (const members of options.together ?? []) {
    for (const i of members.slice(1)) join("c" + members[0], "c" + i);
  }

  // A label or constant on a short lead stays on its port: it is read as part
  // of that port, and a lead stretched across the sheet reads as a wire.
  for (const k of horizontal) {
    const [a, b] = wires[k];
    const i = portPart.get(pointKey(a));
    const j = portPart.get(pointKey(b));
    if (
      Math.abs(a[0] - b[0]) <= 2 * grid &&
      i !== undefined &&
      j !== undefined
    ) {
      if (components[i].cling || components[j].cling) join("c" + i, "c" + j);
    }
  }

  const objects: Obj[] = [];
  components.forEach((c, i) => {
    for (const [x0, y0, x1, y1] of c.boxes)
      objects.push([x0, x1, y0, y1, "box", "c" + i]);
    for (const [x, y] of c.ports) objects.push([x, x, y, y, "point", "c" + i]);
  });
  for (const k of vertical) {
    const [a, b] = wires[k];
    objects.push([
      a[0],
      a[0],
      Math.min(a[1], b[1]),
      Math.max(a[1], b[1]),
      "run",
      "w" + k,
    ]);
  }
  for (const [key, node] of pointNode) {
    const p = nodePoint.get(key) as Point;
    objects.push([p[0], p[0], p[1], p[1], "point", node]);
  }
  if (!objects.length)
    return [
      components.map(() => 0),
      wires.map(([a, b]) => [a, b] as [Point, Point]),
    ];

  const ys = [...new Set(objects.flatMap((o) => [o[2], o[3]]))].sort(
    (a, b) => a - b,
  );
  const slotOf = new Map<number, number>();
  ys.forEach((y, i) => slotOf.set(y, 2 * i));
  const order = objects
    .map((_o, n) => n)
    .sort((m, n) => objects[m][0] - objects[n][0] || objects[m][1] - objects[n][1]);

  const sweep = (visit: (m: number, n: number) => void): void => {
    // per height slot: the object reaching furthest right
    const front: (number | null)[] = new Array(2 * ys.length).fill(null);
    for (const n of order) {
      const [, x1, y0, y1] = objects[n];
      const s0 = slotOf.get(y0) as number;
      const s1 = slotOf.get(y1) as number;
      const seen = new Set<number>();
      for (let s = s0; s <= s1; s++) {
        const m = front[s];
        if (m !== null && !seen.has(m)) {
          seen.add(m);
          visit(m, n);
        }
        if (m === null || objects[m][1] <= x1) front[s] = n;
      }
    }
  };

  // 1. Things that already overlap (a label box over a neighbour's edge, a
  //    run along a body) are held together rather than pulled apart.
  sweep((m, n) => {
    if (
      objects[m][1] >= objects[n][0] &&
      find(objects[m][5]) !== find(objects[n][5])
    )
      join(objects[m][5], objects[n][5]);
  });
  const group = new Map<string, string>();
  for (const o of objects) if (!group.has(o[5])) group.set(o[5], find(o[5]));
  const fixedGroups = new Set([...fixedNodes].map(find));

  // 2. Nearest left neighbour at every height -> constraint.
  const slackOf = new Map<string, Constraint>();
  const tighten = (ga: string, gb: string, slack: number): void => {
    const key = ga + "|" + gb;
    const known = slackOf.get(key);
    if (known === undefined) slackOf.set(key, { ga, gb, slack });
    else if (known.slack > slack) known.slack = slack;
  };
  sweep((m, n) => {
    const a = objects[m];
    const b = objects[n];
    const ga = group.get(a[5]) as string;
    const gb = group.get(b[5]) as string;
    if (ga === gb || a[1] >= b[0]) return;
    const gap = b[0] - a[1];
    const want = a[4] === "box" && b[4] === "box" ? partGap : options.wireGap ?? grid;
    tighten(ga, gb, gap - Math.min(want, gap));
  });
  for (const [[i, xi], [j, xj]] of options.keepOrder ?? []) {
    const ga = find("c" + i);
    const gb = find("c" + j);
    if (ga === gb || xj < xi) continue;
    tighten(ga, gb, xj - xi - Math.min(grid, xj - xi));
  }

  // 3. Width: everything as far left as the sheet's left edge and its left
  //    neighbours allow ...
  const groups = [...new Set(group.values())];
  let left = Infinity;
  let anyMovable = false;
  for (const o of objects) {
    if (fixedGroups.has(group.get(o[5]) as string)) continue;
    anyMovable = true;
    if (o[0] < left) left = o[0];
  }
  if (!anyMovable) left = 0;
  const lowest = new Map<string, number>();
  const highest = new Map<string, number>();
  for (const o of objects) {
    const g = group.get(o[5]) as string;
    lowest.set(g, Math.min(lowest.get(g) ?? Infinity, o[0]));
    highest.set(g, Math.max(highest.get(g) ?? -Infinity, o[1]));
  }
  const floor = new Map<string, number>();
  for (const g of groups)
    floor.set(
      g,
      fixedGroups.has(g) ? 0 : up(left - (lowest.get(g) as number), grid),
    );
  const preds = new Map<string, [string, number][]>();
  const succs = new Map<string, [string, number][]>();
  for (const { ga, gb, slack } of slackOf.values()) {
    getOr(preds, gb, () => []).push([ga, slack]);
    getOr(succs, ga, () => []).push([gb, slack]);
  }
  let shift = new Map(floor);
  const lowestOf = (g: string): number => {
    const value = lowest.get(g);
    if (value === undefined) throw new Error(`KeyError: ${g}`);
    return value;
  };
  const edges = [...slackOf.values()].sort((e, f) => lowestOf(e.gb) - lowestOf(f.gb));
  const shiftOf = (g: string): number => {
    const value = shift.get(g);
    if (value === undefined) throw new Error(`KeyError: ${g}`);
    return value;
  };
  for (let round = 0; round < groups.length + 1; round++) {
    let changed = false;
    for (const { ga, gb, slack } of edges) {
      if (fixedGroups.has(gb)) continue;
      const want = up(shiftOf(ga) - slack, grid);
      if (want > shiftOf(gb)) {
        shift.set(gb, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const [g, v] of shift) shift.set(g, Math.min(0, v));
  let width = 0;
  let anyWidth = false;
  for (const g of groups) {
    if (fixedGroups.has(g)) continue;
    const v = (highest.get(g) as number) + shiftOf(g);
    if (!anyWidth || v > width) width = v;
    anyWidth = true;
  }

  // 4. ... then, within that width, every group where its horizontal wires
  //    are shortest (coordinate descent from the leftmost placement: each
  //    move stays between what its neighbours allow, so every constraint
  //    keeps holding).
  const pulls = new Map<string, [number, string, number][]>(); // group -> [own x, other group, other x]
  for (const k of horizontal) {
    const [a, b] = wires[k];
    const ga = group.get(pointNode.get(pointKey(a)) as string) as string;
    const gb = group.get(pointNode.get(pointKey(b)) as string) as string;
    if (ga !== gb) {
      getOr(pulls, ga, () => []).push([a[0], gb, b[0]]);
      getOr(pulls, gb, () => []).push([b[0], ga, a[0]]);
    }
  }
  // Ties in the leftmost x keep the order groups were first met in; the
  // original iterated a hash set there.
  const ordered = groups
    .filter((g) => !fixedGroups.has(g) && (pulls.get(g) ?? []).length)
    .sort((g, h) => lowestOf(g) - lowestOf(h));
  const reversed = [...ordered].reverse();
  for (let pass = 0; pass < 24; pass++) {
    let changed = false;
    for (const g of pass % 2 === 0 ? ordered : reversed) {
      let lo = floor.get(g) as number;
      for (const [a, slack] of preds.get(g) ?? [])
        lo = Math.max(lo, shiftOf(a) - slack);
      let hi = Math.min(0, width - (highest.get(g) as number));
      for (const [b, slack] of succs.get(g) ?? [])
        hi = Math.min(hi, shiftOf(b) + slack);
      lo = up(lo, grid);
      hi = down(hi, grid);
      if (lo > hi) continue;
      const targets = (pulls.get(g) as [number, string, number][])
        .map(([x, og, ox]) => ox + shiftOf(og) - x)
        .sort((p, q) => p - q);
      let best = down(targets[Math.floor((targets.length - 1) / 2)], grid);
      best = Math.min(Math.max(best, lo), hi);
      if (best !== shiftOf(g)) {
        shift.set(g, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 5. Not denser than minWidth allows: blend back towards the drawing as
  //    routed, then lift anything the rounding put too far left.
  const parts =
    options.extentParts === undefined || options.extentParts === null
      ? components.map((_c, i) => i)
      : [...options.extentParts];
  const spans: [string, number, number][] = [];
  for (const i of parts)
    for (const [x0, , x1] of components[i].boxes)
      spans.push([group.get("c" + i) as string, x0, x1]);

  const extent = (sh: Map<string, number>): number => {
    if (!spans.length) return 0;
    let hiX = -Infinity;
    let loX = Infinity;
    for (const [g, x0, x1] of spans) {
      const s = sh.get(g) as number;
      if (x1 + s > hiX) hiX = x1 + s;
      if (x0 + s < loX) loX = x0 + s;
    }
    return hiX - loX;
  };

  if (minWidth && spans.length && extent(shift) < minWidth) {
    const full = new Map(shift);
    let loA = 0.0;
    let hiA = 1.0;
    for (let step = 0; step < 12; step++) {
      const mid = (loA + hiA) / 2;
      const trial = new Map<string, number>();
      for (const [g, v] of full) trial.set(g, up(mid * v, grid));
      if (extent(trial) >= minWidth) loA = mid;
      else hiA = mid;
    }
    shift = new Map();
    for (const [g, v] of full) shift.set(g, up(loA * v, grid));
    for (let round = 0; round < groups.length + 1; round++) {
      let changed = false;
      for (const { ga, gb, slack } of edges) {
        const want = up(shiftOf(ga) - slack, grid);
        if (!fixedGroups.has(gb) && want > shiftOf(gb)) {
          shift.set(gb, want);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  const dx = components.map((_c, i) => {
    const g = group.get("c" + i);
    return g === undefined ? 0 : shiftOf(g);
  });

  const moved = (p: Point, node: string): Point => {
    const fallback = find(node);
    return [p[0] + (shift.get(group.get(node) ?? fallback) ?? 0), p[1]];
  };

  const runs = new Set(vertical);
  const newWires: [Point, Point][] = [];
  wires.forEach(([a, b], k) => {
    const na = pointNode.get(pointKey(a));
    const nb = pointNode.get(pointKey(b));
    if (runs.has(k)) newWires.push([moved(a, "w" + k), moved(b, "w" + k)]);
    else if (na !== undefined && nb !== undefined)
      newWires.push([moved(a, na), moved(b, nb)]);
    else newWires.push([a, b]); // a zero-length stub: nothing to move it with
  });
  return [dx, newWires];
}
