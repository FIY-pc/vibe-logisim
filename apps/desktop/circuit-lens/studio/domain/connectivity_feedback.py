"""Static endpoint facts from a complete native circuit observation.

No geometry-based joins, factory-specific defaults, or simulation judgments.
In particular, a mapped bit need not have peers, and a peer marked output need
not actually drive a defined value. Native EndData directions are metadata.
"""

from copy import deepcopy


# Bound the new preview independently of the full native net records.
_OUTPUT_GROUP_LIMIT = 16
_OUTPUT_PEER_LIMIT = 8
_OUTPUT_BIT_LIMIT = 32
_OUTPUT_TEXT_LIMIT = 256


def _endpoint(component, end):
    return {
        **{key: component.get(key) for key in ('componentId', 'factory', 'label')},
        'endIndex': end['index'],
        **{key: end.get(key) for key in (
            'location', 'width', 'direction', 'semanticRole', 'runtimeTooltip')},
        **{key: end[key] for key in ('nativeDirection', 'directionSource') if key in end},
    }


def _index_contacts(contacts):
    members, endpoints, outputs = set(), set(), {}
    for contact in contacts:
        endpoint = (contact.get('componentId'), contact.get('endIndex'))
        members.add((*endpoint, contact.get('bit')))
        endpoints.add(endpoint)
        if contact.get('direction') == 'output':
            outputs.setdefault(endpoint, set()).add(contact.get('bit'))
    return members, endpoints, outputs


def _multiple_output_peers(circuit, peer_nets, selected):
    # One group per complete output-endpoint set, not pairs or repeated reports
    # at every sink. Different bit mappings still retain their native net IDs.
    groups = {}
    for net_id, outputs in peer_nets.items():
        groups.setdefault(frozenset(outputs), []).append((net_id, outputs))
    if not groups:
        return [], 0
    endpoints = {
        (component['componentId'], end['index']): (component, end)
        for component in circuit.get('components', [])
        for end in component.get('ends', [])
    }
    result = []
    for ports, nets in list(groups.items())[:_OUTPUT_GROUP_LIMIT]:
        # Keep a selected output visible even when many peers share the bus.
        shown = sorted(ports, key=lambda p: (p[0] not in selected, *p))[:_OUTPUT_PEER_LIMIT]
        peers = []
        for port in shown:
            component, end = endpoints.get(port, ({'componentId': port[0]}, {'index': port[1]}))
            peer = {**_endpoint(component, end), 'componentLocation': component.get('location')}
            # Direction includes verified implementation corrections, never a drive
            # assertion. Exclusive flags are deliberately not interpreted.
            peer['direction'] = 'output'
            truncated = []
            for key in ('factory', 'label', 'semanticRole', 'runtimeTooltip'):
                value = peer[key]
                if isinstance(value, str) and len(value) > _OUTPUT_TEXT_LIMIT:
                    peer[key] = value[:_OUTPUT_TEXT_LIMIT]
                    truncated.append(key)
            if truncated:
                peer['truncatedFields'] = truncated
            bits, count = [], 0
            for net_id, outputs in nets:
                count += len(outputs[port])
                if len(bits) < _OUTPUT_BIT_LIMIT:
                    bits.extend({'bit': bit, 'netId': net_id}
                                for bit in sorted(outputs[port])[:_OUTPUT_BIT_LIMIT - len(bits)])
            peer['netBits'] = bits
            peer['omittedNetBits'] = count - len(bits)
            peers.append(peer)
        result.append({'peers': peers, 'netCount': len(nets),
                       'omittedPeers': len(ports) - len(peers)})
    return result, max(0, len(groups) - len(result))


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
            'directions may differ from functional roles. multipleOutputPeers '
            'groups output-marked ends sharing bit nets, including verified '
            'implementation corrections and peers '
            'outside the selection; this does not establish an electrical conflict. '
            'Outputs may be tri-stated, inactive, or misdescribed by runtime metadata. '
            'Groups, peers, bit mappings and text are bounded previews; omissions '
            'are explicit. Details remain in '
            'components.ends.netBits and inspect(includeNets=true).'
        ),
        'unconnectedInputs': [],
        'unconnectedOutputs': [],
        'inputsWithoutOutputPeer': [],
        'multipleOutputPeers': [],
        'multipleOutputPeersOmittedGroups': 0,
        'unknownPorts': [],
        'widthIncompatibilities': deepcopy(circuit.get('widthIncompatibilities', [])),
    }
    if not exact:
        return result

    nets = {n['netId']: n for n in circuit.get('nets', [])}
    # Index each visited net once, including peers outside the report selection.
    # Work is linear in contacts plus port bits, rather than fanout squared.
    indexed_nets = {}
    peer_nets = {}
    selected = set(component_ids or [])
    for component in circuit.get('components', []):
        component_id = component['componentId']
        if selected and component_id not in selected:
            continue
        for end in component.get('ends', []):
            endpoint = _endpoint(component, end)
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
                if len(outputs) > 1:
                    peer_nets[net_id] = outputs
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
    result['multipleOutputPeers'], result['multipleOutputPeersOmittedGroups'] = (
        _multiple_output_peers(circuit, peer_nets, selected))
    # Do not expose references into the cached circuit view to callers.
    return deepcopy(result)
