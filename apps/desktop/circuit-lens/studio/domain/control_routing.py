"""Short shared rails within one bank column, with atomic obstacle checks.

This is a geometry preference for an already verified single-bit net. A rail
that cannot fit keeps named endpoints; no partial rail or winding tree is added.
"""
from studio.domain.routing import Router
from collections import Counter


def repeated_control_networks(layout, assigned):
    """Only native semantic evidence qualifies a net as control distribution.

    Fanout alone cannot tell a one-bit data lane from a clock or enable. Unknown
    custom-symbol ports keep their ordinary connections and representation.
    """
    roles = {'clock', 'clear', 'preset', 'enable', 'chipSelect'}
    result = set()
    for key, ports in layout.nets.items():
        if len(layout.bits_of[key]) != 1 or layout.classes[key] == 'constant': continue
        kinds = Counter((layout.by_id[cid]['factoryName'], idx) for cid,idx in ports
                        if cid in assigned and layout.by_id[cid]['ends'][idx].get('direction') == 'input'
                        and layout.by_id[cid]['ends'][idx].get('semanticRole') in roles)
        if kinds and max(kinds.values()) >= 3: result.add(key)
    return result


def shared_rail(router, moved, ports, port_edge, leads, corridor, label_boxes=()):
    ends = [moved[cid]['ends'][idx] for cid, idx in ports]
    points = [(e['location']['x'], e['location']['y']) for e in ends]
    if any(v % 10 for p in points for v in p): return None
    normals = [port_edge(moved[cid], idx)[2] for cid, idx in ports]
    if len(set(normals)) != 1: return None
    bodies = [moved[cid]['bounds'] for cid, _idx in ports]
    owner = router.owner(ends[0]['netBits'])
    if any(router.owner(e['netBits']) != owner for e in ends): return None
    left = corridor['left']
    right = corridor['right']
    prefer_left = sum(p[0]-(b['x']+b['width']/2) for p,b in zip(points,bodies)) < 0
    sx, sy = normals[0]
    candidates = []
    if sx:
        # A side-facing enable needs a straight comb on its own column, not a
        # tree that alternates between columns. Search inside the padded bank
        # edge, so existing clock/reset rails outside it remain undisturbed.
        start, stop = (left+10, min(p[0] for p in points)-20) if sx < 0 else (right-10, max(p[0] for p in points)+20)
        for rail in range(start, stop+(10 if sx < 0 else -10), 10 if sx < 0 else -10):
            joins = [(rail, p[1]) for p in points]
            candidates.append([((rail,min(p[1] for p in joins)),(rail,max(p[1] for p in joins))),
                               *[(p,j) for p,j in zip(points,joins)]])
    else:
        for gap in (0, 10, 20):
            for rail in ((left-gap,right+gap) if prefer_left else (right+gap,left-gap)):
                joins = [(rail, p[1] + sy * max(2, leads.get(port, 1)+1)) for p,port in zip(points,ports)]
                segments = [((rail,min(p[1] for p in joins)),(rail,max(p[1] for p in joins)))]
                for p,j in zip(points,joins): segments.extend([(p,(p[0],j[1])),((p[0],j[1]),j)])
                candidates.append(segments)
    for segments in candidates:
        segments = [(a,b) for a,b in segments if a!=b]
        if any(q in router.blocked or any(o!=owner for o in router.port_owners.get(q,()))
               or any(o!=owner for o,_axis,_end in router.at.get(q,()))
               or (sx and any(o!=owner and box[0]<q[0]<box[2] and box[1]<q[1]<box[3] for o,box in label_boxes))
               for a,b in segments for q in Router.grid(a,b)):
            continue
        bus = tuple(b['netId'] for b in ends[0]['netBits'])
        for a,b in segments: router.add(a,b,owner,bus)
        for e in ends[1:]: router.connected.join(bus,tuple(b['netId'] for b in e['netBits']))
        return segments
    return None
