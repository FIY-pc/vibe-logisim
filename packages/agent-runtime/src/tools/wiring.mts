/**
 * Orthogonal wire routing on the Logisim grid between observed ports.
 *
 * A route joins two nets: it may start anywhere on the first (its ports and
 * every point of its wires) and end anywhere on the second, so a fan-out
 * branches off the existing wire with a T instead of running back to the
 * port, and a net that already reaches the neighbourhood through a tunnel is
 * joined there. A* over 10 px steps with a cost per bend and per crossing.
 *
 * What Logisim would connect decides what a route may touch: it never passes
 * through a port or a wire end, never runs along another wire and never
 * bends on one (each would join that net); it crosses other wires only at a
 * right angle, where Logisim leaves both unconnected. A route meets a port
 * head-on, from outside its part. Component bodies (bounds, edges included)
 * are crossed only straight and at a high price: a wire over a body connects
 * nothing, but reads badly, so it happens only when a port is boxed in (a
 * tunnel sitting on it, a neighbour against it).
 */
import { CircuitToolError } from "./errors.mts";
import type {
  CircuitView,
  ObservedComponent,
  ObservedEnd,
} from "./observe.mts";

export interface Point {
  x: number;
  y: number;
}
export interface PortRef {
  c: ObservedComponent;
  end: ObservedEnd;
}

const GRID = 10;
const BEND = 4;
const CROSS = 3;
const BODY = 25;
const MARGIN = 200;
const EXPANSIONS = 600_000;

/** `w3`: a file wire's id. */
export function fileWireId(id: string): string {
  const match = /^w(\d+)$/.exec(id);
  if (!match)
    throw new CircuitToolError("INVALID_ARGUMENT", "无效的导线编号：" + id, {
      hint: "导线编号形如 w12，来自同一次 inspect_circuit 的 includeWires。",
    });
  return `w${Number(match[1])}`;
}

/** Every port of the definition keyed `componentId:portIndex`. */
export function portIndex(circuit: CircuitView): Map<string, PortRef> {
  const ports = new Map<string, PortRef>();
  for (const c of circuit.components)
    for (const end of c.ends)
      ports.set(`${c.componentId}:${end.index}`, { c, end });
  return ports;
}

/** The net an end belongs to, by its bit nets; null when the runtime left it unknown. */
export function netKey(bits: { bit: number; netId: string }[] | undefined) {
  if (!bits?.length || bits.some((b) => !b.netId)) return null;
  return [...bits]
    .sort((a, b) => a.bit - b.bit)
    .map((b) => b.netId)
    .join(" ");
}

// Grid points as integers: x and y in grid steps, offset to stay positive.
const OFFSET = 1 << 15;
const pack = (x: number, y: number) =>
  (x / GRID + OFFSET) * 65536 + (y / GRID + OFFSET);
const unpackX = (k: number) => (Math.floor(k / 65536) - OFFSET) * GRID;
const unpackY = (k: number) => ((k % 65536) - OFFSET) * GRID;
const onGrid = (p: Point) => p.x % GRID === 0 && p.y % GRID === 0;

// Directions: 0 east, 1 west, 2 south, 3 north; 4 = start, not moving yet.
const DX = [GRID, -GRID, 0, 0];
const DY = [0, 0, GRID, -GRID];
const START = 4;
const horizontal = (d: number) => d < 2;

/** What one grid point holds. */
interface Cell {
  /** Inside or on the edge of a component body. */
  body?: boolean;
  /** Group of a port, wire end or bend here: anything ending here joins it. */
  joint?: number;
  /** Groups of a horizontal / vertical wire passing through. */
  h?: number;
  v?: number;
  /** For a port on the edge of its body: the directions leading away from the body (bit per direction). */
  exits?: number;
}

/** The directions that leave `bounds` from a port on its edge; 0 when the port is not on an edge. */
function exitsOf(
  at: Point,
  b: { x: number; y: number; width: number; height: number } | undefined,
) {
  if (!b) return 0;
  const inX = at.x >= b.x && at.x <= b.x + b.width;
  const inY = at.y >= b.y && at.y <= b.y + b.height;
  let mask = 0;
  if (inY && at.x === b.x) mask |= 1 << 1;
  if (inY && at.x === b.x + b.width) mask |= 1 << 0;
  if (inX && at.y === b.y) mask |= 1 << 3;
  if (inX && at.y === b.y + b.height) mask |= 1 << 2;
  return mask;
}

/**
 * The routing grid of one definition. `commit` records a route as wire of
 * the joined net so later routes of the same call can branch off it.
 */
export class Router {
  private cells = new Map<number, Cell>();
  private parent: number[] = [];
  private members = new Map<number, number[]>();
  private keys = new Map<string, number>();
  private box: { minX: number; minY: number; maxX: number; maxY: number };

  constructor(circuit: CircuitView) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const extend = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    // A bundle and an end with the same bit nets are one net, wherever they are.
    const bundleGroup = new Map<string, number>();
    for (const bundle of circuit.bundles) {
      const key = (bundle.valid && netKey(bundle.bitNets)) || null;
      bundleGroup.set(
        bundle.bundleId,
        this.group(key ? "net:" + key : "bundle:" + bundle.bundleId),
      );
    }
    for (const wire of circuit.wires) {
      if (!onGrid(wire.from) || !onGrid(wire.to)) continue;
      const g =
        bundleGroup.get(wire.bundleId) ??
        this.group("bundle:" + (wire.bundleId ?? wire.wireId));
      this.paint([wire.from, wire.to], g);
      extend(wire.from.x, wire.from.y);
      extend(wire.to.x, wire.to.y);
    }
    for (const component of circuit.components) {
      const b = component.bounds;
      if (b) {
        extend(b.x, b.y);
        extend(b.x + b.width, b.y + b.height);
        for (
          let x = Math.ceil(b.x / GRID) * GRID;
          x <= b.x + b.width;
          x += GRID
        )
          for (
            let y = Math.ceil(b.y / GRID) * GRID;
            y <= b.y + b.height;
            y += GRID
          )
            this.cell(pack(x, y)).body = true;
      }
    }
    for (const component of circuit.components)
      for (const end of component.ends) {
        if (!onGrid(end.location)) continue;
        const k = pack(end.location.x, end.location.y);
        const c = this.cell(k);
        const key = netKey(end.netBits);
        let g = key ? this.group("net:" + key) : undefined;
        // An end the runtime could not resolve belongs with what touches it.
        g ??= c.joint ?? c.h ?? c.v ?? this.group(`point:${k}`);
        if (c.joint !== undefined) g = this.union(c.joint, g);
        else this.add(g, k);
        c.joint = this.find(g);
        // A wire meets a port head-on, never along its body's edge.
        const exits = exitsOf(end.location, component.bounds);
        if (exits) c.exits = (c.exits ?? 0) | exits;
        extend(end.location.x, end.location.y);
      }
    if (minX > maxX) minX = minY = maxX = maxY = 0;
    this.box = {
      minX: Math.floor((minX - MARGIN) / GRID) * GRID,
      minY: Math.floor((minY - MARGIN) / GRID) * GRID,
      maxX: Math.ceil((maxX + MARGIN) / GRID) * GRID,
      maxY: Math.ceil((maxY + MARGIN) / GRID) * GRID,
    };
  }

  private cell(k: number) {
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = {}));
    return c;
  }
  private group(key: string) {
    let g = this.keys.get(key);
    if (g === undefined) {
      g = this.parent.length;
      this.parent.push(g);
      this.keys.set(key, g);
    }
    return this.find(g);
  }
  private find(g: number): number {
    while (this.parent[g] !== g)
      g = this.parent[g] = this.parent[this.parent[g]];
    return g;
  }
  private add(g: number, k: number) {
    const root = this.find(g);
    const list = this.members.get(root);
    if (list) list.push(k);
    else this.members.set(root, [k]);
  }
  private union(a: number, b: number) {
    const ra = this.find(a),
      rb = this.find(b);
    if (ra === rb) return ra;
    this.parent[rb] = ra;
    const moved = this.members.get(rb) ?? [];
    this.members.delete(rb);
    for (const k of moved) this.add(ra, k);
    return ra;
  }
  /** Draws a polyline of group `g`: ends and bends are joints, the rest wire interior. */
  private paint(points: Point[], g: number) {
    for (let i = 1; i < points.length; i += 1) {
      const p = points[i - 1],
        q = points[i];
      const steps =
        Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) / GRID;
      const sx = Math.sign(q.x - p.x) * GRID,
        sy = Math.sign(q.y - p.y) * GRID;
      for (let j = 0; j <= steps; j += 1) {
        const k = pack(p.x + sx * j, p.y + sy * j);
        const c = this.cell(k);
        if (j === 0 || j === steps) {
          // An end on another wire's interior or end joins it (Logisim splits there).
          for (const other of [c.joint, c.h, c.v])
            if (other !== undefined) g = this.union(other, g);
          if (c.joint === undefined) this.add(g, k);
          c.joint = this.find(g);
        } else {
          if (sy === 0) c.h = g;
          else c.v = g;
          this.add(g, k);
        }
      }
    }
  }
  /** The group at a point a route may start or end on, or null. */
  private reachable(k: number, g: number) {
    const c = this.cells.get(k);
    if (!c) return false;
    if (c.joint !== undefined) return this.find(c.joint) === g;
    // A crossing of two nets cannot take an end without joining both.
    const h = c.h === undefined ? undefined : this.find(c.h);
    const v = c.v === undefined ? undefined : this.find(c.v);
    if (h !== undefined && v !== undefined) return false;
    return (h ?? v) === g;
  }
  private groupOf(end: ObservedEnd) {
    const c = this.cells.get(pack(end.location.x, end.location.y));
    return c?.joint === undefined ? null : this.find(c.joint);
  }

  /** Whether two ports are already on one net. */
  joined(from: PortRef, to: PortRef) {
    const a = this.groupOf(from.end);
    return a !== null && a === this.groupOf(to.end);
  }

  /**
   * The corner points of the cheapest route from `from`'s net to `to`'s,
   * [] when they are already one net, null when nothing fits.
   */
  route(from: PortRef, to: PortRef): Point[] | null {
    for (const end of [from.end, to.end])
      if (!onGrid(end.location))
        throw new CircuitToolError(
          "OFF_GRID_PORT",
          `端口 (${end.location.x},${end.location.y}) 不在 10 像素网格上，无法自动布线。`,
          { hint: "用 write_file 手工写这段导线，或把元件移到网格上。" },
        );
    const source = this.groupOf(from.end);
    const target = this.groupOf(to.end);
    if (source === null || target === null) return null;
    if (source === target) return [];
    const sources = (this.members.get(source) ?? []).filter((k) =>
      this.reachable(k, source),
    );
    const targets = new Set(
      (this.members.get(target) ?? []).filter((k) =>
        this.reachable(k, target),
      ),
    );
    let tx0 = Infinity,
      ty0 = Infinity,
      tx1 = -Infinity,
      ty1 = -Infinity;
    for (const k of targets) {
      const x = unpackX(k),
        y = unpackY(k);
      tx0 = Math.min(tx0, x);
      tx1 = Math.max(tx1, x);
      ty0 = Math.min(ty0, y);
      ty1 = Math.max(ty1, y);
    }
    const estimate = (x: number, y: number) =>
      (Math.max(tx0 - x, 0, x - tx1) + Math.max(ty0 - y, 0, y - ty1)) / GRID;
    const { minX, minY, maxX, maxY } = this.box;
    const cost = new Map<number, number>();
    const back = new Map<number, number>();
    const heap = new Heap();
    for (const k of sources) {
      cost.set(k * 5 + START, 0);
      heap.push(estimate(unpackX(k), unpackY(k)), k * 5 + START);
    }
    let found = -1;
    for (let expanded = 0; heap.size && expanded < EXPANSIONS; ) {
      const [priority, state] = heap.pop();
      const g = cost.get(state)!;
      const k = Math.floor(state / 5),
        d = state % 5;
      const x = unpackX(k),
        y = unpackY(k);
      if (priority > g + estimate(x, y) + 1e-9) continue;
      if (d !== START && targets.has(k)) {
        found = state;
        break;
      }
      expanded += 1;
      const here = this.cells.get(k);
      const across = here?.h !== undefined || here?.v !== undefined;
      const over = here?.body && here.joint === undefined;
      for (let nd = 0; nd < 4; nd += 1) {
        if (d !== START && (nd ^ 1) === d) continue;
        const turning = d !== START && nd !== d;
        // A bend is a wire end: never on another wire's interior, nor hidden on a body.
        if (turning && (across || over)) continue;
        // Leave a wire's interior only at a right angle to it, a port only away from its body.
        if (d === START && here) {
          if (here.joint === undefined) {
            if (here.h !== undefined && horizontal(nd)) continue;
            if (here.v !== undefined && !horizontal(nd)) continue;
          } else if (here.exits && !(here.exits & (1 << nd))) continue;
        }
        const nx = x + DX[nd],
          ny = y + DY[nd];
        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
        const nk = pack(nx, ny);
        const next = this.cells.get(nk);
        let step = 1 + (turning ? BEND : 0);
        if (targets.has(nk)) {
          // End on a wire's interior only at a right angle to it, on a port only towards its body.
          if (next && next.joint === undefined) {
            if (next.h !== undefined && horizontal(nd)) continue;
            if (next.v !== undefined && !horizontal(nd)) continue;
          } else if (next?.exits && !(next.exits & (1 << (nd ^ 1)))) continue;
        } else if (next) {
          if (next.joint !== undefined) continue;
          if (next.h !== undefined && horizontal(nd)) continue;
          if (next.v !== undefined && !horizontal(nd)) continue;
          if (next.h !== undefined || next.v !== undefined) step += CROSS;
          if (next.body) step += BODY;
        }
        const total = g + step;
        const nstate = nk * 5 + nd;
        if (total < (cost.get(nstate) ?? Infinity)) {
          cost.set(nstate, total);
          back.set(nstate, state);
          heap.push(total + estimate(nx, ny), nstate);
        }
      }
    }
    if (found < 0) return null;
    const path: Point[] = [];
    for (let s: number | undefined = found; s !== undefined; s = back.get(s)) {
      const k = Math.floor(s / 5);
      path.push({ x: unpackX(k), y: unpackY(k) });
    }
    return corners(path.reverse());
  }

  /** Records a route as wire of the net it joined, so later routes can use it. */
  commit(points: Point[]) {
    if (points.length < 2) return;
    const start = this.cells.get(pack(points[0].x, points[0].y));
    const g = start?.joint ?? start?.h ?? start?.v ?? this.group("route");
    this.paint(points, g);
  }
}

/** Collapses a step path to its corners (plus both ends). */
export function corners(nodes: Point[]): Point[] {
  if (nodes.length < 2) return nodes;
  const points = [nodes[0]];
  for (let i = 1; i < nodes.length - 1; i += 1) {
    const p = nodes[i - 1],
      c = nodes[i],
      n = nodes[i + 1];
    if (p.x === c.x !== (n.x === c.x)) points.push(c);
  }
  points.push(nodes[nodes.length - 1]);
  return points;
}

/** A binary min-heap of [priority, value]. */
class Heap {
  private items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(priority: number, value: number) {
    const items = this.items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop(): [number, number] {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < items.length && items[l][0] < items[m][0]) m = l;
        if (r < items.length && items[r][0] < items[m][0]) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}
