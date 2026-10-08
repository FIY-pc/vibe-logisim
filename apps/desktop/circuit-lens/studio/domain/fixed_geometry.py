"""Physical fixed copper, independent of electrically merged Tunnel bundles."""
def point(value):
    return value['x'], value['y']


def region_segment(wire, below_y):
    """Original copper within the closed top-region boundary, including frames."""
    if below_y is None:
        return None
    a, b = point(wire['from']), point(wire['to'])
    if min(a[1], b[1]) >= below_y:
        return None
    if max(a[1], b[1]) <= below_y:
        return dict(wire)
    if a[0] != b[0]:
        raise ValueError('固定区域边界遇到非正交导线')
    low = min((a,b), key=lambda p:p[1])
    return {**wire, 'from':dict(zip(('x','y'), low)), 'to':{'x':a[0], 'y':below_y}}


def fixed_copper(focus, fixed_ids, below_y):
    wires = focus.get('wires', [])
    parents = {}
    def root(p):
        parents.setdefault(p,p)
        if parents[p]!=p:parents[p]=root(parents[p])
        return parents[p]
    for w in wires:
        a,b=point(w['from']),point(w['to']);parents[root(a)]=root(b)
    fixed, moving = set(),set()
    for c in focus['components']:
        if c['componentId'] in fixed_ids:
            fixed.update(root(point(e['location'])) for e in c['ends'])
        elif c['factoryName']!='Tunnel':
            moving.update(root(point(e['location'])) for e in c['ends'])
    stable = fixed-moving
    kept, cuts = [], []
    for w in wires:
        region = region_segment(w,below_y)
        if root(point(w['from'])) in stable:
            kept.append(dict(w))
        elif region:
            kept.append(region)
            if region['from']!=w['from'] or region['to']!=w['to']:
                cut = max((point(region['from']),point(region['to'])),key=lambda p:p[1])
                cuts.append({'point':cut,'bundleId':w['bundleId']})
    return kept,cuts
