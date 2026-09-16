"""Compare port-bit relationships across a known geometric relocation.

Observer net IDs and traversal IDs are local to a load, not stable identities.
"""


def component_key(component):
    return component['factory'], component['location']['x'], component['location']['y']


def assert_preserved_connections(before, after, moved_ids, dx, dy, *, joins=()):
    parents = {}
    def root(net):
        parents.setdefault(net, net)
        if parents[net] != net:
            parents[net] = root(parents[net])
        return parents[net]
    for a, b in joins:
        parents[root(a)] = root(b)
    actual = {component_key(c): c for c in after}
    if len(actual) != len(after) or len(before) != len(after):
        raise ValueError('移动后元件重叠或数量改变，请调整位置')
    forward, backward = {}, {}
    checked = 0
    for component in before:
        factory, x, y = component_key(component)
        if component['componentId'] in moved_ids:
            x, y = x + dx, y + dy
        other = actual.get((factory, x, y))
        if other is None:
            raise ValueError('移动后无法对应原有元件')
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
