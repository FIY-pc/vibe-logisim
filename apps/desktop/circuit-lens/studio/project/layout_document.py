"""Apply layout geometry to a detached circuit XML without publishing it."""
import xml.etree.ElementTree as ET

from studio.project.layout import plan_layout
from studio.project.movement import plan_movements


def apply_layout(circuit: ET.Element, scene: dict, selected: set[str],
                 wire_ids: set[str], dx: int, dy: int) -> dict[str, str]:
    """Apply a validated selection, returning old-to-new Pin references (x,y).

    Only the supplied circuit is mutated; scene remains read-only. The caller
    owns native validation and publication, and must discard circuit on failure.
    """
    deltas = {identifier: (dx, dy) for identifier in selected}
    return _apply(circuit, scene, deltas, plan_layout(scene, selected, wire_ids, dx, dy))


def apply_positions(circuit: ET.Element, scene: dict, positions: dict[str, tuple[int, int]]) -> dict[str, str]:
    deltas = {c['componentId']: (positions[c['componentId']][0] - c['location']['x'],
                               positions[c['componentId']][1] - c['location']['y'])
              for c in scene['components'] if c['componentId'] in positions}
    return _apply(circuit, scene, deltas, plan_movements(scene, deltas))


def _apply(circuit, scene, deltas, segments):
    targets = [c for c in scene['components'] if c['componentId'] in deltas]
    pin_moves = {}
    available = list(circuit.findall('comp'))
    moves = []
    for c in targets:
        point = c['location']['x'], c['location']['y']
        candidates = [n for n in available if n.get('name') == c['factory']
                      and n.get('loc') == f'({point[0]},{point[1]})']
        if len(candidates)>1:
            # Named co-located aliases are independent objects. Do not move
            # every object at that coordinate when only one was selected.
            key = 'text' if c['factory']=='Text' else 'label'
            label = c.get('attributes', {}).get(key)
            candidates = [n for n in candidates if next((a.get('val') for a in n.findall('a')
                                                       if a.get('name')==key), None)==label]
        if len(candidates)!=1:
            raise ValueError(f"无法唯一对应所选对象 {c['componentId']} ({c['factory']})；请保留其可区分的名称")
        node = candidates[0]; available.remove(node)
        moves.append((node, point, deltas[c['componentId']]))
    for node, point, (dx,dy) in moves:
        node.set('loc', f'({point[0] + dx},{point[1] + dy})')
        if node.get('name') == 'Pin':
            # Appearance port references use x,y, unlike component loc=(x,y).
            # Move the referenced Pin without changing its external port position.
            pin_moves[f'{point[0]},{point[1]}'] = f'{point[0] + dx},{point[1] + dy}'
    for wire in list(circuit.findall('wire')):
        circuit.remove(wire)
    for start, end in segments:
        ET.SubElement(circuit, 'wire', {'from': f'({start[0]},{start[1]})', 'to': f'({end[0]},{end[1]})'})
    for port in circuit.findall('appear/circ-port'):
        if port.get('pin') in pin_moves:
            port.set('pin', pin_moves[port.get('pin')])
    return pin_moves
