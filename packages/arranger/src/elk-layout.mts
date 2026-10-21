// The group solver: each group's parts are placed by ELK's layered algorithm
// (or stacked as a bank), then the groups are packed into rows or stages.
// Geometry only; nothing here adds or removes a connection.
import elkjs from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import { orderBanks, placeBank } from "./bank-order.mts";
import { packGroups } from "./group-packing.mts";
import { packStages } from "./stage-packing.mts";

export type Snap = (value: number) => number;
export type SolverReport = Record<string, unknown>;

// A part's fixed port, relative to the part's padded box.
export interface SolverPort {
  id: string;
  x: number;
  y: number;
  direction?: string | null;
  [key: string]: unknown;
}

// A part, as its padded box.
export interface SolverNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ports: SolverPort[];
  bankColumn?: number;
  bankFamily?: string;
  [key: string]: unknown;
}

export interface SolverGroup {
  id: string;
  label?: unknown;
  row: number;
  order: number;
  role?: string;
  layout?: string;
  columns?: number;
  bankOrder?: string;
  attachTo?: string | null;
  children: SolverNode[];
  edges: unknown[];
  x: number;
  y: number;
  width: number;
  height: number;
  readingRow?: number;
  supportOf?: string;
  stage?: string;
  heading?: string;
  [key: string]: unknown;
}

// A connection between two groups, by port id.
export interface SolverLink {
  source: string;
  target: string;
  sourceGroup: string;
  targetGroup: string;
  weight: number;
  directed?: boolean;
  distribution?: boolean;
  [key: string]: unknown;
}

export interface SolverStage {
  id: string;
  label?: unknown;
  row?: number;
  groups: string[];
  mainPath: string[];
  [key: string]: unknown;
}

export interface SolverInput {
  groups: SolverGroup[];
  links: SolverLink[];
  attachments: { group: string; source: string; target: string }[];
  stages?: SolverStage[] | null;
  groupGap: number;
  rowGap: number;
  maxRowWidth?: number | null;
  alignTop?: boolean;
}

const ELK = elkjs.default;
const elk = new ELK();
const snap: Snap = (v) => Math.ceil(v / 10) * 10;

function port(
  group: SolverGroup,
  id: string,
): { x: number; y: number; node: SolverNode; port: SolverPort } | null {
  for (const n of group.children) {
    const p = n.ports.find((p) => p.id === id);
    if (p) return { x: n.x + p.x, y: n.y + p.y, node: n, port: p };
  }
  return null;
}

export async function layoutGroups(input: SolverInput): Promise<SolverReport> {
  const groups: SolverGroup[] = [];
  let attachedBuffers = 0;
  for (const group of input.groups) {
    let graph: SolverGroup;
    if (!group.children.length) {
      groups.push({
        ...group,
        children: [],
        edges: [],
        width: 200,
        height: 80,
      });
      continue;
    }
    if (group.layout === "bank") {
      graph = { ...group, children: structuredClone(group.children) };
      placeBank(graph, snap);
    } else
      graph = (await elk.layout({
        id: group.id,
        children: structuredClone(group.children),
        edges: structuredClone(group.edges),
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.edgeRouting": "ORTHOGONAL",
          "elk.randomSeed": "1",
          "elk.spacing.nodeNode": "25",
          "elk.layered.spacing.nodeNodeBetweenLayers": "30",
          "elk.padding": "[top=55,left=20,bottom=25,right=20]",
          "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
          "elk.separateConnectedComponents": "true",
          "elk.aspectRatio": "1.5",
        },
      } as ElkNode)) as unknown as SolverGroup;
    // ELK projects ports onto the padded node border. Use the caller's
    // real inner-symbol offsets for attachment and inter-group alignment.
    for (const n of graph.children) {
      const original = group.children.find((c) => c.id === n.id) as SolverNode;
      for (const p of n.ports) {
        const q = original.ports.find((v) => v.id === p.id) as SolverPort;
        p.x = q.x;
        p.y = q.y;
      }
    }
    // Terminal buffers remain real components. Move the existing small symbol
    // toward its driver if its full reserved box still fits without overlap.
    for (const a of input.attachments.filter((a) => a.group === group.id)) {
      const s = port(graph, a.source);
      const t = port(graph, a.target);
      if (!s || !t) continue;
      if (s.port.x < s.node.width / 2 || t.port.x > t.node.width / 2) continue;
      const x = snap(s.x + 35 - t.port.x);
      const y = snap(s.y - t.port.y);
      const n = t.node;
      if (x + t.port.x <= s.x + 20) continue;
      if (
        graph.children.some(
          (c) =>
            c !== n &&
            c !== s.node &&
            x < c.x + c.width &&
            x + n.width > c.x &&
            y < c.y + c.height &&
            y + n.height > c.y,
        )
      )
        continue;
      n.x = x;
      n.y = y;
      attachedBuffers++;
    }
    graph.width = snap(
      Math.max(...graph.children.map((n) => n.x + n.width)) + 20,
    );
    graph.height = snap(
      Math.max(...graph.children.map((n) => n.y + n.height)) + 25,
    );
    groups.push({ ...group, ...graph });
  }
  const bankOrdering = orderBanks(groups, input.links);
  for (const g of groups)
    if (g.layout === "bank" && g.children.length) placeBank(g, snap);
  const packing = input.stages?.length
    ? packStages(groups, input, snap)
    : packGroups(groups, input, snap);
  return { groups, attachedBuffers, bankOrdering, ...packing };
}
