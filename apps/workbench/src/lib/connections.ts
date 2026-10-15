import type { Bounds, Circuit, Point } from "./types";

export interface SignalBit {
  bit: number;
  netId: string | null;
}
export interface ConnectionEnd {
  index: number;
  location: Point;
  width: number | null;
  direction: string;
  semanticRole?: string | null;
  runtimeTooltip?: string | null;
  netBits: SignalBit[];
}
export interface ConnectionComponent {
  componentId: string;
  factoryName: string;
  displayName?: string;
  selector?: { label?: string | null };
  location: Point;
  bounds: Bounds;
  ends: ConnectionEnd[];
}
export interface ConnectionWire {
  wireId: string;
  from: Point;
  to: Point;
  bundleId: string | null;
}
export interface ConnectionBundle {
  bundleId: string;
  valid: boolean;
  width: number | null;
  wireIds: string[];
  bitNets: SignalBit[];
}
export interface ConnectionNet {
  netId: string;
  contacts: { componentId: string; endIndex: number; bit: number }[];
}
export interface ConnectionFocus {
  components: ConnectionComponent[];
  wires: ConnectionWire[];
  wireBundles: ConnectionBundle[];
  bitNets: ConnectionNet[];
}
export interface SignalOrigin {
  componentId: string;
  endIndex: number;
}
export interface SignalTarget {
  bits: SignalBit[];
  origin: SignalOrigin | null;
  label: string;
}
export interface ConnectionPeer {
  component: ConnectionComponent;
  end: ConnectionEnd;
  pairs: { from: number; to: number }[];
}
export type ConnectionIndex = ReturnType<typeof connectionIndex>;

export function componentName(component: ConnectionComponent) {
  return (
    component.selector?.label || component.displayName || component.factoryName
  );
}
export function portName(component: ConnectionComponent, end: ConnectionEnd) {
  const roles: Record<string, string> = {
    circuitInput: "输入引脚",
    circuitOutput: "输出引脚",
  };
  if (end.semanticRole && roles[end.semanticRole])
    return roles[end.semanticRole];
  const native = (end.runtimeTooltip || "").split(":")[0].trim();
  const register: Record<string, string> = {
    Output: "当前值 Q",
    Data: "写入值 D",
  };
  const names: Record<string, string> = {
    Output: "输出",
    Input: "输入",
    Data: "数据",
    Address: "地址",
    Clock: "时钟",
    Clear: "清零",
    Enable: "使能",
    "Chip select": "片选",
    Preset: "置位",
    Select: "选择",
    Store: "写入",
    Load: "读取",
    Carry: "进位",
  };
  return (
    (component.factoryName === "Register" && register[native]) ||
    names[native] ||
    native ||
    `端口 ${end.index}`
  );
}
export function bitRange(bits: number[]) {
  const sorted = [...new Set(bits)].sort((a, b) => a - b),
    ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i];
    let last = first;
    while (sorted[i + 1] === last + 1) last = sorted[++i];
    ranges.push(first === last ? String(first) : `${last}:${first}`);
  }
  return ranges.join(", ");
}
export function bitMapping(pairs: ConnectionPeer["pairs"]) {
  const sorted = [...pairs].sort((a, b) => a.from - b.from || a.to - b.to);
  if (!sorted.length) return "";
  if (sorted.every((p) => p.to - p.from === sorted[0].to - sorted[0].from))
    return `所选 [${bitRange(sorted.map((p) => p.from))}] → 此端口 [${bitRange(sorted.map((p) => p.to))}]`;
  return `逐位映射 ${sorted.map((p) => `${p.from}→${p.to}`).join(", ")}`;
}
/** Native bit nets account for tunnels and splitter mappings; intersections do not. */
export function connectionIndex(focus: ConnectionFocus) {
  return {
    components: new Map(focus.components.map((c) => [c.componentId, c])),
    wires: new Map(focus.wires.map((w) => [w.wireId, w])),
    nets: new Map(focus.bitNets.map((n) => [n.netId, n])),
    bundles: new Map(focus.wireBundles.map((b) => [b.bundleId, b])),
  };
}
export function connectedPorts(
  index: ConnectionIndex,
  bits: SignalBit[],
  origin: SignalOrigin | null = null,
): ConnectionPeer[] {
  const peers = new Map<string, ConnectionPeer>();
  for (const bit of bits)
    for (const contact of (bit.netId
      ? index.nets.get(bit.netId)?.contacts
      : []) || []) {
      if (
        contact.componentId === origin?.componentId &&
        contact.endIndex === origin?.endIndex
      )
        continue;
      const component = index.components.get(contact.componentId),
        end = component?.ends.find((e) => e.index === contact.endIndex);
      if (!component || !end) continue;
      const key = `${contact.componentId}:${contact.endIndex}`;
      let peer = peers.get(key);
      if (!peer) {
        peer = { component, end, pairs: [] };
        peers.set(key, peer);
      }
      if (!peer.pairs.some((p) => p.from === bit.bit && p.to === contact.bit))
        peer.pairs.push({ from: bit.bit, to: contact.bit });
    }
  return [...peers.values()];
}
export function signalTrace(
  index: ConnectionIndex,
  bits: SignalBit[],
  origin: SignalOrigin | null = null,
) {
  const peers = connectedPorts(index, bits, origin);
  const self = origin ? index.components.get(origin.componentId) : undefined;
  const end = self?.ends.find((e) => e.index === origin?.endIndex);
  const passive = (peer: ConnectionPeer) =>
    ["Tunnel", "Splitter"].includes(peer.component.factoryName);
  if (
    self &&
    end?.direction === "output" &&
    !["Tunnel", "Splitter"].includes(self.factoryName)
  ) {
    const pairs = bits.flatMap((b) =>
      (end.netBits || [])
        .filter((e) => b.netId && e.netId === b.netId)
        .map((e) => ({ from: b.bit, to: e.bit })),
    );
    if (pairs.length) peers.unshift({ component: self, end, pairs });
  }
  const sources = peers.filter(
    (p) => !passive(p) && p.end.direction === "output",
  );
  const uses = peers.filter((p) => !passive(p) && p.end.direction === "input");
  const unknown = peers.filter(
    (p) => !passive(p) && !["input", "output"].includes(p.end.direction),
  );
  const aliases = peers.filter((p) => p.component.factoryName === "Tunnel");
  const taps = peers.filter((p) => p.component.factoryName === "Splitter");
  const selected = new Set(bits.map((b) => b.bit));
  const singleSource =
    selected.size > 0 &&
    sources.length === 1 &&
    new Set(sources[0].pairs.map((p) => p.from)).size === selected.size
      ? sources[0]
      : null;
  return { peers, sources, uses, unknown, aliases, taps, singleSource };
}
export function portSignal(
  component: ConnectionComponent,
  end: ConnectionEnd,
): SignalTarget {
  return {
    bits: end.netBits,
    origin: { componentId: component.componentId, endIndex: end.index },
    label: `${componentName(component)} · ${portName(component, end)}`,
  };
}
export function wireSignal(
  index: ConnectionIndex,
  wire: ConnectionWire,
): SignalTarget | null {
  const bundle = wire.bundleId ? index.bundles.get(wire.bundleId) : undefined;
  if (!bundle?.valid || !bundle.width || !bundle.bitNets.some((b) => b.netId))
    return null;
  return {
    bits: bundle.bitNets,
    origin: null,
    label: `导线 · ${bundle.width} 位`,
  };
}
/** Geometry binds native records to revision-local edit IDs; it never infers a net. */
export function documentComponent(
  circuit: Circuit,
  native: ConnectionComponent,
) {
  const found = circuit.components.filter(
    (c) =>
      c.name === native.factoryName &&
      c.location.x === native.location.x &&
      c.location.y === native.location.y,
  );
  return found.length === 1 ? found[0] : null;
}
export function documentWire(circuit: Circuit, native: ConnectionWire) {
  const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
  const found = circuit.wires.filter(
    (w) =>
      (same(w.from, native.from) && same(w.to, native.to)) ||
      (same(w.from, native.to) && same(w.to, native.from)),
  );
  return found.length === 1 ? found[0] : null;
}
