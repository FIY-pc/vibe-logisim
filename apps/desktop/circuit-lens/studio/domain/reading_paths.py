"""Concrete signal-reading examples from native bit nets and physical copper.

Named links are legitimate. This report distinguishes electrical association
from a visible copper path; it does not grade either representation.
"""
from bisect import bisect_left, bisect_right
from collections import defaultdict
from math import isfinite

CONTROL_ROLES = {'clock', 'clear', 'preset', 'enable', 'chipSelect'}
PASSIVE = {'Tunnel', 'Text', 'Probe', 'Splitter'}
SOURCES_WITHOUT_OPERATION = {'Constant', 'Ground', 'Power', 'Pull Resistor', 'Clock', 'Pin'}


def _point(value):
    if not isinstance(value, dict):
        return None
    x, y = value.get('x'), value.get('y')
    return (x, y) if all(type(v) in (int, float) and isfinite(v) for v in (x, y)) else None


def _bits(end):
    bits = end.get('netBits', [])
    width = end.get('width')
    if type(width) is not int or width <= 0 or len(bits) != width:
        return None
    ordered = sorted(bits, key=lambda b: b.get('bit', -1))
    if [b.get('bit') for b in ordered] != list(range(width)) or any(not b.get('netId') for b in ordered):
        return None
    return tuple(b['netId'] for b in ordered)


def _physical_roots(focus):
    points = {_point(e.get('location')) for c in focus.get('components', []) for e in c.get('ends', [])}
    wires = [(_point(w.get('from')), _point(w.get('to'))) for w in focus.get('wires', [])]
    points.update(p for pair in wires for p in pair)
    points.discard(None)
    parents = {p: p for p in points}
    def root(p):
        if p not in parents:
            return None
        while parents[p] != p:
            parents[p] = parents[parents[p]]
            p = parents[p]
        return p
    def join(a, b):
        aa, bb = root(a), root(b)
        if aa is not None and bb is not None and aa != bb:
            parents[bb] = aa
    rows, cols = defaultdict(list), defaultdict(list)
    for x, y in points:
        rows[y].append(x); cols[x].append(y)
    for index in (rows, cols):
        for values in index.values():
            values.sort()
    for a, b in wires:
        if a is None or b is None:
            continue
        if a[1] == b[1]:
            values = rows[a[1]]; lo, hi = sorted((a[0], b[0]))
            for x in values[bisect_left(values, lo):bisect_right(values, hi)]:
                join(a, (x, a[1]))
        elif a[0] == b[0]:
            values = cols[a[0]]; lo, hi = sorted((a[1], b[1]))
            for y in values[bisect_left(values, lo):bisect_right(values, hi)]:
                join(a, (a[0], y))
    return {p: root(p) for p in points}


def _port(component, end):
    attrs = {a['name']: a.get('standard', a.get('value')) for a in component.get('attributes', [])}
    label = str(attrs.get('label') or '')
    return {'componentId': component['componentId'], 'factory': component['factoryName'],
            'label': label[:80], 'port': end['index'], 'location': end['location'],
            'semanticRole': end.get('semanticRole')}


def reading_paths(focus):
    roots = _physical_roots(focus)
    groups = defaultdict(lambda: {'outputs': [], 'inputs': [], 'rootNames': defaultdict(set)})
    incomplete = 0
    for component in focus.get('components', []):
        factory = component['factoryName']
        for end in component.get('ends', []):
            bits = _bits(end)
            if bits is None:
                incomplete += 1
                continue
            group = groups[bits]
            if factory == 'Tunnel':
                attrs = {a['name']: a.get('standard', a.get('value')) for a in component.get('attributes', [])}
                if attrs.get('label'):
                    group['rootNames'][roots.get(_point(end.get('location')))].add(str(attrs['label']))
            elif factory not in PASSIVE:
                direction = end.get('direction')
                if direction in ('input', 'output'):
                    group[direction+'s'].append((component, end))
    named, wired, control, ambiguous = 0, 0, 0, 0
    examples = []
    for bits, group in groups.items():
        if len(group['outputs']) != 1:
            if group['inputs']:
                ambiguous += 1
            continue
        source, output = group['outputs'][0]
        if source['factoryName'] in SOURCES_WITHOUT_OPERATION:
            continue
        start = _point(output.get('location')); source_root = roots.get(start)
        if start is None or source_root is None:
            continue
        for sink, input_end in group['inputs']:
            if sink['factoryName'] in {'Pin', 'LED', 'Hex Digit Display'}:
                continue
            finish = _point(input_end.get('location')); target_root = roots.get(finish)
            if finish is None or target_root is None:
                continue
            if input_end.get('semanticRole') in CONTROL_ROLES:
                control += 1
                continue
            if source_root == target_root:
                wired += 1
                continue
            names = sorted(group['rootNames'].get(source_root, set()) & group['rootNames'].get(target_root, set()))
            if not names:
                continue
            named += 1
            distance = abs(start[0]-finish[0]) + abs(start[1]-finish[1])
            # Small windows keep labels readable. Remote links remain in the
            # count but are not presented as a local-wire repair suggestion.
            if abs(start[0]-finish[0]) > 500 or abs(start[1]-finish[1]) > 320:
                continue
            width, height = max(320, abs(start[0]-finish[0])+160), max(200, abs(start[1]-finish[1])+120)
            examples.append({'signals': [s[:80] for s in names[:4]], 'signalCount': len(names),
                'width': len(bits), 'source': _port(source, output), 'consumer': _port(sink, input_end),
                'portDistance': distance, 'connection': 'same ordered native bit nets; separate copper paths joined by named Tunnels',
                'viewport': {'x': int((start[0]+finish[0]-width)//2), 'y': int((start[1]+finish[1]-height)//2),
                             'width': width, 'height': height, 'scale': 1.5}})
    examples.sort(key=lambda x: (x['portDistance'], x['source']['componentId'], x['source']['port'],
                                 x['consumer']['componentId'], x['consumer']['port']))
    chosen, sources = [], set()
    for example in examples:
        source = example['source']['componentId']
        if source not in sources:
            chosen.append(example); sources.add(source)
        if len(chosen) == 6:
            break
    return {'scope': 'One definition, unique-output operation ports with identical complete ordered bit nets. '
                     'Named links require an identical Tunnel label on both copper paths. '
                     'Constants, interface sources, displays, splitter propagation and recognized control inputs excluded. '
                     'No functional importance or reading quality is inferred.',
            'operationLinks': {'physicalCopperOrContact': wired, 'namedOnly': named},
            'coverage': {'portsWithIncompleteBitMapping': incomplete, 'groupsWithoutUniqueOutput': ambiguous,
                         'recognizedControlInputsExcluded': control},
            'nearbyNamedLinks': chosen, 'nearbyNamedLinkCount': len(examples),
            'question': 'Follow a real operation through these source/consumer ports in the drawing. '
                        'Does each named hop help the reader, or hide an adjacent relationship? '
                        'Repair unclear local paths with grouping/wires or another justified representation; '
                        'retain useful remote references and protected geometry. Counts and rendering do not answer this question.'}
