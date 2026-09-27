"""Topology-preserving horizontal compaction of a routed schematic.

A laid-out sheet is mostly air: columns are as wide as their widest part and
channels as wide as the wires estimated to cross them, so most of any row is
empty. This pass removes that air after routing without changing the drawing:
parts, Tunnels, Constants and vertical wire runs only move left, horizontal
wires stretch or shrink, and any two things whose height ranges overlap keep
their left-to-right order and at least a grid step between them. A wire that
crossed another still crosses it, one that did not still does not, no bend is
added or removed, and no two nets can come to touch (they could only meet
where they overlap in height, and there they stay apart). The pass works on
geometry alone -- it knows nothing about what the circuit is.

Classic 1-D constraint-graph compaction: every object gets a shift; each
object is constrained only by its nearest neighbour to the left at each
height (found with a sweep over the objects in x order), and the smallest
shifts that satisfy all constraints are found by relaxation. Objects that are
attached to each other (a part and its ports, a vertical run and the port it
leaves from, collinear runs that meet) move as one group.
"""
from __future__ import annotations

import math
from collections import defaultdict

GRID = 10


def compact_x(components, wires, *, part_gap=30, grid=GRID, keep_order=(), min_width=0, extent_parts=None):
    """components: list of {"boxes": [(x0, y0, x1, y1)], "ports": [(x, y)],
    "fixed": bool}; wires: list of ((ax, ay), (bx, by), fixed) with every wire
    horizontal or vertical. keep_order: pairs ((i, xi), (j, xj)) -- a point
    at x = xi of component i that must stay at least a grid step left of a
    point at xj of component j whatever their heights (Pins whose order is
    an instance's port order; a driver and a consumer joined by a label, whose
    left-to-right reading no wire holds).

    min_width: the boxes of the components in extent_parts (all when None)
    stay at least this wide from leftmost to rightmost (a density cap); the
    shifts are then scaled back towards zero, which keeps every constraint (a
    blend of two drawings that satisfy them does too).

    Returns (dx, new_wires): the shift of every component (a multiple of
    grid, never positive) and the wires with their endpoints moved."""
    parent = {}

    def find(a):
        parent.setdefault(a, a)
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:
            parent[a], a = root, parent[a]
        return root

    def join(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    fixed_nodes = set()
    port_part = {}
    for i, c in enumerate(components):
        find(("c", i))
        if c.get("fixed"):
            fixed_nodes.add(("c", i))
        for p in c["ports"]:
            if p in port_part:
                join(("c", port_part[p]), ("c", i))      # parts touching port to port
            else:
                port_part[p] = i
    vertical = [k for k, (a, b, _f) in enumerate(wires) if a[0] == b[0] and a[1] != b[1]]
    horizontal = [k for k, (a, b, _f) in enumerate(wires) if a[1] == b[1] and a[0] != b[0]]
    by_x = defaultdict(list)                 # x -> [(y0, y1, k)] vertical runs
    for k in vertical:
        a, b, fixed = wires[k]
        find(("w", k))
        if fixed:
            fixed_nodes.add(("w", k))
        by_x[a[0]].append((min(a[1], b[1]), max(a[1], b[1]), k))
    for x, runs in by_x.items():
        runs.sort()
        end, first = None, None
        for y0, y1, k in runs:
            if end is not None and y0 <= end:
                join(("w", first), ("w", k))           # collinear runs that meet are one track
                end = max(end, y1)
            else:
                end, first = y1, k

    def vertical_at(p):
        for y0, y1, k in by_x.get(p[0], ()):
            if y0 <= p[1] <= y1:
                return k
        return None

    for p, i in port_part.items():
        k = vertical_at(p)
        if k is not None:
            join(("w", k), ("c", i))                   # a run leaving a port moves with the part
    point_node = {}
    for k in horizontal:
        a, b, fixed = wires[k]
        for p in (a, b):
            if p in point_node:
                node = point_node[p]
            elif p in port_part:
                node = ("c", port_part[p])
            else:
                v = vertical_at(p)
                node = ("w", v) if v is not None else ("p", p)
            find(node)
            point_node[p] = node
            if fixed:
                fixed_nodes.add(node)

    # A label or constant on a short lead stays on its port: it is read as
    # part of that port, and a lead stretched across the sheet reads as a wire.
    for k in horizontal:
        a, b, _f = wires[k]
        if abs(a[0] - b[0]) <= 2 * grid and a in port_part and b in port_part:
            i, j = port_part[a], port_part[b]
            if components[i].get("cling") or components[j].get("cling"):
                join(("c", i), ("c", j))

    # Objects: (x0, x1, y0, y1, kind, node)
    objects = []
    for i, c in enumerate(components):
        for x0, y0, x1, y1 in c["boxes"]:
            objects.append((x0, x1, y0, y1, "box", ("c", i)))
        for x, y in c["ports"]:
            objects.append((x, x, y, y, "point", ("c", i)))
    for k in vertical:
        (ax, ay), (bx, by), _f = wires[k]
        objects.append((ax, ax, min(ay, by), max(ay, by), "run", ("w", k)))
    for p, node in point_node.items():
        objects.append((p[0], p[0], p[1], p[1], "point", node))
    if not objects:
        return [0] * len(components), [(a, b) for a, b, _f in wires]

    ys = sorted({v for o in objects for v in (o[2], o[3])})
    slot_of = {y: 2 * i for i, y in enumerate(ys)}
    order = sorted(range(len(objects)), key=lambda n: (objects[n][0], objects[n][1]))

    def sweep(visit):
        front = [None] * (2 * len(ys))          # per height slot: the object reaching furthest right
        for n in order:
            x0, x1, y0, y1, _kind, _node = objects[n]
            s0, s1 = slot_of[y0], slot_of[y1]
            seen = set()
            for s in range(s0, s1 + 1):
                m = front[s]
                if m is not None and m not in seen:
                    seen.add(m)
                    visit(m, n)
                if m is None or objects[m][1] <= x1:
                    front[s] = n

    # 1. Things that already overlap (a label box over a neighbour's edge, a
    #    run along a body) are held together rather than pulled apart.
    def merge(m, n):
        if objects[m][1] >= objects[n][0] and find(objects[m][5]) != find(objects[n][5]):
            join(objects[m][5], objects[n][5])

    sweep(merge)
    group = {o[5]: find(o[5]) for o in objects}
    fixed_groups = {find(node) for node in fixed_nodes}

    # 2. Nearest left neighbour at every height -> constraint.
    slack_of = {}

    def constrain(m, n):
        a, b = objects[m], objects[n]
        ga, gb = group[a[5]], group[b[5]]
        if ga == gb or a[1] >= b[0]:
            return
        gap = b[0] - a[1]
        want = part_gap if a[4] == "box" and b[4] == "box" else grid
        slack = gap - min(want, gap)
        if slack_of.get((ga, gb), math.inf) > slack:
            slack_of[(ga, gb)] = slack

    sweep(constrain)
    for (i, xi), (j, xj) in keep_order:
        ga, gb = find(("c", i)), find(("c", j))
        if ga == gb or xj < xi:
            continue
        slack = (xj - xi) - min(grid, xj - xi)
        if slack_of.get((ga, gb), math.inf) > slack:
            slack_of[(ga, gb)] = slack

    # 3. Width: everything as far left as the sheet's left edge and its left
    #    neighbours allow ...
    groups = set(group.values())
    movable = [o for o in objects if group[o[5]] not in fixed_groups]
    left = min(o[0] for o in movable) if movable else 0
    lowest, highest = {}, {}
    for o in objects:
        g = group[o[5]]
        lowest[g] = min(lowest.get(g, math.inf), o[0])
        highest[g] = max(highest.get(g, -math.inf), o[1])
    floor = {g: (0 if g in fixed_groups else _up(left - lowest[g], grid)) for g in groups}
    preds, succs = defaultdict(list), defaultdict(list)
    for (ga, gb), slack in slack_of.items():
        preds[gb].append((ga, slack))
        succs[ga].append((gb, slack))
    shift = dict(floor)
    edges = sorted(slack_of.items(), key=lambda kv: lowest[kv[0][1]])
    for _round in range(len(groups) + 1):
        changed = False
        for (ga, gb), slack in edges:
            if gb in fixed_groups:
                continue
            want = _up(shift[ga] - slack, grid)
            if want > shift[gb]:
                shift[gb] = want
                changed = True
        if not changed:
            break
    shift = {g: min(0, v) for g, v in shift.items()}
    width = max((highest[g] + shift[g] for g in groups if g not in fixed_groups), default=0)

    # 4. ... then, within that width, every group where its horizontal wires
    #    are shortest (coordinate descent from the leftmost placement: each
    #    move stays between what its neighbours allow, so every constraint
    #    keeps holding).
    pulls = defaultdict(list)            # group -> [(own x, other group, other x)]
    for k in horizontal:
        a, b, _f = wires[k]
        ga, gb = group[point_node[a]], group[point_node[b]]
        if ga != gb:
            pulls[ga].append((a[0], gb, b[0]))
            pulls[gb].append((b[0], ga, a[0]))
    ordered = sorted((g for g in groups if g not in fixed_groups and pulls[g]), key=lambda g: lowest[g])
    for sweep in range(24):
        changed = False
        for g in (ordered if sweep % 2 == 0 else reversed(ordered)):
            lo = max([floor[g]] + [shift[a] - slack for a, slack in preds[g]])
            hi = min([0, width - highest[g]] + [shift[b] + slack for b, slack in succs[g]])
            lo, hi = _up(lo, grid), _down(hi, grid)
            if lo > hi:
                continue
            targets = sorted(ox + shift[og] - x for x, og, ox in pulls[g])
            best = _down(targets[(len(targets) - 1) // 2], grid)
            best = min(max(best, lo), hi)
            if best != shift[g]:
                shift[g] = best
                changed = True
        if not changed:
            break

    # 5. Not denser than min_width allows: blend back towards the drawing
    #    as routed, then lift anything the rounding put too far left.
    parts = range(len(components)) if extent_parts is None else extent_parts
    spans = [(group[("c", i)], x0, x1) for i in parts for x0, _y0, x1, _y1 in components[i]["boxes"]]

    def extent(sh):
        return max(x1 + sh[g] for g, _x0, x1 in spans) - min(x0 + sh[g] for g, x0, _x1 in spans) if spans else 0

    if min_width and spans and extent(shift) < min_width:
        full = dict(shift)
        lo_a, hi_a = 0.0, 1.0
        for _step in range(12):
            mid = (lo_a + hi_a) / 2
            trial = {g: _up(mid * v, grid) for g, v in full.items()}
            if extent(trial) >= min_width:
                lo_a = mid
            else:
                hi_a = mid
        shift = {g: _up(lo_a * v, grid) for g, v in full.items()}
        for _round in range(len(groups) + 1):
            changed = False
            for (ga, gb), slack in edges:
                want = _up(shift[ga] - slack, grid)
                if gb not in fixed_groups and want > shift[gb]:
                    shift[gb] = want
                    changed = True
            if not changed:
                break

    dx = [shift[group[("c", i)]] if ("c", i) in group else 0 for i in range(len(components))]

    def moved(p, node):
        return (p[0] + shift.get(group.get(node, find(node)), 0), p[1])

    runs = set(vertical)
    new_wires = []
    for k, (a, b, _f) in enumerate(wires):
        if k in runs:
            new_wires.append((moved(a, ("w", k)), moved(b, ("w", k))))
        elif a in point_node and b in point_node:
            new_wires.append((moved(a, point_node[a]), moved(b, point_node[b])))
        else:
            new_wires.append((a, b))            # a zero-length stub: nothing to move it with
    return dx, new_wires


def _up(value, grid):
    """The smallest multiple of grid at or above value."""
    return math.ceil(value / grid) * grid


def _down(value, grid):
    """The largest multiple of grid at or below value."""
    return math.floor(value / grid) * grid
