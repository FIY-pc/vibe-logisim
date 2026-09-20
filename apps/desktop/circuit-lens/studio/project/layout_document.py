"""Apply layout geometry to a detached circuit XML without publishing it."""
import xml.etree.ElementTree as ET

from studio.project.layout import plan_layout


def apply_layout(circuit: ET.Element, scene: dict, selected: set[str],
                 wire_ids: set[str], dx: int, dy: int) -> dict[str, str]:
    """Apply a validated selection, returning old-to-new Pin references (x,y).

    Only the supplied circuit is mutated; scene remains read-only. The caller
    owns native validation and publication, and must discard circuit on failure.
    """
    targets = [c for c in scene['components'] if c['componentId'] in selected]
    locations = {(c['factory'], c['location']['x'], c['location']['y']) for c in targets}
    pin_moves = {}
    changed = 0
    for node in circuit.findall('comp'):
        point = tuple((int(value) for value in node.get('loc', '(0,0)').strip('()').split(',')))
        if (node.get('name'), *point) not in locations:
            continue
        node.set('loc', f'({point[0] + dx},{point[1] + dy})')
        if node.get('name') == 'Pin':
            # Appearance port references use x,y, unlike component loc=(x,y).
            # Move the referenced Pin without changing its external port position.
            pin_moves[f'{point[0]},{point[1]}'] = f'{point[0] + dx},{point[1] + dy}'
        changed += 1
    if changed != len(targets):
        raise ValueError('对象位置不唯一，不能安全移动')
    segments = plan_layout(scene, selected, wire_ids, dx, dy)
    for wire in list(circuit.findall('wire')):
        circuit.remove(wire)
    for start, end in segments:
        ET.SubElement(circuit, 'wire', {'from': f'({start[0]},{start[1]})', 'to': f'({end[0]},{end[1]})'})
    for port in circuit.findall('appear/circ-port'):
        if port.get('pin') in pin_moves:
            port.set('pin', pin_moves[port.get('pin')])
    return pin_moves
