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
    locations = {(c['factory'], c['location']['x'], c['location']['y']): deltas[c['componentId']] for c in targets}
    pin_moves = {}
    changed = 0
    for node in circuit.findall('comp'):
        point = tuple((int(value) for value in node.get('loc', '(0,0)').strip('()').split(',')))
        if (node.get('name'), *point) not in locations:
            continue
        dx, dy = locations[(node.get('name'), *point)]
        node.set('loc', f'({point[0] + dx},{point[1] + dy})')
        if node.get('name') == 'Pin':
            # Appearance port references use x,y, unlike component loc=(x,y).
            # Move the referenced Pin without changing its external port position.
            pin_moves[f'{point[0]},{point[1]}'] = f'{point[0] + dx},{point[1] + dy}'
        changed += 1
    if changed != len(targets):
        raise ValueError('对象位置不唯一，不能安全移动')
    for wire in list(circuit.findall('wire')):
        circuit.remove(wire)
    for start, end in segments:
        ET.SubElement(circuit, 'wire', {'from': f'({start[0]},{start[1]})', 'to': f'({end[0]},{end[1]})'})
    for port in circuit.findall('appear/circ-port'):
        if port.get('pin') in pin_moves:
            port.set('pin', pin_moves[port.get('pin')])
    return pin_moves
