"""Re-place and physically wire a tunnel-only circuit into a readable schematic.

Methodology (this is the part an LLM should not improvise per wire):

1. The observed netlist is the specification. Every port belongs to a net
   (the observer's per-bit netIds). Nothing below may change which ports share
   a net; that is verified after emission by re-observing the result.
2. Two kinds of objects: a *fixed panel* (the course's Pins, Probes, displays,
   text, anything the caller pins) that must not move, and the *body* that is
   free to be re-placed. Panel<->body links stay tunnels; body<->body links
   become wires.
3. Net classes: globals (huge fan-out: clock/reset/run) stay tunnels, as any
   human schematic does; constant drivers get a private Constant next to each
   consumer instead of a tunnel; everything else is wired.
4. Placement is a layered drawing (Sugiyama): layer = longest path from
   sources in the signal-flow DAG with register outputs starting a new layer
   (a pipeline stage), barycenter sweeps to reduce crossings, then tight
   grid-snapped coordinate assignment in sub-columns of bounded height.
5. Routing is global and ordered: short nets first, then longer ones detour
   around them, using the grid A* router that already knows Logisim's rules
   (never end or bend on foreign copper, never pass through a foreign port,
   prefer a cell of clearance). A net that cannot be routed keeps its tunnel
   instead of failing the whole drawing.
"""
from __future__ import annotations

from collections import defaultdict
import copy
import math
import re
import xml.etree.ElementTree as ET

from studio.domain.routing import Router, Partition

GRID = 10
PANEL_FACTORIES = {"Pin", "Probe", "Hex Digit Display", "LED", "Button", "Text", "Clock", "Pull Resistor", "RiscV Probe", "Counter", "D Flip-Flop", "Controlled Buffer", "NAND Gate"}
GLOBAL_FANOUT = 12          # >= this many ports: keep as tunnel (clock/reset/run)
ROW_GAP = 50                # vertical air between stacked components (registers carry 4 side pins + tunnels)
COLUMN_GAP = 220            # horizontal air between layers (routing channel)
MAX_STACK = 1400            # split a layer into sub-columns beyond this height


def _loc(text):
    x, y = map(int, re.findall(r"-?\d+", text))
    return x, y


def _attr(component, name):
    for item in component["attributes"]:
        if item.get("name") == name:
            return item.get("value", item.get("standard"))
    return None


def _snap(value):
    return int(round(value / GRID)) * GRID


class SchematicLayout:
    def __init__(self, xml_text, circuit_name, focus, *, pinned_ids=(), keep_tunnels=(), localise_constants=True, panel_below_y=None):
        self.tree = ET.ElementTree(ET.fromstring(xml_text))
        self.circuit = next(c for c in self.tree.getroot().findall("circuit") if c.get("name") == circuit_name)
        self.focus = focus
        self.components = focus["components"]
        self.by_id = {c["componentId"]: c for c in self.components}
        self.pinned = set(pinned_ids)
        self.keep_tunnels = set(keep_tunnels)
        self.localise_constants = localise_constants
        self.report = {"nets": {}, "moved": 0, "wires": 0, "tunnelsRemoved": 0, "tunnelsKept": 0, "constantsPlaced": 0, "unrouted": []}
        self.column_gap = COLUMN_GAP
        # A wired net may span at most this many layers (register -> logic ->
        # register = 2). Longer cross-stage signals and feedback (consumer left
        # of driver) keep their Tunnels, as in any hand-drawn schematic.
        self.max_layer_span = 2
        self.panel_below_y = panel_below_y if panel_below_y is not None else self._detect_panel()
        self.report["panelBelowY"] = self.panel_below_y
        self._bind_xml()

    def _detect_panel(self):
        """The fixed observation panel is the cluster above the largest vertical
        gap between non-tunnel components (the generated body starts below it).
        Returns the y below which components are free to move; None = no panel."""
        real = [c for c in self.components if c["factoryName"] != "Tunnel"]
        ys = sorted({c["bounds"]["y"] for c in real})
        if len(ys) < 4 or len(real) < 40:
            return None                      # small circuits have no fixed panel
        gaps = [(ys[i + 1] - ys[i], ys[i], ys[i + 1]) for i in range(len(ys) - 1)]
        gap, top, bottom = max(gaps)
        cluster = [c for c in real if c["bounds"]["y"] <= top]
        above = len(cluster)
        # A panel is a substantial cluster (course templates: 60-80 parts)
        # separated by a real gap; a 3-row full adder is not a panel + body.
        # Its size relative to the body says nothing (a 330-part CPU still has
        # the same 80-part panel); its composition does: an observation panel
        # is mostly I/O and annotation, a body slice is mostly logic.
        if gap < 150 or above < 12:
            return None
        io = sum(1 for c in cluster if c["factoryName"] in PANEL_FACTORIES)
        if above < len(real) // 4 and io * 2 < above:
            return None
        return (top + bottom) // 2

    # ---- observation -> model -------------------------------------------------
    def _bind_xml(self):
        """Pair each observed component with its XML element by location+factory."""
        elements = defaultdict(list)
        for element in self.circuit.findall("comp"):
            elements[(_loc(element.get("loc")), element.get("name"))].append(element)
        self.element_of = {}
        for c in self.components:
            key = ((c["location"]["x"], c["location"]["y"]), c["factoryName"])
            candidates = elements.get(key) or elements.get((key[0], c.get("displayName")))
            if not candidates:
                # Subcircuit instances are named after the definition.
                candidates = [e for (loc, name), es in elements.items() if loc == key[0] for e in es]
            if not candidates:
                raise ValueError(f"cannot bind observed component {c['componentId']} at {key}")
            self.element_of[c["componentId"]] = candidates.pop(0)

    def _nets(self):
        nets = defaultdict(list)           # netKey -> [(componentId, endIndex)]
        bits_of = {}
        for c in self.components:
            for e in c["ends"]:
                bits = e.get("netBits") or []
                if not bits:
                    continue
                key = tuple(sorted(b["netId"] for b in bits))
                nets[key].append((c["componentId"], e["index"]))
                bits_of.setdefault(key, sorted(bits, key=lambda b: b["bit"]))
        return nets, bits_of

    def _is_panel(self, c):
        if c["componentId"] in self.pinned:
            return True
        if self.panel_below_y is not None:
            return c["bounds"]["y"] < self.panel_below_y
        # No detected panel: everything is body. Input/output Pins then take
        # their natural place as sources on the left and sinks on the right.
        return False

    def plan(self):
        nets, bits_of = self._nets()
        tunnels = {c["componentId"]: c for c in self.components if c["factoryName"] == "Tunnel"}
        label_of_net = {}
        for key, ports in nets.items():
            for cid, _ in ports:
                if cid in tunnels:
                    label_of_net.setdefault(key, _attr(tunnels[cid], "label"))
        body = [c for c in self.components if c["factoryName"] != "Tunnel" and not self._is_panel(c)]
        body_ids = {c["componentId"] for c in body}
        constants = {c["componentId"]: c for c in body if c["factoryName"] == "Constant"}

        classes = {}
        for key, ports in nets.items():
            real = [(cid, idx) for cid, idx in ports if cid not in tunnels]
            label = label_of_net.get(key)
            body_ports = [(cid, idx) for cid, idx in real if cid in body_ids]
            drivers = [cid for cid, idx in real if cid in constants]
            if label in self.keep_tunnels:
                classes[key] = "global"
            elif self.localise_constants and len(drivers) == 1 and len(real) >= 3 and all(self.by_id[cid]["ends"][idx].get("direction") != "output" or cid in constants for cid, idx in real):
                classes[key] = "constant"
            elif len(real) >= GLOBAL_FANOUT:
                classes[key] = "global"
            elif len(body_ports) >= 2:
                classes[key] = "wire"
            else:
                classes[key] = "tunnel"
        self.nets, self.bits_of, self.classes, self.label_of_net, self.tunnels, self.body, self.constants = nets, bits_of, classes, label_of_net, tunnels, body, constants
        summary = defaultdict(int)
        for k, v in classes.items():
            summary[v] += 1
        self.report["nets"] = dict(summary)
        return classes

    # ---- placement -------------------------------------------------------------
    def _graph(self, *, all_nets=False):
        """Directed signal flow among body components.

        With all_nets the graph includes nets that stay Tunnels (globals like
        the instruction word) so stage inference sees the real dependencies;
        clock/reset/enable style nets (fan-out >= GLOBAL_FANOUT of 1-bit inputs)
        are still skipped because they do not define data-flow order.
        Splitter ports are 'inout': a splitter is a pass-through node, so an
        edge is added from every driver on its nets to it and from it to every
        consumer on its nets.
        """
        body_ids = {c["componentId"] for c in self.body}
        out_edges = defaultdict(set)
        for key, cls in self.classes.items():
            if cls == "constant":
                continue
            if not all_nets and cls != "wire":
                continue
            ports = [(cid, idx) for cid, idx in self.nets[key] if cid in body_ids]
            if len(ports) < 2:
                continue
            width = self.bits_of[key][-1]["bit"] + 1 if self.bits_of.get(key) else 1
            if cls == "global" and width == 1:
                continue
            srcs = [cid for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "output"]
            dsts = [cid for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "input"]
            pass_through = [cid for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") not in ("output", "input")]
            for s_ in srcs:
                for d in dsts + pass_through:
                    if s_ != d:
                        out_edges[s_].add(d)
            for p in pass_through:
                for d in dsts:
                    if p != d:
                        out_edges[p].add(d)
        return out_edges

    def _layers(self):
        """Signal-flow layering.

        Longest path from sources over the body graph (all nets, splitters as
        pass-through, back-edges cut by DFS) gives every part a depth.
        Registers are stage boundaries: stage(r) = longest register-to-register
        path; when registers carry stage prefixes (EX.*, MEM.*) the groups are
        ordered by median depth so bypass/feedback paths do not spread one
        stage over many columns. Layers:
            pre-register logic .......... its depth (0..K)
            register of stage s ......... K+1 + 2s
            logic driven by stage s ..... K+1 + 2s + 1
        Pure combinational circuits have no registers, so layer == depth.
        """
        out_edges = self._graph(all_nets=True)
        ids = [c["componentId"] for c in self.body]
        storage = {cid for cid in ids if self.by_id[cid]["factoryName"] in
                   ("Register", "ROM", "RAM", "Counter", "D Flip-Flop", "J-K Flip-Flop", "S-R Flip-Flop", "T Flip-Flop", "Random")}
        indeg = {u: 0 for u in ids}
        for u, vs in out_edges.items():
            for v in vs:
                if v in indeg:
                    indeg[v] += 1
        # DFS from sources (registers first so feedback into them is the cut edge)
        state, order, forward = {}, [], defaultdict(set)
        def dfs(u):
            state[u] = 1
            for v in sorted(out_edges.get(u, ())):
                if v not in indeg or state.get(v) == 1:
                    continue
                forward[u].add(v)
                if v not in state:
                    dfs(v)
            state[u] = 2
            order.append(u)
        roots = sorted(ids, key=lambda u: (u not in storage, indeg[u], u))
        for u in roots:
            if u not in state:
                dfs(u)
        depth = {u: 0 for u in ids}
        for u in reversed(order):
            for v in forward.get(u, ()):
                depth[v] = max(depth[v], depth[u] + 1)
        if not storage:
            self.stage_of = {}
            return self._compact(depth)
        # register stages: longest register->register path over the cut DAG
        reach = defaultdict(set)
        for r in storage:
            seen, stack = set(), list(forward.get(r, ()))
            while stack:
                v = stack.pop()
                if v in seen:
                    continue
                seen.add(v)
                if v in storage:
                    reach[r].add(v)
                else:
                    stack.extend(forward.get(v, ()))
        stage = {r: 0 for r in storage}
        for u in reversed(order):
            if u in storage:
                for v in reach.get(u, ()):
                    stage[v] = max(stage[v], stage[u] + 1)
        prefix_of = {}
        for r in storage:
            label = _attr(self.by_id[r], "label") or ""
            if "." in label and label.split(".", 1)[0].isalpha():
                prefix_of[r] = label.split(".", 1)[0].upper()
        if len(set(prefix_of.values())) >= 2:
            groups = defaultdict(list)
            for r, pfx in prefix_of.items():
                groups[pfx].append(stage[r])
            ordered = sorted(groups, key=lambda p_: sorted(groups[p_])[len(groups[p_]) // 2])
            rank = {p_: i for i, p_ in enumerate(ordered)}
            medians = [sorted(groups[p_])[len(groups[p_]) // 2] for p_ in ordered]
            for r in storage:
                stage[r] = rank[prefix_of[r]] if r in prefix_of else sum(1 for m in medians if m < stage[r])
        # which registers drive each combinational node (transitively, via forward)
        drivers = defaultdict(set)
        for r in storage:
            seen, stack = set(), list(forward.get(r, ()))
            while stack:
                v = stack.pop()
                if v in seen or v in storage:
                    continue
                seen.add(v)
                drivers[v].add(r)
                stack.extend(forward.get(v, ()))
        pre = [u for u in ids if u not in storage and not drivers[u]]
        K = max((depth[u] for u in pre), default=-1)
        layer = {}
        for u in ids:
            if u in storage:
                layer[u] = K + 1 + 2 * stage[u]
            elif drivers[u]:
                layer[u] = K + 1 + 2 * min(stage[r] for r in drivers[u]) + 1
            else:
                layer[u] = depth[u]
        self.stage_of = stage
        return self._compact(layer)

    @staticmethod
    def _compact(layer):
        """Renumber densely; merge single-part layers leftwards."""
        used = sorted(set(layer.values()))
        dense = {l: i for i, l in enumerate(used)}
        layer = {cid: dense[l] for cid, l in layer.items()}
        counts = defaultdict(int)
        for l in layer.values():
            counts[l] += 1
        remap, shift = {}, 0
        for l in sorted(counts):
            if counts[l] == 1 and l > 0:
                shift += 1
                remap[l] = l - shift
            else:
                remap[l] = l - shift
        return {cid: remap[l] for cid, l in layer.items()}

    def _place(self):
        layer = self._layers()
        by_layer = defaultdict(list)
        for cid, l in layer.items():
            by_layer[l].append(cid)
        adjacency = defaultdict(set)
        for key, cls in self.classes.items():
            if cls != "wire":
                continue
            ids = [cid for cid, idx in self.nets[key] if cid in layer]
            for a in ids:
                for b in ids:
                    if a != b:
                        adjacency[a].add(b)
        # initial order: by original y (keeps the author's intent when it exists)
        pos = {}
        for l, ids in by_layer.items():
            ids.sort(key=lambda cid: (self.by_id[cid]["location"]["y"], self.by_id[cid]["location"]["x"]))
            for i, cid in enumerate(ids):
                pos[cid] = i
        layers_sorted = sorted(by_layer)
        for sweep in range(12):
            seq = layers_sorted if sweep % 2 == 0 else layers_sorted[::-1]
            for l in seq:
                ids = by_layer[l]
                def bary(cid):
                    nb = [pos[n] for n in adjacency[cid] if layer.get(n) in (l - 1, l + 1)]
                    return (sum(nb) / len(nb)) if nb else pos[cid]
                ids.sort(key=lambda cid: (bary(cid), pos[cid]))
                for i, cid in enumerate(ids):
                    pos[cid] = i
        # coordinate assignment: sub-columns of bounded height per layer
        panel_bottom = max((c["bounds"]["y"] + c["bounds"]["height"] for c in self.components if self._is_panel(c)), default=0)
        panel_right = max((c["bounds"]["x"] + c["bounds"]["width"] for c in self.components if self._is_panel(c)), default=0)
        top = _snap(panel_bottom + 120)
        x_cursor = 100
        placement = {}
        for l in layers_sorted:
            ids = by_layer[l]
            columns = [[]]
            height = 0
            for cid in ids:
                h = self.by_id[cid]["bounds"]["height"] + ROW_GAP
                if height + h > MAX_STACK and columns[-1]:
                    columns.append([])
                    height = 0
                columns[-1].append(cid)
                height += h
            for column in columns:
                width = max(self.by_id[cid]["bounds"]["width"] for cid in column)
                y = top
                for cid in column:
                    c = self.by_id[cid]
                    b = c["bounds"]
                    # anchor so that the body's left edge sits on x_cursor and the
                    # component's own loc stays on the 10-grid
                    dx = _snap(x_cursor - b["x"] + (width - b["width"]) // 2)
                    dy = _snap(y - b["y"])
                    placement[cid] = (dx, dy)
                    y += b["height"] + ROW_GAP
                    y = _snap(y)
                x_cursor += width + self.column_gap
        self.placement = placement
        self.layer = layer
        self.report["moved"] = sum(1 for cid, (dx, dy) in placement.items() if dx or dy)
        demoted = 0
        for key, cls in list(self.classes.items()):
            if cls != "wire":
                continue
            ports = [(cid, idx) for cid, idx in self.nets[key] if cid in layer]
            if not ports:
                continue
            layers_ = [layer[cid] for cid, idx in ports]
            drivers = [layer[cid] for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "output"]
            consumers = [layer[cid] for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "input"]
            backward = bool(drivers and consumers and min(consumers) < max(drivers))
            if max(layers_) - min(layers_) > self.max_layer_span or backward:
                self.classes[key] = "tunnel"
                demoted += 1
        self.report["nets"]["demotedToTunnel"] = demoted
        return placement

    # ---- routing ---------------------------------------------------------------
    def _moved(self, c):
        dx, dy = self.placement.get(c["componentId"], (0, 0))
        m = copy.deepcopy(c)
        m["location"] = {"x": c["location"]["x"] + dx, "y": c["location"]["y"] + dy}
        m["bounds"] = {**c["bounds"], "x": c["bounds"]["x"] + dx, "y": c["bounds"]["y"] + dy}
        for e in m["ends"]:
            e["location"] = {"x": e["location"]["x"] + dx, "y": e["location"]["y"] + dy}
        return m

    def _port_edge(self, moved_component, idx):
        """The body edge a port sits on (as its outward Tunnel facing and the
        outward grid step), in moved coordinates."""
        end = moved_component["ends"][idx]
        px, py = end["location"]["x"], end["location"]["y"]
        b = moved_component["bounds"]
        d = {"west": px - b["x"], "east": b["x"] + b["width"] - px, "north": py - b["y"], "south": b["y"] + b["height"] - py}
        edge = min(d, key=d.get)
        facing = {"west": "east", "east": "west", "north": "south", "south": "north"}[edge]
        step = {"west": (-GRID, 0), "east": (GRID, 0), "north": (0, -GRID), "south": (0, GRID)}[edge]
        return (px, py), facing, step

    def _reanchor_plan(self):
        """Nets that stay Tunnels and have a placed body port: (labels, body
        ports) per net. emit() puts one Tunnel per label on each such port,
        chained outward on 10 px stubs; the router must keep those cells free."""
        plan = []
        for key, cls in self.classes.items():
            if cls not in ("tunnel", "global"):
                continue
            labels = sorted({_attr(self.tunnels[cid], "label") for cid, idx in self.nets[key] if cid in self.tunnels and _attr(self.tunnels[cid], "label")})
            body_ports = [(cid, idx) for cid, idx in self.nets[key] if cid not in self.tunnels and cid in self.layer]
            if labels and body_ports:
                plan.append((key, labels, body_ports))
        return plan

    @staticmethod
    def _split_at_endpoints(wires):
        """Split every segment at the interior points where another segment
        ends. Logisim merges two collinear wires that meet at a point where no
        third wire ends, so a '+' made of two branches leaving a trunk from
        opposite sides loses its junction on load; a trunk split there is a
        real 4-way node instead."""
        ends_x, ends_y = defaultdict(set), defaultdict(set)
        for a, b in wires:
            for p in (a, b):
                ends_x[p[0]].add(p[1])
                ends_y[p[1]].add(p[0])
        out = []
        for a, b in wires:
            if a[0] == b[0]:
                lo, hi = sorted((a[1], b[1]))
                cuts = sorted(y for y in ends_x.get(a[0], ()) if lo < y < hi)
                pts = [(a[0], y) for y in (lo, *cuts, hi)]
            else:
                lo, hi = sorted((a[0], b[0]))
                cuts = sorted(x for x in ends_y.get(a[1], ()) if lo < x < hi)
                pts = [(x, a[1]) for x in (lo, *cuts, hi)]
            out.extend(zip(pts, pts[1:]))
        return out

    def _route(self):
        moved = {c["componentId"]: self._moved(c) for c in self.components}
        panel_points = {(e["location"]["x"], e["location"]["y"]) for c in self.components if self._is_panel(c) for e in c["ends"]}
        body_ids = {c["componentId"] for c in self.body}
        # Tunnels to remove: on wired/constant nets, the ones standing at body
        # ports. A tunnel at a panel port stays as the panel<->body bridge.
        drop_tunnels = set()
        bridge_tunnels = set()
        for key, cls in self.classes.items():
            if cls not in ("wire", "constant"):
                continue
            ports = self.nets[key]
            # Which real ports of this net will actually be joined by wires? Only
            # placed body components (they have a layer). Anything else — panel
            # parts, pinned parts, parts the layering skipped — keeps its own
            # tunnel, and the wired group keeps exactly one tunnel as the bridge.
            wired = [(cid, idx) for cid, idx in ports if cid not in self.tunnels and cid in self.layer]
            unwired = [(cid, idx) for cid, idx in ports if cid not in self.tunnels and cid not in self.layer]
            if len(wired) < 2:
                continue                      # nothing to wire; leave all tunnels
            unwired_points = {(self.by_id[cid]["ends"][idx]["location"]["x"], self.by_id[cid]["ends"][idx]["location"]["y"]) for cid, idx in unwired}
            body_tunnels = [cid for cid, idx in ports if cid in self.tunnels
                            and (self.tunnels[cid]["location"]["x"], self.tunnels[cid]["location"]["y"]) not in unwired_points
                            and not self._is_panel(self.tunnels[cid])]
            keep = set(body_tunnels[:1]) if unwired else set()
            for cid in body_tunnels:
                if cid not in keep:
                    drop_tunnels.add(cid)
            bridge_tunnels.update(keep)
        # Router view. The observer already merged every tunnel into its net, so
        # all ports of a wired net carry identical netIds; the router would call
        # them "already connected" and route nothing. Give each port a private
        # bus id, and fold those ids back onto the real net in the ownership
        # partition so same-net copper is never treated as foreign.
        partition = Partition()
        for cid, c in moved.items():
            for e in c["ends"]:
                bits = e.get("netBits") or []
                key = tuple(sorted(b["netId"] for b in bits)) if bits else None
                # Real body ports of wired nets, plus the one bridge tunnel kept on
                # such a net, carry the net's identity; everything else is an obstacle.
                if key is not None and self.classes.get(key) == "wire" and cid not in drop_tunnels and (cid not in self.tunnels or cid in bridge_tunnels):
                    fresh = []
                    for b in sorted(bits, key=lambda b: b["bit"]):
                        synthetic = f"{b['netId']}#{cid}:{e['index']}"
                        partition.join(b["netId"], synthetic)
                        fresh.append({"bit": b["bit"], "netId": synthetic})
                    e["netBits"] = fresh
                else:
                    e["netBits"] = [{"bit": i, "netId": f"x:{cid}:{e['index']}:{i}"} for i in range(max(1, e.get("width") or 1))]
        # Localised constants become synthetic components the router knows about:
        # one per consumer port, 20 px outward from the port along the edge
        # normal, carrying the consumer's net bits so the stub is routed as a
        # normal 2-pin net (shortest first) instead of pasted blindly afterwards.
        self.synthetic_constants = []
        occupied = [c["bounds"] for cid, c in moved.items() if cid not in self.tunnels and cid not in drop_tunnels and c["factoryName"] not in ("Text", "Tunnel")]

        def collides(rect, skip=None):
            return any(o is not skip and rect["x"] < o["x"] + o["width"] and o["x"] < rect["x"] + rect["width"] and
                       rect["y"] < o["y"] + o["height"] and o["y"] < rect["y"] + rect["height"] for o in occupied)

        def constant_bounds(cx, cy, facing, body):
            # Logisim draws a Constant entirely behind its output port: facing
            # east the body spans [cx-body, cx], facing west [cx, cx+body]; the
            # port is on the body's edge, so the stub cell in front stays free.
            if facing == "east":
                return {"x": cx - body, "y": cy - 8, "width": body, "height": 16}
            if facing == "west":
                return {"x": cx, "y": cy - 8, "width": body, "height": 16}
            if facing == "south":
                return {"x": cx - body // 2, "y": cy - 16, "width": body, "height": 16}
            # north: the observer reports the body hanging below the port
            # (200,500 -> y 500..516), i.e. the label box, not the arrow side.
            return {"x": cx - body // 2, "y": cy, "width": body, "height": 16}

        def stub_bounds(px, py, cx, cy):
            # The straight stub from the port to the Constant, one grid cell thick,
            # excluding the port cell itself (which sits on the consumer's edge).
            x0, x1 = sorted((px, cx)); y0, y1 = sorted((py, cy))
            if x0 == x1:
                return {"x": x0 - 4, "y": (y0 + 1 if py == y0 else y0), "width": 8, "height": max(1, y1 - y0 - 1)}
            return {"x": (x0 + 1 if px == x0 else x0), "y": y0 - 4, "width": max(1, x1 - x0 - 1), "height": 8}

        # Consumer ports that get no local Constant (boxed in, or the stub failed
        # to route) reach the shared Constant through its label instead: emit()
        # puts a fresh labelled Tunnel on the port and on the driver.
        self.failed_constant_consumers = set()

        for key, cls in self.classes.items():
            if cls != "constant":
                continue
            driver = next(cid for cid, idx in self.nets[key] if cid in self.constants)
            drv = self.by_id[driver]
            value = _attr(drv, "value") or "0x0"
            width = drv["ends"][0]["width"] or 1
            for cid, idx in self.nets[key]:
                if cid in self.tunnels or cid == driver or self._is_panel(self.by_id[cid]):
                    continue
                end = moved[cid]["ends"][idx]
                px, py = end["location"]["x"], end["location"]["y"]
                b = moved[cid]["bounds"]
                d = {"west": px - b["x"], "east": b["x"] + b["width"] - px, "north": py - b["y"], "south": b["y"] + b["height"] - py}
                edge = min(d, key=d.get)
                dx, dy, facing = {"west": (-1, 0, "east"), "east": (1, 0, "west"), "north": (0, -1, "south"), "south": (0, 1, "north")}[edge]
                # Native Constant body: 16 px up to 8 bits, then 10 px per further
                # hex digit of the bit width (26 px at 9-12 bits ... 76 px at 29-32),
                # regardless of the value printed (measured with the observer).
                body_px = 16 + 10 * max(0, (width + 3) // 4 - 2)
                # A gate's side pins sit 10 px from a stacked neighbour, so a fixed
                # 30 px offset lands the Constant on that neighbour's body. Step
                # outward along the port normal until body and stub are clear; a
                # port boxed in on that side keeps its Tunnel rather than getting
                # a Constant pasted onto a neighbour.
                placed = None
                for step in range(3, 16):
                    cx, cy = px + dx * step * GRID, py + dy * step * GRID
                    bounds = constant_bounds(cx, cy, facing, body_px)
                    if not collides(bounds) and not collides(stub_bounds(px, py, cx, cy), skip=b):
                        placed = (cx, cy, bounds)
                        break
                if placed is None:
                    self.failed_constant_consumers.add((cid, idx))
                    continue
                cx, cy, bounds = placed
                sid = f"const:{cid}:{idx}"
                bits = [{"bit": i, "netId": f"{sid}:b{i}"} for i in range(width)]
                consumer_bits = [{"bit": i, "netId": f"{sid}:b{i}#consumer"} for i in range(width)]
                for i in range(width):
                    partition.join(f"{sid}:b{i}", f"{sid}:b{i}#consumer")
                end["netBits"] = consumer_bits
                synthetic = {"componentId": sid, "factoryName": "Constant", "location": {"x": cx, "y": cy}, "bounds": bounds,
                             "attributes": [], "ends": [{"index": 0, "location": {"x": cx, "y": cy}, "width": width, "direction": "output", "netBits": bits}]}
                moved[sid] = synthetic
                occupied.append(bounds)
                occupied.append(stub_bounds(px, py, cx, cy))
                self.synthetic_constants.append((sid, cx, cy, facing, width, value, (cid, idx)))
        # Body-side Tunnels of nets that stay tunnels are re-anchored on their
        # moved ports at emission; until then they stand at their old spot,
        # where a moved body component may now have a port. Keep them out of
        # the router's world so a stale tunnel end does not claim that port.
        reanchor_tunnels = set()
        self.reanchor = self._reanchor_plan()
        for key, labels, body_ports in self.reanchor:
            reanchor_tunnels.update(cid for cid, idx in self.nets[key] if cid in self.tunnels and not self._is_panel(self.tunnels[cid]))
        focus_components = [c for cid, c in moved.items() if cid not in drop_tunnels and cid not in reanchor_tunnels]
        # Panel wires did not move and stay; body wiring is rebuilt.
        bundle_by_id = {b["bundleId"]: b for b in self.focus.get("wireBundles", [])}
        kept_wires, kept_bundles = [], []
        for w in self.focus.get("wires", []):
            bundle = bundle_by_id.get(w["bundleId"])
            pts = {(p["x"], p["y"]) for p in (bundle or {}).get("points", [])}
            if pts & panel_points:
                kept_wires.append(w)
                if bundle and bundle not in kept_bundles:
                    kept_bundles.append(bundle)
        self.kept_wires = kept_wires
        router = Router({"focus": {"components": focus_components, "wires": kept_wires, "wireBundles": kept_bundles}}, partition)
        # A port that gets several re-anchored labels chains them outward on
        # 10 px stubs (see emit); those cells are copper of that net, so no
        # other route may run through them.
        for key, labels, body_ports in self.reanchor:
            for cid, idx in body_ports:
                (px, py), _facing, (sx, sy) = self._port_edge(moved[cid], idx)
                for k in range(1, len(labels)):
                    router.blocked.add((px + sx * k, py + sy * k))
        jobs = []
        for key, cls in self.classes.items():
            if cls != "wire":
                continue
            ports = [(cid, idx) for cid, idx in self.nets[key] if cid in body_ids]
            if len(ports) < 2:
                continue
            xs = [moved[cid]["ends"][idx]["location"]["x"] for cid, idx in ports]
            ys = [moved[cid]["ends"][idx]["location"]["y"] for cid, idx in ports]
            jobs.append((len(ports) > 2, (max(xs) - min(xs)) + (max(ys) - min(ys)), key, ports))
        for sid, cx, cy, facing, width, value, (cid, idx) in self.synthetic_constants:
            jobs.append((False, 20, ("const", sid), [(sid, 0), (cid, idx)]))
        jobs.sort(key=lambda j: (j[0], j[1]))
        wires = []
        for _, _, key, ports in jobs:
            ends = [moved[cid]["ends"][idx] for cid, idx in ports]
            ends.sort(key=lambda e: (e.get("direction") != "output"))
            source, remaining = ends[0], ends[1:]
            remaining.sort(key=lambda e: abs(e["location"]["x"] - source["location"]["x"]) + abs(e["location"]["y"] - source["location"]["y"]))
            routed = []
            try:
                for target in remaining:
                    routed.extend(router.route(source, target))
            except ValueError as error:
                self.report["unrouted"].append({"label": self.label_of_net.get(key) if key in self.nets else key[1], "ports": len(ports), "reason": str(error)[:120]})
                if key in self.nets:
                    for cid, idx in self.nets[key]:
                        if cid in self.tunnels:
                            drop_tunnels.discard(cid)
                else:
                    # constant stub: this consumer falls back to the shared Constant's label.
                    self.failed_constant_consumers.add(ports[1])
                continue
            wires.extend(routed)
        wires = self._split_at_endpoints(wires)
        self.wires, self.drop_tunnels, self.moved = wires, drop_tunnels, moved
        self.report["wires"] = len(wires)
        return wires

    # ---- emission --------------------------------------------------------------
    def emit(self):
        self.plan()
        self._place()
        self._route()
        circuit = self.circuit
        # Move body components; a tunnel standing on a body port moves with it.
        port_delta = {}
        for c in self.body:
            dx, dy = self.placement.get(c["componentId"], (0, 0))
            for e in c["ends"]:
                port_delta[(e["location"]["x"], e["location"]["y"])] = (dx, dy)
        for cid, element in self.element_of.items():
            dx, dy = self.placement.get(cid, (0, 0))
            if cid in self.tunnels and cid not in self.drop_tunnels:
                loc = (self.tunnels[cid]["location"]["x"], self.tunnels[cid]["location"]["y"])
                dx, dy = port_delta.get(loc, (0, 0))
            if dx or dy:
                x, y = _loc(element.get("loc"))
                element.set("loc", f"({x + dx},{y + dy})")
        # Old body wiring goes; panel wires (unchanged coordinates) stay.
        kept = {((kw["from"]["x"], kw["from"]["y"]), (kw["to"]["x"], kw["to"]["y"])) for kw in self.kept_wires}
        kept |= {(b, a) for a, b in kept}
        for w in list(circuit.findall("wire")):
            if (_loc(w.get("from")), _loc(w.get("to"))) not in kept:
                circuit.remove(w)
        # Drop replaced tunnels
        for cid in self.drop_tunnels:
            element = self.element_of.get(cid)
            if element is not None and element in list(circuit):
                circuit.remove(element)
        # Nets that stay Tunnels: a body port was connected to its Tunnel either
        # directly (same point) or through a short wire. The component moved and
        # the body wires were rebuilt, so re-anchor one Tunnel per label right on
        # the port's new location; the old Tunnel elements of that net go.
        reanchored = 0

        def anchor_tunnels(cid, idx, labels):
            (px, py), facing, step = self._port_edge(self.moved[cid], idx)
            width = self.moved[cid]["ends"][idx].get("width") or 1
            for k, label in enumerate(labels):
                # first label sits on the port; further labels chain outward on a
                # short stub (cells the router kept free) so every label joins the net
                tx, ty = px + step[0] * k, py + step[1] * k
                el = ET.SubElement(circuit, "comp", {"lib": "0", "name": "Tunnel", "loc": f"({tx},{ty})"})
                ET.SubElement(el, "a", {"name": "facing", "val": facing})
                ET.SubElement(el, "a", {"name": "width", "val": str(width)})
                ET.SubElement(el, "a", {"name": "label", "val": label})
                if k:
                    ET.SubElement(circuit, "wire", {"from": f"({min(px, tx)},{min(py, ty)})", "to": f"({max(px, tx)},{max(py, ty)})"})
            return len(labels)

        for key, labels, body_ports in self.reanchor:
            # drop this net's body-side tunnels (panel-side ones stay where they are)
            for cid, idx in self.nets[key]:
                if cid in self.tunnels and not self._is_panel(self.tunnels[cid]):
                    element = self.element_of.get(cid)
                    if element is not None and element in list(circuit):
                        circuit.remove(element)
                    self.drop_tunnels.add(cid)
            for cid, idx in body_ports:
                reanchored += anchor_tunnels(cid, idx, labels)
        # Consumers of a localised Constant that got no Constant of their own
        # (boxed in, or the stub failed to route) reach the shared driver by its
        # label: one Tunnel on the consumer port, one on the driver's output.
        for key, cls in self.classes.items():
            if cls != "constant":
                continue
            failed = [(cid, idx) for cid, idx in self.nets[key] if (cid, idx) in self.failed_constant_consumers]
            if not failed:
                continue
            labels = sorted({_attr(self.tunnels[cid], "label") for cid, idx in self.nets[key] if cid in self.tunnels and _attr(self.tunnels[cid], "label")})[:1]
            if not labels:
                continue
            driver = next(cid for cid, idx in self.nets[key] if cid in self.constants)
            for cid, idx in failed:
                reanchored += anchor_tunnels(cid, idx, labels)
            # The driver's own Tunnel moved with it if it was kept as the bridge
            # to panel consumers; otherwise it was dropped and needs a new one.
            driver_port = (self.by_id[driver]["ends"][0]["location"]["x"], self.by_id[driver]["ends"][0]["location"]["y"])
            if not any(cid in self.tunnels and cid not in self.drop_tunnels and (self.tunnels[cid]["location"]["x"], self.tunnels[cid]["location"]["y"]) == driver_port
                       for cid, idx in self.nets[key]):
                reanchored += anchor_tunnels(driver, 0, labels)
        self.report["tunnelsReanchored"] = reanchored
        self.report["tunnelsRemoved"] = len(self.drop_tunnels)
        self.report["tunnelsKept"] = len(self.tunnels) - len(self.drop_tunnels) + reanchored
        # Localised constants: emit the synthetic components the router placed.
        for sid, cx, cy, facing, width, value, _consumer in self.synthetic_constants:
            if _consumer in self.failed_constant_consumers:
                continue
            el = ET.SubElement(circuit, "comp", {"lib": "0", "name": "Constant", "loc": f"({cx},{cy})"})
            ET.SubElement(el, "a", {"name": "facing", "val": facing})
            ET.SubElement(el, "a", {"name": "width", "val": str(width)})
            ET.SubElement(el, "a", {"name": "value", "val": str(value)})
            self.report["constantsPlaced"] += 1
        for key, cls in self.classes.items():
            if cls != "constant":
                continue
            driver = next(cid for cid, idx in self.nets[key] if cid in self.constants)
            still_needed = any(self._is_panel(self.by_id[cid]) for cid, idx in self.nets[key] if cid not in self.tunnels and cid != driver) \
                or any((cid, idx) in self.failed_constant_consumers for cid, idx in self.nets[key])
            if not still_needed:
                drv_el = self.element_of.get(driver)
                if drv_el is not None and drv_el in list(circuit):
                    circuit.remove(drv_el)
        for a, b in self.wires:
            ET.SubElement(circuit, "wire", {"from": f"({a[0]},{a[1]})", "to": f"({b[0]},{b[1]})"})
        return ET.tostring(self.tree.getroot(), encoding="unicode")


def netlist_signature(focus, *, ignore_factories=("Tunnel",)):
    """Canonical connectivity over non-tunnel ports, keyed by stable identity.

    Identity = (factoryName, label, sorted attribute values, end index) is not
    unique in general; callers pass a focus whose components carry an
    `identity` tag injected before layout. Here we key by componentId when the
    caller guarantees ids are stable, else by (factory, label, index).
    """
    def attr(c, n):
        for a in c["attributes"]:
            if a.get("name") == n:
                return a.get("value", a.get("standard"))
        return None
    groups = defaultdict(set)
    for c in focus["components"]:
        if c["factoryName"] in ignore_factories:
            continue
        ident = (c["factoryName"], attr(c, "label"), c.get("identity"))
        for e in c["ends"]:
            bits = e.get("netBits") or []
            if not bits:
                continue
            key = tuple(sorted(b["netId"] for b in bits))
            groups[key].add((ident, e["index"]))
    return sorted(frozenset(v) for v in groups.values() if len(v) >= 2)
