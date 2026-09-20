"""Static endpoint facts from a complete native circuit observation.

No geometry-based joins, factory-specific defaults, or simulation judgments.
In particular, a mapped bit need not have peers, and a peer marked output need
not actually drive a defined value. Native EndData directions are metadata.
"""

from copy import deepcopy


def _index_contacts(contacts):
    members, endpoints, outputs = set(), set(), set()
    for contact in contacts:
        endpoint = (contact.get('componentId'), contact.get('endIndex'))
        members.add((*endpoint, contact.get('bit')))
        endpoints.add(endpoint)
        if contact.get('direction') == 'output':
            outputs.add(endpoint)
    return members, endpoints, outputs


def connectivity_feedback(circuit, *, exact, component_ids=None):
    """Inspect full native nets, optionally reporting only selected components.

    Pass the complete transformed circuit, not inspect_circuit's optional nets.
    ``exact`` must come from the observation capability. Entries group affected
    bits by end; detailed contacts remain in the existing native net records.
    """
    result = {
        'status': 'observed' if exact else 'unavailable',
        'scope': (
            'Static native endpoint facts, not drive/value/correctness judgments. '
            'Unconnected lists bits without endpoint peers, regardless of wires. '
            'inputsWithoutOutputPeer excludes those bits: peers exist but none is '
            'marked output; inout peers are not interpreted as drivers. EndData '
            'directions may differ from functional roles. Details remain in '
            'components.ends.netBits and inspect(includeNets=true).'
        ),
        'unconnectedInputs': [],
        'unconnectedOutputs': [],
        'inputsWithoutOutputPeer': [],
        'unknownPorts': [],
        'widthIncompatibilities': deepcopy(circuit.get('widthIncompatibilities', [])),
    }
    if not exact:
        return result

    nets = {n['netId']: n for n in circuit.get('nets', [])}
    # Index each visited net once, including peers outside the report selection.
    # Work is linear in contacts plus port bits, rather than fanout squared.
    indexed_nets = {}
    selected = set(component_ids or [])
    for component in circuit.get('components', []):
        component_id = component['componentId']
        if selected and component_id not in selected:
            continue
        for end in component.get('ends', []):
            endpoint = {
                **{key: component.get(key) for key in ('componentId', 'factory', 'label')},
                'endIndex': end['index'],
                **{key: end.get(key) for key in (
                    'location', 'width', 'direction', 'semanticRole', 'runtimeTooltip')},
            }
            width = end.get('width')
            if type(width) is not int or width < 0:
                result['unknownPorts'].append({**endpoint, 'reason': 'unknown-width'})
                continue
            mappings = {}
            for mapping in end.get('netBits', []):
                mappings.setdefault(mapping['bit'], []).append(mapping.get('netId'))
            missing, no_peer, no_output = [], [], []
            for bit in range(width):
                net_ids = mappings.get(bit, [])
                net = nets.get(net_ids[0]) if len(net_ids) == 1 else None
                # Require reciprocal membership. An absent/partial observation
                # must not turn into an assertion that the port is disconnected.
                if not net:
                    missing.append(bit)
                    continue
                net_id = net_ids[0]
                if net_id not in indexed_nets:
                    indexed_nets[net_id] = _index_contacts(net.get('contacts', []))
                members, endpoints, outputs = indexed_nets[net_id]
                port = (component_id, end['index'])
                if (*port, bit) not in members:
                    missing.append(bit)
                    continue
                # All bits of this same end are excluded, even if a splitter
                # maps several of them onto one net; duplicates add no peers.
                if len(endpoints) == 1:
                    no_peer.append(bit)
                elif not outputs or (len(outputs) == 1 and port in outputs):
                    no_output.append(bit)
            if missing:
                result['unknownPorts'].append({**endpoint, 'reason': 'unmapped-bits', 'bits': missing})
            direction = end.get('direction')
            groups = []
            if direction in ('input', 'output'):
                key = 'unconnectedInputs' if direction == 'input' else 'unconnectedOutputs'
                groups.append((key, no_peer))
            if direction == 'input':
                groups.append(('inputsWithoutOutputPeer', no_output))
            for key, bits in groups:
                if bits:
                    result[key].append({**endpoint, 'bits': bits})
    if result['unknownPorts']:
        result['status'] = 'partial'
    # Do not expose references into the cached circuit view to callers.
    return deepcopy(result)
