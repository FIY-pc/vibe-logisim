"""Orthogonal geometry proposals shared by manual editing and optional routing.

The caller supplies observed port/wire ownership. This module has no runtime,
filesystem, candidate or revision lifecycle; native acceptance stays outside.
"""
from collections import defaultdict
import heapq


STEPS = ((10, 0, 0), (-10, 0, 0), (0, 10, 1), (0, -10, 1))


def point(value):
    return value['x'], value['y']


class Partition:
    def __init__(self):
        self.parents = {}

    def root(self, value):
        parent = self.parents.setdefault(value, value)
        if parent != value:
            self.parents[value] = self.root(parent)
        return self.parents[value]

    def join(self, a, b):
        a, b = self.root(a), self.root(b)
        if a != b:
            self.parents[b] = a



class Router:
    """Grid Manhattan routing. Cross a foreign straight wire, never its vertex.

    Component interiors and foreign ports are obstacles. A finite cost prefers
    one grid cell of clearance and straight pin leads, without closing narrow
    passages or moving fixed anchors. A route may branch anywhere on its own
    bus. Compressed polylines keep straight crossings from becoming junctions.
    """
    def __init__(self, document, partition, *, crossing_cost=24, visit_cap=200000):
        self.partition = partition
        self.visit_cap = visit_cap
        # Cost of crossing a foreign straight wire (one grid step is 10, a bend
        # 18). Manual edits keep the default; a global re-layout may raise it
        # so that a short detour beats a crossing.
        self.crossing_cost = crossing_cost
        self.connected = Partition()
        self.segment_buses = []
        self.segments = []
        self.at = defaultdict(list)
        self.blocked = set()
        self.clearance_cost = {}
        self.port_owners = defaultdict(set)
        self.all_points = []
        focus = document["focus"]
        for c in focus["components"]:
            b = c["bounds"]
            body = c["factoryName"] not in {"Text", "Tunnel", "Splitter"}
            escape_axes = set()
            if body:
                # The body interior is forbidden; end points on its boundary remain usable.
                for x in range((b["x"] // 10) * 10, b["x"] + b["width"] + 1, 10):
                    for y in range((b["y"] // 10) * 10, b["y"] + b["height"] + 1, 10):
                        if b["x"] < x < b["x"] + b["width"] and b["y"] < y < b["y"] + b["height"]:
                            self.blocked.add((x, y))
            for end in c["ends"]:
                p = point(end["location"])
                self.port_owners[p].add(self.owner(end["netBits"]))
                self.all_points.append(p)
                # A custom ALU symbol has diagonal edges: some real ports lie
                # inside its rectangular bounds. Open only the nearest escape ray.
                distances = [(abs(p[0] - b["x"]), -10, 0),
                             (abs(p[0] - b["x"] - b["width"]), 10, 0),
                             (abs(p[1] - b["y"]), 0, -10),
                             (abs(p[1] - b["y"] - b["height"]), 0, 10)]
                _, dx, dy = min(distances, key=lambda d: (d[0], 0 if d[1] == (10 if end["direction"] == "output" else -10) else 1))
                q = p
                while b["x"] <= q[0] <= b["x"] + b["width"] and b["y"] <= q[1] <= b["y"] + b["height"]:
                    self.blocked.discard(q)
                    q = q[0] + dx, q[1] + dy
                q = p
                while (b["x"] - 10 < q[0] < b["x"] + b["width"] + 10 and
                       b["y"] - 10 < q[1] < b["y"] + b["height"] + 10):
                    escape_axes.add((q, 0 if dx else 1))
                    q = q[0] + dx, q[1] + dy
            if body:
                # Prefer a grid cell of air around bodies. Keep this a cost,
                # not a new obstacle: fixed junctions and narrow gaps must
                # remain routable. A port's outward ray is free only along
                # its axis; turning immediately at the pin still pays. 40 is
                # slightly more than two bends (2 * 18), so a small detour can
                # beat tracing the edge. Overlapping halos do not multiply it.
                for x in range((b["x"] // 10) * 10, b["x"] + b["width"] + 10, 10):
                    for y in range((b["y"] // 10) * 10, b["y"] + b["height"] + 10, 10):
                        for axis in (0, 1):
                            key = ((x, y), axis)
                            if key not in escape_axes:
                                self.clearance_cost[key] = 40
        for p in self.port_owners:
            self.blocked.discard(p)
        owners = {b["bundleId"]: self.owner(b.get("bitNets", [])) or ("floating", b["bundleId"])
                  for b in focus["wireBundles"]}
        for wire in focus["wires"]:
            bundle = next(b for b in focus["wireBundles"] if b["bundleId"] == wire["bundleId"])
            bus = tuple(b["netId"] for b in bundle.get("bitNets", [])) or ("floating", wire["bundleId"])
            self.add(point(wire["from"]), point(wire["to"]), owners[wire["bundleId"]], bus)
        # Logisim coordinates may be negative (a panel drawn above the origin);
        # the search window must follow the circuit, not the origin.
        self.extent = (min(p[0] for p in self.all_points) - 100,
                       min(p[1] for p in self.all_points) - 100,
                       max(p[0] for p in self.all_points) + 240,
                       max(p[1] for p in self.all_points) + 240) if self.all_points else (0, 0, 6000, 6000)

    def owner(self, bits):
        return tuple(self.partition.root(b["netId"]) for b in sorted(bits, key=lambda b: b["bit"]))

    @staticmethod
    def grid(a, b):
        if a[0] == b[0]:
            return [(a[0], y) for y in range(min(a[1], b[1]), max(a[1], b[1]) + 1, 10)]
        if a[1] == b[1]:
            return [(x, a[1]) for x in range(min(a[0], b[0]), max(a[0], b[0]) + 1, 10)]
        raise ValueError("仅支持正交导线")

    def add(self, a, b, owner, bus):
        if a == b:
            return
        axis = 0 if a[1] == b[1] else 1
        self.segments.append((a, b, owner))
        self.segment_buses.append(bus)
        self.all_points.extend((a, b))
        for p in self.grid(a, b):
            self.at[p].append((owner, axis, p in (a, b)))

    def route(self, source_end, target_end):
        source, target = point(source_end["location"]), point(target_end["location"])
        owner = self.owner(source_end["netBits"])
        source_bus = tuple(b["netId"] for b in source_end["netBits"])
        target_bus = tuple(b["netId"] for b in target_end["netBits"])
        if self.connected.root(source_bus) == self.connected.root(target_bus):
            return []
        if any(v % 10 for p in (source, target) for v in p):
            raise ValueError("端口不在 10 单位布线网格上")
        # Start on any same-bus segment, reusing template stubs and previous fanout.
        starts = {source}
        for (a, b, own), bus in zip(self.segments, self.segment_buses):
            if self.connected.root(bus) == self.connected.root(source_bus):
                starts.update(self.grid(a, b))
        starts = {p for p in starts if p not in self.blocked and
                  not any(own != owner for own, _, _ in self.at[p]) and
                  not any(own != owner for own in self.port_owners[p])}
        if target in starts:
            return []
        result = self.path(starts, target, owner)
        for a, b in result:
            self.add(a, b, owner, source_bus)
        self.connected.join(source_bus, target_bus)
        return result

    def boxed_in(self, target, starts, owner, budget=64):
        """True when no route can arrive at target: walking backwards from it
        over every step a route could take (every rule except the one that
        depends on the direction a route came in, so no real route is missed)
        closes up within budget cells without meeting a start. A port walled
        in by foreign copper is found here in a few cells; A* would flood the
        whole reachable sheet before giving up."""
        def foreign(p):
            return [s for s in self.at.get(p, ()) if s[0] != owner]

        seen, todo = {target}, [target]
        while todo:
            q = todo.pop()
            here = foreign(q)
            for dx, dy, axis in ((10, 0, 0), (-10, 0, 0), (0, 10, 1), (0, -10, 1)):
                p = q[0] - dx, q[1] - dy                # a step p -> q along axis
                if p in seen or not (self.extent[0] <= p[0] <= self.extent[2] and self.extent[1] <= p[1] <= self.extent[3]):
                    continue
                if p in self.blocked or any(own != owner for own in self.port_owners.get(p, ())):
                    continue
                if any(s[1] == axis or s[2] for s in foreign(p)):
                    continue
                if here and (q == target or any(s[1] == axis or s[2] for s in here)):
                    continue
                if p in starts or len(seen) >= budget:
                    return False
                seen.add(p)
                todo.append(p)
        return True

    def path(self, starts, target, owner, *, avoid_retrace=False):
        """Propose geometry between explicit anchors; do not infer connectivity."""
        # A route may cross unrelated copper, but cannot terminate on it. This
        # is impossible regardless of path length; avoid exhausting A* first.
        if any(own != owner for own, _, _ in self.at[target]):
            raise ValueError(f"目标端点 {target} 已被其他信号的导线占用，请调整元件或导线位置")
        starts = {p for p in starts if p not in self.blocked and
                  not any(own != owner for own, _, _ in self.at[p]) and
                  not any(own != owner for own in self.port_owners[p])}
        if target in starts:
            return []
        if self.boxed_in(target, starts, owner):
            raise ValueError(f"无法在目标位置保持连线，请留出更多空间：{target}")
        tx, ty = target
        queue, cost, previous = [], {}, {}
        for p in sorted(starts):
            state = (p, -1)
            cost[state] = 0
            heapq.heappush(queue, (abs(p[0] - tx) + abs(p[1] - ty), 0, state))
        end = None
        visits = 0
        # the loop below runs millions of times on a full re-layout: names bound once
        blocked, port_owners, at, clearance = self.blocked, self.port_owners, self.at, self.clearance_cost
        x0, y0, x1, y1 = self.extent
        crossing_cost, visit_cap = self.crossing_cost, self.visit_cap
        push, pop, inf = heapq.heappush, heapq.heappop, float("inf")
        while queue:
            _, distance, state = pop(queue)
            if distance != cost.get(state):
                continue
            p, incoming = state
            if p == target:
                end = state
                break
            visits += 1
            if visits > visit_cap:
                break
            foreign_here = None
            for dx, dy, axis in STEPS:
                q = p[0] + dx, p[1] + dy
                if not (x0 <= q[0] <= x1 and y0 <= q[1] <= y1):
                    continue
                if q in blocked or any(own != owner for own in port_owners[q]):
                    continue
                # At a crossing continue straight; never end, bend, or overlap there.
                if foreign_here is None:
                    foreign_here = [s for s in at[p] if s[0] != owner]
                if foreign_here and (incoming != axis or any(s[1] == axis or s[2] for s in foreign_here)):
                    continue
                foreign_next = [s for s in at[q] if s[0] != owner]
                if foreign_next and (q == target or any(s[1] == axis or s[2] for s in foreign_next)):
                    continue
                following = (q, axis)
                new_cost = distance + 10 + (18 if incoming not in (-1, axis) else 0) + (crossing_cost if foreign_next else 0)
                new_cost += max(clearance.get((p, axis), 0), clearance.get((q, axis), 0))
                # A manually placed segment should end at its new bend, not
                # become a dangling stub when its connector doubles back.
                if avoid_retrace and any(own == owner and direction == axis for own, direction, _ in at[q]):
                    new_cost += 30
                if new_cost >= cost.get(following, inf):
                    continue
                cost[following] = new_cost
                previous[following] = state
                push(queue, (new_cost + abs(q[0] - tx) + abs(q[1] - ty), new_cost, following))
        if end is None:
            raise ValueError(f"无法在目标位置保持连线，请留出更多空间：{target}")
        path = []
        while True:
            path.append(end[0])
            if end not in previous:
                break
            end = previous[end]
        path.reverse()
        corners = [path[0]]
        for i in range(1, len(path) - 1):
            a, b, c = path[i-1:i+2]
            if (a[0] == b[0]) != (b[0] == c[0]):
                corners.append(b)
        corners.append(path[-1])
        result = list(zip(corners, corners[1:]))
        return result
