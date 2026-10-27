/**
 * The editor picture, composed in the window: wires and junctions from the
 * document, each component from the recorded picture of its kind (see
 * `symbols.ts`), drawn with Canvas2D the way Logisim's Circuit.draw paints
 * them. Ops replay in symbol space under the view transform; strokes take the
 * offset Java2D's stroke normalization gives them, so a picture at 100% lands
 * on the same pixels as Logisim's own (docs/rendering.md).
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
type Draw =
  | { kind: "fill"; path: Path2D; rule: CanvasFillRule }
  | { kind: "stroke"; path: Path2D; shift: number }
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
/** Java's arc: degrees counterclockwise on screen, angles relative to the frame. */
function arc(
  p: Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  start: number,
  extent: number,
  pie: boolean,
) {
  const cx = x + w / 2,
    cy = y + h / 2,
    rx = w / 2,
    ry = h / 2;
  const from = (-start * Math.PI) / 180,
    to = (-(start + extent) * Math.PI) / 180;
  if (pie) p.moveTo(cx, cy);
  else p.moveTo(cx + rx * Math.cos(from), cy + ry * Math.sin(from));
  p.ellipse(cx, cy, rx, ry, 0, from, to, extent > 0);
  if (pie) p.closePath();
}
function poly(v: number[], close: boolean) {
  const p = new Path2D();
  for (let i = 0; i + 1 < v.length; i += 2)
    if (i === 0) p.moveTo(v[0], v[1]);
    else p.lineTo(v[i], v[i + 1]);
  if (close) p.closePath();
  return p;
}

const programs = new WeakMap<SymbolPicture, Program>();
/** Compiles a recorded picture once; see RecordingGraphics2D for the ops. */
export function program(picture: SymbolPicture): Program {
  const known = programs.get(picture);
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
  const push = (step: Draw) => {
    steps.push({ ...step, style, when });
    when = -1;
  };
  // Java2D normalizes strokes: lines and mitered rectangles through its
  // parallelogram pipe by 0.499 px, every other stroke by a quarter pixel.
  const solid = () => style.cap !== "round" && !style.dash.length;
  for (const op of picture.ops as Op[]) {
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
      case "L": {
        const path = new Path2D();
        path.moveTo(n(v[1]), n(v[2]));
        path.lineTo(n(v[3]), n(v[4]));
        push({ kind: "stroke", path, shift: solid() ? 0.499 : 0.25 });
        break;
      }
      case "R":
      case "r": {
        const [x, y, w, h] = [n(v[1]), n(v[2]), n(v[3]), n(v[4])];
        const path = new Path2D();
        path.rect(x, y, w, h);
        if (v[0] === "r") push({ kind: "fill", path, rule: "nonzero" });
        else
          push({
            kind: "stroke",
            path,
            shift:
              w > 0 && h > 0
                ? style.join === "miter" && !style.dash.length
                  ? 0.499
                  : 0.25
                : solid()
                  ? 0.499
                  : 0.25,
          });
        break;
      }
      case "Q":
      case "q": {
        const [x, y, w, h] = [n(v[1]), n(v[2]), n(v[3]), n(v[4])];
        if (w < 0 || h < 0) break;
        const path = new Path2D();
        roundRect(path, x, y, w, h, n(v[5]), n(v[6]));
        if (v[0] === "q") push({ kind: "fill", path, rule: "nonzero" });
        else push({ kind: "stroke", path, shift: 0.25 });
        break;
      }
      case "O":
      case "o": {
        const [x, y, w, h] = [n(v[1]), n(v[2]), n(v[3]), n(v[4])];
        if (w < 0 || h < 0) break;
        const path = new Path2D();
        path.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        if (v[0] === "o") push({ kind: "fill", path, rule: "nonzero" });
        else push({ kind: "stroke", path, shift: 0.25 });
        break;
      }
      case "A":
      case "a": {
        const [x, y, w, h] = [n(v[1]), n(v[2]), n(v[3]), n(v[4])];
        if (w < 0 || h < 0) break;
        const path = new Path2D();
        arc(path, x, y, w, h, n(v[5]), n(v[6]), v[0] === "a");
        if (v[0] === "a") push({ kind: "fill", path, rule: "nonzero" });
        else push({ kind: "stroke", path, shift: 0.25 });
        break;
      }
      case "Y":
        push({ kind: "stroke", path: poly(list(v[1]), false), shift: 0.25 });
        break;
      case "G":
        push({ kind: "stroke", path: poly(list(v[1]), true), shift: 0.25 });
        break;
      case "g":
        push({ kind: "fill", path: poly(list(v[1]), true), rule: "evenodd" });
        break;
      case "P":
        push({ kind: "stroke", path: new Path2D(String(v[1])), shift: 0.25 });
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
  const compiled = { steps, conditions, clips };
  programs.set(picture, compiled);
  return compiled;
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
  dash: number[] | null = null;
  phase = -1;
  font = "";
  reset() {
    this.fill = this.stroke = this.cap = this.join = this.font = "";
    this.alpha = this.width = this.miter = this.phase = -1;
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
  const width = style.width > 0 ? style.width : 1 / k;
  if (pen.width !== width) ctx.lineWidth = pen.width = width;
  if (pen.cap !== style.cap)
    ctx.lineCap = (pen.cap = style.cap) as CanvasLineCap;
  if (pen.join !== style.join)
    ctx.lineJoin = (pen.join = style.join) as CanvasLineJoin;
  if (pen.miter !== style.miter) ctx.miterLimit = pen.miter = style.miter;
  if (pen.dash !== style.dash) {
    ctx.setLineDash((pen.dash = style.dash));
    ctx.lineDashOffset = pen.phase = style.phase;
  }
}

function replay(
  ctx: CanvasRenderingContext2D,
  pen: Pen,
  compiled: Program,
  when: boolean[] | null,
  k: number,
  ox: number,
  oy: number,
  alpha: number,
) {
  // The stroke offset the transform carries; -1 after a step set its own.
  let applied = 0;
  const offset = (shift: number) => {
    if (applied === shift) return;
    applied = shift;
    ctx.setTransform(k, 0, 0, k, ox + shift, oy + shift);
  };
  ctx.setTransform(k, 0, 0, k, ox, oy);
  if (compiled.clips) ctx.save();
  for (const step of compiled.steps) {
    if (step.when >= 0 && !when?.[step.when]) continue;
    const style = step.style;
    switch (step.kind) {
      case "stroke":
        offset(step.shift);
        strokeWith(ctx, pen, style, style.alpha * alpha, k);
        ctx.stroke(step.path);
        break;
      case "fill":
        offset(0);
        fillWith(ctx, pen, style.color, style.alpha * alpha);
        ctx.fill(step.path, step.rule);
        break;
      case "clear":
        offset(0);
        fillWith(ctx, pen, step.color, alpha);
        ctx.fill(step.path);
        break;
      case "text":
        fillWith(ctx, pen, style.color, style.alpha * alpha);
        if (pen.font !== style.font) ctx.font = pen.font = style.font;
        if (step.matrix) {
          const [a, b, c, d] = step.matrix;
          offset(0);
          ctx.translate(step.x, step.y);
          ctx.transform(a, b, c, d, 0, 0);
          applied = -1;
          ctx.fillText(step.text, 0, 0);
        } else {
          offset(0);
          ctx.fillText(step.text, step.x, step.y);
        }
        break;
      case "image": {
        if (!step.image.complete || !step.image.naturalWidth) break;
        const m = step.matrix;
        offset(0);
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        applied = -1;
        if (pen.alpha !== style.alpha * alpha)
          ctx.globalAlpha = pen.alpha = style.alpha * alpha;
        ctx.drawImage(step.image, 0, 0);
        break;
      }
      case "clip":
        ctx.restore();
        ctx.save();
        pen.reset();
        applied = 0;
        ctx.setTransform(k, 0, 0, k, ox, oy);
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
  /** The region a running simulation's frame covers. */
  cover: Bounds | null;
}

const pens = new WeakMap<CanvasRenderingContext2D, Pen>();
const WIRE = 3;
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
  if (frame.cover) {
    const c = frame.cover;
    const outside = new Path2D();
    outside.rect(0, 0, width, height);
    outside.rect(c.x * k + ox, c.y * k + oy, c.width * k, c.height * k);
    ctx.clip(outside, "evenodd");
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  // Wires: Logisim's width-3 round stroke, its vertices normalized as Java2D does.
  const snap = (d: number) => Math.floor(d + 0.25) + 0.25;
  const strokeWires = (
    wires: { from: Point; to: Point; error?: boolean }[],
    dx: number,
    dy: number,
    color: (error: boolean) => string,
  ) => {
    const paths = new Map<string, Path2D>();
    for (const w of wires) {
      const x1 = w.from.x + dx,
        y1 = w.from.y + dy,
        x2 = w.to.x + dx,
        y2 = w.to.y + dy;
      if (
        Math.max(x1, x2) < left ||
        Math.min(x1, x2) > right ||
        Math.max(y1, y2) < top ||
        Math.min(y1, y2) > bottom
      )
        continue;
      const key = color(Boolean(w.error));
      let path = paths.get(key);
      if (!path) paths.set(key, (path = new Path2D()));
      path.moveTo(snap(x1 * k + ox), snap(y1 * k + oy));
      path.lineTo(snap(x2 * k + ox), snap(y2 * k + oy));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = pen.width = WIRE * k;
    ctx.lineCap = pen.cap = "round";
    ctx.lineJoin = pen.join = "round";
    if (pen.dash?.length !== 0) ctx.setLineDash((pen.dash = []));
    if (pen.alpha !== 1) ctx.globalAlpha = pen.alpha = 1;
    for (const [key, path] of paths) {
      ctx.strokeStyle = pen.stroke = key;
      ctx.stroke(path);
    }
  };
  const { scene, hidden } = frame;
  strokeWires(
    hidden.size ? scene.wires.filter((w) => !hidden.has(w.id)) : scene.wires,
    0,
    0,
    (error) => (error ? ERROR : "#000000"),
  );
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const error of [false, true]) {
    const path = new Path2D();
    let any = false;
    for (const dot of scene.dots) {
      if (
        dot.error !== error ||
        dot.x < left ||
        dot.x > right ||
        dot.y < top ||
        dot.y > bottom
      )
        continue;
      const cx = dot.x * k + ox,
        cy = dot.y * k + oy;
      path.moveTo(cx + 4 * k, cy);
      path.arc(cx, cy, 4 * k, 0, Math.PI * 2);
      any = true;
    }
    if (any) {
      fillWith(ctx, pen, error ? ERROR : "#000000", 1);
      ctx.fill(path);
    }
  }
  for (const part of scene.parts) {
    if (hidden.has(part.id) || !visible(part.ink)) continue;
    replay(
      ctx,
      pen,
      part.program,
      part.when,
      k,
      ox + part.x * k,
      oy + part.y * k,
      1,
    );
  }
  if (scene.broken.length) {
    ctx.setTransform(k, 0, 0, k, ox, oy);
    strokeWith(ctx, pen, { ...brokenStyle }, 1, k);
    for (const { id, bounds: b } of scene.broken)
      if (!hidden.has(id) && visible(b))
        ctx.strokeRect(b.x, b.y, b.width, b.height);
  }
  if (frame.moved) {
    const { delta, parts, wires } = frame.moved;
    strokeWires(wires, delta.x, delta.y, (error) =>
      error ? ERROR : "#000000",
    );
    for (const part of parts)
      replay(
        ctx,
        pen,
        part.program,
        part.when,
        k,
        ox + (part.x + delta.x) * k,
        oy + (part.y + delta.y) * k,
        1,
      );
  }
  if (frame.added.length) strokeWires(frame.added, 0, 0, () => "#000000");
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
