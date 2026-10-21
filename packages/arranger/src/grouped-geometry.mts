// Geometry constraints shared by organized placement and its feedback.
//
// Native visualBounds include the runtime's own label font/position. Tunnel
// reservations are conservative estimates until native emission and readback.
import {
  PyKeyError,
  PyValueError,
  getOr,
  item,
  maxOf,
  minOf,
  pyRepr,
  sortBy,
  sorted,
  sortInPlace,
  sum,
} from "./py.mts";
import type { Point } from "./py.mts";
import {
  attr,
  chainOffsets,
  labelBox,
  pinOrderKey,
  portMap,
  snap,
  textWidth,
} from "./schematic-layout.mts";
import type {
  Box,
  NetKey,
  Port,
  Report,
  SchematicLayout,
} from "./schematic-layout.mts";
import type { Bounds, Component } from "./types.mts";

function visualOf(c: Component): Bounds {
  return Object.prototype.hasOwnProperty.call(c, "visualBounds")
    ? (c.visualBounds as Bounds)
    : c.bounds;
}

// Padding (left, top, right, bottom) around a part's native bounds: its own
// visual extent, plus room for the Tunnel flags of named connections that
// leave its group (or that feedback found colliding).
export function paddingFor(
  layout: SchematicLayout,
  cid: string,
  assigned: ReadonlyMap<string, string>,
): [number, number, number, number] {
  const c = item(layout.byId, cid);
  const b = c.bounds;
  const v = visualOf(c);
  let left = Math.max(20, b.x - v.x + 10);
  let right = Math.max(20, v.x + v.width - b.x - b.width + 10);
  let top = Math.max(30, b.y - v.y + 20);
  let bottom = Math.max(30, v.y + v.height - b.y - b.height + 20);
  const ports = portMap<NetKey>();
  for (const [key, ps] of layout.nets) for (const p of ps) ports.set(p, key);
  const vertical = new Map<string, number[]>();
  for (const e of c.ends) {
    const key = ports.get([cid, e.index]);
    if (key === undefined) continue;
    const labels = layout.labelsOfNet.get(key) ?? new Set<string>();
    // Local named roots are added to the reservation if feedback finds a
    // collision. This avoids expanding every already-readable small motif.
    if (!labels.size) continue;
    const own = item(assigned, cid);
    const remote = item(layout.nets, key).some(
      (p) =>
        !layout.tunnels.has(p[0]) &&
        !layout.constants.has(p[0]) &&
        assigned.get(p[0]) !== own,
    );
    if (!remote && item(layout.classes, key) !== "global") {
      if (!layout.labelPaddingPorts?.has([cid, e.index])) continue;
    }
    const [, facing] = layout.portEdge(c, e.index);
    const reach = maxOf([...labels].map(textWidth)) + 20;
    if (facing === "east") left = Math.max(left, reach);
    else if (facing === "west") right = Math.max(right, reach);
    else getOr(vertical, facing, () => []).push(reach);
  }
  for (const [facing, widths] of vertical) {
    const depth = 20 + 20 * Math.ceil(widths.length / 2);
    if (facing === "south") top = Math.max(top, depth);
    else bottom = Math.max(bottom, depth);
    left = Math.max(left, maxOf(widths));
    right = Math.max(right, maxOf(widths));
  }
  return [snap(left + 5), snap(top + 5), snap(right + 5), snap(bottom + 5)];
}

// Keep valid local placements. Repair reordered default Pins on a rail.
//
// Facing and native position order define a default subcircuit interface.
// A custom appearance binds identity independently. Explicit fixed Pins and
// contact assemblies are anchors, never silently separated or moved here.
export function preserveInterfaceOrder(layout: SchematicLayout): void {
  if (layout.circuit.find("appear") !== null) return;
  const faces = new Map<string, string[]>();
  for (const c of layout.components)
    if (c.factoryName === "Pin")
      getOr(faces, attr(c, "facing") || "east", () => []).push(c.componentId);
  const boxes = layout.components
    .filter(
      (c) => layout.bodyIds.has(c.componentId) && c.factoryName !== "Tunnel",
    )
    .map((c) => visualOf(layout.movedComponent(c)));
  if (!boxes.length) return;
  const left = minOf(boxes.map((b) => b.x));
  const top = minOf(boxes.map((b) => b.y));
  const right = maxOf(boxes.map((b) => b.x + b.width));
  const bottom = maxOf(boxes.map((b) => b.y + b.height));
  const repairs: Report[] = [];
  const fusedHosts = new Set(layout.fused.values());
  for (const [facing, ids] of faces) {
    const orderKey = pinOrderKey(facing);
    const point = (cid: string, placed = false): Point => {
      const c = item(layout.byId, cid);
      const [dx, dy] = placed ? (layout.placement.get(cid) ?? [0, 0]) : [0, 0];
      return [c.location.x + dx, c.location.y + dy];
    };
    sortInPlace(ids, (cid) => orderKey(point(cid)));
    const inOrder = (): boolean => {
      const placed = sortBy(ids, (cid) => orderKey(point(cid, true)));
      return placed.every((cid, i) => cid === ids[i]);
    };
    if (inOrder()) continue;
    const movable = new Set(
      ids.filter(
        (cid) =>
          layout.bodyIds.has(cid) &&
          !layout.fused.has(cid) &&
          !fusedHosts.has(cid) &&
          !layout.isPanel(item(layout.byId, cid)),
      ),
    );
    const axis = facing === "east" || facing === "west" ? 1 : 0;
    const sizes = new Map<string, number>();
    for (const cid of ids) {
      const v = visualOf(item(layout.byId, cid));
      sizes.set(cid, axis ? v.height : v.width);
    }
    // Solve ordered intervals between immutable anchors. No changing the
    // author's absolute fixed positions to make the constraint convenient.
    const positions = new Map<string, number>();
    let index = 0;
    while (index < ids.length) {
      if (!movable.has(ids[index])) {
        positions.set(ids[index], point(ids[index], true)[axis]);
        index += 1;
        continue;
      }
      let end = index;
      while (end < ids.length && movable.has(ids[end])) end += 1;
      const run = ids.slice(index, end);
      const size = (cid: string): number => item(sizes, cid);
      const gaps = run
        .slice(1)
        .map((b, i) => Math.max(60, snap((size(run[i]) + size(b)) / 2 + 30)));
      const lo = index
        ? item(positions, ids[index - 1]) +
          Math.max(60, size(ids[index - 1]) + size(run[0]))
        : -Infinity;
      const hi =
        end < ids.length
          ? point(ids[end], true)[axis] -
            Math.max(60, size(ids[end]) + size(run[run.length - 1]))
          : Infinity;
      const start = Math.max(
        lo,
        Math.min((axis ? top : left) + 60, hi - sum(gaps)),
      );
      if (start + sum(gaps) > hi)
        throw new PyValueError(
          "固定 Pin 之间没有足够空间保持接口次序；需调整可改范围，不能把接口换序。",
        );
      run.forEach((cid, n) =>
        positions.set(cid, snap(start + sum(gaps.slice(0, n)))),
      );
      index = end;
    }
    const reach = maxOf(
      [...movable].map((cid) =>
        textWidth(attr(item(layout.byId, cid), "label") || ""),
      ),
      0,
    );
    const rails = new Map([
      ["east", left - reach - 70],
      ["west", right + reach + 70],
      ["south", top - 100],
      ["north", bottom + 100],
    ]);
    if (!rails.has(facing)) throw new PyKeyError(pyRepr(facing));
    const rail = snap(rails.get(facing) as number);
    for (const cid of movable) {
      const old = point(cid);
      const at = item(positions, cid);
      const next: Point = axis ? [rail, at] : [at, rail];
      layout.placement.set(cid, [next[0] - old[0], next[1] - old[1]]);
    }
    if (!inOrder())
      throw new PyValueError("固定接触组合与接口顺序冲突；不能隐式改变接口。");
    repairs.push({
      facing,
      orderedComponentIds: ids,
      movedComponentIds: sorted(movable),
    });
  }
  layout.report.interfaceOrderRepairs = repairs;
}

// Report remaining estimated flag collisions, with actionable identities.
export function labelFeedback(layout: SchematicLayout): void {
  const boxes: [string, Box][] = [];
  const flags: [Port, string, Box][] = [];
  const issues: Report[] = [];
  for (const [cid, c] of layout.moved) {
    if (c.factoryName === "Tunnel" || c.factoryName === "Text") continue;
    const b = visualOf(c);
    boxes.push([cid, [b.x, b.y, b.x + b.width, b.y + b.height]]);
  }
  const overlap = (a: Box, b: Box): boolean =>
    Math.min(a[2], b[2]) - Math.max(a[0], b[0]) >= 3 &&
    Math.min(a[3], b[3]) - Math.max(a[1], b[1]) >= 3;
  for (const [port, labels] of layout.anchors) {
    const [[x, y], edgeFacing, [sx, sy]] = layout.portEdge(
      item(layout.moved, port[0]),
      port[1],
    );
    const facing = layout.leadFacing.get(port) ?? edgeFacing;
    const n = layout.leadSteps.get(port) ?? 1;
    const offsets = chainOffsets(labels, [sx, sy]);
    labels.forEach((label, i) => {
      const k = offsets[i];
      const flag = labelBox(
        [x + sx * (n + k), y + sy * (n + k)],
        facing,
        label,
      );
      for (const [cid, box] of boxes)
        if (overlap(flag, box))
          issues.push({
            kind: "label-body",
            componentId: port[0],
            port: port[1],
            label,
            otherComponentId: cid,
          });
      for (const [other, text, box] of flags)
        if (overlap(flag, box))
          issues.push({
            kind: "label-label",
            componentId: port[0],
            port: port[1],
            label,
            otherComponentId: other[0],
            otherPort: other[1],
            otherLabel: text,
          });
      flags.push([port, label, flag]);
    });
  }
  layout.report.labelGeometry = {
    method: "native visual bounds and estimated tunnel text boxes",
    remainingCollisions: issues.length,
    examples: issues.slice(0, 24),
    note: "Geometric feedback, not a complete readability score. Inspect the rendered labels.",
  };
}
