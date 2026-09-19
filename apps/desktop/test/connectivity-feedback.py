"""Focused native counterexamples for static connectivity feedback; no model.

Fixtures are generic and generated here, independent of experiment 011. Both
installed runtimes and the production inspect integration are exercised.
"""
from copy import deepcopy
from pathlib import Path
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.domain.connectivity_feedback import connectivity_feedback


def fixture(version):
    root = ET.Element('project', source=version, version='1.0')
    for index, name in enumerate(('Wiring', 'Gates', 'Plexers', 'Arithmetic')):
        ET.SubElement(root, 'lib', name=str(index), desc='#' + name)
    ET.SubElement(root, 'main', name='Connected')

    def circuit(name):
        return ET.SubElement(root, 'circuit', name=name)

    def comp(c, name, x, y, lib='0', **attrs):
        node = ET.SubElement(c, 'comp', name=name, lib=lib, loc=f'({x},{y})')
        for key, value in attrs.items():
            ET.SubElement(node, 'a', name=key, val=str(value))

    def wire(c, x, y, a, b):
        ET.SubElement(c, 'wire', {'from': f'({x},{y})', 'to': f'({a},{b})'})

    c = circuit('Connected')
    comp(c, 'Pin', 100, 100, label='Source', width=4)
    comp(c, 'Pin', 200, 100, label='Sink', width=4, output='true')
    wire(c, 100, 100, 200, 100)

    c = circuit('Coincident')
    comp(c, 'Constant', 100, 100, value='0x1')
    comp(c, 'Pin', 100, 100, label='Sink', output='true')

    for name in ('Isolated', 'WireStub'):
        c = circuit(name)
        comp(c, 'Pin', 200, 100, label='Sink', width=32 if name == 'Isolated' else 4, output='true')
        comp(c, 'Constant', 100, 160, width=4, value='0xa')
        if name == 'WireStub':
            wire(c, 160, 100, 200, 100)

    c = circuit('InputPeers')
    comp(c, 'Pin', 100, 100, label='SinkA', output='true')
    comp(c, 'Pin', 200, 100, label='SinkB', output='true')
    wire(c, 100, 100, 200, 100)

    c = circuit('DefaultCarry')
    comp(c, 'Adder', 200, 100, lib='3', width=4)
    comp(c, 'Constant', 100, 90, width=4, value='0x2')
    comp(c, 'Constant', 100, 110, width=4, value='0x3')
    wire(c, 100, 90, 160, 90)
    wire(c, 100, 110, 160, 110)
    comp(c, 'Pin', 300, 100, width=4, output='true', label='Sum')
    wire(c, 200, 100, 300, 100)

    c = circuit('PartialBus')
    comp(c, 'Splitter', 200, 100, fanout=2, incoming=4, facing='east',
         **{'bit0': 0, 'bit1': 0, 'bit2': 1, 'bit3': 1})
    comp(c, 'Pin', 100, 100, width=4, output='true', label='Sink')
    wire(c, 100, 100, 200, 100)
    comp(c, 'Constant', 280, 80, width=2, value='0x3')
    wire(c, 220, 80, 280, 80)  # Second branch deliberately has no source.

    c = circuit('UnknownWidth')
    comp(c, 'Probe', 200, 100, label='Probe')

    c = circuit('WidthConflict')
    comp(c, 'Constant', 100, 100, width=2, value='0x0')
    comp(c, 'Pin', 200, 100, width=1, output='true', label='Sink')
    wire(c, 100, 100, 200, 100)

    c = circuit('DriveConflict')
    comp(c, 'Constant', 100, 100, value='0x0')
    comp(c, 'Constant', 100, 200, value='0x1')
    comp(c, 'Pin', 300, 100, output='true', label='Clash')
    wire(c, 100, 100, 200, 100)
    wire(c, 200, 100, 300, 100)
    wire(c, 200, 100, 200, 200)
    wire(c, 100, 200, 200, 200)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


class ConnectivityFeedback(unittest.TestCase):
    def test_native_counterexamples(self):
        for version in ('2.16.2.2', '2.15.0'):
            with self.subTest(runtime=version), tempfile.TemporaryDirectory(prefix='vibe-connectivity-') as directory:
                root = Path(directory)
                source = root / 'fixture.circ'
                original = fixture(version)
                source.write_bytes(original)
                w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'connectivity-feedback')
                try:
                    w.open_path(source)
                    before = deepcopy((w.revision_id, w.artifact_sha256, w.history.record))
                    frozen = w.frozen_path.read_bytes()

                    def call(tool, circuit, **arguments):
                        return w.application.agent_tool({
                            'projectId': w.history.record['id'], 'revisionId': w.revision_id,
                            'tool': tool, 'arguments': {'circuit': circuit, **arguments},
                        })

                    scenes, facts = {}, {}
                    for name in (c.get('name') for c in ET.fromstring(original).findall('circuit')):
                        inspection = call('inspect_circuit', name, includeNets=True)
                        self.assertEqual(inspection['authority'], 'exact-runtime', inspection.get('error'))
                        view = w.circuit_view(name)
                        self.assertTrue(view['capabilities']['exactConnectivity'])
                        self.assertEqual(view['runtime']['jarSha256'], w.observer.profile()['runtimeJarSha256'])
                        scene = view['circuit']
                        self.assertEqual(scene['nets'], inspection['nets'])
                        saved = deepcopy(scene)
                        scenes[name] = scene
                        facts[name] = connectivity_feedback(scene, exact=True)
                        self.assertEqual(inspection['connectivityIssues'], facts[name])
                        compact = call('inspect_circuit', name)
                        self.assertEqual(compact['nets'], [])
                        self.assertEqual(compact['connectivityIssues'], facts[name])
                        self.assertEqual(scene, saved, 'helper is a pure observation')

                    for name in ('Connected', 'Coincident'):
                        self.assertEqual(facts[name]['unconnectedInputs'], [])
                        self.assertEqual(facts[name]['unconnectedOutputs'], [])
                        self.assertEqual(facts[name]['inputsWithoutOutputPeer'], [])
                        self.assertEqual(facts[name]['status'], 'observed')
                    self.assertEqual(scenes['Coincident']['wires'], [])

                    for name in ('Isolated', 'WireStub'):
                        f = facts[name]
                        sink, = f['unconnectedInputs']
                        orphan, = f['unconnectedOutputs']
                        self.assertEqual(sink['bits'], list(range(32 if name == 'Isolated' else 4)))
                        self.assertEqual(orphan['factory'], 'Constant')
                        self.assertEqual(orphan['bits'], [0, 1, 2, 3])
                        self.assertEqual(f['inputsWithoutOutputPeer'], [], 'no-peer bits appear only once')
                        self.assertNotIn('evidence', sink, 'detailed contacts belong in includeNets, not repeated feedback')
                        # Drill into native evidence separately from the compact feedback.
                        scene = scenes[name]
                        nets = {n['netId']: n for n in scene['nets']}
                        bundles = {b['bundleId']: b for b in scene['bundles']}
                        component = next(c for c in scene['components'] if c['componentId'] == sink['componentId'])
                        for bit in component['ends'][0]['netBits']:
                            net = nets[bit['netId']]
                            self.assertEqual(len(net['contacts']), 1)
                            wires = [w for s in net['slices'] for w in bundles[s['bundleId']]['wireIds']]
                            self.assertEqual(bool(wires), name == 'WireStub')
                        # Demonstrates why the former production predicate missed these.
                        self.assertEqual([e for c in scenes[name]['components'] for e in c['ends']
                                          if e['direction'] == 'input' and not e['netBits']], [])

                    self.assertEqual(facts['InputPeers']['unconnectedInputs'], [])
                    self.assertEqual(len(facts['InputPeers']['inputsWithoutOutputPeer']), 2)
                    self.assertTrue(all(len(n['contacts']) == 2 for n in scenes['InputPeers']['nets']))

                    carry = [p for p in facts['DefaultCarry']['unconnectedInputs']
                             if p['factory'] == 'Adder' and p['endIndex'] == 3]
                    self.assertEqual(len(carry), 1)
                    default = call('simulate_circuit', 'DefaultCarry', vectors=[{'inputs': {}, 'expected': {'Sum': 5}}])
                    self.assertEqual(default['rows'][0]['outputs']['Sum'], 5)
                    self.assertTrue(default['rows'][0]['passed'], 'floating carry does not imply a functional error')

                    partial, = facts['PartialBus']['inputsWithoutOutputPeer']
                    self.assertEqual(partial['bits'], [2, 3])
                    self.assertEqual(partial['label'], 'Sink')
                    self.assertEqual(facts['PartialBus']['unconnectedInputs'], [])
                    scene = scenes['PartialBus']
                    nets = {n['netId']: n for n in scene['nets']}
                    sink = next(c for c in scene['components'] if c['label'] == 'Sink')
                    for bit in sink['ends'][0]['netBits']:
                        if bit['bit'] in partial['bits']:
                            peers = [c for c in nets[bit['netId']]['contacts'] if c['componentId'] != sink['componentId']]
                            self.assertTrue(peers and all(c['direction'] == 'inout' for c in peers))
                    # Report filtering must not remove the source from the peer graph.
                    sink = next(c for c in scenes['Connected']['components'] if c['label'] == 'Sink')
                    selected = connectivity_feedback(scenes['Connected'], exact=True, component_ids=[sink['componentId']])
                    self.assertEqual(selected['inputsWithoutOutputPeer'], [])
                    self.assertEqual(call('inspect_circuit', 'Connected', componentIds=[sink['componentId']])['connectivityIssues'], selected)

                    unknown, = facts['UnknownWidth']['unknownPorts']
                    self.assertEqual(unknown['reason'], 'unknown-width')
                    self.assertEqual(facts['UnknownWidth']['unconnectedInputs'], [])
                    conflict = facts['WidthConflict']
                    self.assertTrue(conflict['widthIncompatibilities'])
                    self.assertEqual(conflict['status'], 'partial')
                    self.assertEqual(conflict['unconnectedInputs'], [])
                    self.assertEqual(conflict['inputsWithoutOutputPeer'], [])
                    self.assertEqual(len(conflict['unknownPorts']), 2)

                    # Output contacts are not a proof of correct or defined drive.
                    self.assertEqual(facts['DriveConflict']['inputsWithoutOutputPeer'], [])
                    clash = call('simulate_circuit', 'DriveConflict', vectors=[{'inputs': {}}])
                    self.assertIsNone(clash['rows'][0]['outputs']['Clash'])
                    self.assertIn('E', clash['rows'][0]['bits']['Clash'].upper())

                    missing_net = deepcopy(scenes['Connected'])
                    missing_net['nets'].pop()
                    unavailable = connectivity_feedback(missing_net, exact=True)
                    self.assertEqual(unavailable['status'], 'partial')
                    self.assertEqual(unavailable['unconnectedInputs'], [])
                    self.assertEqual(unavailable['inputsWithoutOutputPeer'], [])
                    fallback = connectivity_feedback(scenes['Isolated'], exact=False)
                    self.assertEqual(fallback['status'], 'unavailable')
                    self.assertEqual(fallback['unconnectedInputs'], [])

                    self.assertEqual(source.read_bytes(), original)
                    self.assertEqual(w.frozen_path.read_bytes(), frozen)
                    self.assertEqual((w.revision_id, w.artifact_sha256, w.history.record), before)
                    print(json.dumps({'runtime': version, 'runtimeJarSha256': view['runtime']['jarSha256'],
                                      'artifactSha256': w.artifact_sha256, 'sourceAndRevisionUnchanged': True,
                                      'partialBusWithoutOutputPeerBits': partial['bits'],
                                      'isolated32bitFeedbackBytes': len(json.dumps(facts['Isolated']).encode()),
                                      'floatingCarrySum': default['rows'][0]['outputs'],
                                      'opposedOutputsBits': clash['rows'][0]['bits']}, ensure_ascii=False), flush=True)
                finally:
                    w.close()


if __name__ == '__main__':
    unittest.main()
