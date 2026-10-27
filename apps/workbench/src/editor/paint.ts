/**
 * The editor picture, composed in the window: wires and junctions from the
 * document, each component from the recorded picture of its kind (see
 * `symbols.ts`), drawn with Canvas2D the way Logisim's Circuit.draw paints
 * them. Fills and text replay in symbol space under the view transform;
 * strokes are built in device space with every point moved to its pixel
 * centre, as Java2D's stroke normalization moves it, so a picture at 100%
 * lands on the same pixels as Logisim's own (docs/rendering.md).
 */
import type { Bounds, Circuit, Component, Point } from "../shared/types";
import { fallbackBounds, wireBounds, type View } from "./geometry";
import type { Op, SymbolEntry, SymbolPicture } from "./symbols";

interface Style {
  color: string;
  alpha: number;
  width: number;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  miter: number;
  dash: number[];
  phase: number;
  font: string;
}
/** A stroked outline as Java2D iterates it: a segment code, then its points. */
type Segments = number[];
const M = 0,
  L = 1,
  Q = 2,
  C = 3,
  Z = 4;
type Draw =
  | { kind: "fill"; path: Path2D; rule: CanvasFillRule }
  | { kind: "stroke"; segments: Segments; index: number }
  | {
      kind: "text";
      text: string;
      x: number;
      y: number;
      matrix: number[] | null;
    }
  | { kind: "clear"; path: Path2D; color: string }
  | { kind: "image"; image: HTMLImageElement; matrix: number[] }
  | { kind: "clip"; path: Path2D | null };
type Step = Draw & { style: Style; when: number };
/** A kind's ops compiled for Canvas2D. */
export interface Program {
  steps: Step[];
  /** The points whose connection decides the steps marked with them ("U"). */
  conditions: Point[];
  clips: boolean;
  /** Its strokes in device space, by sub-pixel origin, for one scale. */
  strokes: { k: number; byOrigin: Map<string, Path2D[]> };
}

const caps: CanvasLineCap[] = ["butt", "round", "square"];
const joins: CanvasLineJoin[] = ["miter", "round", "bevel"];
const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
// Java's logical fonts are the platform's: Arial (Chinese from SimSun) on
// Windows, Lucida Grande on macOS, fontconfig's sans elsewhere.
const sans = /Windows/.test(agent)
  ? "Arial, SimSun, sans-serif"
  : /Mac OS/.test(agent)
    ? '"Lucida Grande", sans-serif'
    : "sans-serif";
function family(name: string) {
  if (name === "Dialog" || name === "SansSerif" || name === "Sans Serif")
    return sans;
  if (name === "Serif") return "serif";
  if (name === "Monospaced" || name === "DialogInput") return "monospace";
  return `"${name.replace(/"/g, "")}", ${sans}`;
}

const images = new Map<string, HTMLImageElement>();
const imageListeners = new Set<() => void>();
/** Calls `listener` whenever a recorded image finishes loading. */
export function onImageLoad(listener: () => void) {
  imageListeners.add(listener);
  return () => void imageListeners.delete(listener);
}
function image(url: string) {
  let found = images.get(url);
  if (!found) {
    found = new Image();
    found.onload = () => imageListeners.forEach((listener) => listener());
    found.src = url;
    images.set(url, found);
  }
  return found;
}

const n = (v: unknown) => (typeof v === "number" ? v : 0);
const list = (v: unknown) => (Array.isArray(v) ? (v as number[]) : []);

// Outlines to stroke, point for point as Java's path iterators give them
// (RectIterator, RoundRectIterator, EllipseIterator, ArcIterator), because
// normalization moves exactly those points.
function rectOutline(x: number, y: number, w: number, h: number): Segments {
  return [M, x, y, L, x + w, y, L, x + w, y + h, L, x, y + h, L, x, y, Z];
}
const bend = (() => {
  const a = 1 - Math.cos(Math.PI / 4),
    b = Math.tan(Math.PI / 4),
    c = Math.sqrt(1 + b * b) - 1 + a;
  return (1 - ((4 / 3) * a * b) / c) / 2;
})();
function roundRectOutline(
  x: number,
  y: number,
  w: number,
  h: number,
  arcWidth: number,
  arcHeight: number,
): Segments {
  const aw = Math.min(w, Math.abs(arcWidth)),
    ah = Math.min(h, Math.abs(arcHeight));
  const v = bend;
  // prettier-ignore
  return [
    M, x, y + ah / 2,
    L, x, y + h - ah / 2,
    C, x, y + h - v * ah, x + v * aw, y + h, x + aw / 2, y + h,
    L, x + w - aw / 2, y + h,
    C, x + w - v * aw, y + h, x + w, y + h - v * ah, x + w, y + h - ah / 2,
    L, x + w, y + ah / 2,
    C, x + w, y + v * ah, x + w - v * aw, y, x + w - aw / 2, y,
    L, x + aw / 2, y,
    C, x + v * aw, y, x, y + v * ah, x, y + ah / 2,
    Z,
  ];
}
const KAPPA = 0.5522847498307933;
const PCV = 0.5 + KAPPA * 0.5,
  NCV = 0.5 - KAPPA * 0.5;
function ovalOutline(x: number, y: number, w: number, h: number): Segments {
  // prettier-ignore
  return [
    M, x + w, y + h / 2,
    C, x + w, y + PCV * h, x + PCV * w, y + h, x + w / 2, y + h,
    C, x + NCV * w, y + h, x, y + PCV * h, x, y + h / 2,
    C, x, y + NCV * h, x + NCV * w, y, x + w / 2, y,
    C, x + PCV * w, y, x + w, y + NCV * h, x + w, y + h / 2,
    Z,
  ];
}
function arcOutline(
  left: number,
  top: number,
  width: number,
  height: number,
  start: number,
  extent: number,
): Segments {
  const w = width / 2,
    h = height / 2,
    x = left + w,
    y = top + h;
  const from = (-start * Math.PI) / 180,
    ext = -extent;
  let count: number, step: number, cv: number;
  if (ext >= 360 || ext <= -360) {
    count = 4;
    step = ext < 0 ? -Math.PI / 2 : Math.PI / 2;
    cv = ext < 0 ? -KAPPA : KAPPA;
  } else {
    count = Math.ceil(Math.abs(ext) / 90);
    step = ((ext / count) * Math.PI) / 180;
    const half = step / 2;
    cv = ((4 / 3) * Math.sin(half)) / (1 + Math.cos(half));
    if (cv === 0) count = 0;
  }
  const out: Segments = [M, x + Math.cos(from) * w, y + Math.sin(from) * h];
  for (let i = 0; i < count; i++) {
    const a1 = from + step * i,
      a2 = a1 + step;
    const c1 = Math.cos(a1),
      s1 = Math.sin(a1),
      c2 = Math.cos(a2),
      s2 = Math.sin(a2);
    out.push(
      C,
      x + (c1 - cv * s1) * w,
      y + (s1 + cv * c1) * h,
      x + (c2 + cv * s2) * w,
      y + (s2 - cv * c2) * h,
      x + c2 * w,
      y + s2 * h,
    );
  }
  return out;
}
function polyOutline(v: number[], close: boolean): Segments {
  const out: Segments = [];
  for (let i = 0; i + 1 < v.length; i += 2) out.push(i ? L : M, v[i], v[i + 1]);
  if (close && out.length) out.push(Z);
  return out;
}
/** The recorder's path text ("M0 1L2 3Q…C…Z") as segments. */
function pathOutline(d: string): Segments {
  const out: Segments = [];
  for (const [, letter, numbers] of d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    out.push("MLQCZ".indexOf(letter));
    const text = numbers.trim();
    if (text) for (const t of text.split(/\s+/)) out.push(Number(t));
  }
  return out;
}

/**
 * An outline in device space (`k` device pixels to the unit, origin at
 * `fx, fy` past a whole pixel), normalized as Java2D's antialiased stroking
 * does: each segment end moves to the centre of its pixel, quadratic
 * controls by the mean of both ends' moves, cubic controls with their end.
 */
function deviceOutline(s: Segments, k: number, fx: number, fy: number) {
  const p = new Path2D();
  let cx = 0,
    cy = 0,
    mx = 0,
    my = 0;
  for (let i = 0; i < s.length;) {
    const code = s[i++];
    if (code === Z) {
      p.closePath();
      cx = mx;
      cy = my;
      continue;
    }
    const count = code === Q ? 2 : code === C ? 3 : 1;
    const e = i + 2 * (count - 1);
    const ex = s[e] * k + fx,
      ey = s[e + 1] * k + fy;
    const ax = Math.floor(ex) + 0.5 - ex,
      ay = Math.floor(ey) + 0.5 - ey;
    if (code === M) {
      p.moveTo(ex + ax, ey + ay);
      mx = ax;
      my = ay;
    } else if (code === L) p.lineTo(ex + ax, ey + ay);
    else if (code === Q)
      p.quadraticCurveTo(
        s[i] * k + fx + (cx + ax) / 2,
        s[i + 1] * k + fy + (cy + ay) / 2,
        ex + ax,
        ey + ay,
      );
    else
      p.bezierCurveTo(
        s[i] * k + fx + cx,
        s[i + 1] * k + fy + cy,
        s[i + 2] * k + fx + ax,
        s[i + 3] * k + fy + ay,
        ex + ax,
        ey + ay,
      );
    cx = ax;
    cy = ay;
    i += 2 * count;
  }
  return p;
}
/** Where Java2D puts a stroked point: the centre of its device pixel. */
const centre = (d: number) => Math.floor(d) + 0.5;

function roundRect(
  p: Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  aw: number,
  ah: number,
) {
  const rx = Math.min(Math.abs(aw), w) / 2,
    ry = Math.min(Math.abs(ah), h) / 2;
  p.moveTo(x + rx, y);
  p.lineTo(x + w - rx, y);
  p.ellipse(x + w - rx, y + ry, rx, ry, 0, -Math.PI / 2, 0);
  p.lineTo(x + w, y + h - ry);
  p.ellipse(x + w - rx, y + h - ry, rx, ry, 0, 0, Math.PI / 2);
  p.lineTo(x + rx, y + h);
  p.ellipse(x + rx, y + h - ry, rx, ry, 0, Math.PI / 2, Math.PI);
  p.lineTo(x, y + ry);
  p.ellipse(x + rx, y + ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
  p.closePath();
}
/** Java's filled arc (a pie): degrees counterclockwise on screen, relative to the frame. */
function pie(
  p: Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  start: number,
  extent: number,
) {
  const cx = x + w / 2,
    cy = y + h / 2;
  const from = (-start * Math.PI) / 180,
    to = (-(start + extent) * Math.PI) / 180;
  p.moveTo(cx, cy);
  p.ellipse(cx, cy, w / 2, h / 2, 0, from, to, extent > 0);
  p.closePath();
}
function poly(v: number[]) {
  const p = new Path2D();
  for (let i = 0; i + 1 < v.length; i += 2)
    if (i === 0) p.moveTo(v[0], v[1]);
    else p.lineTo(v[i], v[i + 1]);
  p.closePath();
  return p;
}

const programs = new WeakMap<Op[], Program>();
/** Compiles a recorded picture once; see RecordingGraphics2D for the ops. */
export function program(picture: SymbolPicture): Program {
  return compiled(picture.ops);
}
/** Compiles recorded ops once per list: a symbol's, or a component's as a
 * running simulation drew it. */
function compiled(ops: Op[]): Program {
  const known = programs.get(ops);
  if (known) return known;
  const steps: Step[] = [];
  const conditions: Point[] = [];
  let style: Style = {
    color: "#000000",
    alpha: 1,
    width: 1,
    cap: "square",
    join: "miter",
    miter: 10,
    dash: [],
    phase: 0,
    font: `12px ${sans}`,
  };
  const restyle = (change: Partial<Style>) => (style = { ...style, ...change });
  let when = -1;
  let clips = false;
  let strokes = 0;
  const push = (step: Draw) => {
    steps.push({ ...step, style, when });
    when = -1;
  };
  const stroke = (segments: Segments) =>
    push({ kind: "stroke", segments, index: strokes++ });
  for (const op of ops) {
    const v = op as unknown[];
    switch (v[0]) {
      case "C":
        restyle({ color: String(v[1]) });
        break;
      case "W": {
        let i = 4;
        const change: Partial<Style> = {
          width: n(v[1]),
          cap: caps[n(v[2])] ?? "square",
          join: joins[n(v[3])] ?? "miter",
          miter: 10,
          dash: [],
          phase: 0,
        };
        if (typeof v[i] === "number") change.miter = n(v[i++]);
        if (Array.isArray(v[i])) {
          change.dash = list(v[i++]);
          change.phase = n(v[i]);
        }
        restyle(change);
        break;
      }
      case "F": {
        const bits = n(v[2]);
        restyle({
          font: `${bits & 2 ? "italic " : ""}${bits & 1 ? "bold " : ""}${n(v[3])}px ${family(String(v[1]))}`,
        });
        break;
      }
      case "X":
        restyle({ alpha: v.length > 2 ? n(v[2]) : 1 });
        break;
      case "K": {
        clips = true;
        let path: Path2D | null = null;
        if (v.length >= 5) {
          path = new Path2D();
          path.rect(n(v[1]), n(v[2]), n(v[3]), n(v[4]));
        } else if (typeof v[1] === "string") path = new Path2D(v[1]);
        push({ kind: "clip", path });
        break;
      }
      case "U":
        when = conditions.push({ x: n(v[1]), y: n(v[2]) }) - 1;
        break;
      case "L":
        stroke([M, n(v[1]), n(v[2]), L, n(v[3]), n(v[4])]);
        break;
      case "R":
      case "r": {
        const [x, y, w, h] = [n(v[1]), n(v[2]), n(v[3]), n(v[4])];
        if (v[0] === "R")
          // Java draws an empty rectangle as the line it is.
          stroke(w && h ? rectOutline(x, y, w, h) : [M, x, y, L, x + w, y + h]);
        else {
          const path = new Path2D();
          path.rect(x, y, w, h);
          push({ kind: "fill", path, rule: "nonzero" });
        }
        break;
      }
      case "Q":
      case "q": {
        const [x, y, w, h] = [n(v[1]), n(v[2]), n(v[3]), n(v[4])];
        if (w < 0 || h < 0) break;
        if (v[0] === "Q")
          stroke(roundRectOutline(x, y, w, h, n(v[5]), n(v[6])));
        else {
          const path = new Path2D();
          roundRect(path, x, y, w, h, n(v[5]), n(v[6]));
          push({ kind: "fill", path, rule: "nonzero" });
        }
        break;
      }
      case "O":
      case "o": {
        const [x, y, w, h] = [n(v[1]), n(v[2]), n(v[3]), n(v[4])];
        if (w < 0 || h < 0) break;
        if (v[0] === "O") stroke(ovalOutline(x, y, w, h));
        else {
          const path = new Path2D();
          path.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          push({ kind: "fill", path, rule: "nonzero" });
        }
        break;
      }
      case "A":
      case "a": {
        const [x, y, w, h] = [n(v[1]), n(v[2]), n(v[3]), n(v[4])];
        if (w < 0 || h < 0) break;
        if (v[0] === "A") stroke(arcOutline(x, y, w, h, n(v[5]), n(v[6])));
        else {
          const path = new Path2D();
          pie(path, x, y, w, h, n(v[5]), n(v[6]));
          push({ kind: "fill", path, rule: "nonzero" });
        }
        break;
      }
      case "Y":
        stroke(polyOutline(list(v[1]), false));
        break;
      case "G":
        stroke(polyOutline(list(v[1]), true));
        break;
      case "g":
        push({ kind: "fill", path: poly(list(v[1])), rule: "evenodd" });
        break;
      case "P":
        stroke(pathOutline(String(v[1])));
        break;
      case "p":
        push({
          kind: "fill",
          path: new Path2D(String(v[1])),
          rule: v[2] === 1 ? "evenodd" : "nonzero",
        });
        break;
      case "E": {
        let path: Path2D;
        if (typeof v[2] === "string") path = new Path2D(v[2]);
        else {
          path = new Path2D();
          path.rect(n(v[2]), n(v[3]), n(v[4]), n(v[5]));
        }
        push({ kind: "clear", path, color: String(v[1]) });
        break;
      }
      case "T":
        push({
          kind: "text",
          text: String(v[1]),
          x: n(v[2]),
          y: n(v[3]),
          matrix: Array.isArray(v[4]) ? list(v[4]) : null,
        });
        break;
      case "I":
        push({
          kind: "image",
          image: image(String(v[1])),
          matrix: list(v[2]),
        });
        break;
      // "N" (a paint that is not a color) keeps the last color; "Z" (XOR) paints plainly.
    }
  }
  const result: Program = {
    steps,
    conditions,
    clips,
    strokes: { k: 0, byOrigin: new Map() },
  };
  programs.set(ops, result);
  return result;
}

/** A component of the picture: its kind's program at its location. */
export interface Part {
  id: string;
  x: number;
  y: number;
  program: Program;
  /** Whether each of the program's conditions holds here. */
  when: boolean[];
  /** What it can touch, in circuit coordinates. */
  ink: Bounds;
}
export interface SceneWire {
  id: string;
  from: Point;
  to: Point;
  error: boolean;
}
export interface Scene {
  wires: SceneWire[];
  dots: { x: number; y: number; error: boolean }[];
  parts: Part[];
  /** Components the runtime could not draw: a marked box where they are. */
  broken: { id: string; bounds: Bounds }[];
  /** Every component's and wire's bounds, by id. */
  bounds: Map<string, Bounds>;
  /** Every drawn component's ends, in circuit coordinates. */
  ports: Point[];
}

function sortedInsert(map: Map<number, number[]>, key: number, value: number) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}
function firstAbove(values: number[], bound: number) {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= bound) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The static picture of a circuit. Junctions and connection-dependent
 * appearance follow Logisim after its wire repair splits wires at every point
 * something ends on: a point counts each wire end there, each wire passing
 * through twice, and each component end.
 */
export function buildScene(
  circuit: Circuit,
  resolve: (component: Component) => SymbolEntry | null | undefined,
  widthErrors: Set<string>,
): Scene {
  const points = new Map<
    string,
    { ends: number; ports: number; through: number }
  >();
  const at = (x: number, y: number) => {
    const key = `${x},${y}`;
    let found = points.get(key);
    if (!found) points.set(key, (found = { ends: 0, ports: 0, through: 0 }));
    return found;
  };
  for (const w of circuit.wires) {
    at(w.from.x, w.from.y).ends++;
    at(w.to.x, w.to.y).ends++;
  }
  const drawn: { component: Component; picture: SymbolPicture }[] = [];
  const broken: Scene["broken"] = [];
  const bounds = new Map<string, Bounds>();
  const ports: Point[] = [];
  for (const component of circuit.components) {
    const entry = resolve(component);
    const { x, y } = component.location;
    if (!entry?.picture) {
      const fallback = fallbackBounds(component);
      bounds.set(component.id, fallback);
      if (entry) broken.push({ id: component.id, bounds: fallback });
      continue;
    }
    const b = entry.picture.bounds;
    bounds.set(component.id, {
      x: x + b.x,
      y: y + b.y,
      width: b.width,
      height: b.height,
    });
    for (const port of entry.picture.ports) {
      at(x + port.x, y + port.y).ports++;
      ports.push({ x: x + port.x, y: y + port.y });
    }
    drawn.push({ component, picture: entry.picture });
  }
  for (const w of circuit.wires) bounds.set(w.id, wireBounds(w));
  const rows = new Map<number, number[]>(),
    columns = new Map<number, number[]>();
  for (const key of points.keys()) {
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma)),
      y = Number(key.slice(comma + 1));
    sortedInsert(rows, y, x);
    sortedInsert(columns, x, y);
  }
  for (const values of rows.values()) values.sort((a, b) => a - b);
  for (const values of columns.values()) values.sort((a, b) => a - b);
  for (const w of circuit.wires) {
    const horizontal = w.from.y === w.to.y;
    if (!horizontal && w.from.x !== w.to.x) continue;
    const line = horizontal ? w.from.y : w.from.x;
    const values = (horizontal ? rows : columns).get(line);
    if (!values) continue;
    const a = horizontal ? w.from.x : w.from.y,
      b = horizontal ? w.to.x : w.to.y;
    const lo = Math.min(a, b),
      hi = Math.max(a, b);
    for (
      let i = firstAbove(values, lo);
      i < values.length && values[i] < hi;
      i++
    )
      points.get(horizontal ? `${values[i]},${line}` : `${line},${values[i]}`)!
        .through++;
  }
  const dots: Scene["dots"] = [];
  for (const [key, p] of points)
    if ((p.ends || p.through) && p.ends + 2 * p.through + p.ports > 2) {
      const comma = key.indexOf(",");
      dots.push({
        x: Number(key.slice(0, comma)),
        y: Number(key.slice(comma + 1)),
        error: widthErrors.has(key),
      });
    }
  const parts = drawn.map(({ component: c, picture }): Part => {
    const compiled = program(picture);
    const when = compiled.conditions.map(({ x, y }) => {
      const p = points.get(`${c.location.x + x},${c.location.y + y}`);
      if (!p) return false;
      const own = picture.ports.filter((q) => q.x === x && q.y === y).length;
      return p.ends + p.through + p.ports - own > 0;
    });
    const ink = picture.ink;
    return {
      id: c.id,
      x: c.location.x,
      y: c.location.y,
      program: compiled,
      when,
      ink: {
        x: c.location.x + ink.x,
        y: c.location.y + ink.y,
        width: ink.width,
        height: ink.height,
      },
    };
  });
  const wires = circuit.wires.map((w) => ({
    id: w.id,
    from: w.from,
    to: w.to,
    error: widthErrors.has(`${w.from.x},${w.from.y}`),
  }));
  return { wires, dots, parts, broken, bounds, ports };
}

/** The canvas state already set, so a frame sets each property only when it changes. */
class Pen {
  fill = "";
  stroke = "";
  alpha = -1;
  width = -1;
  cap = "";
  join = "";
  miter = -1;
  dash: string | null = null;
  font = "";
  reset() {
    this.fill = this.stroke = this.cap = this.join = this.font = "";
    this.alpha = this.width = this.miter = -1;
    this.dash = null;
  }
}
function fillWith(
  ctx: CanvasRenderingContext2D,
  pen: Pen,
  color: string,
  alpha: number,
) {
  if (pen.fill !== color) ctx.fillStyle = pen.fill = color;
  if (pen.alpha !== alpha) ctx.globalAlpha = pen.alpha = alpha;
}
/** Sets a style for stroking in device space, `k` device pixels to the unit. */
function strokeWith(
  ctx: CanvasRenderingContext2D,
  pen: Pen,
  style: Style,
  alpha: number,
  k: number,
) {
  if (pen.stroke !== style.color) ctx.strokeStyle = pen.stroke = style.color;
  if (pen.alpha !== alpha) ctx.globalAlpha = pen.alpha = alpha;
  // Java's zero-width stroke is the thinnest line the device can draw.
  const width = style.width > 0 ? style.width * k : 1;
  if (pen.width !== width) ctx.lineWidth = pen.width = width;
  if (pen.cap !== style.cap)
    ctx.lineCap = (pen.cap = style.cap) as CanvasLineCap;
  if (pen.join !== style.join)
    ctx.lineJoin = (pen.join = style.join) as CanvasLineJoin;
  if (pen.miter !== style.miter) ctx.miterLimit = pen.miter = style.miter;
  const dash = style.dash.length
    ? `${k} ${style.dash.join(" ")} ${style.phase}`
    : "";
  if (pen.dash !== dash) {
    pen.dash = dash;
    ctx.setLineDash(style.dash.map((d) => d * k));
    ctx.lineDashOffset = style.phase * k;
  }
}

/** A program's strokes in device space for scale `k` and an origin `fx, fy` past a whole pixel. */
function strokePaths(compiled: Program, k: number, fx: number, fy: number) {
  const cache = compiled.strokes;
  if (cache.k !== k) {
    cache.k = k;
    cache.byOrigin.clear();
  }
  const key = `${fx} ${fy}`;
  let paths = cache.byOrigin.get(key);
  if (!paths) {
    paths = [];
    for (const step of compiled.steps)
      if (step.kind === "stroke")
        paths.push(deviceOutline(step.segments, k, fx, fy));
    cache.byOrigin.set(key, paths);
  }
  return paths;
}

/** Replays a program with its origin at device point `x, y`, `k` device pixels to the unit. */
function replay(
  ctx: CanvasRenderingContext2D,
  pen: Pen,
  compiled: Program,
  when: boolean[] | null,
  k: number,
  x: number,
  y: number,
  alpha: number,
) {
  const bx = Math.floor(x),
    by = Math.floor(y);
  let strokes: Path2D[] | null = null;
  // The transform set: 1 symbol space, 2 device space, 0 something else.
  let space = 0;
  const symbolSpace = () => {
    if (space !== 1) ctx.setTransform(k, 0, 0, k, x, y);
    space = 1;
  };
  if (compiled.clips) ctx.save();
  for (const step of compiled.steps) {
    if (step.when >= 0 && !when?.[step.when]) continue;
    const style = step.style;
    switch (step.kind) {
      case "stroke":
        strokes ??= strokePaths(compiled, k, x - bx, y - by);
        if (space !== 2) ctx.setTransform(1, 0, 0, 1, bx, by);
        space = 2;
        strokeWith(ctx, pen, style, style.alpha * alpha, k);
        ctx.stroke(strokes[step.index]);
        break;
      case "fill":
        symbolSpace();
        fillWith(ctx, pen, style.color, style.alpha * alpha);
        ctx.fill(step.path, step.rule);
        break;
      case "clear":
        symbolSpace();
        fillWith(ctx, pen, step.color, alpha);
        ctx.fill(step.path);
        break;
      case "text":
        fillWith(ctx, pen, style.color, style.alpha * alpha);
        if (pen.font !== style.font) ctx.font = pen.font = style.font;
        symbolSpace();
        if (step.matrix) {
          const [a, b, c, d] = step.matrix;
          ctx.translate(step.x, step.y);
          ctx.transform(a, b, c, d, 0, 0);
          space = 0;
          ctx.fillText(step.text, 0, 0);
        } else ctx.fillText(step.text, step.x, step.y);
        break;
      case "image": {
        if (!step.image.complete || !step.image.naturalWidth) break;
        const m = step.matrix;
        symbolSpace();
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        space = 0;
        if (pen.alpha !== style.alpha * alpha)
          ctx.globalAlpha = pen.alpha = style.alpha * alpha;
        ctx.drawImage(step.image, 0, 0);
        break;
      }
      case "clip":
        ctx.restore();
        ctx.save();
        pen.reset();
        space = 0;
        symbolSpace();
        if (step.path) ctx.clip(step.path);
        break;
    }
  }
  if (compiled.clips) {
    ctx.restore();
    pen.reset();
  }
}

export interface Frame {
  view: View;
  /** The canvas size in CSS pixels. */
  width: number;
  height: number;
  scene: Scene | null;
  /** Components and wires not drawn where they are (moving or deleted). */
  hidden: Set<string>;
  /** What a drag or a committed move shows at its new place. */
  moved: { delta: Point; parts: Part[]; wires: SceneWire[] } | null;
  /** Wires a committed wire edit adds, until its answer arrives. */
  added: { from: Point; to: Point }[];
  /** Placement previews and the cursor ghost. */
  ghosts: { program: Program; x: number; y: number; alpha: number }[];
  /** A running simulation's picture of the circuit. */
  live: Live | null;
}

/** The picture a running simulation drew of the view, in its state: wires
 * and junctions with the colors of their values, which replace the scene's,
 * and the ops of each component, which replace its kind's picture. */
export interface Live {
  wires: Map<string, readonly [number, number, number, number, string]>;
  dots: Map<string, readonly [number, number, string]>;
  components: Map<string, Op[]>;
}

/** Whether the segment `[x1, y1, x2, y2]` lies on wire `w`: the runtime
 * splits and joins the document's wires as Logisim's wire repair does. */
function lies(
  w: SceneWire,
  [x1, y1, x2, y2]: readonly [number, number, number, number, ...unknown[]],
) {
  const { from, to } = w;
  if (from.y === to.y && y1 === from.y && y2 === from.y)
    return (
      Math.min(x1, x2) >= Math.min(from.x, to.x) &&
      Math.max(x1, x2) <= Math.max(from.x, to.x)
    );
  if (from.x === to.x && x1 === from.x && x2 === from.x)
    return (
      Math.min(y1, y2) >= Math.min(from.y, to.y) &&
      Math.max(y1, y2) <= Math.max(from.y, to.y)
    );
  return false;
}

const pens = new WeakMap<CanvasRenderingContext2D, Pen>();
const WIRE = 3;
const BLACK = "#000000";
const ERROR = "#ff7b00";

/** Paints one frame of the editor picture onto `canvas`, `dpr` device pixels to the CSS pixel. */
export function paintFrame(
  canvas: HTMLCanvasElement,
  frame: Frame,
  dpr: number,
) {
  const { view } = frame;
  const width = Math.max(1, Math.round(frame.width * dpr)),
    height = Math.max(1, Math.round(frame.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let pen = pens.get(ctx);
  if (!pen) pens.set(ctx, (pen = new Pen()));
  pen.reset();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);
  if (!frame.scene) return;
  const k = view.scale * dpr;
  // Whole device pixels at the origin keep 100% on Logisim's pixel grid.
  const ox = Math.round(-view.x * k),
    oy = Math.round(-view.y * k);
  const left = view.x - 10,
    top = view.y - 10,
    right = view.x + frame.width / view.scale + 10,
    bottom = view.y + frame.height / view.scale + 10;
  const visible = (b: Bounds) =>
    b.x <= right &&
    b.y <= bottom &&
    b.x + b.width >= left &&
    b.y + b.height >= top;
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  // Wires: Logisim's width-3 round stroke, its ends at pixel centres as
  // Java2D puts them, one path per color.
  const lines = new Map<string, Path2D>();
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
  ) => {
    if (
      Math.max(x1, x2) < left ||
      Math.min(x1, x2) > right ||
      Math.max(y1, y2) < top ||
      Math.min(y1, y2) > bottom
    )
      return;
    let path = lines.get(color);
    if (!path) lines.set(color, (path = new Path2D()));
    path.moveTo(centre(x1 * k + ox), centre(y1 * k + oy));
    path.lineTo(centre(x2 * k + ox), centre(y2 * k + oy));
  };
  const strokeLines = () => {
    if (!lines.size) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = pen.width = WIRE * k;
    ctx.lineCap = pen.cap = "round";
    ctx.lineJoin = pen.join = "round";
    if (pen.dash !== "") ctx.setLineDash([]);
    pen.dash = "";
    if (pen.alpha !== 1) ctx.globalAlpha = pen.alpha = 1;
    for (const [color, path] of lines) {
      ctx.strokeStyle = pen.stroke = color;
      ctx.stroke(path);
    }
    lines.clear();
  };
  const strokeWires = (
    wires: { from: Point; to: Point; error?: boolean }[],
    dx: number,
    dy: number,
  ) => {
    for (const w of wires)
      line(
        w.from.x + dx,
        w.from.y + dy,
        w.to.x + dx,
        w.to.y + dy,
        w.error ? ERROR : BLACK,
      );
    strokeLines();
  };
  const { scene, hidden, live } = frame;
  if (live) {
    const gone = hidden.size ? scene.wires.filter((w) => hidden.has(w.id)) : [];
    for (const w of live.wires.values())
      if (!gone.length || !gone.some((g) => lies(g, w)))
        line(w[0], w[1], w[2], w[3], w[4]);
    strokeLines();
  } else
    strokeWires(
      hidden.size ? scene.wires.filter((w) => !hidden.has(w.id)) : scene.wires,
      0,
      0,
    );
  // Junctions: Logisim's 8-wide dot, one path per color.
  const fills = new Map<string, Path2D>();
  const dot = (x: number, y: number, color: string) => {
    if (x < left || x > right || y < top || y > bottom) return;
    let path = fills.get(color);
    if (!path) fills.set(color, (path = new Path2D()));
    const cx = x * k + ox,
      cy = y * k + oy;
    path.moveTo(cx + 4 * k, cy);
    path.arc(cx, cy, 4 * k, 0, Math.PI * 2);
  };
  if (live) for (const d of live.dots.values()) dot(d[0], d[1], d[2]);
  else for (const d of scene.dots) dot(d.x, d.y, d.error ? ERROR : BLACK);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const [color, path] of fills) {
    fillWith(ctx, pen, color, 1);
    ctx.fill(path);
  }
  // A component the run drew is its ops in the run's state; the conditions
  // of a kind's picture do not apply to them.
  const drawPart = (part: Part, dx: number, dy: number) => {
    const ops = live?.components.get(part.id);
    replay(
      ctx,
      pen,
      ops ? compiled(ops) : part.program,
      ops ? null : part.when,
      k,
      ox + (part.x + dx) * k,
      oy + (part.y + dy) * k,
      1,
    );
  };
  for (const part of scene.parts)
    if (!hidden.has(part.id) && visible(part.ink)) drawPart(part, 0, 0);
  if (scene.broken.length) {
    const boxes = new Path2D();
    for (const { id, bounds: b } of scene.broken)
      if (!hidden.has(id) && visible(b)) {
        const x1 = centre(b.x * k + ox),
          y1 = centre(b.y * k + oy);
        boxes.rect(
          x1,
          y1,
          centre((b.x + b.width) * k + ox) - x1,
          centre((b.y + b.height) * k + oy) - y1,
        );
      }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    strokeWith(ctx, pen, brokenStyle, 1, k);
    ctx.stroke(boxes);
  }
  if (frame.moved) {
    const { delta, parts, wires } = frame.moved;
    strokeWires(wires, delta.x, delta.y);
    for (const part of parts) drawPart(part, delta.x, delta.y);
  }
  if (frame.added.length) strokeWires(frame.added, 0, 0);
  for (const ghost of frame.ghosts)
    replay(
      ctx,
      pen,
      ghost.program,
      null,
      k,
      ox + ghost.x * k,
      oy + ghost.y * k,
      ghost.alpha,
    );
  ctx.restore();
}
const brokenStyle: Style = {
  color: "#c0392b",
  alpha: 1,
  width: 1,
  cap: "butt",
  join: "miter",
  miter: 10,
  dash: [3, 2],
  phase: 0,
  font: "",
};
