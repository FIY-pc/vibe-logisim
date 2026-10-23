/**
 * Orthogonal wire routing on the Logisim grid between two observed ports.
 * Breadth-first over 10 px steps, turns pushed to the back of the queue so a
 * path with fewer bends wins; component bodies (except Tunnels) and existing
 * wires block, the two end points never do. Returns the corner points of the
 * path (what `{"kind":"wire","points":…}` takes), [] when the ports touch,
 * null when nothing fits inside the circuit bounds plus a 200 px margin.
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
const key = (x: number, y: number) => `${x},${y}`;

/** `w3` as the host names loaded segments; ids past 512 are refused. */
export function fileWireId(id: string): string {
  const match = /^w(\d+)$/.exec(id);
  if (!match)
    throw new CircuitToolError("INVALID_ARGUMENT", "无效的导线编号：" + id);
  const index = Number(match[1]);
  if (index >= 512)
    throw new CircuitToolError("INVALID_ARGUMENT", "导线编号超出范围：" + id);
  return `w${index}`;
}

/** Every port of the definition keyed `componentId:portIndex`. */
export function portIndex(circuit: CircuitView): Map<string, PortRef> {
  const ports = new Map<string, PortRef>();
  for (const c of circuit.components)
    for (const end of c.ends)
      ports.set(`${c.componentId}:${end.index}`, { c, end });
  return ports;
}

export function route(
  circuit: CircuitView,
  from: PortRef,
  to: PortRef,
): Point[] | null {
  const start = { x: from.end.location.x, y: from.end.location.y };
  const goal = { x: to.end.location.x, y: to.end.location.y };
  if (start.x === goal.x && start.y === goal.y) return [];
  const blocked = new Set<string>();
  for (const component of circuit.components) {
    const b = component.bounds;
    if (!b || component.factory === "Tunnel") continue;
    for (let x = Math.ceil(b.x / GRID) * GRID; x < b.x + b.width; x += GRID)
      for (let y = Math.ceil(b.y / GRID) * GRID; y < b.y + b.height; y += GRID)
        blocked.add(key(x, y));
  }
  for (const wire of circuit.wires) {
    const steps =
      Math.max(
        Math.abs(wire.to.x - wire.from.x),
        Math.abs(wire.to.y - wire.from.y),
      ) / GRID;
    for (let i = 0; i <= steps; i += 1)
      blocked.add(
        key(
          wire.from.x + ((wire.to.x - wire.from.x) / steps) * i,
          wire.from.y + ((wire.to.y - wire.from.y) / steps) * i,
        ),
      );
  }
  blocked.delete(key(start.x, start.y));
  blocked.delete(key(goal.x, goal.y));
  const bounds = circuit.bounds ?? {
    x: Math.min(start.x, goal.x),
    y: Math.min(start.y, goal.y),
    width: Math.abs(goal.x - start.x),
    height: Math.abs(goal.y - start.y),
  };
  const minX = Math.floor((bounds.x - 200) / GRID) * GRID;
  const minY = Math.floor((bounds.y - 200) / GRID) * GRID;
  const maxX = Math.ceil((bounds.x + bounds.width + 200) / GRID) * GRID;
  const maxY = Math.ceil((bounds.y + bounds.height + 200) / GRID) * GRID;
  const inside = (x: number, y: number) =>
    x >= minX && x <= maxX && y >= minY && y <= maxY;
  type Node = { x: number; y: number; horizontal: boolean | null };
  const queue: { node: Node; path: Node[] }[] = [
    { node: { x: start.x, y: start.y, horizontal: null }, path: [] },
  ];
  const seen = new Set<string>([key(start.x, start.y) + ":n"]);
  for (let visited = 0; queue.length && visited < 60000; visited += 1) {
    const { node, path } = queue.shift()!;
    for (const [dx, dy] of [
      [GRID, 0],
      [-GRID, 0],
      [0, GRID],
      [0, -GRID],
    ]) {
      const x = node.x + dx;
      const y = node.y + dy;
      if (!inside(x, y)) continue;
      const horizontal = dx !== 0;
      const finish = x === goal.x && y === goal.y;
      if (!finish && blocked.has(key(x, y))) continue;
      const state = key(x, y) + (horizontal ? ":h" : ":v");
      if (seen.has(state)) continue;
      seen.add(state);
      const turned = node.horizontal !== null && node.horizontal !== horizontal;
      const next = [...path, { x, y, horizontal }];
      if (finish) return pointsOf(start, next);
      if (turned) queue.push({ node: { x, y, horizontal }, path: next });
      else queue.unshift({ node: { x, y, horizontal }, path: next });
    }
  }
  return null;
}

/** Collapses a step path to its corners (plus both ends). */
export function pointsOf(start: Point, path: Point[]): Point[] {
  const nodes = [{ x: start.x, y: start.y }, ...path];
  const points = [nodes[0]];
  for (let i = 1; i < nodes.length - 1; i += 1) {
    const p = nodes[i - 1];
    const c = nodes[i];
    const n = nodes[i + 1];
    if ((p.x === c.x) !== (n.x === c.x)) points.push(c);
  }
  const last = nodes[nodes.length - 1];
  if (
    last.x !== points[points.length - 1].x ||
    last.y !== points[points.length - 1].y
  )
    points.push(last);
  return points;
}
