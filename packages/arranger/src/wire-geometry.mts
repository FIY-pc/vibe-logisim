// Orthogonal segment operations; intersections alone do not imply a net.
import type { Point } from "./py.mts";

export function onSegment(p: Point, a: Point, b: Point): boolean {
  return (
    (a[0] === b[0] &&
      b[0] === p[0] &&
      Math.min(a[1], b[1]) <= p[1] &&
      p[1] <= Math.max(a[1], b[1])) ||
    (a[1] === b[1] &&
      b[1] === p[1] &&
      Math.min(a[0], b[0]) <= p[0] &&
      p[0] <= Math.max(a[0], b[0]))
  );
}

export function subtractSegments(
  a: Point,
  b: Point,
  removed: Iterable<readonly [Point, Point]>,
): [Point, Point][] {
  let segments: [Point, Point][] = [[a, b]];
  for (const [p, q] of removed) {
    const remaining: [Point, Point][] = [];
    for (const [start, end] of segments) {
      const axis = start[0] === end[0] ? 1 : 0;
      const other = 1 - axis;
      const lo = Math.min(start[axis], end[axis]);
      const hi = Math.max(start[axis], end[axis]);
      const cutLo = Math.max(lo, Math.min(p[axis], q[axis]));
      const cutHi = Math.min(hi, Math.max(p[axis], q[axis]));
      if (
        start[other] !== p[other] ||
        p[other] !== q[other] ||
        cutLo >= cutHi
      ) {
        remaining.push([start, end]);
        continue;
      }
      const at = (value: number): Point =>
        axis === 0 ? [value, start[1]] : [start[0], value];
      if (lo < cutLo) remaining.push([at(lo), at(cutLo)]);
      if (cutHi < hi) remaining.push([at(cutHi), at(hi)]);
    }
    segments = remaining;
  }
  return segments;
}
