"""Lossless grouping of native bit nets with the same endpoint/slice shape.

Each lane is still one native net, including unusual mappings and shorted bits.
This is a read view, never a new source of connectivity or driver semantics.
"""
from __future__ import annotations

from copy import deepcopy
import json


def group_bit_nets(nets):
    groups, ungrouped = {}, []
    for net in nets:
        # Incomplete observations stay verbatim rather than becoming a guessed
        # complete bus. Unknown metadata participates in the grouping key.
        if (not isinstance(net, dict) or not isinstance(net.get('netId'), str)
                or not isinstance(net.get('contacts'), list) or not isinstance(net.get('slices'), list)
                or 'netIds' in net
                or any(not isinstance(item, dict) or type(item.get('bit')) is not int or 'bits' in item
                       for item in [*net['contacts'], *net['slices']])):
            ungrouped.append(deepcopy(net))
            continue
        common = {k: v for k, v in net.items() if k not in ('netId', 'contacts', 'slices')}
        shape = {**common, **{key: [{k: v for k, v in item.items() if k != 'bit'} for item in net[key]]
                             for key in ('contacts', 'slices')}}
        key = json.dumps(shape, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        groups.setdefault(key, (shape, []))[1].append(net)

    result = []
    for shape, lanes in groups.values():
        # Native IDs are hashes, not bit order. Sort by the actual endpoint bit
        # mappings so straight buses read [0,1,...]; reversed slices stay exact.
        lanes.sort(key=lambda net: (tuple(c['bit'] for c in net['contacts']),
                                   tuple(s['bit'] for s in net['slices']), net['netId']))
        group = {**deepcopy(shape), 'netIds': [lane['netId'] for lane in lanes]}
        for key in ('contacts', 'slices'):
            for index, item in enumerate(group[key]):
                item['bits'] = [lane[key][index]['bit'] for lane in lanes]
        result.append(group)
    return {
        'netCount': len(nets), 'groups': result, 'ungroupedNets': ungrouped,
        'scope': 'Each netIds[i] is one independent native bit net. All contacts.bits[i] '
                 'and slices.bits[i] in its group belong to that net. Grouping does not '
                 'connect lanes or assert a bus width, driver, or value. Repeated endpoints '
                 'can connect distinct bits to the same net. Ungrouped records remain verbatim.',
    }
