// Copper on the 10 px grid, as Logisim will load it.
//
// A net's copper is a set of grid units ("h:x:y" runs (x,y)-(x+10,y), "v:x:y"
// runs (x,y)-(x,y+10)). Routes are unioned into it, reduced to a tree joining
// the net's ports, and cut into <wire> runs at every bend, junction and end:
// Logisim joins wires only at their ends, and its load-time repair merges two
// collinear ends that meet with nothing else there, so a '+' junction drawn as
// one straight wire with branches ending on it would become a crossing.
//
// `conflicts` holds a drawing against Logisim's connection rules: a wire that
// ends or bends on another net's copper joins it, a port on a wire joins it, a
// wire through a body hides it.
import { GRID } from "./circuit.mts";
import type { Box, Point } from "./circuit.mts";

export type Units = Set<string>;

export const pointKey = (x: number, y: number): string => `${x},${y}`;

export function addPolyline(units: Units, points: readonly Point[]): boolean {
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

export function unitEnds(unit: string): [string, string] {
  const [t, xs, ys] = unit.split(":");
  const x = Number(xs);
  const y = Number(ys);
  return [pointKey(x, y), t === "h" ? pointKey(x + GRID, y) : pointKey(x, y + GRID)];
}

// The net's copper reduced to a tree joining its terminals: loops broken
// breadth-first from the first terminal, stubs that lead nowhere removed.
// Null when the copper does not join every terminal.
export function netTree(units: Units, terminals: string[]): Units | null {
  if (terminals.length < 2) return new Set();
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
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
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

// Straight runs of copper, split at every bend, junction and end.
export function runsOf(units: Units, cuts: ReadonlySet<string> = new Set()): [Point, Point][] {
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
    if (cuts.has(p)) return false;
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

// Where each net's copper is, by point: the directions it leaves the point in.
export type CopperMap = Map<string, Map<number, Set<string>>>;

export function copperMap(nets: ReadonlyMap<number, Units>): CopperMap {
  const at: CopperMap = new Map();
  for (const [n, units] of nets)
    for (const u of units) {
      const [a, b] = unitEnds(u);
      const t = u[0];
      for (const [p, d] of [
        [a, t === "h" ? "E" : "S"],
        [b, t === "h" ? "W" : "N"],
      ]) {
        if (!at.has(p)) at.set(p, new Map());
        const here = at.get(p)!;
        if (!here.has(n)) here.set(n, new Set());
        here.get(n)!.add(d);
      }
    }
  return at;
}

export interface Obstacle {
  // a body wires may not cross (edges may be touched)
  box: Box;
  // the net whose own lead may pass (a port inside the body)
  leads?: Map<number, Units>;
}

export interface PortMark {
  point: Point;
  net: number | null;
}

// The nets whose copper breaks a connection rule: two nets meeting other
// than straight across each other, a port touched by another net, a wire
// through a body (other than a port's own lead). Of the nets at fault the one
// `movable` says can be drawn otherwise is blamed; kept copper (net -1) is
// never checked against bodies or its own ports.
export function conflicts(
  nets: ReadonlyMap<number, Units>,
  ports: readonly PortMark[],
  bodies: readonly Obstacle[],
  movable: (net: number) => boolean,
): Map<number, string> {
  const blamed = new Map<number, string>();
  const blame = (n: number, why: string) => {
    if (!blamed.has(n)) blamed.set(n, why);
  };
  const at = copperMap(nets);
  for (const [p, here] of at) {
    if (here.size < 2) continue;
    const entries = [...here.entries()];
    if (entries.length === 2) {
      const [d1, d2] = entries.map(([, d]) => [...d].sort().join(""));
      if ((d1 === "EW" && d2 === "NS") || (d1 === "NS" && d2 === "EW")) continue;
    }
    // the net that ends or bends here is the one to move, if it can be
    const turning = (n: number) => {
      const s = [...here.get(n)!].sort().join("");
      return s !== "EW" && s !== "NS";
    };
    const pick = entries
      .map(([n]) => n)
      .sort(
        (a, b) =>
          Number(movable(b)) - Number(movable(a)) ||
          Number(turning(b)) - Number(turning(a)) ||
          b - a,
      )[0];
    blame(pick, `nets meet at ${p}`);
  }
  for (const port of ports) {
    const here = at.get(pointKey(port.point[0], port.point[1]));
    if (!here) continue;
    for (const n of here.keys())
      if (n !== port.net && n >= 0)
        blame(
          movable(n) || port.net === null || !movable(port.net) ? n : port.net,
          `a wire touches the port at ${port.point}`,
        );
  }
  // bodies by 100 px cell
  const CELL = 100;
  const cells = new Map<string, Obstacle[]>();
  for (const body of bodies) {
    const [x0, y0, x1, y1] = body.box;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = `${cx},${cy}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k)!.push(body);
      }
  }
  for (const [n, units] of nets) {
    if (n < 0 || blamed.has(n)) continue;
    search: for (const u of units) {
      const [t, xs, ys] = u.split(":");
      const x = Number(xs);
      const y = Number(ys);
      const ex = t === "h" ? x + GRID : x;
      const ey = t === "h" ? y : y + GRID;
      const seen = new Set<Obstacle>();
      for (const [px, py] of [
        [x, y],
        [ex, ey],
      ]) {
        for (const body of cells.get(`${Math.floor(px / CELL)},${Math.floor(py / CELL)}`) ?? []) {
          if (seen.has(body)) continue;
          seen.add(body);
          if (body.leads?.get(n)?.has(u)) continue;
          const [x0, y0, x1, y1] = body.box;
          const through =
            t === "h"
              ? y > y0 && y < y1 && x + GRID > x0 && x < x1
              : x > x0 && x < x1 && y + GRID > y0 && y < y1;
          if (through) {
            blame(n, `a wire crosses a body at ${x},${y}`);
            break search;
          }
        }
      }
    }
  }
  return blamed;
}
