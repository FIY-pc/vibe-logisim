// Short shared rails within one bank column, with atomic obstacle checks.
//
// This is a geometry preference for an already verified single-bit net. A rail
// that cannot fit keeps named endpoints; no partial rail or winding tree is
// added.
import { item, maxOf, minOf } from "./py.mts";
import type { KeyMap, Point } from "./py.mts";
import { Router, busKey, pk } from "./routing.mts";
import type {
  Box,
  NetKey,
  Port,
  SchematicLayout,
} from "./schematic-layout.mts";
import type { Component } from "./types.mts";

// The column a control tree runs in: its ports and the bank edges a rail may
// use (see grouped geometry).
export interface Corridor {
  left: number;
  right: number;
  [key: string]: unknown;
}

const ROLES = new Set(["clock", "clear", "preset", "enable", "chipSelect"]);

// Only native semantic evidence qualifies a net as control distribution.
//
// Fanout alone cannot tell a one-bit data lane from a clock or enable. Unknown
// custom-symbol ports keep their ordinary connections and representation.
export function repeatedControlNetworks(
  layout: SchematicLayout,
  assigned: { has(cid: string): boolean },
): Set<NetKey> {
  const result = new Set<NetKey>();
  for (const [key, ports] of layout.nets) {
    if (
      item(layout.bitsOf, key).length !== 1 ||
      item(layout.classes, key) === "constant"
    )
      continue;
    const kinds = new Map<string, number>();
    for (const [cid, idx] of ports) {
      if (!assigned.has(cid)) continue;
      const component = item(layout.byId, cid);
      const end = component.ends[idx];
      if (end.direction !== "input" || !ROLES.has(end.semanticRole as string))
        continue;
      const kind = JSON.stringify([component.factoryName, idx]);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    if (kinds.size && maxOf(kinds.values()) >= 3) result.add(key);
  }
  return result;
}

export function sharedRail(
  router: Router,
  moved: ReadonlyMap<string, Component>,
  ports: readonly Port[],
  portEdge: (c: Component, idx: number) => [Point, string, Point],
  leads: KeyMap<Port, number>,
  corridor: Corridor,
  labelBoxes: readonly (readonly [string, Box])[] = [],
): [Point, Point][] | null {
  const ends = ports.map(([cid, idx]) => item(moved, cid).ends[idx]);
  const points = ends.map((e): Point => [e.location.x, e.location.y]);
  if (points.some((p) => p[0] % 10 || p[1] % 10)) return null;
  const normals = ports.map(([cid, idx]) => portEdge(item(moved, cid), idx)[2]);
  if (new Set(normals.map((n) => `${n[0]},${n[1]}`)).size !== 1) return null;
  const bodies = ports.map(([cid]) => item(moved, cid).bounds);
  const owner = router.owner(ends[0].netBits ?? []);
  if (ends.some((e) => router.owner(e.netBits ?? []) !== owner)) return null;
  const left = corridor.left;
  const right = corridor.right;
  let offset = 0;
  points.forEach(
    (p, i) => (offset += p[0] - (bodies[i].x + bodies[i].width / 2)),
  );
  const preferLeft = offset < 0;
  const [sx, sy] = normals[0];
  const candidates: [Point, Point][][] = [];
  if (sx) {
    // A side-facing enable needs a straight comb on its own column, not a
    // tree that alternates between columns. Search inside the padded bank
    // edge, so existing clock/reset rails outside it remain undisturbed.
    const xs = points.map((p) => p[0]);
    const [start, stop] =
      sx < 0 ? [left + 10, minOf(xs) - 20] : [right - 10, maxOf(xs) + 20];
    const step = sx < 0 ? 10 : -10;
    for (
      let rail = start;
      step > 0 ? rail < stop + step : rail > stop + step;
      rail += step
    ) {
      const joins = points.map((p): Point => [rail, p[1]]);
      const ys = joins.map((j) => j[1]);
      candidates.push([
        [
          [rail, minOf(ys)],
          [rail, maxOf(ys)],
        ],
        ...points.map((p, i): [Point, Point] => [p, joins[i]]),
      ]);
    }
  } else {
    for (const gap of [0, 10, 20])
      for (const rail of preferLeft
        ? [left - gap, right + gap]
        : [right + gap, left - gap]) {
        const joins = points.map((p, i): Point => [
          rail,
          p[1] + sy * Math.max(2, (leads.get(ports[i]) ?? 1) + 1),
        ]);
        const ys = joins.map((j) => j[1]);
        const segments: [Point, Point][] = [
          [
            [rail, minOf(ys)],
            [rail, maxOf(ys)],
          ],
        ];
        points.forEach((p, i) => {
          const j = joins[i];
          segments.push([p, [p[0], j[1]]], [[p[0], j[1]], j]);
        });
        candidates.push(segments);
      }
  }
  const foreign = (q: Point): boolean => {
    const at = pk(q[0], q[1]);
    if (router.blocked.has(at)) return true;
    for (const o of router.owners(at)) if (o !== owner) return true;
    if (router.occupants(at).some((s) => s.owner !== owner)) return true;
    return (
      sx !== 0 &&
      labelBoxes.some(
        ([o, box]) =>
          o !== owner &&
          box[0] < q[0] &&
          q[0] < box[2] &&
          box[1] < q[1] &&
          q[1] < box[3],
      )
    );
  };
  for (const candidate of candidates) {
    const segments = candidate.filter(
      ([a, b]) => a[0] !== b[0] || a[1] !== b[1],
    );
    if (segments.some(([a, b]) => Router.grid(a, b).some(foreign))) continue;
    const bus = busKey((ends[0].netBits ?? []).map((b) => b.netId));
    for (const [a, b] of segments) router.add(a, b, owner, bus);
    for (const e of ends.slice(1))
      router.connected.join(bus, busKey((e.netBits ?? []).map((b) => b.netId)));
    return segments;
  }
  return null;
}
