"""Compare native port-bit partitions under explicit comparison-local matches.

Neither native net IDs nor component traversal IDs are cross-version identity.
The caller provides the matched component pairs; unmatched objects stay distinct.
"""
from collections import defaultdict


def compare_connections(before, after, matches):
    labels = [{}, {}]
    for index, (a, b) in enumerate(matches):
        labels[0][a] = labels[1][b] = f'm{index}'
    endpoints, partitions, unknown = [{}, {}], [], 0
    for side, components in enumerate((before, after)):
        nets = defaultdict(set)
        for c in components:
            key = labels[side].get(c['componentId'], f'{side}:{c["componentId"]}')
            for end in c.get('ends', []):
                width = end.get('width')
                if not isinstance(width, int) or width < 1:
                    unknown += 1; continue
                bits = {b['bit']: b.get('netId') for b in end.get('netBits', [])}
                if set(bits) != set(range(width)) or not all(bits.values()):
                    unknown += 1; continue
                # Index alone is insufficient when a component changes its
                # port interface. Runtime role/direction/tooltip travel with it.
                contract = repr((end.get('direction'), end.get('semanticRole'), end.get('runtimeTooltip')))
                endpoint = (key, (end['index'], contract))
                endpoints[side][endpoint] = {'component': c, 'port':end['index'],
                    'portName':end.get('runtimeTooltip') or end.get('semanticRole') or f'端口 {end["index"]}',
                    'location':end['location'], 'width':width}
                for bit, net in bits.items(): nets[net].add((*endpoint, bit))
        partitions.append({frozenset(group) for group in nets.values()})

    delta = [(0, group) for group in partitions[0]-partitions[1]] + [(1, group) for group in partitions[1]-partitions[0]]
    # Join changed partitions sharing a port-bit, then combine parallel bus bits
    # only when their full relative bit mapping is identical (crossed bits differ).
    parents = list(range(len(delta)))
    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]; i = parents[i]
        return i
    seen = {}
    for i, (_, group) in enumerate(delta):
        for token in group:
            if token in seen: parents[root(i)] = root(seen[token])
            else: seen[token] = i
    joined = defaultdict(lambda: [[], []])
    for i, (side, group) in enumerate(delta): joined[root(i)][side].append(group)
    buses = {}
    for groups in joined.values():
        if all(len(g) < 2 for side in groups for g in side): continue
        offset = min(t[2] for side in groups for g in side for t in g)
        shape = tuple(tuple(sorted(tuple(sorted((a,b,bit-offset) for a,b,bit in group)) for group in side)) for side in groups)
        buses.setdefault(shape, []).append(groups)
    rows = []
    for samples in buses.values():
        views = []
        affected_bits = defaultdict(set)
        for side in (0, 1):
            grouped = defaultdict(lambda: defaultdict(set))
            components = {}
            for sample in samples:
                for group in sample[side]:
                    offset = min(bit for _,_,bit in group)
                    group_key = tuple(sorted((a,b,bit-offset) for a,b,bit in group))
                    for a,b,bit in group:
                        grouped[group_key][(a,b)].add(bit)
                        affected_bits[(a,b)].add(bit)
            connections = []
            for group in grouped.values():
                entries = []
                for endpoint, bits in sorted(group.items()):
                    description = endpoints[side][endpoint]
                    c = description['component']; components[c['componentId']] = c
                    entries.append({k:v for k,v in description.items() if k!='component'} | {
                        'label':c.get('label') or c['factory'], 'factory':c['factory'], 'bits':sorted(bits)})
                connections.append(entries)
            views.append({'components':list(components.values()), 'wires':[], 'connections':connections})
        rows.append({'kind':'connection', 'category':'connections', 'change':'modified' if all(v['components'] for v in views) else 'added' if views[1]['components'] else 'removed',
                     'before':views[0], 'after':views[1], 'bitCount':max(map(len,affected_bits.values()))})
    rows.sort(key=lambda r:repr([[[(e['label'],e['port'],e['bits']) for e in g] for g in r[s]['connections']] for s in ('before','after')]))
    return {'status':'partial' if unknown else 'changed' if rows else 'unchanged', 'unknownPorts':unknown,
            'matchedComponents':len(matches), 'rows':rows}
