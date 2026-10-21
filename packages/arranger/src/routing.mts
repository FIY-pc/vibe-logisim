// Grid Manhattan routing shared by the layout passes. Cross a foreign
// straight wire, never its vertex. Component interiors and foreign ports are
// obstacles; a finite cost prefers one grid cell of clearance and straight
// pin leads without closing narrow passages or moving fixed anchors. A route
// may branch anywhere on its own bus. Compressed polylines keep straight
// crossings from becoming junctions.
import { PyValueError, StopIteration, getOr } from "./py.mts";
import type { Point } from "./py.mts";
import type { End, Focus, NetBit, XY } from "./types.mts";

const OFFSET = 524288; // 2^19: coordinates stay within ±2^19
const SCALE = 1048576; // 2^20

// A point as one number that orders like the (x, y) tuple.
export function pk(x: number, y: number): number {
  return (x + OFFSET) * SCALE + (y + OFFSET);
}

export function pkX(key: number): number {
  return Math.floor(key / SCALE) - OFFSET;
}

export function pkY(key: number): number {
  return (key % SCALE) - OFFSET;
}

export function pointOf(key: number): Point {
  return [pkX(key), pkY(key)];
}

const STEPS: readonly (readonly [number, number, 0 | 1])[] = [
  [10, 0, 0],
  [-10, 0, 0],
  [0, 10, 1],
  [0, -10, 1],
];

function xy(value: XY): Point {
  return [value.x, value.y];
}

// Union-find over string identities; the first argument's root wins.
export class Partition {
  parents = new Map<string, string>();

  root(value: string): string {
    let parent = this.parents.get(value);
    if (parent === undefined) {
      this.parents.set(value, value);
      return value;
    }
    if (parent !== value) {
      parent = this.root(parent);
      this.parents.set(value, parent);
    }
    return parent;
  }

  join(a: string, b: string): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parents.set(rb, ra);
  }
}

// A tuple of net ids (a bus) as one Partition identity.
export function busKey(ids: readonly string[]): string {
  return JSON.stringify(ids);
}

export interface Occupant {
  owner: string;
  axis: 0 | 1;
  end: boolean;
}

export interface RouterOptions {
  crossingCost?: number;
  visitCap?: number;
  bendCost?: number;
}

export type Segment = [Point, Point];

const EMPTY_OCCUPANTS: readonly Occupant[] = [];
const EMPTY_OWNERS: ReadonlySet<string> = new Set();

export class Router {
  partition: Partition;
  visitCap: number;
  crossingCost: number;
  bendCost: number;
  connected = new Partition();
  segmentBuses: string[] = [];
  segments: [Point, Point, string][] = [];
  at = new Map<number, Occupant[]>();
  blocked = new Set<number>();
  // key: point key * 2 + axis
  clearanceCost = new Map<number, number>();
  portOwners = new Map<number, Set<string>>();
  allPoints: Point[] = [];
  extent: [number, number, number, number];

  constructor(
    focus: Pick<Focus, "components" | "wires" | "wireBundles">,
    partition: Partition,
    options: RouterOptions = {},
  ) {
    this.partition = partition;
    this.visitCap = options.visitCap ?? 200000;
    this.crossingCost = options.crossingCost ?? 24;
    this.bendCost = options.bendCost ?? 18;
    for (const c of focus.components) {
      const b = c.bounds;
      const body =
        c.factoryName !== "Text" &&
        c.factoryName !== "Tunnel" &&
        c.factoryName !== "Splitter";
      const escapeAxes = new Set<number>();
      if (body) {
        // The body interior is forbidden; end points on its boundary remain usable.
        for (
          let x = Math.floor(b.x / 10) * 10;
          x < b.x + b.width + 1;
          x += 10
        ) {
          for (
            let y = Math.floor(b.y / 10) * 10;
            y < b.y + b.height + 1;
            y += 10
          ) {
            if (b.x < x && x < b.x + b.width && b.y < y && y < b.y + b.height)
              this.blocked.add(pk(x, y));
          }
        }
      }
      for (const end of c.ends) {
        const p = xy(end.location);
        getOr(this.portOwners, pk(p[0], p[1]), () => new Set()).add(
          this.owner(end.netBits as NetBit[]),
        );
        this.allPoints.push(p);
        // A custom ALU symbol has diagonal edges: some real ports lie inside
        // its rectangular bounds. Open only the nearest escape ray.
        const preferred = end.direction === "output" ? 10 : -10;
        const distances: [number, number, number][] = [
          [Math.abs(p[0] - b.x), -10, 0],
          [Math.abs(p[0] - b.x - b.width), 10, 0],
          [Math.abs(p[1] - b.y), 0, -10],
          [Math.abs(p[1] - b.y - b.height), 0, 10],
        ];
        let best = distances[0];
        let bestRank = best[1] === preferred ? 0 : 1;
        for (const d of distances.slice(1)) {
          const rank = d[1] === preferred ? 0 : 1;
          if (d[0] < best[0] || (d[0] === best[0] && rank < bestRank)) {
            best = d;
            bestRank = rank;
          }
        }
        const dx = best[1];
        const dy = best[2];
        let q: Point = p;
        while (
          b.x <= q[0] &&
          q[0] <= b.x + b.width &&
          b.y <= q[1] &&
          q[1] <= b.y + b.height
        ) {
          this.blocked.delete(pk(q[0], q[1]));
          q = [q[0] + dx, q[1] + dy];
        }
        q = p;
        while (
          b.x - 10 < q[0] &&
          q[0] < b.x + b.width + 10 &&
          b.y - 10 < q[1] &&
          q[1] < b.y + b.height + 10
        ) {
          escapeAxes.add(pk(q[0], q[1]) * 2 + (dx ? 0 : 1));
          q = [q[0] + dx, q[1] + dy];
        }
      }
      if (body) {
        // Prefer a grid cell of air around bodies: a cost, not an obstacle,
        // so fixed junctions and narrow gaps stay routable. A port's outward
        // ray is free only along its axis.
        for (
          let x = Math.floor(b.x / 10) * 10;
          x < b.x + b.width + 10;
          x += 10
        ) {
          for (
            let y = Math.floor(b.y / 10) * 10;
            y < b.y + b.height + 10;
            y += 10
          ) {
            for (const axis of [0, 1]) {
              const key = pk(x, y) * 2 + axis;
              if (!escapeAxes.has(key)) this.clearanceCost.set(key, 40);
            }
          }
        }
      }
    }
    for (const p of this.portOwners.keys()) this.blocked.delete(p);
    const bundles = focus.wireBundles ?? [];
    const owners = new Map<string, string>();
    const firstBundle = new Map<string, (typeof bundles)[number]>();
    for (const b of bundles) {
      const bits = b.bitNets ?? [];
      owners.set(
        b.bundleId,
        bits.length
          ? this.owner(bits)
          : JSON.stringify(["floating", b.bundleId]),
      );
      if (!firstBundle.has(b.bundleId)) firstBundle.set(b.bundleId, b);
    }
    for (const wire of focus.wires ?? []) {
      const bundle = firstBundle.get(wire.bundleId as string);
      if (!bundle) throw new StopIteration();
      const ids = (bundle.bitNets ?? []).map((b) => b.netId);
      const bus = ids.length
        ? busKey(ids)
        : busKey(["floating", wire.bundleId as string]);
      this.add(
        xy(wire.from),
        xy(wire.to),
        owners.get(wire.bundleId as string) as string,
        bus,
      );
    }
    // Logisim coordinates may be negative (a panel drawn above the origin);
    // the search window must follow the circuit, not the origin.
    if (this.allPoints.length) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of this.allPoints) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      this.extent = [x0 - 100, y0 - 100, x1 + 240, y1 + 240];
    } else {
      this.extent = [0, 0, 6000, 6000];
    }
  }

  // The partition roots of a port's bits in bit order, as one identity.
  owner(bits: readonly NetBit[]): string {
    const sortedBits = [...bits].sort((a, b) => a.bit - b.bit);
    return JSON.stringify(sortedBits.map((b) => this.partition.root(b.netId)));
  }

  static grid(a: Point, b: Point): Point[] {
    const out: Point[] = [];
    if (a[0] === b[0]) {
      for (let y = Math.min(a[1], b[1]); y < Math.max(a[1], b[1]) + 1; y += 10)
        out.push([a[0], y]);
      return out;
    }
    if (a[1] === b[1]) {
      for (let x = Math.min(a[0], b[0]); x < Math.max(a[0], b[0]) + 1; x += 10)
        out.push([x, a[1]]);
      return out;
    }
    throw new PyValueError("仅支持正交导线");
  }

  occupants(key: number): readonly Occupant[] {
    return this.at.get(key) ?? EMPTY_OCCUPANTS;
  }

  owners(key: number): ReadonlySet<string> {
    return this.portOwners.get(key) ?? EMPTY_OWNERS;
  }

  add(a: Point, b: Point, owner: string, bus: string): void {
    if (a[0] === b[0] && a[1] === b[1]) return;
    const axis: 0 | 1 = a[1] === b[1] ? 0 : 1;
    this.segments.push([a, b, owner]);
    this.segmentBuses.push(bus);
    this.allPoints.push(a, b);
    for (const p of Router.grid(a, b)) {
      const end =
        (p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]);
      getOr(this.at, pk(p[0], p[1]), () => []).push({ owner, axis, end });
    }
  }

  private usableStart(key: number, owner: string): boolean {
    if (this.blocked.has(key)) return false;
    for (const s of this.occupants(key)) if (s.owner !== owner) return false;
    for (const own of this.owners(key)) if (own !== owner) return false;
    return true;
  }

  route(sourceEnd: End, targetEnd: End): Segment[] {
    const source = xy(sourceEnd.location);
    const target = xy(targetEnd.location);
    const sourceBits = sourceEnd.netBits as NetBit[];
    const targetBits = targetEnd.netBits as NetBit[];
    const owner = this.owner(sourceBits);
    const sourceBus = busKey(sourceBits.map((b) => b.netId));
    const targetBus = busKey(targetBits.map((b) => b.netId));
    if (this.connected.root(sourceBus) === this.connected.root(targetBus))
      return [];
    if (source.some((v) => v % 10) || target.some((v) => v % 10))
      throw new PyValueError("端口不在 10 单位布线网格上");
    // Start on any same-bus segment, reusing template stubs and previous fanout.
    const starts = new Set<number>([pk(source[0], source[1])]);
    const sourceRoot = this.connected.root(sourceBus);
    for (let i = 0; i < this.segments.length; i++) {
      if (this.connected.root(this.segmentBuses[i]) === sourceRoot) {
        const [a, b] = this.segments[i];
        for (const p of Router.grid(a, b)) starts.add(pk(p[0], p[1]));
      }
    }
    const usable = new Set<number>();
    for (const p of starts) if (this.usableStart(p, owner)) usable.add(p);
    if (usable.has(pk(target[0], target[1]))) return [];
    const result = this.path(usable, target, owner);
    for (const [a, b] of result) this.add(a, b, owner, sourceBus);
    this.connected.join(sourceBus, targetBus);
    return result;
  }

  // True when no route can arrive at target: walking backwards from it over
  // every step a route could take (every rule except the one that depends on
  // the direction a route came in) closes up within budget cells without
  // meeting a start. A walled-in port is found here in a few cells; A* would
  // flood the whole reachable sheet before giving up.
  boxedIn(
    target: Point,
    starts: ReadonlySet<number>,
    owner: string,
    budget = 64,
  ): boolean {
    const foreign = (key: number) =>
      this.occupants(key).filter((s) => s.owner !== owner);
    const targetKey = pk(target[0], target[1]);
    const seen = new Set<number>([targetKey]);
    const todo: Point[] = [target];
    const [ex0, ey0, ex1, ey1] = this.extent;
    while (todo.length) {
      const q = todo.pop() as Point;
      const qKey = pk(q[0], q[1]);
      const here = foreign(qKey);
      for (const [dx, dy, axis] of STEPS) {
        const p: Point = [q[0] - dx, q[1] - dy]; // a step p -> q along axis
        const key = pk(p[0], p[1]);
        if (
          seen.has(key) ||
          !(ex0 <= p[0] && p[0] <= ex1 && ey0 <= p[1] && p[1] <= ey1)
        )
          continue;
        if (this.blocked.has(key)) continue;
        let foreignOwner = false;
        for (const own of this.owners(key))
          if (own !== owner) {
            foreignOwner = true;
            break;
          }
        if (foreignOwner) continue;
        if (foreign(key).some((s) => s.axis === axis || s.end)) continue;
        if (
          here.length &&
          (qKey === targetKey || here.some((s) => s.axis === axis || s.end))
        )
          continue;
        if (starts.has(key) || seen.size >= budget) return false;
        seen.add(key);
        todo.push(p);
      }
    }
    return true;
  }

  // Propose geometry between explicit anchors; do not infer connectivity.
  path(
    startsIn: Iterable<number>,
    target: Point,
    owner: string,
    { avoidRetrace = false }: { avoidRetrace?: boolean } = {},
  ): Segment[] {
    // A route may cross unrelated copper, but cannot terminate on it. This is
    // impossible regardless of path length; avoid exhausting A* first.
    const targetKey = pk(target[0], target[1]);
    if (this.occupants(targetKey).some((s) => s.owner !== owner))
      throw new PyValueError(
        `目标端点 (${target[0]}, ${target[1]}) 已被其他信号的导线占用，请调整元件或导线位置`,
      );
    const starts = new Set<number>();
    for (const p of startsIn) if (this.usableStart(p, owner)) starts.add(p);
    if (starts.has(targetKey)) return [];
    if (this.boxedIn(target, starts, owner))
      throw new PyValueError(
        `无法在目标位置保持连线，请留出更多空间：(${target[0]}, ${target[1]})`,
      );
    const [tx, ty] = target;
    const bendCost = this.bendCost;
    const estimate = (x: number, y: number, axis: number) => {
      const dx = tx - x;
      const dy = ty - y;
      const straight = (dx === 0 && axis !== 0) || (dy === 0 && axis !== 1);
      return Math.abs(dx) + Math.abs(dy) + (straight ? 0 : bendCost);
    };
    const heap = new StateHeap();
    const cost = new Map<number, number>();
    const previous = new Map<number, number>();
    for (const p of [...starts].sort((a, b) => a - b)) {
      const state = p * 4; // incoming -1
      cost.set(state, 0);
      heap.push(estimate(pkX(p), pkY(p), -1), 0, state);
    }
    let end = -1;
    let visits = 0;
    const { blocked, portOwners, at, clearanceCost, crossingCost, visitCap } =
      this;
    const [x0, y0, x1, y1] = this.extent;
    while (heap.size) {
      const distance = heap.topG();
      const state = heap.pop();
      if (distance !== cost.get(state)) continue;
      const pKey = Math.floor(state / 4);
      const incoming = (state % 4) - 1;
      if (pKey === targetKey) {
        end = state;
        break;
      }
      visits++;
      if (visits > visitCap) break;
      const px = pkX(pKey);
      const py = pkY(pKey);
      let foreignHere: Occupant[] | null = null;
      for (const [dx, dy, axis] of STEPS) {
        const qx = px + dx;
        const qy = py + dy;
        if (!(x0 <= qx && qx <= x1 && y0 <= qy && qy <= y1)) continue;
        const qKey = pk(qx, qy);
        if (blocked.has(qKey)) continue;
        const owners = portOwners.get(qKey);
        if (owners) {
          let foreignOwner = false;
          for (const own of owners)
            if (own !== owner) {
              foreignOwner = true;
              break;
            }
          if (foreignOwner) continue;
        }
        // At a crossing continue straight; never end, bend, or overlap there.
        if (foreignHere === null)
          foreignHere = (at.get(pKey) ?? EMPTY_OCCUPANTS).filter(
            (s) => s.owner !== owner,
          );
        if (
          foreignHere.length &&
          (incoming !== axis ||
            foreignHere.some((s) => s.axis === axis || s.end))
        )
          continue;
        const atQ = at.get(qKey);
        let foreignNext = false;
        if (atQ) {
          let blocking = false;
          for (const s of atQ) {
            if (s.owner !== owner) {
              foreignNext = true;
              if (s.axis === axis || s.end) blocking = true;
            }
          }
          if (foreignNext && (qKey === targetKey || blocking)) continue;
        }
        const following = qKey * 4 + axis + 1;
        let newCost =
          distance +
          10 +
          (incoming !== -1 && incoming !== axis ? bendCost : 0) +
          (foreignNext ? crossingCost : 0);
        newCost += Math.max(
          clearanceCost.get(pKey * 2 + axis) ?? 0,
          clearanceCost.get(qKey * 2 + axis) ?? 0,
        );
        // A manually placed segment should end at its new bend, not become a
        // dangling stub when its connector doubles back.
        if (
          avoidRetrace &&
          atQ &&
          atQ.some((s) => s.owner === owner && s.axis === axis)
        )
          newCost += 30;
        const known = cost.get(following);
        if (known !== undefined && newCost >= known) continue;
        cost.set(following, newCost);
        previous.set(following, state);
        heap.push(newCost + estimate(qx, qy, axis), newCost, following);
      }
    }
    if (end < 0)
      throw new PyValueError(
        `无法在目标位置保持连线，请留出更多空间：(${target[0]}, ${target[1]})`,
      );
    const path: Point[] = [];
    let state = end;
    for (;;) {
      path.push(pointOf(Math.floor(state / 4)));
      const before = previous.get(state);
      if (before === undefined) break;
      state = before;
    }
    path.reverse();
    const corners: Point[] = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[i - 1];
      const b = path[i];
      const c = path[i + 1];
      if ((a[0] === b[0]) !== (b[0] === c[0])) corners.push(b);
    }
    corners.push(path[path.length - 1]);
    const result: Segment[] = [];
    for (let i = 0; i + 1 < corners.length; i++)
      result.push([corners[i], corners[i + 1]]);
    return result;
  }
}

// A binary min-heap of A* entries ordered like the (f, g, (p, incoming))
// tuples: f, then g, then the point, then the incoming axis. A state key
// (point key * 4 + incoming + 1) orders exactly like (p, incoming).
class StateHeap {
  private f: number[] = [];
  private g: number[] = [];
  private s: number[] = [];

  get size(): number {
    return this.s.length;
  }

  topG(): number {
    return this.g[0];
  }

  private less(i: number, j: number): boolean {
    const f = this.f;
    if (f[i] !== f[j]) return f[i] < f[j];
    const g = this.g;
    if (g[i] !== g[j]) return g[i] < g[j];
    return this.s[i] < this.s[j];
  }

  private swap(i: number, j: number): void {
    let t = this.f[i];
    this.f[i] = this.f[j];
    this.f[j] = t;
    t = this.g[i];
    this.g[i] = this.g[j];
    this.g[j] = t;
    t = this.s[i];
    this.s[i] = this.s[j];
    this.s[j] = t;
  }

  push(f: number, g: number, s: number): void {
    this.f.push(f);
    this.g.push(g);
    this.s.push(s);
    let i = this.s.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.s[0];
    const last = this.s.length - 1;
    this.swap(0, last);
    this.f.pop();
    this.g.pop();
    this.s.pop();
    let i = 0;
    const n = this.s.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}
