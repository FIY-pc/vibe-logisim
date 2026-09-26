"""Focused static inspection: failed 027 artifact and ordinary bus fanout.

No simulation, model, or UI. Native resources may be read from --runtime-repo;
all generated inputs, state and evidence stay in the persistent --output folder.
"""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.dont_write_bytecode = True
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import skip_unless_samples
from studio.application.workspace import Workspace
from studio.domain.connectivity_feedback import connectivity_feedback


def scene(width=4, outputs=2, sinks=1, group=''):
    result = {'components': [], 'nets': [
        {'netId': f'{group}n{bit}', 'contacts': []} for bit in range(width)]}
    for i in range(outputs + sinks):
        cid = f'{group}c{i:04d}'
        direction = 'output' if i < outputs else 'input'
        end = {'index': 0, 'direction': direction, 'width': width,
               'location': {'x': i * 20, 'y': 0}, 'exclusive': True,
               'runtimeTooltip': 'Native output' if i < outputs else 'Native input',
               'netBits': [{'bit': bit, 'netId': net['netId']}
                           for bit, net in enumerate(result['nets'])]}
        result['components'].append({'componentId': cid, 'factory': 'Synthetic',
                                      'location': end['location'], 'ends': [end]})
        for bit, net in enumerate(result['nets']):
            net['contacts'].append({'componentId': cid, 'endIndex': 0,
                                    'bit': bit, 'direction': direction})
    return result


def fanout():
    root = ET.Element('project', source='2.15.0', version='1.0')
    ET.SubElement(root, 'lib', name='0', desc='#Wiring')
    ET.SubElement(root, 'main', name='Fanout')
    c = ET.SubElement(root, 'circuit', name='Fanout')
    for i in range(17):
        p = ET.SubElement(c, 'comp', lib='0', name='Pin', loc=f'(100,{100 + 20 * i})')
        for key, value in {'width': '32', 'output': 'true' if i else 'false',
                           'label': f'Sink{i}' if i else 'Source'}.items():
            ET.SubElement(p, 'a', name=key, val=value)
        if i:
            ET.SubElement(c, 'wire', {'from': f'(100,{80 + 20 * i})', 'to': f'(100,{100 + 20 * i})'})
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


class PeerFacts(unittest.TestCase):
    def test_grouped_bus_and_selection_on_sink(self):
        circuit = scene(width=32, sinks=64)
        original = deepcopy(circuit)
        full = connectivity_feedback(circuit, exact=True)
        group, = full['multipleOutputPeers']
        self.assertEqual(group['netCount'], 32)
        self.assertEqual(len(group['peers']), 2)
        for peer in group['peers']:
            self.assertEqual(peer['runtimeTooltip'], 'Native output')
            self.assertEqual([m['bit'] for m in peer['netBits']], list(range(32)))
        # Selecting an input-only sink still exposes both output peers outside it.
        selected = connectivity_feedback(circuit, exact=True, component_ids=['c0065'])
        self.assertEqual(selected['multipleOutputPeers'], full['multipleOutputPeers'])
        self.assertEqual(circuit, original)
        group['peers'][0]['location']['x'] = -1
        self.assertEqual(circuit, original, 'feedback must not alias the cached circuit')
        self.assertEqual(connectivity_feedback(circuit, exact=False)['multipleOutputPeers'], [])

    def test_native_metadata_is_not_drive_or_exclusivity(self):
        circuit = scene()
        # Metadata-only fixture: two explicitly tri-state/inactive outputs still
        # yield exactly the same static endpoint facts, with no conflict verdict.
        before = connectivity_feedback(circuit, exact=True)
        for component in circuit['components'][:2]:
            component['attributes'] = {'disabled': 'Z', 'enable': 'false'}
            component['ends'][0]['exclusive'] = False
        self.assertEqual(connectivity_feedback(circuit, exact=True), before)
        self.assertIn('does not establish an electrical conflict', before['scope'])
        # An inout contact is not promoted to output even if it might drive.
        circuit['components'][1]['ends'][0]['direction'] = 'inout'
        for net in circuit['nets']:
            net['contacts'][1]['direction'] = 'inout'
        self.assertEqual(connectivity_feedback(circuit, exact=True)['multipleOutputPeers'], [])

    def test_distinct_endpoints_and_crossed_bit_mappings(self):
        circuit = scene(width=2, sinks=0)
        a, b = circuit['components']
        # Two ends on one component count as peers; same-end bits do not.
        b['ends'][0]['index'] = 1
        a['ends'].append(b['ends'][0])
        circuit['components'] = [a]
        for bit, net in enumerate(circuit['nets']):
            net['contacts'][1].update(componentId=a['componentId'], endIndex=1, bit=1 - bit)
            net['contacts'].append(dict(net['contacts'][0]))
            a['ends'][1]['netBits'][bit]['bit'] = 1 - bit
        group, = connectivity_feedback(circuit, exact=True)['multipleOutputPeers']
        self.assertEqual([p['endIndex'] for p in group['peers']], [0, 1])
        self.assertEqual([m['bit'] for m in group['peers'][1]['netBits']], [1, 0])
        self.assertEqual(group['peers'][0]['omittedNetBits'], 0)
        # Join both bits of just one end on a net; this is not multiple outputs.
        a['ends'].pop()
        circuit['nets'][0]['contacts'] = [
            {'componentId': a['componentId'], 'endIndex': 0, 'bit': bit, 'direction': 'output'}
            for bit in range(2)]
        circuit['nets'].pop()
        a['ends'][0]['netBits'][1]['netId'] = 'n0'
        self.assertEqual(connectivity_feedback(circuit, exact=True)['multipleOutputPeers'], [])

    def test_partial_observation_does_not_invent_selected_net(self):
        circuit = scene()
        # The selected sink is mapped to the net but not reciprocally present.
        for net in circuit['nets']:
            net['contacts'].pop()
        facts = connectivity_feedback(circuit, exact=True, component_ids=['c0002'])
        self.assertEqual(facts['multipleOutputPeers'], [])
        self.assertEqual(facts['status'], 'partial')

    def test_different_full_peer_sets_stay_separate(self):
        circuit = scene(width=2, outputs=3, sinks=0)
        circuit['nets'][0]['contacts'].pop()
        circuit['components'][2]['ends'][0]['netBits'].pop(0)
        groups = connectivity_feedback(circuit, exact=True)['multipleOutputPeers']
        self.assertEqual(sorted(len(g['peers']) for g in groups), [2, 3])
        self.assertTrue(all(g['netCount'] == 1 for g in groups))

    def test_preview_bounds_and_one_contact_scan(self):
        class Contacts(list):
            visits = 0

            def __iter__(self):
                for contact in super().__iter__():
                    self.visits += 1
                    yield contact

        circuit = scene(width=40, outputs=64, sinks=1)
        for component in circuit['components']:
            component['label'] = '界' * 1000
        for net in circuit['nets']:
            net['contacts'] = Contacts(net['contacts'])
        facts = connectivity_feedback(circuit, exact=True, component_ids=['c0063'])
        group, = facts['multipleOutputPeers']
        self.assertEqual(group['omittedPeers'], 56)
        self.assertEqual(group['peers'][0]['componentId'], 'c0063')
        self.assertTrue(any(p['componentId'] != 'c0063' for p in group['peers']))
        self.assertTrue(all(p['omittedNetBits'] == 8 for p in group['peers']))
        self.assertTrue(all(p['truncatedFields'] == ['label'] for p in group['peers']))
        self.assertEqual(sum(n['contacts'].visits for n in circuit['nets']), 65 * 40)
        many = {'components': [], 'nets': []}
        for i in range(20):
            part = scene(group=f'g{i}')
            for key in many:
                many[key].extend(part[key])
        bounded = connectivity_feedback(many, exact=True)
        self.assertEqual(len(bounded['multipleOutputPeers']), 16)
        self.assertEqual(bounded['multipleOutputPeersOmittedGroups'], 4)


class NativePeerFacts(unittest.TestCase):
    @skip_unless_samples(REPO, 'experiments/027-counter-from-blank/model-1.16/after.circ')
    def test_failed_counter_and_bus_fanout(self):
        output = OPTIONS.output.resolve()
        output.mkdir(parents=True, exist_ok=False)

        def save(name, value):
            (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

        source = REPO / 'experiments/027-counter-from-blank/model-1.16/after.circ'
        failed_bytes = source.read_bytes()
        results = []
        cases = [('counter', failed_bytes, 'main'), ('fanout', fanout(), 'Fanout')]
        if OPTIONS.recovered:
            recovered_bytes = OPTIONS.recovered.read_bytes()
            cases.append(('recovered', recovered_bytes, 'main'))
        for name, data, circuit_name in cases:
            path = output / f'{name}.circ'
            path.write_bytes(data)
            w = Workspace(OPTIONS.runtime_repo.resolve(), output / f'{name}-state',
                          REPO / 'apps/desktop/circuit-lens/lensctl.py', 'multiple-output-peers')
            try:
                with patch.object(w.observer.simulation_worker, 'request', side_effect=AssertionError('No simulation')):
                    w.open_path(path)
                    identity = deepcopy((w.revision_id, w.artifact_sha256, w.history.record))
                    frozen = w.frozen_path.read_bytes()

                    def inspect(**args):
                        return w.application.agent_tool({
                            'projectId': w.history.record['id'], 'revisionId': w.revision_id,
                            'tool': 'inspect_circuit', 'arguments': {'circuit': circuit_name, **args}})

                    full = inspect(includeNets=True, netFormat='bits')
                    save(f'{name}-full.json', full)
                    self.assertEqual(full['authority'], 'exact-runtime', full.get('error'))
                    view = w.circuit_view(circuit_name)
                    self.assertEqual(view['runtime']['jarSha256'],
                                     'b2400702fb9e8e4c71c512d7e09678a788039f402be55164209cde4cee8fc996')
                    with patch.object(w.observer.worker, 'request', side_effect=AssertionError('No new native query')):
                        compact = inspect()
                        self.assertEqual(compact['nets'], [])
                        self.assertEqual(compact['connectivityIssues'], full['connectivityIssues'])
                        if name == 'counter':
                            group, = full['connectivityIssues']['multipleOutputPeers']
                            self.assertEqual({p['factory'] for p in group['peers']}, {'Register', 'Multiplexer', 'Constant'})
                            self.assertEqual(group['netCount'], 4)
                            for peer in group['peers']:
                                component = next(c for c in full['components'] if c['componentId'] == peer['componentId'])
                                end = next(e for e in component['ends'] if e['index'] == peer['endIndex'])
                                self.assertEqual(peer['location'], end['location'])
                                self.assertEqual(peer['runtimeTooltip'], end['runtimeTooltip'])
                                self.assertEqual({m['bit'] for m in peer['netBits']}, set(range(4)))
                                for mapping in peer['netBits']:
                                    net = next(n for n in full['nets'] if n['netId'] == mapping['netId'])
                                    expected = {'componentId': peer['componentId'], 'endIndex': peer['endIndex'],
                                                'bit': mapping['bit'], 'direction': 'output'}
                                    self.assertIn(expected, [{key: c.get(key) for key in expected}
                                                             for c in net['contacts']])
                                selected = inspect(componentIds=[peer['componentId']])
                                self.assertEqual(len(selected['components']), 1)
                                self.assertEqual({p['componentId'] for p in selected['connectivityIssues']['multipleOutputPeers'][0]['peers']},
                                                 {p['componentId'] for p in group['peers']})
                                save(f"counter-selected-{peer['factory']}.json", selected)
                            adder = next(c for c in full['components'] if c['factory'] == 'Adder')
                            self.assertEqual(next(e for e in adder['ends'] if e['index'] == 0)['direction'], 'input')
                        elif name == 'fanout':
                            self.assertEqual(len(full['nets']), 32)
                            self.assertTrue(all(len(n['contacts']) == 17 for n in full['nets']))
                            self.assertEqual(full['connectivityIssues']['multipleOutputPeers'], [])
                            self.assertEqual(full['connectivityIssues']['inputsWithoutOutputPeer'], [])
                            sink = next(c for c in full['components'] if c['label'] == 'Sink16')
                            selected = inspect(componentIds=[sink['componentId']])
                            self.assertEqual(selected['connectivityIssues']['multipleOutputPeers'], [])
                            save('fanout-selected.json', selected)
                        else:
                            self.assertEqual(full['connectivityIssues']['multipleOutputPeers'], [])
                            register = next(c for c in full['components'] if c['factory'] == 'Register')
                            selected = inspect(componentIds=[register['componentId']])
                            self.assertEqual(selected['connectivityIssues']['multipleOutputPeers'], [])
                            save('recovered-selected.json', selected)
                    self.assertEqual(path.read_bytes(), data)
                    self.assertEqual(w.frozen_path.read_bytes(), frozen)
                    self.assertEqual((w.revision_id, w.artifact_sha256, w.history.record), identity)
                    save(f'{name}-compact.json', compact)
                    results.append({'case': name, 'artifactSha256': w.artifact_sha256,
                                    'runtimeJarSha256': view['runtime']['jarSha256'],
                                    'multipleOutputPeers': full['connectivityIssues']['multipleOutputPeers'],
                                    'feedbackBytes': len(json.dumps(full['connectivityIssues'], ensure_ascii=False,
                                                                   separators=(',', ':')).encode()),
                                    'sourceAndRevisionUnchanged': True, 'cachedInspectExtraNativeQueries': 0})
            finally:
                w.close()
        self.assertEqual(source.read_bytes(), failed_bytes)
        if OPTIONS.recovered:
            self.assertEqual(OPTIONS.recovered.read_bytes(), recovered_bytes)
        save('report.json', {'modelCalls': 0, 'simulationCalls': 0, 'repo': str(REPO),
                             'helperSha256': hashlib.sha256((REPO / 'apps/desktop/circuit-lens/studio/domain/connectivity_feedback.py').read_bytes()).hexdigest(),
                             'results': results})
        print(f'Native static evidence: {output / "report.json"}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-repo', type=Path, default=REPO)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--recovered', type=Path)
    OPTIONS = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PeerFacts)
    if OPTIONS.output:
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(NativePeerFacts))
    success = unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    raise SystemExit(0 if success else 1)
