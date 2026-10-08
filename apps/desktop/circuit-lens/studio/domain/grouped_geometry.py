"""Geometry constraints shared by organized placement and its feedback.

Native visualBounds include the runtime's own label font/position. Tunnel
reservations are conservative estimates until native emission and readback.
"""
from collections import defaultdict
import math

from studio.domain.schematic_layout import _attr, _snap, _text_width, _pin_order_key, _label_box, _chain_offsets


def padding_for(layout, cid, assigned):
    c = layout.by_id[cid]
    b, v = c['bounds'], c.get('visualBounds', c['bounds'])
    left = max(20, b['x'] - v['x'] + 10)
    right = max(20, v['x'] + v['width'] - b['x'] - b['width'] + 10)
    top = max(30, b['y'] - v['y'] + 20)
    bottom = max(30, v['y'] + v['height'] - b['y'] - b['height'] + 20)
    ports = {p: key for key, ps in layout.nets.items() for p in ps}
    vertical = defaultdict(list)
    for e in c['ends']:
        key = ports.get((cid, e['index']))
        if key is None:
            continue
        labels = layout.labels_of_net.get(key, set())
        # Local named roots are added to the reservation if feedback finds a
        # collision. This avoids expanding every already-readable small motif.
        if not labels:
            continue
        remote = any(assigned.get(p[0]) != assigned[cid] for p in layout.nets[key]
                     if p[0] not in layout.tunnels and p[0] not in layout.constants)
        if not remote and layout.classes[key] != 'global':
            if (cid,e['index']) not in getattr(layout,'label_padding_ports',set()):
                continue
        (_x, _y), facing, _step = layout._port_edge(c, e['index'])
        reach = max(_text_width(label) for label in labels) + 20
        if facing == 'east': left = max(left, reach)
        elif facing == 'west': right = max(right, reach)
        else: vertical[facing].append(reach)
    for facing, widths in vertical.items():
        depth = 20 + 20 * math.ceil(len(widths) / 2)
        if facing == 'south': top = max(top, depth)
        else: bottom = max(bottom, depth)
        left, right = max(left, max(widths)), max(right, max(widths))
    return tuple(_snap(v + 5) for v in (left, top, right, bottom))


def preserve_interface_order(layout):
    """Keep valid local placements. Repair reordered default Pins on a rail.

    Facing and native position order define a default subcircuit interface.
    A custom appearance binds identity independently. Explicit fixed Pins and
    contact assemblies are anchors, never silently separated or moved here.
    """
    if layout.circuit.find('appear') is not None:
        return
    faces = defaultdict(list)
    for c in layout.components:
        if c['factoryName'] == 'Pin':
            faces[_attr(c, 'facing') or 'east'].append(c['componentId'])
    boxes = [layout._moved(c).get('visualBounds', layout._moved(c)['bounds'])
             for c in layout.components if c['componentId'] in layout.body_ids and c['factoryName'] != 'Tunnel']
    if not boxes:
        return
    left = min(b['x'] for b in boxes); top = min(b['y'] for b in boxes)
    right = max(b['x'] + b['width'] for b in boxes)
    bottom = max(b['y'] + b['height'] for b in boxes)
    repairs = []
    for facing, ids in faces.items():
        order_key = _pin_order_key(facing)
        def point(cid, placed=False):
            c = layout.by_id[cid]; dx, dy = layout.placement.get(cid, (0, 0)) if placed else (0, 0)
            return c['location']['x'] + dx, c['location']['y'] + dy
        ids.sort(key=lambda cid: order_key(point(cid)))
        if sorted(ids, key=lambda cid: order_key(point(cid, True))) == ids:
            continue
        movable = {cid for cid in ids if cid in layout.body_ids and cid not in layout.fused
                   and cid not in layout.fused.values() and not layout._is_panel(layout.by_id[cid])}
        axis = 1 if facing in ('east', 'west') else 0
        sizes = {cid: layout.by_id[cid].get('visualBounds', layout.by_id[cid]['bounds'])[
            'height' if axis else 'width'] for cid in ids}
        # Solve ordered intervals between immutable anchors. No changing the
        # author's absolute fixed positions to make the constraint convenient.
        positions = {}; index = 0
        while index < len(ids):
            if ids[index] not in movable:
                positions[ids[index]] = point(ids[index], True)[axis]; index += 1; continue
            end = index
            while end < len(ids) and ids[end] in movable: end += 1
            run = ids[index:end]
            gaps = [max(60, _snap((sizes[a] + sizes[b]) / 2 + 30)) for a,b in zip(run, run[1:])]
            lo = positions[ids[index-1]] + max(60, sizes[ids[index-1]] + sizes[run[0]]) if index else -math.inf
            hi = point(ids[end], True)[axis] - max(60, sizes[ids[end]] + sizes[run[-1]]) if end < len(ids) else math.inf
            start = max(lo, min((top if axis else left) + 60, hi - sum(gaps)))
            if start + sum(gaps) > hi:
                raise ValueError('固定 Pin 之间没有足够空间保持接口次序；需调整可改范围，不能把接口换序。')
            for n, cid in enumerate(run):
                positions[cid] = _snap(start + sum(gaps[:n]))
            index = end
        reach = max((_text_width(_attr(layout.by_id[cid], 'label') or '') for cid in movable), default=0)
        rail = _snap({'east': left - reach - 70, 'west': right + reach + 70,
                      'south': top - 100, 'north': bottom + 100}[facing])
        for cid in movable:
            old = point(cid); new = (rail, positions[cid]) if axis else (positions[cid], rail)
            layout.placement[cid] = (new[0] - old[0], new[1] - old[1])
        if sorted(ids, key=lambda cid: order_key(point(cid, True))) != ids:
            raise ValueError('固定接触组合与接口顺序冲突；不能隐式改变接口。')
        repairs.append({'facing': facing, 'orderedComponentIds': ids, 'movedComponentIds': sorted(movable)})
    layout.report['interfaceOrderRepairs'] = repairs


def label_feedback(layout):
    """Report remaining estimated flag collisions, with actionable identities."""
    boxes, flags, issues = [], [], []
    for cid, c in layout.moved.items():
        if c['factoryName'] in ('Tunnel', 'Text'): continue
        b = c.get('visualBounds', c['bounds'])
        boxes.append((cid, (b['x'], b['y'], b['x']+b['width'], b['y']+b['height'])))
    def overlap(a, b):
        return min(a[2],b[2])-max(a[0],b[0]) >= 3 and min(a[3],b[3])-max(a[1],b[1]) >= 3
    for port, labels in layout.anchors.items():
        (x,y), facing, (sx,sy) = layout._port_edge(layout.moved[port[0]], port[1])
        facing = layout.lead_facing.get(port, facing); n = layout.lead_steps.get(port, 1)
        for k, label in zip(_chain_offsets(labels, (sx,sy)), labels):
            flag = _label_box((x+sx*(n+k), y+sy*(n+k)), facing, label)
            for cid, box in boxes:
                if overlap(flag, box): issues.append({'kind':'label-body', 'componentId':port[0], 'port':port[1], 'label':label, 'otherComponentId':cid})
            for other, text, box in flags:
                if overlap(flag, box): issues.append({'kind':'label-label', 'componentId':port[0], 'port':port[1], 'label':label, 'otherComponentId':other[0], 'otherPort':other[1], 'otherLabel':text})
            flags.append((port,label,flag))
    layout.report['labelGeometry'] = {'method':'native visual bounds and estimated tunnel text boxes',
        'remainingCollisions':len(issues), 'examples':issues[:24],
        'note':'Geometric feedback, not a complete readability score. Inspect the rendered labels.'}
