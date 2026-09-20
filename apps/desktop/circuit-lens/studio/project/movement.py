"""Local layout movement: retain shared junctions and move internal paths.

Geometry is a proposal. The editor checks all native port-bit relationships
before publishing it; no Tunnel or component is invented to make a move fit.
"""
from collections import defaultdict
import copy

from studio.domain.routing import Router, Partition, point
from studio.domain.wire_geometry import on_segment


def moved_components(scene, selected, dx, dy):
    deltas = {identifier: (dx, dy) for identifier in selected}
    components, attached = relocated_components(scene, deltas)
    return components, defaultdict(list, {
        p: [(delta != (0, 0), end) for delta, end in ends] for p, ends in attached.items()})


def relocated_components(scene, deltas):
    selected = set(deltas)
    components = copy.deepcopy(scene['components'])
    attached = defaultdict(list)
    for c in components:
        dx, dy = deltas.get(c['componentId'], (0, 0))
        moving = bool(dx or dy)
        for end in c['ends']:
            attached[point(end['location'])].append(((dx, dy), end))
        if moving:
            for location in [c['location'], c['bounds'], *(e['location'] for e in c['ends'])]:
                location['x'] += dx
                location['y'] += dy
            if not 0 <= c['location']['x'] <= 6000 or not 0 <= c['location']['y'] <= 6000:
                raise ValueError('整组选中的元件需要留在画布范围内')
    for i, a in enumerate(components):
        for b in components[i + 1:]:
            if not ({a['componentId'], b['componentId']} & selected):
                continue
            if a['factory'] in {'Text', 'Tunnel'} or b['factory'] in {'Text', 'Tunnel'}:
                continue
            x, y = a['bounds'], b['bounds']
            if (max(x['x'], y['x']) < min(x['x'] + x['width'], y['x'] + y['width']) and
                    max(x['y'], y['y']) < min(x['y'] + x['height'], y['y'] + y['height'])):
                raise ValueError('目标位置与其他元件重叠，请留出空间')

    return components, attached


def plan_move(scene, selected, dx, dy):
    return plan_movements(scene, {identifier: (dx, dy) for identifier in selected})


def plan_movements(scene, deltas):
    components, attached = relocated_components(scene, deltas)
    bundles = {b['bundleId']: b for b in scene['bundles']}
    vertices = set(attached)
    for wire in scene['wires']:
        vertices.update((point(wire['from']), point(wire['to'])))
    edges, adjacent = [], defaultdict(list)
    # Split only at existing vertices/ports: two interior crossings are not junctions.
    for wire in scene['wires']:
        a, b = point(wire['from']), point(wire['to'])
        cuts = sorted(p for p in vertices if on_segment(p, a, b))
        for p, q in zip(cuts, cuts[1:]):
            index = len(edges)
            edges.append((p, q, wire['bundleId']))
            adjacent[p].append(index)
            adjacent[q].append(index)

    vertex_deltas = {}
    visited = set()
    for start in adjacent:
        if start in visited:
            continue
        cluster, stack = set(), [start]
        while stack:
            p = stack.pop()
            if p in cluster:
                continue
            cluster.add(p)
            for index in adjacent[p]:
                a, b, _ = edges[index]
                stack.append(b if a == p else a)
        visited.update(cluster)
        terminals = {delta for p in cluster for delta, _ in attached.get(p, [])}
        if len(terminals) == 1 and (0, 0) not in terminals:
            delta = next(iter(terminals))
            vertex_deltas.update((p, delta) for p in cluster)

    connectors = []
    for p, ends in attached.items():
        movements = {delta for delta, _ in ends}
        moving = movements - {(0, 0)}
        if not moving or p in vertex_deltas:
            continue
        if len(movements) == 1:
            vertex_deltas[p] = next(iter(moving))
        else:
            # Stationary/shared junctions remain anchors. Components at the
            # same original point can now depart in different directions.
            for dx, dy in sorted(moving):
                connectors.append((p, (p[0] + dx, p[1] + dy), ends[0][1]['netBits']))

    anchors = set(attached) | {p for p in adjacent if len(adjacent[p]) != 2}
    paths, used = [], set()
    for first in edges:
        if not (first[0] in anchors or first[1] in anchors):
            continue
        start = first[0] if first[0] in anchors else first[1]
        for index in adjacent[start]:
            if index in used:
                continue
            path, p, bundle = [start], start, edges[index][2]
            while True:
                used.add(index)
                a, b, _ = edges[index]
                p = b if a == p else a
                path.append(p)
                if p in anchors:
                    break
                index = next(i for i in adjacent[p] if i != index)
            paths.append((path, bundle))
    # A closed floating loop has no anchors; retain it verbatim.
    paths.extend(([a, b], bundle) for i, (a, b, bundle) in enumerate(edges) if i not in used)

    kept, reroute = [], []
    def translated(p):
        dx, dy = vertex_deltas.get(p, (0, 0))
        return p[0] + dx, p[1] + dy
    for path, bundle in paths:
        a, b = path[0], path[-1]
        a_delta, b_delta = vertex_deltas.get(a, (0, 0)), vertex_deltas.get(b, (0, 0))
        if a_delta == b_delta:
            dx, dy = a_delta
            transformed = [(p[0] + dx, p[1] + dy) for p in path]
            kept.extend((p, q, bundle) for p, q in zip(transformed, transformed[1:]))
        else:
            reroute.append((translated(a), translated(b), bundles[bundle].get('bitNets', []), bundle))
    for a, b, bits in connectors:
        bundle = next((edges[i][2] for i in adjacent[a]), None)
        if bundle is None:
            bundle = f'move-junction-{len(bundles)}'
            bundles[bundle] = {'bundleId': bundle, 'bitNets': bits}
        reroute.append((a, b, bits, bundle))

    if reroute:
        document = {'focus': {
            'components': [{**c, 'factoryName': c['factory']} for c in components],
            'wireBundles': list(bundles.values()),
            'wires': [{'from': dict(zip(('x', 'y'), a)), 'to': dict(zip(('x', 'y'), b)), 'bundleId': bundle}
                      for a, b, bundle in kept],
        }}
        router = Router(document, Partition())
        for a, b, bits, bundle in reroute:
            owner = router.owner(bits) or ('floating', bundle)
            # Retained bends are anchors too. Doubling back over their old
            # copper leaves a dangling tail after native normalization.
            segments = router.path({a}, b, owner, avoid_retrace=True)
            for p, q in segments:
                router.add(p, q, owner, owner)
                kept.append((p, q, bundle))
    return sorted({tuple(sorted((a, b))) for a, b, _ in kept if a != b})
