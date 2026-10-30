// Bit-slice arrays: several instances of one part, each taking bit k of a
// bus from a Splitter (a fan), giving bit k of another bus to a Splitter (a
// collector), and joined to the next one by a chain (a ripple carry). A
// person draws one as a staircase: the instances step down to the right, each
// bit drops from its fan and turns in to its instance, each output runs right
// and drops into its collector, the chain steps from one instance to the
// next. The bits of one bus then nest without crossing each other, and the
// only crossings left are the ones the parts' port order forces.
//
// ELK cannot draw that: it puts a Splitter's bit ports into one block beside
// the Splitter and bends each bit next to its instance, so the buses cross
// each other in a wedge. So the array is drawn here, ahead of the layout, and
// becomes one unit carrying its own wires (`Unit.offsets`, `Unit.copper`,
// nets of kind "inner"); ELK places that unit among the rest. The Pins alone
// on the array's buses and on the two ends of the chain stand in it too: the
// fan Pins upper left, the chain's input Pin in the pocket left of the first
// instance, the collector Pins and the chain's output Pin on the right.
import { attr, down, GRID, up } from "./circuit.mts";
import type { Box, Point, Report } from "./circuit.mts";
import { footprint, portId, sideOf } from "./model.mts";
import type { Model, Net, Unit } from "./model.mts";
import type { Component, End } from "./types.mts";

// A Splitter whose bit ends each go to the same port of the next member: a
// fan feeds an input, a collector reads an output.
interface Bus {
  unit: Unit;
  splitter: Component;
  // the member port, by end index
  port: number;
  // per member: the bit end and its net
  ends: End[];
  nets: Net[];
  combined: End;
  // a Pin alone on the combined end
  pin: Lone | null;
}

// A part alone in its unit, on a net of two ports.
interface Lone {
  unit: Unit;
  part: Component;
  net: Net;
}

export interface ArrayPlan {
  members: Unit[];
  // innermost first: the fan of the topmost port, the collector of the lowest
  fans: Bus[];
  collectors: Bus[];
  chain: { out: number; in: number; nets: Net[] } | null;
  // Pins on the chain's input at the first member and output at the last
  head: Lone | null;
  tail: Lone | null;
}

const soleOf = (u: Unit | undefined): Component | null =>
  u && u.parts.length === 1 ? u.parts[0] : null;
const endOf = (c: Component, index: number): End => c.ends.find((e) => e.index === index)!;
const rel = (c: Component, e: End): Point => [e.location.x - c.location.x, e.location.y - c.location.y];

// The wire net joining exactly this port and one other.
function pairNet(model: Model, c: Component, e: End): Net | null {
  const net = model.netOfPort.get(portId(c, e));
  if (!net || net.kind !== "wire" || net.ports.length !== 2 || net.terminals.length !== 2 || net.fixed.length)
    return null;
  return net;
}
const otherPort = (net: Net, c: Component) => net.ports.find((p) => p.part !== c)!;

// The Pin alone in its unit at the other end of this port's net, facing the
// way the array needs it.
function lonePin(model: Model, c: Component, e: End, facing: string): Lone | null {
  const net = pairNet(model, c, e);
  if (!net) return null;
  const p = otherPort(net, c).part;
  const unit = model.unitOf.get(p.componentId);
  if (p.factoryName !== "Pin" || soleOf(unit) !== p || (attr(p, "facing") ?? "east") !== facing) return null;
  return { unit: unit!, part: p, net };
}

// Parts drawn alike: same factory, same port offsets, same body.
const shapeKey = (c: Component): string =>
  [
    c.factoryName,
    c.bounds.x - c.location.x,
    c.bounds.y - c.location.y,
    c.bounds.width,
    c.bounds.height,
    ...c.ends.map((e) => `${e.index}:${e.location.x - c.location.x},${e.location.y - c.location.y}:${e.direction}`),
  ].join("|");

// The largest array in the model, if it can be drawn as a staircase: fans
// with their bits on the bottom feeding ports on the left of the members,
// collectors with their bits on top reading ports on the right, bit 0 at the
// right end of each Splitter, and nothing else wired to the members.
export function planArray(model: Model): ArrayPlan | null {
  const buses: (Bus & { parts: Component[] })[] = [];
  for (const u of model.units) {
    const s = soleOf(u);
    if (!s || s.factoryName !== "Splitter") continue;
    const bits = s.ends.filter((e) => e.index > 0).sort((a, b) => a.index - b.index);
    const combined = s.ends.find((e) => e.index === 0);
    if (bits.length < 3 || !combined) continue;
    const ends: End[] = [];
    const nets: Net[] = [];
    const parts: Component[] = [];
    let port = -1;
    for (const e of bits) {
      const net = pairNet(model, s, e);
      const q = net ? otherPort(net, s) : null;
      const m = q && soleOf(model.unitOf.get(q.part.componentId)) === q.part ? q.part : null;
      if (!net || !q || !m || m.factoryName === "Splitter" || m.factoryName === "Pin") break;
      if ((port >= 0 && q.end.index !== port) || parts.includes(m)) break;
      port = q.end.index;
      ends.push(e);
      nets.push(net);
      parts.push(m);
    }
    if (parts.length !== bits.length) continue;
    buses.push({ unit: u, splitter: s, port, ends, nets, combined, pin: null, parts });
  }
  // the buses of one set of members, the set with the most members
  const groups = new Map<string, typeof buses>();
  for (const b of buses) {
    const k = b.parts.map((c) => c.componentId).sort().join("|");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  const group = [...groups.values()].sort((a, b) => b[0].parts.length - a[0].parts.length || b.length - a.length)[0];
  if (!group) return null;
  const parts = group[0].parts;
  const n = parts.length;
  if (group.some((b) => b.parts.some((c, k) => c !== parts[k]))) return null;
  if (new Set(parts.map(shapeKey)).size !== 1) return null;
  const m0 = parts[0];
  const fans: Bus[] = [];
  const collectors: Bus[] = [];
  for (const b of group) {
    const direction = endOf(m0, b.port).direction;
    const fan = direction === "input";
    if (!fan && direction !== "output") return null;
    // the member port on the left (fan) or right (collector), the bits on
    // the bottom (fan) or top (collector) of the Splitter, bit 0 rightmost
    if (sideOf(m0, endOf(m0, b.port)) !== (fan ? "WEST" : "EAST")) return null;
    if (b.ends.some((e) => sideOf(b.splitter, e) !== (fan ? "SOUTH" : "NORTH"))) return null;
    if (b.ends.some((e, k) => k > 0 && (e.location.x >= b.ends[k - 1].location.x || e.location.y !== b.ends[0].location.y)))
      return null;
    b.pin = lonePin(model, b.splitter, b.combined, fan ? "east" : "west");
    (fan ? fans : collectors).push(b);
  }
  const portY = (b: Bus) => endOf(m0, b.port).location.y;
  fans.sort((a, b) => portY(a) - portY(b));
  collectors.sort((a, b) => portY(b) - portY(a));
  // a chain from each member's output to the next one's input
  let chain: ArrayPlan["chain"] = null;
  const used = new Set(group.map((b) => b.port));
  for (const out of m0.ends) {
    if (out.direction !== "output" || used.has(out.index)) continue;
    const nets: Net[] = [];
    let input = -1;
    for (let k = 0; k + 1 < n; k++) {
      const net = pairNet(model, parts[k], endOf(parts[k], out.index));
      const q = net ? otherPort(net, parts[k]) : null;
      if (!net || !q || q.part !== parts[k + 1] || q.end.direction !== "input" || used.has(q.end.index)) break;
      if (input >= 0 && q.end.index !== input) break;
      input = q.end.index;
      nets.push(net);
    }
    if (nets.length !== n - 1) continue;
    if (sideOf(m0, out) !== "EAST" || sideOf(m0, endOf(m0, input)) !== "WEST") return null;
    chain = { out: out.index, in: input, nets };
    break;
  }
  if (chain) used.add(chain.out), used.add(chain.in);
  // nothing else on the members
  for (const c of parts)
    for (const e of c.ends) {
      if (used.has(e.index)) continue;
      const net = model.netOfPort.get(portId(c, e));
      if (net && net.kind !== "fixed") return null;
    }
  const members = parts.map((c) => model.unitOf.get(c.componentId)!);
  return {
    members,
    fans,
    collectors,
    chain,
    head: chain ? lonePin(model, m0, endOf(m0, chain.in), "east") : null,
    tail: chain ? lonePin(model, parts[n - 1], endOf(parts[n - 1], chain.out), "west") : null,
  };
}

// A part's body, label and captions, from its location.
function extent(c: Component, captions: Component[] = []): Box {
  const boxes: Box[] = [c.bounds, c.visualBounds ?? c.bounds].map((b) => [
    b.x - c.location.x,
    b.y - c.location.y,
    b.x + b.width - c.location.x,
    b.y + b.height - c.location.y,
  ]);
  for (const t of captions) {
    const f = footprint(t);
    boxes.push([f[0] - c.location.x, f[1] - c.location.y, f[2] - c.location.x, f[3] - c.location.y]);
  }
  return boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
}

export interface ArrayDrawing {
  // where each unit goes, as a move from where it was drawn
  moves: Map<Unit, Point>;
  // the wires of the nets inside the array, where the moved parts are
  copper: Map<Net, Point[][]>;
}

// Distances, in px: a wire keeps CLEAR from another net's port (closer reads
// as a junction) and more than 2 px from a body it passes.
const CLEAR = 20;
const PASS = 3;

// The staircase, with the first member where it was.
export function drawArray(plan: ArrayPlan): ArrayDrawing {
  const { members, fans, collectors, chain, head, tail } = plan;
  const n = members.length;
  const parts = members.map((u) => u.parts[0]);
  const m0 = parts[0];
  const L: Point = [m0.location.x, m0.location.y];
  // the member: its box with labels and every member's captions, its ports
  let box = extent(m0);
  members.forEach((u, k) => {
    const e = extent(parts[k], u.captions);
    box = [Math.min(box[0], e[0]), Math.min(box[1], e[1]), Math.max(box[2], e[2]), Math.max(box[3], e[3])];
  });
  const ports = m0.ends.map((e) => rel(m0, e));
  const minX = Math.min(...ports.map((p) => p[0]));
  const maxX = Math.max(...ports.map((p) => p[0]));
  const minY = Math.min(...ports.map((p) => p[1]));
  const maxY = Math.max(...ports.map((p) => p[1]));
  const portOf = (b: Bus) => rel(m0, endOf(m0, b.port));
  const fanTop = Math.min(...fans.map((b) => portOf(b)[1]));
  const fanBottom = Math.max(...fans.map((b) => portOf(b)[1]));
  const outBottom = Math.max(...collectors.map((b) => portOf(b)[1]));

  // the chain's column right of each member, and the step between members
  const xc = up(Math.max(maxX + CLEAR, box[2] + PASS));
  const DX = chain ? up(Math.max(xc + CLEAR - minX, xc + PASS - box[0])) : 0;
  let dy = 2 * GRID;
  if (fans.length) dy = Math.max(dy, box[3] + PASS - fanTop, maxY + CLEAR - fanTop);
  if (collectors.length) dy = Math.max(dy, outBottom + PASS - box[1], outBottom + CLEAR - minY);
  // the chain's input Pin in the pocket under the first member's fan wires
  let headAt: Point | null = null;
  let headLine: Point[] = [];
  let pocketLeft = Infinity;
  if (head && chain) {
    const input = rel(m0, endOf(m0, chain.in));
    const pin = extent(head.part, head.unit.captions);
    const x1 = down(Math.min(input[0] - CLEAR, box[0] - PASS));
    const py = fans.length ? up(Math.max(fanBottom + PASS - pin[1], fanBottom + CLEAR, input[1])) : input[1];
    const px = py === input[1] ? x1 : x1 - GRID;
    headAt = [px, py];
    headLine = py === input[1] ? [headAt, input] : [headAt, [x1, py], [x1, input[1]], input];
    pocketLeft = px + pin[0];
    if (fans.length) dy = Math.max(dy, py + pin[3] + PASS - fanTop, py + CLEAR - fanTop);
  }
  const DY = up(dy);
  const X = (k: number) => k * DX;
  const Y = (k: number) => k * DY;

  const moves = new Map<Unit, Point>();
  const copper = new Map<Net, Point[][]>();
  const place = (u: Unit, c: Component, at: Point) => moves.set(u, [L[0] + at[0] - c.location.x, L[1] + at[1] - c.location.y]);
  const wire = (net: Net, line: Point[]) => {
    if (!copper.has(net)) copper.set(net, []);
    copper.get(net)!.push(line.map(([x, y]): Point => [x + L[0], y + L[1]]));
  };
  members.forEach((u, k) => place(u, parts[k], [X(k), Y(k)]));

  // fans upper left, each further out one lower and further left; a fan's
  // Pin up left of its combined end
  const fanX: number[] = [];
  const fanTopY: number[] = [0];
  fans.forEach((b, i) => {
    const s = b.splitter;
    const at = (k: number) => rel(s, b.ends[k]);
    const body = extent(s);
    if (i === 0) {
      let x = Math.min(minX - CLEAR, box[0] - PASS) - at(0)[0];
      if (headAt) x = Math.min(x, pocketLeft - PASS - at(1)[0]);
      fanX.push(down(x));
    } else {
      const prev = fans[i - 1];
      const v = fanX[i - 1] + rel(prev.splitter, prev.ends[n - 1])[0];
      fanX.push(down(Math.min(v - PASS - body[2], v - CLEAR - at(0)[0])));
      const pb = extent(prev.splitter);
      fanTopY.push(fanTopY[i - 1] + up(pb[3] - pb[1]) + GRID);
    }
  });
  // the fans' ends CLEAR above the first member's fan wires
  const lift = fans.length
    ? down(Math.min(...fans.map((b, i) => portOf(b)[1] - CLEAR - rel(b.splitter, b.ends[0])[1] + extent(b.splitter)[1] - fanTopY[i])))
    : 0;
  fans.forEach((b, i) => {
    const s = b.splitter;
    const sx = fanX[i];
    const sy = lift + fanTopY[i] - extent(s)[1];
    place(b.unit, s, [sx, sy]);
    const into = portOf(b);
    b.ends.forEach((e, k) => {
      const [ex, ey] = rel(s, e);
      wire(b.nets[k], [
        [sx + ex, sy + ey],
        [sx + ex, Y(k) + into[1]],
        [X(k) + into[0], Y(k) + into[1]],
      ]);
    });
    if (b.pin) {
      const [cx, cy] = rel(s, b.combined);
      const at: Point = [sx + cx - 2 * GRID, sy + cy - GRID];
      place(b.pin.unit, b.pin.part, at);
      wire(b.pin.net, [at, [sx + cx, at[1]], [sx + cx, sy + cy]]);
    }
  });

  // the chain, stepping down between members
  if (chain) {
    const out = rel(m0, endOf(m0, chain.out));
    const input = rel(m0, endOf(m0, chain.in));
    chain.nets.forEach((net, k) =>
      wire(net, [
        [X(k) + out[0], Y(k) + out[1]],
        [X(k) + xc, Y(k) + out[1]],
        [X(k) + xc, Y(k + 1) + input[1]],
        [X(k + 1) + input[0], Y(k + 1) + input[1]],
      ]),
    );
    if (head && headAt) {
      place(head.unit, head.part, headAt);
      wire(head.net, headLine);
    }
  }

  // collectors lower right, each further out one higher and further right;
  // their Pins and the chain's output Pin in a column on the right
  const last = n - 1;
  const xo = xc;
  const colX: number[] = [];
  const colRise: number[] = [0];
  collectors.forEach((b, i) => {
    const s = b.splitter;
    const at = (k: number) => rel(s, b.ends[k]);
    const body = extent(s);
    if (i === 0) {
      const reach = Math.max(maxX + CLEAR, box[2] + PASS, tail ? xo + CLEAR : -Infinity);
      colX.push(
        up(Math.max(X(last) + reach - at(last)[0], X(last) + box[2] + PASS - body[0], tail ? X(last) + xo + PASS - body[0] : -Infinity)),
      );
    } else {
      const prev = collectors[i - 1];
      const pb = extent(prev.splitter);
      const v = colX[i - 1] + rel(prev.splitter, prev.ends[0])[0];
      colX.push(up(Math.max(v + CLEAR - at(last)[0], colX[i - 1] + pb[2] + PASS - body[0])));
      colRise.push(colRise[i - 1] + up(pb[3] - pb[1]) + GRID);
    }
  });
  // the collectors' ends CLEAR below the last member's outputs, under its box
  const drop = collectors.length
    ? up(
        Math.max(
          Y(last) + box[3] + GRID,
          ...collectors.map((b, i) => Y(last) + portOf(b)[1] + CLEAR + colRise[i]),
        ),
      )
    : 0;
  let column = -Infinity;
  collectors.forEach((b, i) => {
    const [cx] = rel(b.splitter, b.combined);
    column = Math.max(column, colX[i] + cx + 2 * GRID);
  });
  let lowest = -Infinity;
  collectors.forEach((b, i) => {
    const s = b.splitter;
    const sx = colX[i];
    const sy = drop - colRise[i] - rel(s, b.ends[0])[1];
    place(b.unit, s, [sx, sy]);
    const from = portOf(b);
    b.ends.forEach((e, k) => {
      const [ex, ey] = rel(s, e);
      wire(b.nets[k], [
        [X(k) + from[0], Y(k) + from[1]],
        [sx + ex, Y(k) + from[1]],
        [sx + ex, sy + ey],
      ]);
    });
    const [cx, cy] = rel(s, b.combined);
    lowest = Math.max(lowest, sy + cy, sy + extent(s)[3]);
    if (b.pin) {
      // the combined end is in the corner of the body: out of it downward
      const at: Point = [column, sy + cy + GRID];
      place(b.pin.unit, b.pin.part, at);
      wire(b.pin.net, [[sx + cx, sy + cy], [sx + cx, at[1]], at]);
      lowest = Math.max(lowest, at[1] + extent(b.pin.part, b.pin.unit.captions)[3]);
    }
  });
  if (chain && tail) {
    const out = rel(m0, endOf(m0, chain.out));
    const from: Point = [X(last) + out[0], Y(last) + out[1]];
    if (collectors.length) {
      const at: Point = [column, up(lowest + CLEAR) + GRID];
      place(tail.unit, tail.part, at);
      wire(tail.net, [from, [X(last) + xo, from[1]], [X(last) + xo, at[1]], at]);
    } else {
      const at: Point = [from[0] + 2 * GRID, from[1]];
      place(tail.unit, tail.part, at);
      wire(tail.net, [from, at]);
    }
  }
  return { moves, copper };
}

const movedCopy = (c: Component, dx: number, dy: number): Component => {
  const move = <T extends { x: number; y: number }>(v: T): T => ({ ...v, x: v.x + dx, y: v.y + dy });
  return {
    ...c,
    location: move(c.location),
    bounds: move(c.bounds),
    ...(c.visualBounds ? { visualBounds: move(c.visualBounds) } : {}),
    ends: c.ends.map((e) => ({ ...e, location: move(e.location) })),
  };
};

// Draws the largest array of the model as a staircase and puts it in the
// model as one unit; the report says what it holds, null when there is none.
export function applyArray(model: Model): Report | null {
  const plan = planArray(model);
  if (!plan) return null;
  const { moves, copper } = drawArray(plan);
  const units = [...moves.keys()];
  const merged = new Set(units);
  const offsets = new Map<string, Point>();
  const copyOf = new Map<Component, Component>();
  for (const u of units) {
    const [dx, dy] = moves.get(u)!;
    for (const c of [...u.parts, ...u.captions]) {
      offsets.set(c.componentId, [dx, dy]);
      copyOf.set(c, movedCopy(c, dx, dy));
    }
  }
  const unit: Unit = {
    id: units[0].id,
    index: units[0].index,
    parts: units.flatMap((u) => u.parts.map((c) => copyOf.get(c)!)),
    captions: units.flatMap((u) => u.captions.map((c) => copyOf.get(c)!)),
    terminals: [],
    box: [0, 0, 0, 0],
    offsets,
    copper,
  };
  unit.box = [...unit.parts, ...unit.captions]
    .map(footprint)
    .reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  // the ports and terminals onto the copies
  for (const net of model.nets)
    for (const p of net.ports) {
      const copy = copyOf.get(p.part);
      if (!copy) continue;
      p.end = copy.ends.find((e) => e.index === p.end.index)!;
      p.part = copy;
    }
  for (const u of units)
    for (const t of u.terminals) {
      const [dx, dy] = moves.get(u)!;
      t.unit = unit;
      t.point = [t.point[0] + dx, t.point[1] + dy];
      unit.terminals.push(t);
    }
  for (const net of copper.keys()) net.kind = "inner";
  const at = model.units.indexOf(units[0]);
  model.units = model.units.filter((u) => !merged.has(u));
  model.units.splice(Math.min(at, model.units.length), 0, unit);
  for (const c of [...unit.parts, ...unit.captions]) model.unitOf.set(c.componentId, unit);
  return {
    members: plan.members.length,
    fans: plan.fans.length,
    collectors: plan.collectors.length,
    chain: plan.chain !== null,
    parts: unit.parts.length,
  };
}
