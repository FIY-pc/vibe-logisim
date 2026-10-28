// A drawing written into the file, and the observation it should load as.
//
// Moved parts get their new locations; Tunnels and constants the layout
// replaced are removed and the new ones written; every wire is rewritten,
// split at each bend and junction (wiring.mts); group headings become real
// Text. A net that keeps a name because it reaches something that stays
// gets a Tunnel (or its constant) on that side too, where its copper ends.
import {
  estimatedGeometry,
  netKey,
  repointPins,
  spliceCircuit,
} from "./circuit.mts";
import type { Box, Point, Report } from "./circuit.mts";
import { fixedCopper } from "./fixed-geometry.mts";
import type { Drawing } from "./layout.mts";
import { FACING_TOWARD, sideOf } from "./model.mts";
import type { Model, Net } from "./model.mts";
import { CircuitToolError } from "./tool-errors.mts";
import type { Component, Focus, Wire } from "./types.mts";
import { runsOf } from "./wiring.mts";
import { XmlElement } from "./xml.mts";

export interface Emitted {
  xml: string;
  // componentId -> [dx, dy] of every part that moved
  placement: Map<string, Point>;
  // what the file should load as, for choosing among layouts
  predicted: Focus;
  report: Report;
}

const fontSize = (font: string) => Number(font.match(/(\d+)\s*$/)?.[1] ?? 12);

// Appends `child` with the indentation the definition already uses.
function append(parent: XmlElement, child: XmlElement, indent: string): void {
  const last = parent.children.at(-1);
  if (last) {
    child.tail = last.tail;
    last.tail = indent;
  } else child.tail = parent.text;
  parent.append(child);
}

function comp(
  lib: string,
  name: string,
  at: Point,
  attributes: [string, string][],
  indent: string,
): XmlElement {
  const el = new XmlElement("comp", [
    ["lib", lib],
    ["loc", `(${at[0]},${at[1]})`],
    ["name", name],
  ]);
  if (attributes.length) {
    el.text = indent + "  ";
    attributes.forEach(([k, v], i) => {
      const a = new XmlElement("a", [
        ["name", k],
        ["val", v],
      ]);
      a.tail = i + 1 < attributes.length ? indent + "  " : indent;
      el.append(a);
    });
  }
  return el;
}

function setAttribute(el: XmlElement, name: string, value: string, indent: string): void {
  const a = el.findall("a").find((a) => a.get("name") === name);
  if (a) {
    a.set("val", value);
    return;
  }
  const added = new XmlElement("a", [
    ["name", name],
    ["val", value],
  ]);
  if (el.children.length) {
    added.tail = el.children.at(-1)!.tail;
    el.children.at(-1)!.tail = indent + "  ";
  } else {
    el.text = indent + "  ";
    added.tail = indent;
  }
  el.append(added);
}

// A Tunnel or constant on the side that stays, for every piece of kept copper
// (or fixed port) of a net that keeps its name without a kept Tunnel there.
interface Attachment {
  net: Net;
  point: Point;
  facing: string;
}
function attachments(model: Model): Attachment[] {
  const result: Attachment[] = [];
  const netByKey = new Map(model.nets.map((n) => [n.key, n]));
  const cuts = new Map<Net, Point[]>();
  const fixedIds = new Set(model.fixed.keys());
  const [, found] = fixedCopper(model.focus, fixedIds, model.panelBelowY);
  const bundles = new Map((model.focus.wireBundles ?? []).map((b) => [b.bundleId, b]));
  for (const cut of found) {
    const bits = bundles.get(cut.bundleId ?? "")?.bitNets ?? [];
    const net = bits.length ? netByKey.get(netKey(bits)) : undefined;
    if (!net) continue;
    if (!cuts.has(net)) cuts.set(net, []);
    cuts.get(net)!.push(cut.point);
  }
  // pieces of kept copper
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    while (parent.has(a) && parent.get(a) !== a) a = parent.get(a)!;
    return a;
  };
  const wires = model.keptWires;
  wires.forEach((_w, i) => parent.set(`w${i}`, `w${i}`));
  const touching = (p: Point) =>
    wires
      .map((w, i) => [w, i] as const)
      .filter(([w]) =>
        w.from.x === w.to.x
          ? p[0] === w.from.x && p[1] >= Math.min(w.from.y, w.to.y) && p[1] <= Math.max(w.from.y, w.to.y)
          : p[1] === w.from.y && p[0] >= Math.min(w.from.x, w.to.x) && p[0] <= Math.max(w.from.x, w.to.x),
      )
      .map(([, i]) => `w${i}`);
  for (let i = 0; i < wires.length; i++)
    for (const end of [wires[i].from, wires[i].to])
      for (const j of touching([end.x, end.y])) {
        const [a, b] = [find(`w${i}`), find(j)];
        if (a !== b) parent.set(a, b);
      }
  const pieceOf = (p: Point) => {
    const on = touching(p);
    return on.length ? find(on[0]) : `p${p[0]},${p[1]}`;
  };
  for (const net of model.nets) {
    const named = net.kind === "tunnel" && net.fixed.length > 0;
    const constant =
      net.kind === "constant" &&
      net.fixed.length > 0 &&
      net.constant !== null &&
      model.localized.has(net.constant.componentId);
    if (!named && !constant) continue;
    const served = new Set(
      net.keptTunnels.map((t) => pieceOf([t.location.x, t.location.y])),
    );
    if (constant)
      for (const p of net.fixed)
        if (p.part.factoryName === net.constant!.factoryName) served.add(pieceOf([p.end.location.x, p.end.location.y]));
    const done = new Set<string>();
    for (const q of cuts.get(net) ?? []) {
      const piece = pieceOf(q);
      if (served.has(piece) || done.has(piece)) continue;
      done.add(piece);
      result.push({ net, point: q, facing: "north" });
    }
    for (const p of net.fixed) {
      const q: Point = [p.end.location.x, p.end.location.y];
      const piece = pieceOf(q);
      if (served.has(piece) || done.has(piece)) continue;
      done.add(piece);
      const side = sideOf(p.part, p.end);
      result.push({
        net,
        point: q,
        facing: constant && net.constant!.factoryName !== "Constant" ? side.toLowerCase() : FACING_TOWARD[side],
      });
    }
  }
  return result;
}

export function emit(model: Model, drawing: Drawing): Emitted {
  const element = model.element.clone();
  const cloneOf = new Map<XmlElement, XmlElement>();
  const pair = (a: XmlElement, b: XmlElement) => {
    cloneOf.set(a, b);
    a.children.forEach((c, i) => pair(c, b.children[i]));
  };
  pair(model.element, element);
  const first = element.children[0];
  const indent = first?.tail && /^\s*$/.test(first.tail) ? first.tail : element.text ?? "\n    ";
  const elementOf = (id: string) => cloneOf.get(model.elementOf.get(id)!)!;

  // where everything goes
  const placement = new Map<string, Point>();
  for (const [u, s] of drawing.shift) {
    for (const c of u.parts) placement.set(c.componentId, s);
    const moved = drawing.shapes.get(u)!.captionShift;
    for (const c of u.captions) {
      const [dx, dy] = moved.get(c) ?? [0, 0];
      placement.set(c.componentId, [s[0] + dx, s[1] + dy]);
    }
  }
  for (const c of model.notes) placement.set(c.componentId, drawing.notesShift.get(c.componentId) ?? [0, 0]);
  for (const h of drawing.headings)
    if (h.heading.sourceId) {
      const c = model.byId.get(h.heading.sourceId)!;
      const b = c.visualBounds ?? c.bounds;
      placement.set(c.componentId, [h.box[0] - b.x, h.box[1] - b.y]);
    }
  const movedPins = new Map<string, Point>();
  for (const [id, [dx, dy]] of placement) {
    const c = model.byId.get(id)!;
    const x = c.location.x + dx;
    const y = c.location.y + dy;
    elementOf(id).set("loc", `(${x},${y})`);
    if (c.factoryName === "Pin") movedPins.set(`${c.location.x},${c.location.y}`, [x, y]);
  }
  const appearancePortsRepointed = repointPins(element, movedPins);
  const removed = new Set<string>();
  for (const id of model.localized) removed.add(id);
  for (const t of model.tunnels) if (!model.keptTunnels.has(t.componentId)) removed.add(t.componentId);
  for (const id of removed) element.remove(elementOf(id));
  for (const w of element.findall("wire")) element.remove(w);

  // wires: kept copper, routed nets, satellite leads
  const runs: [Point, Point][] = [];
  for (const w of model.keptWires)
    runs.push([
      [w.from.x, w.from.y],
      [w.to.x, w.to.y],
    ]);
  for (const units of drawing.wires.values()) runs.push(...runsOf(units));
  for (const units of drawing.leads.values()) runs.push(...runsOf(units));
  const wireElements = runs.map(([a, b]) => {
    const w = new XmlElement("wire", [
      ["from", `(${a[0]},${a[1]})`],
      ["to", `(${b[0]},${b[1]})`],
    ]);
    return w;
  });
  for (const w of wireElements) append(element, w, indent);

  // new Tunnels, constants and headings
  const added: XmlElement[] = [];
  const wiring = () => {
    if (model.wiringLib === null)
      throw new CircuitToolError("ARRANGE_FAILED", "文件没有声明 #Wiring 库，无法写入 Tunnel。");
    return model.wiringLib;
  };
  const tunnel = (net: Net, at: Point, facing: string) => {
    const attributes: [string, string][] = [["facing", facing]];
    if (net.width > 1) attributes.push(["width", String(net.width)]);
    attributes.push(["label", net.label ?? ""]);
    added.push(comp(wiring(), "Tunnel", at, attributes, indent));
  };
  const constant = (net: Net, at: Point, facing: string) => {
    const el = model.elementOf.get(net.constant!.componentId)!.clone();
    el.tail = null;
    el.set("loc", `(${at[0]},${at[1]})`);
    setAttribute(el, "facing", facing, indent);
    added.push(el);
  };
  let tunnels = 0;
  let constants = 0;
  for (const [u, shape] of drawing.shapes) {
    const [dx, dy] = drawing.shift.get(u)!;
    for (const s of shape.satellites) {
      const at: Point = [s.point[0] + dx, s.point[1] + dy];
      if (s.kind === "tunnel") {
        tunnel(s.net, at, s.facing);
        tunnels++;
      } else {
        constant(s.net, at, s.facing);
        constants++;
      }
    }
  }
  const sides = attachments(model);
  for (const a of sides) {
    if (a.net.kind === "tunnel") tunnel(a.net, a.point, a.facing);
    else constant(a.net, a.point, a.facing);
  }
  for (const h of drawing.headings) {
    if (h.heading.sourceId) continue;
    if (model.baseLib === null)
      throw new CircuitToolError("LAYOUT_ANNOTATION_LIBRARY", "功能区标题需要已声明的 #Base 库。");
    const size = fontSize(h.heading.font);
    added.push(
      comp(
        model.baseLib,
        "Text",
        [h.box[0], h.box[1] + size + 5],
        [
          ["text", h.heading.text],
          ["font", h.heading.font],
          ["halign", "left"],
        ],
        indent,
      ),
    );
  }
  for (const el of added) append(element, el, indent);
  const xml = spliceCircuit(model.xml, model.circuit, element);

  // the observation it should load as
  const components: Component[] = [];
  for (const c of model.focus.components) {
    if (removed.has(c.componentId)) continue;
    const [dx, dy] = placement.get(c.componentId) ?? [0, 0];
    if (!dx && !dy) {
      components.push(c);
      continue;
    }
    const move = <T extends { x: number; y: number }>(v: T): T => ({ ...v, x: v.x + dx, y: v.y + dy });
    components.push({
      ...c,
      location: move(c.location),
      bounds: move(c.bounds),
      ...(c.visualBounds ? { visualBounds: move(c.visualBounds) } : {}),
      ends: c.ends.map((e) => ({ ...e, location: move(e.location) })),
    });
  }
  added.forEach((el, i) => {
    const m = (el.get("loc") ?? "").match(/-?\d+/g)!;
    const [x, y] = [Number(m[0]), Number(m[1])];
    const [[box], ports] = estimatedGeometry(el, x, y);
    const bounds = { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] };
    components.push({
      componentId: `predicted-${i}`,
      factoryName: el.get("name") ?? "",
      location: { x, y },
      bounds,
      visualBounds: bounds,
      attributes: el.findall("a").map((a) => ({ name: a.get("name") ?? "", value: a.get("val") ?? "" })),
      ends: ports.map(([px, py], index) => ({ index, location: { x: px, y: py }, direction: "inout" })),
    });
  });
  const wires: Wire[] = runs.map(([a, b]) => ({ from: { x: a[0], y: a[1] }, to: { x: b[0], y: b[1] } }));
  const kinds: Record<string, number> = {};
  for (const n of model.nets) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  const report: Report = {
    engine: "elk",
    variant: drawing.variant,
    units: model.units.length,
    parts: model.parts.length,
    nets: kinds,
    wires: runs.length,
    tunnelsAdded: tunnels + sides.filter((a) => a.net.kind === "tunnel").length,
    tunnelsRemoved: [...removed].filter((id) => model.byId.get(id)?.factoryName === "Tunnel").length,
    constantsLocalized: model.localized.size,
    constantCopies: constants,
    fixedComponents: model.fixed.size,
    keptWires: model.keptWires.length,
    panelBelowY: model.panelBelowY,
    headings: drawing.headings.length,
    rounds: drawing.rounds,
    elkMs: drawing.elkMs,
    appearancePortsRepointed,
  };
  if (drawing.demoted.length) report.drawnWithTunnels = drawing.demoted.slice(0, 40);
  return { xml, placement, predicted: { ...model.focus, components, wires, wireBundles: [] }, report };
}

export type { Box };
