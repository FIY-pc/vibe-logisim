"""Resolve an explicit wire gesture against observed electrical endpoints."""
from studio.domain.wire_geometry import on_segment


def endpoint_bits(scene, point):
    ends = [e['netBits'] for c in scene['components'] for e in c['ends']
            if (e['location']['x'], e['location']['y']) == point]
    bundles = {b['bundleId']: b for b in scene['bundles']}
    for wire in scene['wires']:
        a, b = [(wire[key]['x'], wire[key]['y']) for key in ('from', 'to')]
        if on_segment(point, a, b):
            ends.append(bundles[wire['bundleId']].get('bitNets', []))
    owners = {tuple(b['netId'] for b in sorted(bits, key=lambda b: b['bit'])) for bits in ends}
    if not owners or () in owners:
        raise ValueError('端点需要落在位宽明确的端口或导线上')
    if len(owners) != 1:
        raise ValueError('交叉处有不同信号，请从交叉点旁的导线开始或结束')
    return next(iter(owners))
