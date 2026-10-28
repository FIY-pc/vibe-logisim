// Physical fixed copper, independent of electrically merged Tunnel bundles.
import type { Point } from "./circuit.mts";
import type { Focus, Wire, XY } from "./types.mts";

function point(value: XY): Point {
  return [value.x, value.y];
}

// Original copper within the closed top-region boundary, including frames.
export function regionSegment(wire: Wire, belowY: number | null): Wire | null {
  if (belowY === null) return null;
  const a = point(wire.from);
  const b = point(wire.to);
  if (Math.min(a[1], b[1]) >= belowY) return null;
  if (Math.max(a[1], b[1]) <= belowY) return { ...wire };
  if (a[0] !== b[0]) throw new Error("固定区域边界遇到非正交导线");
  const low = b[1] < a[1] ? b : a;
  return {
    ...wire,
    from: { x: low[0], y: low[1] },
    to: { x: a[0], y: belowY },
  };
}

export interface FixedCut {
  point: Point;
  bundleId: string | undefined;
}

export function fixedCopper(
  focus: Focus,
  fixedIds: ReadonlySet<string>,
  belowY: number | null,
): [Wire[], FixedCut[]] {
  const wires = focus.wires ?? [];
  const parents = new Map<string, string>();
  const root = (p: string): string => {
    if (!parents.has(p)) parents.set(p, p);
    const parent = parents.get(p) as string;
    if (parent !== p) parents.set(p, root(parent));
    return parents.get(p) as string;
  };
  const key = (v: XY) => `${v.x},${v.y}`;
  for (const w of wires) {
    const rb = root(key(w.to));
    const ra = root(key(w.from));
    parents.set(ra, rb);
  }
  const fixed = new Set<string>();
  const moving = new Set<string>();
  for (const c of focus.components) {
    if (fixedIds.has(c.componentId)) {
      for (const e of c.ends) fixed.add(root(key(e.location)));
    } else if (c.factoryName !== "Tunnel") {
      for (const e of c.ends) moving.add(root(key(e.location)));
    }
  }
  const stable = new Set([...fixed].filter((r) => !moving.has(r)));
  const kept: Wire[] = [];
  const cuts: FixedCut[] = [];
  for (const w of wires) {
    const region = regionSegment(w, belowY);
    if (stable.has(root(key(w.from)))) {
      kept.push({ ...w });
    } else if (region) {
      kept.push(region);
      if (
        region.from.x !== w.from.x ||
        region.from.y !== w.from.y ||
        region.to.x !== w.to.x ||
        region.to.y !== w.to.y
      ) {
        const f = point(region.from);
        const t = point(region.to);
        cuts.push({ point: t[1] > f[1] ? t : f, bundleId: w.bundleId });
      }
    }
  }
  return [kept, cuts];
}
