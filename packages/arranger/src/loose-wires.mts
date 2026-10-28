// Preserve unfinished and cyclic copper independently of port-net
// equivalence. Native normalised segments: a crossing is not a connection
// unless it has an endpoint. Tunnel aliases must not join distant drawings.
import type { Focus, Wire, XY } from "./types.mts";

export interface WireIsland {
  wires: Wire[];
  points: Set<string>;
  ports: Map<string, [string, number]>;
  portPoints: Set<string>;
  loose: boolean;
}

const key = (v: XY) => `${v.x},${v.y}`;

export function wireIslands(focus: Focus): WireIsland[] {
  const wires = focus.wires ?? [];
  const parents = new Map<string, string>();
  const degree = new Map<string, number>();
  const root = (p: string): string => {
    if (!parents.has(p)) parents.set(p, p);
    let start = p;
    while (parents.get(p) !== p) p = parents.get(p) as string;
    while (parents.get(start) !== start) {
      const previous = parents.get(start) as string;
      parents.set(start, p);
      start = previous;
    }
    return p;
  };
  for (const wire of wires) {
    const a = key(wire.from);
    const b = key(wire.to);
    const rb = root(b);
    const ra = root(a);
    parents.set(ra, rb);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  const groups = new Map<string, WireIsland>();
  for (const wire of wires) {
    const a = key(wire.from);
    const b = key(wire.to);
    const r = root(a);
    let group = groups.get(r);
    if (!group) {
      group = {
        wires: [],
        points: new Set(),
        ports: new Map(),
        portPoints: new Set(),
        loose: false,
      };
      groups.set(r, group);
    }
    group.wires.push(wire);
    group.points.add(a);
    group.points.add(b);
  }
  for (const component of focus.components) {
    for (const end of component.ends) {
      const p = key(end.location);
      if (parents.has(p)) {
        const group = groups.get(root(p)) as WireIsland;
        group.ports.set(`${component.componentId}\u0000${end.index}`, [
          component.componentId,
          end.index,
        ]);
        group.portPoints.add(p);
      }
    }
  }
  for (const group of groups.values()) {
    group.loose =
      !group.ports.size ||
      group.wires.length >= group.points.size ||
      [...group.points].some(
        (p) => degree.get(p) === 1 && !group.portPoints.has(p),
      );
  }
  return [...groups.values()];
}

// The copper of unfinished or cyclic islands and the parts standing on it.
export function looseWireGeometry(focus: Focus): [Wire[], Set<string>] {
  const islands = wireIslands(focus).filter((group) => group.loose);
  const wires = islands.flatMap((group) => group.wires);
  const anchors = new Set<string>();
  for (const group of islands)
    for (const [cid] of group.ports.values()) anchors.add(cid);
  return [wires, anchors];
}

// A preserved doodle must not silently become connected to a placed part.
export function assertFloatingIsolation(before: Focus, after: Focus): void {
  const floating = wireIslands(before)
    .filter((group) => !group.ports.size)
    .flatMap((group) => group.wires);
  if (!floating.length) return;
  for (const group of wireIslands(after)) {
    if (!group.ports.size) continue;
    for (const wire of group.wires) {
      const a = [wire.from.x, wire.from.y];
      const b = [wire.to.x, wire.to.y];
      for (const old of floating) {
        const p = [old.from.x, old.from.y];
        const q = [old.to.x, old.to.y];
        // Positive collinear overlap; a plain perpendicular crossing does not
        // make the independently drawn wire conductive.
        let overlap = false;
        if (a[0] === b[0] && b[0] === p[0] && p[0] === q[0]) {
          overlap =
            Math.min(Math.max(a[1], b[1]), Math.max(p[1], q[1])) >
            Math.max(Math.min(a[1], b[1]), Math.min(p[1], q[1]));
        } else if (a[1] === b[1] && b[1] === p[1] && p[1] === q[1]) {
          overlap =
            Math.min(Math.max(a[0], b[0]), Math.max(p[0], q[0])) >
            Math.max(Math.min(a[0], b[0]), Math.min(p[0], q[0]));
        }
        if (overlap)
          throw new Error(
            "整理把独立导线接到了元件，请调整整理范围或固定相关元件",
          );
      }
    }
  }
}
