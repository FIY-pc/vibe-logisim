"""Preserve unfinished and cyclic copper independently of port-net equivalence.

Use native normalized segments: a crossing is not a connection unless it has
an endpoint. Tunnel aliases must not join distant physical drawings here.
"""
from collections import defaultdict


def point(value):
    return value['x'], value['y']


def wire_islands(focus):
    wires = focus.get('wires', [])
    parents, degree = {}, defaultdict(int)

    def root(p):
        parents.setdefault(p, p)
        start = p
        while parents[p] != p:
            p = parents[p]
        while parents[start] != start:
            previous = parents[start]
            parents[start] = p
            start = previous
        return p

    for wire in wires:
        a, b = point(wire['from']), point(wire['to'])
        parents[root(a)] = root(b)
        degree[a] += 1
        degree[b] += 1
    groups = {}
    for wire in wires:
        a, b = point(wire['from']), point(wire['to'])
        group = groups.setdefault(root(a), {'wires': [], 'points': set(), 'ports': set(), 'portPoints': set()})
        group['wires'].append(wire)
        group['points'].update((a, b))
    for component in focus['components']:
        for end in component['ends']:
            p = point(end['location'])
            if p in parents:
                group = groups[root(p)]
                group['ports'].add((component['componentId'], end['index']))
                group['portPoints'].add(p)
    for group in groups.values():
        group['loose'] = (not group['ports'] or len(group['wires']) >= len(group['points']) or
                          any(degree[p] == 1 and p not in group['portPoints'] for p in group['points']))
    return list(groups.values())


def loose_wire_geometry(focus):
    islands = [group for group in wire_islands(focus) if group['loose']]
    return [wire for group in islands for wire in group['wires']], {cid for group in islands for cid, _ in group['ports']}


def assert_floating_isolation(before, after):
    """A preserved doodle must not silently become connected to a placed part."""
    floating = [wire for group in wire_islands(before) if not group['ports'] for wire in group['wires']]
    if not floating:
        return
    for group in wire_islands(after):
        if not group['ports']:
            continue
        for wire in group['wires']:
            a, b = point(wire['from']), point(wire['to'])
            for old in floating:
                p, q = point(old['from']), point(old['to'])
                # Positive collinear overlap; a plain perpendicular crossing
                # does not make the independently drawn wire conductive.
                if a[0] == b[0] == p[0] == q[0]:
                    overlap = min(max(a[1], b[1]), max(p[1], q[1])) > max(min(a[1], b[1]), min(p[1], q[1]))
                elif a[1] == b[1] == p[1] == q[1]:
                    overlap = min(max(a[0], b[0]), max(p[0], q[0])) > max(min(a[0], b[0]), min(p[0], q[0]))
                else:
                    overlap = False
                if overlap:
                    raise ValueError('整理把独立导线接到了元件，请调整整理范围或固定相关元件')
