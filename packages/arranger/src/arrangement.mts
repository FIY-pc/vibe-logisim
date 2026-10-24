// Re-place and physically wire a circuit in one operation, and the structural
// proof that the result may stand in for the source.
//
// Routing is a global optimisation. Asking a model to place and route one net
// per tool call makes every later net thread through the leftovers of earlier
// ones, and in practice the model gives up and hand-writes a router that does
// not know Logisim's rules. Arranging is a single deterministic compilation
// step with a structural proof:
//
//   classify nets -> layered placement -> ordered global routing -> emit
//   (arrange) -> native re-observation (the caller) -> netlist equivalence
//   (every {port} group sharing a net is identical before/after, ports of
//   unknown width such as Probes included; constants, Grounds and Powers
//   compared per driven port) -> same instance for every circuit that uses
//   this one -> nothing else in the file changed (verifyArrangement).
//
// This optional operation realizes the caller's organization and geometric
// parameters. Direct file editing and other layout strategies remain
// available.
import { regionSegment } from "./fixed-geometry.mts";
import { flowIneligible, flowLayout, flowVariants } from "./flow-layout.mts";
import { GroupedPlacement } from "./grouped-layout.mts";
import type { GroupSolver } from "./grouped-layout.mts";
import { solveGroups } from "./layout-solver.mts";
import { assertFloatingIsolation, looseWireGeometry } from "./loose-wires.mts";
import {
  annotateGroups,
  layoutOptions,
  normalizeOrganization,
} from "./organization.mts";
import {
  getOr,
  item,
  pyEq,
  pyInt,
  PyValueError,
  pyStr,
  sortBy,
  sorted,
  StopIteration,
  strCmp,
  strip,
  toInt,
  truthy,
} from "./py.mts";
import type { Point } from "./py.mts";
import {
  attr,
  CONSTANT_SOURCES,
  interfaceSignature,
  loc,
  resolveUnknownWidths,
  SchematicLayout,
  TUNNEL_SPAN,
} from "./schematic-layout.mts";
import type { Report } from "./schematic-layout.mts";
import { predictedFocus, readability } from "./readability.mts";
import type { Readability } from "./readability.mts";
import { CircuitToolError } from "./tool-errors.mts";
import type { Focus, Wire } from "./types.mts";
import { circuitSpan, parseXml, serialize } from "./xml.mts";
import type { XmlElement } from "./xml.mts";

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// dict.get(key) on a JSON object.
function getKey(value: Report, key: string, fallback: unknown = null): any {
  return hasOwn(value, key) ? value[key] : fallback;
}

// The integers of a coordinate attribute, as re.findall(r"-?\d+") reads them.
function numbers(text: string | null): number[] {
  if (text === null)
    throw new TypeError("expected string or bytes-like object, got 'NoneType'");
  return (text.match(/-?[0-9]+/g) ?? []).map(pyInt);
}

// The definitions of the two files read last, parsed once: checking an
// arrangement reads the file before and after it many times. Shared, so
// readers must not change them.
const parsed = new Map<string, Map<string | null, XmlElement>>();
function circuitElement(xml: string, circuit: string): XmlElement {
  let circuits = parsed.get(xml);
  if (!circuits) {
    circuits = new Map();
    for (const c of parseXml(xml).findall("circuit"))
      if (!circuits.has(c.get("name"))) circuits.set(c.get("name"), c);
    parsed.set(xml, circuits);
    if (parsed.size > 2) parsed.delete(parsed.keys().next().value!);
  }
  const element = circuits.get(circuit);
  if (element === undefined) throw new StopIteration();
  return element;
}

// Whether the file outside this definition's text is unchanged.
export function outsideUnchanged(
  before: string,
  after: string,
  circuit: string,
): boolean {
  const outside = (xml: string): string => {
    const span = circuitSpan(xml, circuit);
    return span === null ? xml : xml.slice(0, span[0]) + xml.slice(span[1]);
  };
  return outside(before) === outside(after);
}

// What an instance of the definition looks like from outside (see
// interfaceSignature); `identify` maps a Pin location to a stable identity.
// Equal results mean every circuit using the definition sees the same ports.
export function interfaceOf(
  xml: string,
  circuit: string,
  identify?: (p: Point) => unknown,
): unknown[] {
  return interfaceSignature(circuitElement(xml, circuit), identify);
}

// A part's identity across the rearrangement: its (location, factory).
type Placed = readonly [Point, string | null];
const placedKey = (p: Point, factory: string | null): string =>
  `${p[0]},${p[1]}\u0000${factory}`;

// (original location, factory) -> ordinal, for non-Tunnel, non-constant parts.
export type IdentityMap = Map<string, { placed: Placed; ordinal: number }>;

export function identityMap(xml: string, circuit: string): IdentityMap {
  const identity: IdentityMap = new Map();
  let k = 0;
  for (const el of circuitElement(xml, circuit).findall("comp")) {
    const factory = el.get("name");
    if (factory === "Tunnel" || CONSTANT_SOURCES.includes(factory as string))
      continue;
    const p = loc(el.get("loc"));
    const entry = identity.get(placedKey(p, factory));
    if (entry !== undefined) entry.ordinal = k;
    else
      identity.set(placedKey(p, factory), { placed: [p, factory], ordinal: k });
    k += 1;
  }
  return identity;
}

// One group of ports sharing a net: the ports as (identity, port index) and
// the (value, width) of the constants driving it. An identity is an ordinal
// of the identity map, or ["?", [location, factory]] for an unknown part.
export interface NetGroup {
  ports: [unknown, number][];
  constants: [string, unknown][];
}

// The set of net groups of a circuit, by canonical key.
export type NetlistSignature = Map<string, NetGroup>;

const canonical = <T,>(items: Iterable<T>): T[] =>
  [...items]
    .map((v) => JSON.stringify(v))
    .sort()
    .map((v) => JSON.parse(v) as T);

// `movedMap` names an arranged part by its original (location, factory).
export function netlistSignature(
  focus: Focus,
  identity: IdentityMap,
  movedMap: ReadonlyMap<string, Placed> | null = null,
): NetlistSignature {
  const ident = new Map<string, unknown>();
  for (const comp of focus.components) {
    if (
      comp.factoryName === "Tunnel" ||
      CONSTANT_SOURCES.includes(comp.factoryName)
    )
      continue;
    let key: Placed = [[comp.location.x, comp.location.y], comp.factoryName];
    if (movedMap !== null) key = movedMap.get(comp.componentId) ?? key;
    let i: unknown = identity.get(placedKey(key[0], key[1]))?.ordinal;
    if (i === undefined) {
      const at = key[0];
      const same = [...identity.values()].find(
        (v) => v.placed[0][0] === at[0] && v.placed[0][1] === at[1],
      );
      i = same !== undefined ? same.ordinal : ["?", key];
    }
    ident.set(comp.componentId, i);
  }
  const groups = new Map<string, Map<string, [unknown, number]>>();
  const constDriven = new Map<string, Map<string, [string, unknown]>>();
  for (const comp of focus.components) {
    for (const e of comp.ends) {
      const bits = e.netBits || [];
      if (!bits.length) continue;
      // ordered (bit, thread) vector: same threads in another bit order is another net
      const key = JSON.stringify(
        sortBy(bits, (b) => b.bit).map((b) => [b.bit, b.netId]),
      );
      if (CONSTANT_SOURCES.includes(comp.factoryName)) {
        // a Ground or Power drives its fixed value like a Constant
        const val =
          comp.factoryName === "Constant"
            ? attr(comp, "value")
            : comp.factoryName;
        const entry: [string, unknown] = [pyStr(val).toLowerCase(), e.width];
        const set = constDriven.get(key) ?? new Map();
        constDriven.set(key, set.set(JSON.stringify(entry), entry));
      } else if (comp.factoryName !== "Tunnel") {
        const entry: [unknown, number] = [
          item(ident, comp.componentId),
          e.index,
        ];
        const set = groups.get(key) ?? new Map();
        groups.set(key, set.set(JSON.stringify(entry), entry));
      }
    }
  }
  const result: NetlistSignature = new Map();
  const add = (
    ports: Iterable<[unknown, number]>,
    constants: Iterable<[string, unknown]>,
  ): void => {
    const group: NetGroup = {
      ports: canonical(ports),
      constants: canonical(constants),
    };
    result.set(JSON.stringify(group), group);
  };
  for (const [key, ports] of groups) {
    const consts = [...(constDriven.get(key)?.values() ?? [])];
    if (consts.length) for (const port of ports.values()) add([port], consts);
    else if (ports.size >= 2) add(ports.values(), consts);
  }
  return result;
}

// Whether `observed` copper covers every `required` segment. Physical
// coverage, so Logisim may split and merge wires as it loads them.
export function copperPreserved(
  required: readonly Wire[],
  observed: readonly Wire[],
): boolean {
  const lines = new Map<string, [number, number][]>();
  const segment = (wire: Wire): [string, [number, number]] => {
    const a = wire.from;
    const b = wire.to;
    if (a.y === b.y) return [`h${a.y}`, a.x <= b.x ? [a.x, b.x] : [b.x, a.x]];
    if (a.x === b.x) return [`v${a.x}`, a.y <= b.y ? [a.y, b.y] : [b.y, a.y]];
    throw new PyValueError("非正交导线");
  };
  for (const wire of observed) {
    const [key, interval] = segment(wire);
    getOr(lines, key, () => []).push(interval);
  }
  for (const wire of required) {
    const [key, interval] = segment(wire);
    let [start, end] = interval;
    for (const [lo, hi] of sorted(lines.get(key) ?? [])) {
      if (lo > start) break;
      start = Math.max(start, hi);
      if (start >= end) break;
    }
    if (start < end) return false;
  }
  return true;
}

// The XML of the definition's components named by (factory, loc attribute),
// as ElementTree writes them in us-ascii with whitespace-only text and tails
// dropped, sorted.
export function protectedNodes(
  xml: string,
  circuit: string,
  fixed: Iterable<readonly [string, string]>,
): string[] {
  const keys = new Set(
    [...fixed].map(([factory, at]) => `${factory}\u0000${at}`),
  );
  const nodes: string[] = [];
  for (const shared of circuitElement(xml, circuit).findall("comp")) {
    if (
      shared.get("name") === null ||
      !keys.has(`${shared.get("name")}\u0000${shared.get("loc")}`)
    )
      continue;
    const node = shared.clone();
    for (const child of node.iter()) {
      child.tail = null;
      if (child.text !== null && !strip(child.text)) child.text = null;
    }
    nodes.push(serialize(node, true));
  }
  return nodes.sort(strCmp);
}

export interface ArrangeRequest {
  // The whole .circ file.
  xml: string;
  // The definition to arrange.
  circuit: string;
  // Its native observation. Ports of unknown width are resolved in place;
  // nothing else is changed. Keep it for verifyArrangement.
  focus: Focus;
  // The arrangement arguments: organization, pinnedComponentIds, keepTunnels,
  // localiseConstants, panelBelowY, columnGap, maxLayerSpan, tunnelSpan.
  // Other keys are ignored.
  options?: Report;
  // The group solver an organization is laid out with (default solveGroups).
  solve?: GroupSolver;
}

export interface Arrangement {
  circuit: string;
  // The file and observation the arrangement started from.
  source: string;
  focus: Focus;
  // The file with this definition rearranged; every other byte unchanged.
  xml: string;
  report: Report;
  // componentId -> [dx, dy] of every part the engine placed.
  placement: Map<string, Point>;
  // Copper kept in place: fixed region, loose wires and their anchors.
  keptWires: Wire[];
  panelBelowY: number | null;
  // Source parts kept in place: pinned, loose-wire anchors and panel.
  fixedComponentIds: Set<string>;
  // The observation the arranged file should load as (predictedFocus or the
  // flow layout's own), for choosing a layout before the host sees it.
  // Callers that rebuild an arrangement from a worker's message omit it.
  predicted?: Focus;
}

// Options that ask for what only the column engine does.
const COLUMN_OPTIONS = [
  "organization",
  "pinnedComponentIds",
  "keepTunnels",
  "panelBelowY",
  "columnGap",
  "maxLayerSpan",
  "tunnelSpan",
];

// Rearranges one definition. A small definition arranged without column
// options is laid out by signal flow (FLOW_VARIANTS) and by the column
// engine, and the layout predicted to read best is returned
// (report.candidates lists them all); anything else goes to the column
// engine. An explicit
// organization the engine cannot realize is an INVALID_LAYOUT_ORGANIZATION
// error the caller can correct.
export async function arrange(request: ArrangeRequest): Promise<Arrangement> {
  const { xml, circuit, focus } = request;
  const options = request.options ?? {};
  resolveUnknownWidths(focus);
  const asked = COLUMN_OPTIONS.filter((k) => {
    const value = getKey(options, k);
    return value !== null && !(Array.isArray(value) && !value.length);
  });
  if (asked.length || flowIneligible(focus) !== null) {
    const columns = await columnArrangement(request);
    columns.report.engine = "columns";
    return columns;
  }
  const candidates: Arrangement[] = [];
  const tried: Report[] = [];
  const parts = focus.components.filter((c) => c.factoryName !== "Tunnel");
  for (const variant of flowVariants(parts.length)) {
    const flow = await flowLayout(xml, circuit, focus, variant);
    if ("skipped" in flow) {
      tried.push({
        engine: "flow",
        variant: variant.name,
        skipped: flow.skipped,
      });
      continue;
    }
    candidates.push({
      circuit,
      source: xml,
      focus,
      xml: flow.xml,
      report: flow.report,
      placement: flow.placement,
      keptWires: [],
      panelBelowY: null,
      fixedComponentIds: new Set(),
      predicted: flow.predicted,
    });
  }
  try {
    const columns = await columnArrangement(request);
    columns.report.engine = "columns";
    candidates.push(columns);
  } catch (error) {
    if (!candidates.length) throw error;
    tried.push({
      engine: "columns",
      skipped: error instanceof Error ? error.message : String(error),
    });
  }
  let best: Arrangement | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const { score } = readability(candidate.predicted!);
    tried.push({
      engine: candidate.report.engine,
      ...(candidate.report.variant
        ? { variant: candidate.report.variant }
        : {}),
      score,
    });
    if (score < bestScore) [best, bestScore] = [candidate, score];
  }
  best!.report.candidates = tried;
  return best!;
}

// The column engine: stages, groups, tunnels for long spans, panels.
async function columnArrangement(
  request: ArrangeRequest,
): Promise<Arrangement> {
  const { xml, circuit, focus } = request;
  const options = request.options ?? {};
  const organization = getKey(options, "organization");
  const layoutArgs = layoutOptions(options);
  if (organization !== null)
    layoutArgs.placementStrategy = new GroupedPlacement(
      normalizeOrganization(organization),
      request.solve ?? solveGroups,
    );
  const layout = new SchematicLayout(xml, circuit, focus, layoutArgs);
  if (getKey(options, "columnGap") !== null)
    layout.columnGap = toInt(options.columnGap);
  if (getKey(options, "maxLayerSpan") !== null)
    layout.maxLayerSpan = toInt(options.maxLayerSpan);
  // px from driver to consumer above which a named 1-consumer net is
  // tunnelled (default TUNNEL_SPAN[1]); the fan-out steps scale with it
  if (getKey(options, "tunnelSpan") !== null)
    layout.tunnelSpanScale = toInt(options.tunnelSpan) / item(TUNNEL_SPAN, 1);
  let after: string;
  try {
    after = await layout.emit();
  } catch (error) {
    if (organization === null || !(error instanceof PyValueError)) throw error;
    throw new CircuitToolError("INVALID_LAYOUT_ORGANIZATION", error.message, {
      hint: "按相同保护/常量选项重新读取 layoutContext，完整分组列出的元件；不要分组固定对象、Tunnel 或拆开接触组合。",
    });
  }
  if (organization !== null)
    after = annotateGroups(
      after,
      circuit,
      layout.report.layoutGroups,
      getKey(layout.report, "layoutStages", []),
    );
  return {
    circuit,
    source: xml,
    focus,
    xml: after,
    report: layout.report,
    placement: layout.placement,
    keptWires: layout.keptWires,
    panelBelowY: layout.panelBelowY,
    fixedComponentIds: new Set(
      focus.components
        .filter((c) => layout.isPanel(c))
        .map((c) => c.componentId),
    ),
    predicted: predictedFocus(after, circuit, focus, layout.placement),
  };
}

export interface ArrangementChecks {
  netGroupsCompared: number;
  // "default" or "custom": the instance appearance whose ports were checked.
  interfaceChecked: string;
  protectedWireSegments: number;
  originalRegionWireSegments: number;
  readabilityBefore: Readability;
  readabilityAfter: Readability;
}

// Accepts or rejects an arrangement. `after` is the native observation of
// arrangement.xml. A rejection is a CircuitToolError (ARRANGE_NOT_EQUIVALENT,
// ARRANGE_INTERFACE_CHANGED or ARRANGE_PROTECTED_CHANGED) whose context names
// what changed; an accepted arrangement returns its measurements.
export function verifyArrangement(
  arrangement: Arrangement,
  after: Focus,
): ArrangementChecks {
  const {
    circuit,
    source: beforeXml,
    focus: before,
    xml: afterXml,
    report,
    panelBelowY: belowY,
  } = arrangement;
  resolveUnknownWidths(after);
  const identity = identityMap(beforeXml, circuit);
  const beforeSig = netlistSignature(before, identity);
  const [looseWires] = looseWireGeometry(before);
  if (!copperPreserved(looseWires, after.wires ?? []))
    throw new CircuitToolError(
      "ARRANGE_PROTECTED_CHANGED",
      "整理改变了未完成导线或独立画线，候选已拒绝。",
    );
  try {
    assertFloatingIsolation(before, after);
  } catch (error) {
    if (!(error instanceof PyValueError)) throw error;
    throw new CircuitToolError("ARRANGE_PROTECTED_CHANGED", error.message);
  }
  const origOf = new Map<string, Placed>();
  for (const comp of before.components) {
    const [dx, dy] = arrangement.placement.get(comp.componentId) ?? [0, 0];
    const moved: Point = [comp.location.x + dx, comp.location.y + dy];
    origOf.set(placedKey(moved, comp.factoryName), [
      [comp.location.x, comp.location.y],
      comp.factoryName,
    ]);
  }
  const movedMap = new Map<string, Placed>();
  for (const comp of after.components) {
    const orig = origOf.get(
      placedKey([comp.location.x, comp.location.y], comp.factoryName),
    );
    if (orig !== undefined) movedMap.set(comp.componentId, orig);
  }
  const afterSig = netlistSignature(after, identity, movedMap);
  const lost = [...beforeSig]
    .filter(([key]) => !afterSig.has(key))
    .map(([, group]) => group);
  const gained = [...afterSig]
    .filter(([key]) => !beforeSig.has(key))
    .map(([, group]) => group);
  const invalid = (after.wireBundles ?? [])
    .filter((b) => !truthy(hasOwn(b, "valid") ? b.valid : true))
    .map((b) => b.bundleId);
  if (lost.length || gained.length || invalid.length) {
    // Name the groups so the caller knows WHICH net changed (label,
    // factories, ports) instead of guessing parameters.
    const nameOf = new Map(
      [...identity.values()].map((v) => [v.ordinal, v.placed]),
    );
    const describe = (group: NetGroup): Report => {
      const items: Report[] = [];
      for (const [identKey, port] of sortBy(group.ports, (p) => pyStr(p))) {
        const known =
          typeof identKey === "number" ? nameOf.get(identKey) : undefined;
        const [at, factory] = known ?? [[null, null], pyStr(identKey)];
        const comp = before.components.find(
          (c) =>
            c.location.x === at[0] &&
            c.location.y === at[1] &&
            c.factoryName === factory,
        );
        items.push({
          factory,
          label: comp ? attr(comp, "label") : null,
          port,
          location: at[0] !== null ? { x: at[0], y: at[1] } : null,
        });
      }
      const labels = new Set<string>();
      for (const c of before.components) {
        if (c.factoryName !== "Tunnel") continue;
        for (const e of c.ends) {
          const t = attr(c, "label");
          if (
            t &&
            items.some(
              (i) =>
                i.location &&
                e.location.x === i.location.x &&
                e.location.y === i.location.y,
            )
          )
            labels.add(t);
        }
      }
      return {
        ports: items.slice(0, 8),
        tunnelLabels: sorted(labels).slice(0, 4),
        constants: sorted(group.constants),
      };
    };
    throw new CircuitToolError(
      "ARRANGE_NOT_EQUIVALENT",
      `整理结果的连通性与原电路不一致（丢失 ${lost.length} 组、新增 ${gained.length} 组、无效线束 ${invalid.length}），已丢弃。`,
      {
        hint: "下面列出了改变的网络（端口与 Tunnel 标签）。可以把这些标签加入 keepTunnels 让它们保留 Tunnel 后重试；同时请把该电路和这份报告反馈给维护者，这是布局引擎的缺陷。",
        context: {
          lost: lost.slice(0, 6).map(describe),
          gained: gained.slice(0, 6).map(describe),
          invalidBundles: invalid.length,
          report,
        },
      },
    );
  }
  // The netlist above is this circuit's inside. Circuits that use it see
  // its instance: the same ports in the same places, wired to the same Pins.
  const interfaceBefore = interfaceOf(beforeXml, circuit);
  const interfaceAfter = interfaceOf(
    afterXml,
    circuit,
    (p) => (origOf.get(placedKey(p, "Pin")) ?? [[null, null], null])[0],
  );
  if (!pyEq(interfaceBefore, interfaceAfter)) {
    const pins = sortBy(
      before.components
        .filter((c) => c.factoryName === "Pin")
        .map((c) => ({ componentId: c.componentId, label: attr(c, "label") })),
      (p) => p.componentId,
    );
    throw new CircuitToolError(
      "ARRANGE_INTERFACE_CHANGED",
      "整理会改变这个电路作为子电路时的引脚排列（使用它的电路里端口会对不上），已丢弃。",
      {
        hint:
          "没有自定义外观的电路，子电路实例的端口按引脚的位置排序。把这些引脚的元件 ID 加入 pinnedComponentIds 让它们原地不动后重试；" +
          "同时请把该电路和这份报告反馈给维护者，这是布局引擎的缺陷。",
        context: {
          appearance: interfaceBefore[0],
          pins: pins.slice(0, 48),
          report,
        },
      },
    );
  }
  if (!outsideUnchanged(beforeXml, afterXml, circuit))
    throw new CircuitToolError(
      "ARRANGE_NOT_EQUIVALENT",
      "整理改动了目标电路之外的内容，已丢弃。",
      {
        hint: "这是布局引擎的缺陷，请把该电路反馈给维护者。",
      },
    );
  // Explicit pins and the detected panel must keep their actual XML,
  // not merely remain electrically equivalent after being rearranged.
  const fixed = before.components
    .filter((c) => arrangement.fixedComponentIds.has(c.componentId))
    .map((c): [string, string] => [
      c.factoryName,
      `(${c.location.x},${c.location.y})`,
    ]);
  if (belowY !== null)
    for (const c of after.components)
      if (c.bounds.y < belowY)
        fixed.push([c.factoryName, `(${c.location.x},${c.location.y})`]);
  if (
    !pyEq(
      protectedNodes(beforeXml, circuit, fixed),
      protectedNodes(afterXml, circuit, fixed),
    )
  )
    throw new CircuitToolError(
      "ARRANGE_PROTECTED_CHANGED",
      "整理改变了固定对象，候选已拒绝。",
    );
  // Independent baseline from source XML, not the router's selected subset.
  const originalRegion: Wire[] = [];
  for (const node of circuitElement(beforeXml, circuit).findall("wire")) {
    const [from, to] = ["from", "to"].map((key) => {
      const [x, y] = numbers(node.get(key));
      return { x, y };
    });
    const clipped = regionSegment({ from, to }, belowY);
    if (clipped) originalRegion.push(clipped);
  }
  if (
    !copperPreserved(
      [...originalRegion, ...arrangement.keptWires],
      after.wires ?? [],
    )
  )
    throw new CircuitToolError(
      "ARRANGE_PROTECTED_CHANGED",
      "整理改变了固定区域内部的导线，候选已拒绝。",
    );
  const afterRegion: Wire[] = [];
  for (const wire of after.wires ?? []) {
    const clipped = regionSegment(wire, belowY);
    if (clipped) afterRegion.push(clipped);
  }
  if (!copperPreserved(afterRegion, originalRegion))
    throw new CircuitToolError(
      "ARRANGE_PROTECTED_CHANGED",
      "整理在固定区域内新增了导线，候选已拒绝。",
    );
  return {
    netGroupsCompared: beforeSig.size,
    interfaceChecked: interfaceBefore[0] as string,
    protectedWireSegments: arrangement.keptWires.length,
    originalRegionWireSegments: originalRegion.length,
    readabilityBefore: readability(before),
    readabilityAfter: readability(after),
  };
}
