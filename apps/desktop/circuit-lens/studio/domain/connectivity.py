"""Compare port-bit relationships across a known geometric relocation.

Observer net IDs and traversal IDs are local to a load, not stable identities.
"""
from collections import defaultdict, deque
import json


def component_key(component):
    return component['factory'], component['location']['x'], component['location']['y']


def component_attributes(component):
    attributes = component.get('attributes', {})
    if isinstance(attributes, list):
        attributes = {a['name']: a.get('standard', a.get('value')) for a in attributes}
    return json.dumps([component.get('factoryClass'), component.get('subcircuit'), attributes],
                      ensure_ascii=False, sort_keys=True)


def match_relocated_components(before, after, moved_ids, dx, dy, positions=None):
    """Match a multiset of objects, retaining pre-existing co-located aliases.

    Coordinates alone are not identity. Distinct attributes disambiguate named
    aliases; indistinguishable objects at one point are matched one-to-one.
    New collisions between previously separate objects are still rejected.
    """
    if len(before) != len(after):
        raise ValueError(f'移动改变了元件数量：{len(before)} → {len(after)}')
    actual, expected = defaultdict(deque), defaultdict(list)
    for c in after:
        actual[(*component_key(c), component_attributes(c))].append(c)
    pairs = []
    for c in before:
        factory, x, y = component_key(c)
        old_point = (x, y)
        if positions is not None and c['componentId'] in positions:
            x, y = positions[c['componentId']]
        elif c['componentId'] in moved_ids:
            x, y = x+dx, y+dy
        expected[(factory, x, y)].append((old_point, c['componentId']))
        key = (factory, x, y, component_attributes(c))
        if not actual[key]:
            raise ValueError(f"移动后无法对应元件 {c['componentId']} ({factory})，预期位置 ({x},{y})；属性或对象数量发生变化")
        pairs.append((c, actual[key].popleft()))
    for (factory,x,y), items in expected.items():
        if len({point for point, _ in items}) > 1:
            raise ValueError(f"移动让原先分开的 {factory} 共址于 ({x},{y})：" + ', '.join(cid for _,cid in items))
    return pairs


def assert_preserved_connections(before, after, moved_ids, dx, dy, *, joins=(), positions=None):
    parents = {}
    def root(net):
        parents.setdefault(net, net)
        if parents[net] != net:
            parents[net] = root(parents[net])
        return parents[net]
    for a, b in joins:
        parents[root(a)] = root(b)
    forward, backward = {}, {}
    checked = 0
    for component, other in match_relocated_components(before, after, moved_ids, dx, dy, positions):
        ends = {end['index']: end for end in other['ends']}
        if len(ends) != len(component['ends']):
            raise ValueError('移动改变了元件接口')
        for end in component['ends']:
            new = ends.get(end['index'])
            if not new or new['width'] != end['width']:
                raise ValueError('移动改变了端口位宽')
            width = end['width']
            if width is None or width < 1:
                continue  # Untyped probes do not establish an electrical relationship.
            old_bits = {b['bit']: b['netId'] for b in end['netBits']}
            new_bits = {b['bit']: b['netId'] for b in new['netBits']}
            if set(old_bits) != set(range(width)) or set(new_bits) != set(old_bits):
                raise ValueError('端口连接存在未知值，无法确认移动保持连通')
            for bit, old_net in old_bits.items():
                old_net = root(old_net)
                new_net = new_bits[bit]
                if forward.setdefault(old_net, new_net) != new_net:
                    raise ValueError('导线路径未保持要求的连接，请调整位置')
                if backward.setdefault(new_net, old_net) != old_net:
                    raise ValueError('导线路径会短接其他信号，请调整位置或拐点')
                checked += 1
    return checked
