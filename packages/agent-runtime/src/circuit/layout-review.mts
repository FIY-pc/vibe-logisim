/**
 * Bounded, read-only geometry feedback for any native-loaded artifact.
 *
 * Uses the runtime's measured rectangles, not the arranger's planned
 * positions. Intersections are candidates for visual review, not a
 * readability verdict. Reading paths separate electrical association from a
 * visible copper path without grading either representation.
 */
import { CircuitToolError } from "./errors.mts";

type Box = [number, number, number, number];
type Point = [number, number];

const CONTROL_ROLES = new Set([
  "clock",
  "clear",
  "preset",
  "enable",
  "chipSelect",
]);
const PASSIVE = new Set(["Tunnel", "Text", "Probe", "Splitter"]);
const SOURCES_WITHOUT_OPERATION = new Set([
  "Constant",
  "Ground",
  "Power",
  "Pull Resistor",
  "Clock",
  "Pin",
]);
const EXCLUSIVE = [
  "layoutContext",
  "componentDirectory",
  "portConnections",
  "componentIds",
  "includeNets",
  "netFormat",
  "includeWires",
  "wireOffset",
  "wireLimit",
];

export function reviewOptions(
  args: Record<string, any>,
): { issueOffset: number; artifactSha256?: string } | null {
  if (!("layoutReview" in args)) return null;
  const options = args.layoutReview;
  const offset = options?.issueOffset ?? 0;
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => key !== "issueOffset" && key !== "artifactSha256",
    ) ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "layoutReview 必须是对象；可选 issueOffset 为非负整数。",
      {
        hint: "首次查看使用 layoutReview:{}；不要填写占位摘要。",
      },
    );
  if (!args.circuit)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "layoutReview 需要指定 circuit。",
    );
  const conflicts = EXCLUSIVE.filter((key) => key in args);
  if (conflicts.length)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      `layoutReview 与以下参数冲突：${conflicts.join(", ")}。`,
      {
        hint:
          "每次只选一种观察方式。查看布局时只保留 circuit、layoutReview 和可选 candidateId；" +
          "查看元件或连接时删除 layoutReview。不需要的字段直接省略，不要填空对象、空数组或 false。",
        context: { conflictingParameters: conflicts },
      },
    );
  const digest = options.artifactSha256;
  if (
    (digest !== undefined &&
      !(typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest))) ||
    (offset > 0 && digest === undefined)
  )
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "布局问题续页需要上一页的 artifactSha256（64 位小写十六进制）。",
    );
  return { issueOffset: offset, ...(digest ? { artifactSha256: digest } : {}) };
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function box(bounds: any): Box | null {
  if (!bounds || typeof bounds !== "object") return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(finite)) return null;
  return width > 0 && height > 0 ? [x, y, x + width, y + height] : null;
}

function intersection(a: Box | null, b: Box | null) {
  if (!a || !b) return null;
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const width = Math.min(a[2], b[2]) - x;
  const height = Math.min(a[3], b[3]) - y;
  // Ignore boundary contacts and tiny protrusions at connected ports.
  return width >= 3 && height >= 3 ? { x, y, width, height } : null;
}

function attributes(component: any): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const item of component.attributes || [])
    if (item && typeof item === "object" && "name" in item)
      result[item.name] = item.standard ?? item.value;
  return result;
}

function identity(component: any) {
  const attrs = attributes(component);
  const label = String(attrs.label || attrs.text || "");
  return {
    componentId: component.componentId,
    factory: component.factoryName,
    label: label.slice(0, 160),
    labelTruncated: label.length > 160,
    location: component.location,
  };
}

function point(value: any): Point | null {
  return value && finite(value.x) && finite(value.y)
    ? [value.x, value.y]
    : null;
}

const key = (p: Point) => `${p[0]},${p[1]}`;

function bits(end: any): string | null {
  const width = end.width;
  const list = end.netBits || [];
  if (!Number.isInteger(width) || width <= 0 || list.length !== width)
    return null;
  const ordered = [...list].sort(
    (a: any, b: any) => (a.bit ?? -1) - (b.bit ?? -1),
  );
  if (ordered.some((b: any, i: number) => b.bit !== i || !b.netId)) return null;
  return ordered.map((b: any) => b.netId).join("|");
}

/** Union-find over every port and wire endpoint joined by physical copper. */
function physicalRoots(focus: any): Map<string, string> {
  const points = new Map<string, Point>();
  const add = (p: Point | null) => p && points.set(key(p), p);
  for (const c of focus.components || [])
    for (const e of c.ends || []) add(point(e.location));
  const wires = (focus.wires || []).map(
    (w: any) => [point(w.from), point(w.to)] as [Point | null, Point | null],
  );
  for (const [a, b] of wires) (add(a), add(b));
  const parent = new Map<string, string>([...points.keys()].map((k) => [k, k]));
  const root = (k: string): string => {
    let p = k;
    while (parent.get(p) !== p) {
      parent.set(p, parent.get(parent.get(p)!)!);
      p = parent.get(p)!;
    }
    return p;
  };
  const join = (a: string, b: string) => {
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const rows = new Map<number, number[]>();
  const cols = new Map<number, number[]>();
  for (const [x, y] of points.values()) {
    (rows.get(y) || rows.set(y, []).get(y)!).push(x);
    (cols.get(x) || cols.set(x, []).get(x)!).push(y);
  }
  for (const [a, b] of wires) {
    if (!a || !b) continue;
    if (a[1] === b[1]) {
      const [lo, hi] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]];
      for (const x of rows.get(a[1]) || [])
        if (x >= lo && x <= hi) join(key(a), key([x, a[1]]));
    } else if (a[0] === b[0]) {
      const [lo, hi] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]];
      for (const y of cols.get(a[0]) || [])
        if (y >= lo && y <= hi) join(key(a), key([a[0], y]));
    }
  }
  return new Map([...points.keys()].map((k) => [k, root(k)]));
}

function port(component: any, end: any) {
  const label = String(attributes(component).label || "");
  return {
    componentId: component.componentId,
    factory: component.factoryName,
    label: label.slice(0, 80),
    port: end.index,
    location: end.location,
    semanticRole: end.semanticRole ?? null,
  };
}

type Group = {
  width: number;
  outputs: [any, any][];
  inputs: [any, any][];
  rootNames: Map<string, Set<string>>;
};

export function readingPaths(focus: any) {
  const roots = physicalRoots(focus);
  const rootOf = (value: any) => {
    const p = point(value);
    return p ? (roots.get(key(p)) ?? null) : null;
  };
  const groups = new Map<string, Group>();
  let incomplete = 0;
  for (const component of focus.components || []) {
    const factory = component.factoryName;
    for (const end of component.ends || []) {
      const net = bits(end);
      if (net === null) {
        incomplete++;
        continue;
      }
      let group = groups.get(net);
      if (!group)
        groups.set(
          net,
          (group = {
            width: end.width,
            outputs: [],
            inputs: [],
            rootNames: new Map(),
          }),
        );
      if (factory === "Tunnel") {
        const label = attributes(component).label;
        if (label) {
          const root = rootOf(end.location) ?? "";
          (
            group.rootNames.get(root) ||
            group.rootNames.set(root, new Set()).get(root)!
          ).add(String(label));
        }
      } else if (!PASSIVE.has(factory)) {
        if (end.direction === "input") group.inputs.push([component, end]);
        else if (end.direction === "output")
          group.outputs.push([component, end]);
      }
    }
  }
  let named = 0;
  let wired = 0;
  let control = 0;
  let ambiguous = 0;
  const examples: any[] = [];
  for (const group of groups.values()) {
    if (group.outputs.length !== 1) {
      if (group.inputs.length) ambiguous++;
      continue;
    }
    const [source, output] = group.outputs[0];
    if (SOURCES_WITHOUT_OPERATION.has(source.factoryName)) continue;
    const start = point(output.location);
    const sourceRoot = rootOf(output.location);
    if (!start || sourceRoot === null) continue;
    for (const [sink, input] of group.inputs) {
      if (["Pin", "LED", "Hex Digit Display"].includes(sink.factoryName))
        continue;
      const finish = point(input.location);
      const targetRoot = rootOf(input.location);
      if (!finish || targetRoot === null) continue;
      if (CONTROL_ROLES.has(input.semanticRole)) {
        control++;
        continue;
      }
      if (sourceRoot === targetRoot) {
        wired++;
        continue;
      }
      const theirs = group.rootNames.get(targetRoot) || new Set<string>();
      const names = [...(group.rootNames.get(sourceRoot) || [])]
        .filter((name) => theirs.has(name))
        .sort();
      if (!names.length) continue;
      named++;
      const dx = Math.abs(start[0] - finish[0]);
      const dy = Math.abs(start[1] - finish[1]);
      // Small windows keep labels readable. Remote links remain in the
      // count but are not presented as a local-wire repair suggestion.
      if (dx > 500 || dy > 320) continue;
      const width = Math.max(320, dx + 160);
      const height = Math.max(200, dy + 120);
      examples.push({
        signals: names.slice(0, 4).map((s) => s.slice(0, 80)),
        signalCount: names.length,
        width: group.width,
        source: port(source, output),
        consumer: port(sink, input),
        portDistance: dx + dy,
        connection:
          "same ordered native bit nets; separate copper paths joined by named Tunnels",
        viewport: {
          x: Math.floor((start[0] + finish[0] - width) / 2),
          y: Math.floor((start[1] + finish[1] - height) / 2),
          width,
          height,
          scale: 1.5,
        },
      });
    }
  }
  const order = (x: any) => [
    x.portDistance,
    x.source.componentId,
    x.source.port,
    x.consumer.componentId,
    x.consumer.port,
  ];
  examples.sort((a, b) => {
    const [p, q] = [order(a), order(b)];
    for (let i = 0; i < p.length; i++)
      if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
    return 0;
  });
  const chosen: any[] = [];
  const sources = new Set<string>();
  for (const example of examples) {
    if (!sources.has(example.source.componentId))
      (chosen.push(example), sources.add(example.source.componentId));
    if (chosen.length === 6) break;
  }
  return {
    scope:
      "One definition, unique-output operation ports with identical complete ordered bit nets. " +
      "Named links require an identical Tunnel label on both copper paths. " +
      "Constants, interface sources, displays, splitter propagation and recognized control inputs excluded. " +
      "No functional importance or reading quality is inferred.",
    operationLinks: { physicalCopperOrContact: wired, namedOnly: named },
    coverage: {
      portsWithIncompleteBitMapping: incomplete,
      groupsWithoutUniqueOutput: ambiguous,
      recognizedControlInputsExcluded: control,
    },
    nearbyNamedLinks: chosen,
    nearbyNamedLinkCount: examples.length,
    question:
      "Follow a real operation through these source/consumer ports in the drawing. " +
      "Does each named hop help the reader, or hide an adjacent relationship? " +
      "Repair unclear local paths with grouping/wires or another justified representation; " +
      "retain useful remote references and protected geometry. Counts and rendering do not answer this question.",
  };
}

export function layoutReview(focus: any, issueOffset = 0) {
  const components: any[] = focus.components || [];
  const factories = new Map<string, number>();
  for (const c of components)
    factories.set(c.factoryName, (factories.get(c.factoryName) || 0) + 1);
  const entries: [Box, Box | null, any][] = [];
  let missing = 0;
  let fallback = 0;
  for (const c of components) {
    const visual = box(c.visualBounds);
    const body = box(c.bounds);
    if (!visual) fallback++;
    if (!visual && !body) {
      missing++;
      continue;
    }
    entries.push([(visual || body)!, body, c]);
  }
  entries.sort(
    (a, b) =>
      a[0][0] - b[0][0] ||
      a[0][1] - b[0][1] ||
      (a[2].componentId < b[2].componentId
        ? -1
        : a[2].componentId > b[2].componentId
          ? 1
          : 0),
  );
  let active: typeof entries = [];
  const examples: any[] = [];
  const kinds = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    const [current, body, c] = entry;
    active = active.filter((item) => item[0][2] >= current[0] + 3);
    for (const [otherBox, otherBody, other] of active) {
      const overlap = intersection(current, otherBox);
      if (!overlap) continue;
      const pair = new Set([c.factoryName, other.factoryName]);
      const labels = [...pair].filter(
        (f) => f === "Tunnel" || f === "Text",
      ).length;
      const kind =
        labels === pair.size
          ? "label-label"
          : labels
            ? "label-component"
            : intersection(body, otherBody)
              ? "component-body"
              : "visual-bounds";
      kinds.set(kind, (kinds.get(kind) || 0) + 1);
      if (total >= issueOffset && total < issueOffset + 24) {
        const x0 = Math.min(current[0], otherBox[0]) - 24;
        const y0 = Math.min(current[1], otherBox[1]) - 24;
        const x1 = Math.max(current[2], otherBox[2]) + 24;
        const y1 = Math.max(current[3], otherBox[3]) + 24;
        // A huge symbol should not shrink a local warning into an unreadable overview.
        const width = Math.max(320, Math.min(640, x1 - x0));
        const height = Math.max(180, Math.min(480, y1 - y0));
        let vx = (x0 + x1 - width) / 2;
        let vy = (y0 + y1 - height) / 2;
        if (x1 - x0 > 640) vx = overlap.x + overlap.width / 2 - width / 2;
        if (y1 - y0 > 480) vy = overlap.y + overlap.height / 2 - height / 2;
        examples.push({
          kind,
          objects: [identity(other), identity(c)],
          intersection: overlap,
          viewport: {
            x: Math.floor(vx),
            y: Math.floor(vy),
            width: Math.ceil(width),
            height: Math.ceil(height),
            scale: 1.5,
          },
        });
      }
      total++;
    }
    active.push(entry);
  }
  return {
    schema: "vibe-logisim.layout-review/v1",
    status: "observed",
    scope:
      "One definition; does not review child definitions, template preservation or behavior.",
    method:
      "Native visual/body bounding-box intersections of at least 3 units on both axes; wires excluded.",
    counts: {
      components: components.length,
      tunnels: factories.get("Tunnel") || 0,
      wireSegments: (focus.wires || []).length,
    },
    countsScope:
      "native-loaded; wire segments may be split or merged relative to serialized XML",
    bounds: focus.bounds ?? null,
    coverage: {
      measuredComponents: entries.length,
      missingBounds: missing,
      withoutNativeVisualBounds: fallback,
    },
    overlapPairs: total,
    byKind: Object.fromEntries([...kinds].sort(([a], [b]) => (a < b ? -1 : 1))),
    readingPaths: readingPaths(focus),
    issueOffset,
    examples,
    nextIssueOffset:
      issueOffset + examples.length < total
        ? issueOffset + examples.length
        : null,
    note:
      "疑似遮挡，需看原生局部图确认；外包矩形相交不一定是可见笔画相交。" +
      "包括原有/固定区域，不代表允许移动它们。0 对相交不证明组织清楚，线段/隧道数量不是评分。" +
      "examples 已限制为 24 对；viewport 可传给 render_circuit。",
  };
}
