// Explicit visual groups, laid out through an injected port-aware solver.
//
// The caller supplies group membership and reading rows. They are input for one
// snapshot, never inferred from component names here. A group is not a subcircuit.
// The solver sees padded native bounds and fixed native ports; it cannot rotate,
// resize or reconnect the actual components. Native routing is still responsible
// for the emitted copper. This strategy deliberately skips global column
// compaction, which would destroy its group spacing.
import { repeatedControlNetworks } from "./control-routing.mts";
import { paddingFor } from "./grouped-geometry.mts";
import { arrangeAnnotations } from "./layout-annotations.mts";
import {
  PyKeyError,
  PyValueError,
  getOr,
  item,
  maxOf,
  minBy,
  minOf,
  pyRepr,
  pyStr,
  sorted,
  sortInPlace,
  strip,
  StopIteration,
  sum,
  toInt,
  truthy,
} from "./py.mts";
import type { Point } from "./py.mts";
import { jobKey, portMap, snap } from "./schematic-layout.mts";
import type {
  NetKey,
  PlacementStrategy,
  Port,
  Report,
  SchematicLayout,
} from "./schematic-layout.mts";
import type { Bounds, Component } from "./types.mts";

// The solver's input: per group its padded parts with fixed ports and the
// group's own edges, links between groups, optional stages and spacing.
export type GroupSolver = (graph: Report) => Promise<Report>;

const DIRECTION_RANK = new Map<unknown, number>([
  ["output", 0],
  ["inout", 1],
  ["input", 2],
]);

const CONTROL_ROLES = new Set([
  "clock",
  "clear",
  "preset",
  "enable",
  "chipSelect",
]);

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// dict.get(key, fallback) on a JSON object.
function getKey(value: Report, key: string, fallback: unknown = null): any {
  return hasOwn(value, key) ? value[key] : fallback;
}

function visualOf(c: Component): Bounds {
  return hasOwn(c, "visualBounds") ? (c.visualBounds as Bounds) : c.bounds;
}

export class GroupedPlacement implements PlacementStrategy {
  intent: Report;
  solve: GroupSolver;
  declare distribution: Set<NetKey>;
  declare copperPairs: [string, string, string][] | null;
  declare bankColumns: Map<string, number>;
  declare bankBoxes: Map<string, Bounds>;
  declare assigned: Map<string, string>;
  declare groups: Map<string, Report>;

  constructor(intent: Report, solve: GroupSolver) {
    this.intent = intent;
    this.solve = solve;
  }

  async place(layout: SchematicLayout): Promise<Map<string, Point>> {
    const groups = getKey(this.intent, "groups", []) as Report[];
    if (!truthy(groups)) throw new PyValueError("分块布局需要至少一个显式分组");
    if (
      !truthy(getKey(this.intent, "stages")) &&
      groups.some((g) => truthy(getKey(g, "attachTo")))
    )
      throw new PyValueError(
        "attachTo 需要 stages，且应指向同阶段 mainPath 内的组。",
      );
    const assigned = new Map<string, string>();
    const groupIds = new Set<string>();
    const nodes: Report[] = [];
    const members = new Map<string, string[]>();
    const seen = new Set<unknown>();
    const textIds = new Set(
      [...layout.bodyIds].filter(
        (cid) => item(layout.byId, cid).factoryName === "Text",
      ),
    );
    const legacyAnnotations = new Map<string, string>();
    groups.forEach((group, index) => {
      if (!hasOwn(group, "id")) throw new PyKeyError("'id'");
      const gid = pyStr(group.id);
      if (groupIds.has(gid)) throw new PyValueError(`重复分组: ${gid}`);
      groupIds.add(gid);
      members.set(gid, []);
      if (!hasOwn(group, "componentIds"))
        throw new PyKeyError("'componentIds'");
      for (const original of group.componentIds as unknown[]) {
        if (seen.has(original))
          throw new PyValueError(`重复元件: ${pyStr(original)}`);
        seen.add(original);
        const cid = (layout.fused.get(original as string) ??
          original) as string;
        if (!layout.bodyIds.has(cid)) {
          const part = layout.byId.get(cid);
          const reason = !part
            ? "不存在（元件 ID 以当前 inspect_circuit 的结果为准）"
            : part.factoryName === "Tunnel"
              ? "是隧道：隧道随它的网络布置，不分组"
              : layout.pinned.has(cid)
                ? "在 pinnedComponentIds 里，原地不动的元件不分组"
                : `在固定的面板里（panelBelowY=${layout.panelBelowY}：上边缘在这条线之上的元件原地不动），要布局它就去掉 panelBelowY 或把它改小`;
          throw new PyValueError(
            `分组引用的元件 ${pyStr(original)} ${reason}`,
          );
        }
        if (textIds.has(cid)) {
          legacyAnnotations.set(cid, gid);
          continue;
        }
        if (assigned.has(cid)) {
          if (assigned.get(cid) === gid) continue;
          throw new PyValueError(`元件或接触组合重复/跨组: ${pyStr(original)}`);
        }
        assigned.set(cid, gid);
        item(members, gid).push(cid);
      }
      if (
        !item(members, gid).length &&
        ![...legacyAnnotations.values()].includes(gid)
      )
        throw new PyValueError(`空分组: ${gid}`);
      nodes.push({
        id: gid,
        label: pyStr(getKey(group, "label", gid)),
        row: toInt(getKey(group, "row", 0)),
        order: index,
        role: getKey(group, "role", "main"),
        attachTo: getKey(group, "attachTo"),
        bankOrder: getKey(group, "bankOrder", "connected"),
        layout: getKey(group, "layout", "flow"),
        columns: getKey(group, "columns", 1),
        children: [],
        edges: [],
      });
    });

    // Localized constants disappear during emission. Everything else must
    // be accounted for: silently dropping an unassigned part is not a layout.
    const localized = new Set<string>();
    for (const [key, cls] of layout.classes) {
      if (cls !== "constant") continue;
      const driver = item(layout.nets, key).find(([cid]) =>
        layout.constants.has(cid),
      );
      if (driver === undefined) throw new StopIteration();
      localized.add(driver[0]);
    }
    const missing = [...layout.bodyIds].filter(
      (cid) => !assigned.has(cid) && !localized.has(cid) && !textIds.has(cid),
    );
    if (missing.length)
      throw new PyValueError("分组遗漏元件: " + sorted(missing).join(", "));

    // Explicit representation decisions are tied to an observed port, not
    // guessed from a component name. Existing signal names stay intact.
    const portNet = portMap<NetKey>();
    for (const [key, ports] of layout.nets)
      for (const p of ports) portNet.set(p, key);
    for (const link of getKey(this.intent, "namedLinks", []) as Report[]) {
      // a tuple of (componentId, port number): bools and floats compare as
      // the ints they equal, as in a dict lookup
      let port = [...(link.port as unknown[])];
      const known =
        port.length === 2 &&
        typeof port[0] === "string" &&
        (typeof port[1] === "number" || typeof port[1] === "boolean");
      const asPort = (): Port => [port[0] as string, Number(port[1])];
      if (known) port = [...(layout.piecePort?.get(asPort()) ?? port)];
      const key = known ? portNet.get(asPort()) : undefined;
      if (key === undefined)
        throw new PyValueError(`命名连接引用未知端口: ${pyRepr(port)}`);
      const label = strip(pyStr(link.label));
      if (!label || item(layout.classes, key) === "constant")
        throw new PyValueError(`不能命名该连接: ${pyRepr(port)}`);
      const existing = layout.labelsOfNet.get(key) ?? new Set<string>();
      if (existing.size && !existing.has(label))
        throw new PyValueError(`不能改写已有信号名称: ${label}`);
      if (!existing.size) {
        if (layout.usedLabels.has(label.toLowerCase()))
          throw new PyValueError(`信号名称已被其他网络使用: ${label}`);
        layout.usedLabels.add(label.toLowerCase());
        layout.labelsOfNet.set(key, new Set([label]));
        layout.labelOfNet.set(key, label);
      }
      layout.classes.set(key, "tunnel");
    }

    const byGroup = new Map<string, Report>(nodes.map((n) => [n.id, n]));
    // Repeated one-bit inputs distribute control; they are poor evidence of
    // data-flow order even when explicitly named or requested as local wire.
    // Identity comes from native factory/port, never a CLK/RST name heuristic.
    const distribution = repeatedControlNetworks(layout, assigned);
    this.distribution = distribution;
    const portIds = portMap<string>();
    const padding = new Map<string, [number, number]>();
    for (const [cid, gid] of assigned) {
      const c = item(layout.byId, cid);
      const b = c.bounds;
      const [px, py, pr, pb] = paddingFor(layout, cid, assigned);
      padding.set(cid, [px, py]);
      const node: Report = {
        id: cid,
        width: Math.ceil((b.width + px + pr) / 10) * 10,
        height: Math.ceil((b.height + py + pb) / 10) * 10,
        ports: [],
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      };
      for (const e of c.ends) {
        const p = e.location;
        const distances: [string, number][] = [
          ["WEST", Math.abs(p.x - b.x)],
          ["EAST", Math.abs(p.x - b.x - b.width)],
          ["NORTH", Math.abs(p.y - b.y)],
          ["SOUTH", Math.abs(p.y - b.y - b.height)],
        ];
        const side = minBy(distances, (d) => d[1])[0];
        const pid = `${cid}:p${e.index}`;
        portIds.set([cid, e.index], pid);
        node.ports.push({
          id: pid,
          x: p.x - b.x + px,
          y: p.y - b.y + py,
          direction: e.direction ?? null,
          bitWidth: e.width ?? null,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": side },
        });
      }
      item(byGroup, gid).children.push(node);
    }

    const endOf = (p: Port) => item(layout.byId, p[0]).ends[p[1]];
    // Both splitter directions are legal. A passive endpoint can supply
    // the layout edge toward a known input; this asserts no driver.
    const source = (ports: readonly Port[]): Port =>
      minBy(ports, (p) => [
        DIRECTION_RANK.get(endOf(p).direction ?? null) ?? 1,
        item(layout.byId, p[0]).factoryName === "Splitter" ? p[1] === 0 : false,
        p,
      ]);
    const links: Report[] = [];
    const attachments: Report[] = [];
    let number = 0;
    for (const [key, allPorts] of layout.nets) {
      const current = number++;
      const ports = allPorts.filter((p) => portIds.has(p));
      if (ports.length < 2 || item(layout.classes, key) === "constant")
        continue;
      const width = item(layout.bitsOf, key).length;
      // Do not let high-fanout clocks determine geometric hierarchy.
      if (
        distribution.has(key) ||
        (item(layout.classes, key) === "global" && width === 1)
      )
        continue;
      for (const gid of byGroup.keys()) {
        const local = ports.filter((p) => item(assigned, p[0]) === gid);
        if (local.length < 2) continue;
        const src = source(local);
        local.forEach((dst, i) => {
          if (dst[0] === src[0]) return;
          item(byGroup, gid).edges.push({
            id: `n${current}-${i}`,
            sources: [portIds.get(src)],
            targets: [portIds.get(dst)],
          });
          const sc = item(layout.byId, src[0]);
          const dc = item(layout.byId, dst[0]);
          if (
            dc.factoryName === "Buffer" &&
            dc.ends[dst[1]].direction === "input" &&
            sc.ends[src[1]].direction === "output" &&
            local.length === 2
          )
            attachments.push({
              group: gid,
              source: portIds.get(src),
              target: portIds.get(dst),
            });
        });
      }
      const src = source(ports);
      for (const dst of ports)
        if (item(assigned, src[0]) !== item(assigned, dst[0]))
          links.push({
            source: portIds.get(src),
            target: portIds.get(dst),
            sourceGroup: item(assigned, src[0]),
            targetGroup: item(assigned, dst[0]),
            directed:
              endOf(src).direction === "output" &&
              endOf(dst).direction === "input",
            weight: (width > 1 ? 3 : 1) / Math.max(1, ports.length - 1),
          });
    }
    const widthLimit = getKey(
      this.intent,
      "maxRowWidth",
      truthy(getKey(this.intent, "stages")) ? null : 3600,
    );
    const result = await this.solve({
      groups: nodes,
      links,
      attachments,
      stages: getKey(this.intent, "stages", []),
      groupGap: 100,
      rowGap: 120,
      maxRowWidth: widthLimit,
    });
    const [annotationPlan, annotationHeight] = arrangeAnnotations(
      layout,
      this.intent,
      result.groups,
      members,
      legacyAnnotations,
    );
    this.copperPairs = getKey(result, "copperPairs");
    let panelBottom = maxOf(
      layout.components
        .filter((c) => layout.isPanel(c))
        .map((c) => c.bounds.y + c.bounds.height),
      0,
    );
    panelBottom = Math.max(panelBottom, layout.panelBelowY || 0);
    const ox = 100;
    const annotationTop = snap(panelBottom + 110);
    const oy = annotationTop + annotationHeight;
    const placement = new Map<string, Point>();
    const rectangles: Report[] = [];
    for (const group of result.groups as Report[]) {
      const gid = group.id;
      if (!byGroup.has(gid))
        throw new PyValueError(`布局器返回未知分组: ${pyStr(gid)}`);
      const node = item(byGroup, gid);
      node.row = group.row;
      node.supportOf = getKey(group, "supportOf");
      node.stage = getKey(group, "stage");
      const gx = group.x + ox;
      const gy = group.y + oy;
      rectangles.push({
        id: gid,
        label: node.label,
        heading: getKey(group, "heading"),
        sourceHeading: getKey(group, "sourceHeading"),
        stage: getKey(group, "stage"),
        row: group.row,
        readingRow: getKey(group, "readingRow", group.row),
        role: node.role,
        layout: node.layout,
        columns: node.columns,
        supportOf: getKey(group, "supportOf"),
        x: snap(gx),
        y: snap(gy),
        width: group.width,
        height: group.height,
        componentIds: item(members, gid),
      });
      for (const child of group.children as Report[]) {
        const cid = child.id;
        if (
          !assigned.has(cid) ||
          assigned.get(cid) !== gid ||
          placement.has(cid)
        )
          throw new PyValueError(`布局器返回无效元件: ${pyStr(cid)}`);
        const b = item(layout.byId, cid).bounds;
        const [px, py] = item(padding, cid);
        placement.set(cid, [
          snap(gx + child.x + px - b.x),
          snap(gy + child.y + py - b.y),
        ]);
      }
    }
    this.bankColumns = new Map();
    this.bankBoxes = new Map();
    for (const g of result.groups as Report[])
      if (item(byGroup, g.id).layout === "bank")
        for (const n of g.children as Report[])
          this.bankColumns.set(n.id, getKey(n, "bankColumn", 0));
    for (const g of result.groups as Report[])
      if (item(byGroup, g.id).layout === "bank")
        for (const n of g.children as Report[])
          this.bankBoxes.set(n.id, {
            x: snap(g.x + ox + n.x),
            y: snap(g.y + oy + n.y),
            width: n.width,
            height: n.height,
          });
    if (
      placement.size !== assigned.size ||
      [...assigned.keys()].some((cid) => !placement.has(cid))
    )
      throw new PyValueError("布局器遗漏已分组元件");
    for (const entry of annotationPlan) {
      const cid = entry.componentId;
      const b = visualOf(item(layout.byId, cid));
      const x = ox + entry.x;
      const y = (entry.role === "heading" ? oy : annotationTop) + entry.y;
      placement.set(cid, [snap(x - b.x), snap(y - b.y)]);
      Object.assign(entry, { x, y });
    }
    const bottom = maxOf(rectangles.map((r) => r.y + r.height));
    const right = maxOf(rectangles.map((r) => r.x + r.width));
    sorted([...localized].filter((cid) => !assigned.has(cid))).forEach(
      (cid, i) => {
        const b = item(layout.byId, cid).bounds;
        placement.set(cid, [
          snap(100 + i * 60 - b.x),
          snap(bottom + 100 - b.y),
        ]);
      },
    );
    this.assigned = new Map(assigned);
    for (const [cid, host] of layout.fused)
      if (assigned.has(host)) this.assigned.set(cid, item(assigned, host));
    this.groups = byGroup;
    layout.placement = placement;
    layout.layer = new Map();
    nodes.forEach((g, i) => {
      for (const cid of item(members, g.id)) layout.layer.set(cid, i);
    });
    // The original added these from hash sets; the layer order of the
    // localized constants and source Text does not change the drawing.
    for (const cid of localized)
      if (!layout.layer.has(cid)) layout.layer.set(cid, -1);
    for (const cid of textIds) layout.layer.set(cid, -1);
    layout.fanWires = portMap<Port>();
    layout.shelf = [];
    layout.captions = new Map();
    layout.footer = { x: 100, y: snap(bottom + 160), row: 0, right };
    layout.bodyBottom = bottom;
    layout.sheetGap = 0;
    Object.assign(layout.report, {
      placementMethod: "explicit-groups/elk-layered/connected-interfaces",
      layoutGroups: rectangles,
      layoutStages: (getKey(result, "stageBoxes", []) as Report[]).map((s) => ({
        ...s,
        x: snap(s.x + ox),
        y: snap(s.y + oy),
      })),
      mainPathCopperPairs: this.copperPairs || [],
      autoStageWidth: getKey(result, "autoStageWidth"),
      readingTransitions: (
        getKey(result, "readingTransitions", []) as Report[]
      ).map((t) => ({
        ...t,
        fromTop: { x: snap(t.fromTop.x + ox), y: snap(t.fromTop.y + oy) },
        toTop: { x: snap(t.toTop.x + ox), y: snap(t.toTop.y + oy) },
      })),
      sourceAnnotations: annotationPlan,
      annotationOnlyGroups: [...members]
        .filter(([, ids]) => !ids.length)
        .map(([gid]) => gid),
      bankOrdering: getKey(result, "bankOrdering", []),
      rowCuts: getKey(result, "rowCuts", []),
      wrappedConnections: getKey(result, "wrappedConnections", 0),
      supportAttachments: getKey(result, "supportAttachments", []),
      groupLinks: links.length,
      rowWraps: getKey(result, "rowWraps", 0),
      maxRowWidth: widthLimit,
      attachedBuffers: getKey(result, "attachedBuffers", 0),
      moved: [...placement.values()].filter(([dx, dy]) => dx || dy).length,
    });
    return placement;
  }

  // Partition geometry, never electricity: local trees share one name.
  //
  // Called after fused pieces have expanded back to native ports. Adjacent
  // forward data-path groups may share copper; remote groups use one named
  // bridge per local tree, rather than a Tunnel on every endpoint.
  prepareRouting(layout: SchematicLayout): void {
    layout.wireTrees = new Map();
    layout.controlTrees = new Map();
    const controlReports: Report[] = [];
    const groups = this.groups;
    const assigned = this.assigned;
    // Repaired interface rails are remote connections, not a reason to
    // drag a local group's wire all the way across the sheet to its Pin.
    for (const rail of (layout.report.interfaceOrderRepairs ??
      []) as Report[]) {
      const gid = "__interface_" + rail.facing;
      groups.set(gid, { row: -1, order: -1 });
      for (const cid of rail.movedComponentIds as string[])
        assigned.set(cid, gid);
    }
    const rows = new Map<string, unknown>(
      [...groups].map(([gid, g]) => [gid, g.row]),
    );
    const orders = new Map<string, number>(
      [...groups].map(([gid, g]) => [gid, g.order]),
    );
    const endOf = (p: Port) => item(layout.byId, p[0]).ends[p[1]];
    const offset = (cid: string): Point => item(layout.placement, cid);
    const labelsOf = (key: NetKey): Set<string> =>
      layout.labelsOfNet.get(key) ?? new Set<string>();
    const localSignals = new Set(
      getKey(this.intent, "localSignals", []) as unknown[],
    );
    for (const [key, cls] of [...layout.classes]) {
      if (cls === "constant") continue;
      if ([...labelsOf(key)].some((label) => layout.keepTunnels.has(label)))
        continue;
      const ps = item(layout.nets, key).filter((p) => assigned.has(p[0]));
      if (ps.length < 2) continue;
      const width = item(layout.bitsOf, key).length;
      const explicitlyLocal = [...labelsOf(key)].some((label) =>
        localSignals.has(label),
      );
      if (
        this.distribution.has(key) &&
        truthy(getKey(this.intent, "sharedControls", true))
      ) {
        const buckets = new Map<string, [unknown[], Port[]]>();
        for (const [cid, idx] of ps) {
          const c = item(layout.byId, cid);
          const gid = item(assigned, cid);
          const [, facing] = layout.portEdge(c, idx);
          const eligible =
            this.bankColumns.has(cid) &&
            c.ends[idx].direction === "input" &&
            CONTROL_ROLES.has(c.ends[idx].semanticRole as string);
          const bucket = eligible
            ? [
                "bank",
                gid,
                item(this.bankColumns, cid),
                c.factoryName,
                idx,
                facing,
              ]
            : explicitlyLocal
              ? ["requested", gid]
              : ["single", cid, idx];
          getOr(buckets, JSON.stringify(bucket), (): [unknown[], Port[]] => [
            bucket,
            [],
          ])[1].push([cid, idx]);
        }
        const trees: Port[][] = [];
        const controls: [number, unknown[], Port[]][] = [];
        for (const [bucket, ports] of buckets.values()) {
          sortInPlace(ports, (p) => [endOf(p).location.y + offset(p[0])[1], p]);
          if (bucket[0] === "requested") trees.push(ports);
          else if (bucket[0] === "bank" && ports.length >= 3) {
            controls.push([trees.length, bucket, ports]);
            trees.push(ports);
          } else trees.push(...ports.map((p) => [p]));
        }
        if (controls.length) {
          layout.labelsFor(key);
          layout.classes.set(key, "wire");
          layout.wireTrees.set(key, trees);
          for (const [index, bucket, ports] of controls) {
            const boxes = ports.map(([cid]) => item(this.bankBoxes, cid));
            layout.controlTrees.set(jobKey("local", key, index), {
              ports,
              groupId: bucket[1] as string,
              column: bucket[2] as number,
              left: minOf(boxes.map((b) => b.x)),
              right: maxOf(boxes.map((b) => b.x + b.width)),
            });
            controlReports.push({
              groupId: bucket[1],
              column: bucket[2],
              labels: sorted(item(layout.labelsOfNet, key)),
              ports,
            });
          }
          continue;
        }
      }
      if (
        (this.distribution.has(key) || (cls === "global" && width === 1)) &&
        !explicitlyLocal
      )
        continue;
      let clusters = new Map<string, Port[]>();
      for (const p of ps)
        getOr(clusters, item(assigned, p[0]), () => []).push(p);
      const outputs = ps.filter((p) => endOf(p).direction === "output");
      if (this.copperPairs !== null) {
        // Merge only the geometry of endpoints already on this same
        // native net. A reading relationship never invents a wire.
        const roots = new Map<string, string>(
          [...clusters.keys()].map((gid) => [gid, gid]),
        );
        const root = (gid: string): string => {
          while (item(roots, gid) !== gid) gid = item(roots, gid);
          return gid;
        };
        const point = (p: Port): Point => {
          const q = endOf(p).location;
          const [dx, dy] = offset(p[0]);
          return [q.x + dx, q.y + dy];
        };
        for (const [a, b, role] of this.copperPairs) {
          if (!roots.has(a) || !roots.has(b)) continue;
          // Semantic proximity alone is not permission for a sheet-
          // spanning wire. Distant fields keep their named bridge.
          const reach = role === "main" ? 1200 : 600;
          let near = false;
          for (const p of item(clusters, a)) {
            const [x, y] = point(p);
            for (const q of item(clusters, b)) {
              const [u, v] = point(q);
              if (
                Math.abs(x - u) + Math.abs(y - v) <= reach &&
                Math.abs(y - v) <= 400
              )
                near = true;
            }
          }
          if (near) roots.set(root(b), root(a));
        }
        const merged = new Map<string, Port[]>();
        for (const [gid, ports] of clusters)
          getOr(merged, root(gid), () => []).push(...ports);
        clusters = merged;
      } else if (outputs.length && width > 1) {
        const sg = item(assigned, outputs[0][0]);
        for (const tg of [...clusters.keys()])
          if (
            tg !== sg &&
            item(rows, tg) === item(rows, sg) &&
            item(orders, tg) === item(orders, sg) + 1
          ) {
            const moved = item(clusters, tg);
            clusters.delete(tg);
            item(clusters, sg).push(...moved);
          }
      }
      const trees: Port[][] = [];
      for (const ports of clusters.values()) {
        sortInPlace(ports, (p) => [
          endOf(p).direction !== "output",
          endOf(p).location.x + offset(p[0])[0],
          p,
        ]);
        trees.push(ports);
      }
      if (trees.length === 1 && trees[0].length < 2) continue;
      // Unnamed remote branches get the existing native-derived name.
      if (trees.length > 1) layout.labelsFor(key);
      layout.classes.set(key, "wire");
      layout.wireTrees.set(key, trees);
    }
    layout.report.hybridNetworks = [...layout.wireTrees.values()].filter(
      (ts) => ts.length > 1 && ts.some((t) => t.length > 1),
    ).length;
    layout.report.sharedControls = {
      trees: controlReports,
      plannedLabelReduction: sum(controlReports.map((c) => c.ports.length - 1)),
    };
    const isProtected = (key: NetKey): boolean =>
      [...labelsOf(key)].some((label) => layout.keepTunnels.has(label));
    const protectedNets = [...layout.nets.keys()].filter(isProtected);
    layout.report.representationChoices = {
      stages: (getKey(this.intent, "stages", []) as unknown[]).length,
      namedOnlyNetworks: protectedNets.length,
      sharedControlsEnabled: getKey(this.intent, "sharedControls", true),
      controlNetworksExcludedByKeepTunnels: protectedNets.filter((key) =>
        this.distribution.has(key),
      ).length,
      annotationOnlyGroups: layout.report.annotationOnlyGroups,
      note:
        "Named-only protection suppresses local wire trees and bank rails on those nets. " +
        "Zero wire crossings can therefore mean more name-based tracing, not better readability. " +
        "Annotation-only groups contain no electrical path.",
    };
  }
}
