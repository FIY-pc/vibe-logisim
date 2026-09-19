"""Replace selected wire paths while keeping their terminals and junctions fixed.

Native bundle identity disambiguates crossings. Geometry is only a proposal;
the caller must reload it in Logisim and compare every port-bit relationship.
"""
from collections import defaultdict

from studio.domain.routing import Partition, Router, point
from studio.domain.wire_geometry import on_segment


def wire_length(wires):
    return sum(abs(w['from']['x'] - w['to']['x']) + abs(w['from']['y'] - w['to']['y']) for w in wires)


def reroute(document, wire_ids):
    focus = document['focus']
    wires = {w['wireId']: w for w in focus['wires']}
    if not wire_ids or not wire_ids <= wires.keys():
        raise ValueError('请选择 inspect_circuit(includeWires=true) 返回的当前导线 ID')
    bundles = {b['bundleId']: b for b in focus['wireBundles']}
    chosen = [w for w in focus['wires'] if w['wireId'] in wire_ids]
    kept = [w for w in focus['wires'] if w['wireId'] not in wire_ids]
    vertices = defaultdict(set)
    for w in focus['wires']:
        vertices[w['bundleId']].update((point(w['from']), point(w['to'])))
    ports = {point(e['location']) for c in focus['components'] for e in c['ends']}
    edges, adjacent = [], defaultdict(list)
    fixed = set()
    for w in chosen:
        bundle = bundles.get(w['bundleId'])
        if not bundle or not bundle.get('valid') or not bundle.get('bitNets'):
            raise ValueError('所选导线位宽未知或存在冲突，不能确认重新布线的连接语义')
        a, b = point(w['from']), point(w['to'])
        cuts = sorted(p for p in vertices[w['bundleId']] | ports if on_segment(p, a, b))
        if any(v % 10 for p in cuts for v in p):
            raise ValueError('所选路径的端点和分支必须在 10 单位网格上')
        for p in cuts:
            key = (w['bundleId'], p)
            if p in ports or any(k['bundleId'] == w['bundleId'] and
                                on_segment(p, point(k['from']), point(k['to'])) for k in kept):
                fixed.add(key)
        for a, b in zip(cuts, cuts[1:]):
            index = len(edges)
            p, q = (w['bundleId'], a), (w['bundleId'], b)
            edges.append((p, q))
            adjacent[p].append(index)
            adjacent[q].append(index)
    anchors = fixed | {p for p, indices in adjacent.items() if len(indices) != 2}
    paths, used = [], set()
    for start in sorted(anchors):
        for index in adjacent[start]:
            if index in used:
                continue
            here, path = start, [start[1]]
            while True:
                used.add(index)
                a, b = edges[index]
                here = b if here == a else a
                path.append(here[1])
                if here in anchors:
                    break
                index = next(i for i in adjacent[here] if i != index)
            if path[0] == path[-1]:
                raise ValueError('所选路径包含闭合回路，请缩小范围；不会静默删除回路')
            paths.append((start[0], path))
    if len(used) != len(edges):
        raise ValueError('所选路径包含无端点的闭合回路，请缩小范围')
    router = Router({'focus': {**focus, 'wires': kept}}, Partition())
    all_points = router.all_points + [p for _, path in paths for p in path]
    router.extent = (min(p[0] for p in all_points) - 100, min(p[1] for p in all_points) - 100,
                     max(p[0] for p in all_points) + 100, max(p[1] for p in all_points) + 100)
    output = []
    # Shorter local paths first; deterministic, with no hidden randomized retries.
    for bundle_id, path in sorted(paths, key=lambda item: (len(item[1]), item[0], item[1])):
        owner = router.owner(bundles[bundle_id]['bitNets'])
        segments = router.path({path[0]}, path[-1], owner)
        for a, b in segments:
            router.add(a, b, owner, owner)
            output.append({'from': dict(zip(('x', 'y'), a)), 'to': dict(zip(('x', 'y'), b))})
    return output, {'selectedWires': len(chosen), 'fixedAnchors': len(anchors), 'paths': len(paths),
                    'lengthBefore': wire_length(chosen), 'lengthAfter': wire_length(output)}
