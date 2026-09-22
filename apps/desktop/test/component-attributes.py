"""Real templates, XML loader, manual editing and wired native simulation.

No model calls, course task fixtures or private workspaces. Both supported JARs
are required. Optional --report writes only this synthetic verification evidence.
"""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('describe_fixture', Path(__file__).with_name('describe-component.py'))
describe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(describe)

EVIDENCE = []


def grouping(destinations):
    return {'facing':'east', 'fanout':str(max(d for d in destinations if d is not None) + 1),
            'incoming':str(len(destinations)), 'appear':'left',
            **{f'bit{i}':'none' if d is None else str(d) for i, d in enumerate(destinations)}}


def document_with(fixture, component):
    root = deepcopy(fixture.document)
    circuit = root.find("circuit[@name='main']")
    component = deepcopy(component)
    component.set('loc', '(400,300)')
    circuit.append(component)
    return root, circuit


class ComponentAttributes(unittest.TestCase):
    def test_hust_integer_formats_across_describe_add_and_edit(self):
        # Replay the real value="0" request on the official blank HUST main.
        original = (describe.REPO / 'apps/desktop/electron/templates/blank.circ').read_bytes()
        with tempfile.TemporaryDirectory(prefix='vibe-native-integers-') as directory:
            root = Path(directory)
            source = root / 'source.circ'
            source.write_bytes(original)
            w = describe.Workspace(describe.REPO, root / 'state',
                                   describe.REPO / 'apps/desktop/circuit-lens/lensctl.py', 'native-integers')
            try:
                w.open_path(source)
                before = deepcopy((w.revision_id, w.history.record, w.frozen_path.read_bytes()))

                def call(tool_name, **args):
                    if tool_name == 'wire_candidate':
                        args.setdefault('title', 'Native integer formats')
                    return w.application.agent_tool({'projectId': w.history.record['id'],
                        'revisionId': w.revision_id, 'tool': tool_name, 'arguments': {'circuit': 'main', **args}})

                def part(alias, factory, attributes, y=100):
                    return {'id': alias, 'library': '0', 'factory': factory,
                            'location': {'x': 300, 'y': y}, 'attributes': attributes}

                for raw, canonical in [('0', '0x0'), ('0x07f', '0x7f'), ('127', '0x7f')]:
                    result = call('describe_component', library='0', tool='Constant', attributes={'width': '8', 'value': raw})
                    self.assertEqual(describe.values(result)['value'], canonical)
                    self.assertEqual(ET.fromstring(result['xml']).find("a[@name='value']").get('val'), canonical)
                width = call('describe_component', library='0', tool='Constant', attributes={'width': '08', 'value': '0'})
                self.assertEqual(describe.values(width)['width'], '8')
                added = call('wire_candidate', additions=[
                    part('zero', 'Constant', {'width': '8', 'value': '0'}),
                    part('padded', 'Constant', {'width': '8', 'value': '0x07f'}, 220)], connections=[])
                observed = call('inspect_circuit', candidateId=added['id'])
                by_y = {c['location']['y']: c for c in observed['components']}
                self.assertEqual({y: c['attributes']['value'] for y, c in by_y.items()}, {100: '0x0', 220: '0x7f'})
                edited = call('edit_candidate', candidateId=added['id'], artifactSha256=observed['artifactSha256'], edits=[
                    {'componentId': by_y[100]['componentId'], 'attributes': {'value': '0x07f'}},
                    {'componentId': by_y[220]['componentId'], 'attributes': {'value': '0'}}])
                after = call('inspect_circuit', candidateId=edited['id'])
                self.assertEqual({c['location']['y']: c['attributes']['value'] for c in after['components']},
                                 {100: '0x7f', 220: '0x0'})

                # Parser fallbacks and integer truncation must still be rejected
                # by both query and placement, not merely by final XML reloading.
                invalid = [('Pin', {'output': 'banana'}), ('Constant', {'facing': 'diagonal'}),
                           ('Constant', {'width': '8', 'value': '0x100'}),
                           ('Constant', {'width': '32', 'value': '0x100000000'}),
                           ('Constant', {'width': '33'}), ('Constant', {'width': '8', 'value': 'junk'})]
                for factory, attrs in invalid:
                    with self.subTest(factory=factory, attrs=attrs):
                        with self.assertRaises(describe.CircuitToolError):
                            call('describe_component', library='0', tool=factory, attributes=attrs)
                        with self.assertRaises(describe.CircuitToolError):
                            call('wire_candidate', additions=[part('bad', factory, attrs)], connections=[])

                # A failed template request should expose the native choices
                # needed to correct the request, rather than making the model
                # rediscover them through a second free-form guess.
                bad_gate = {'id': 'bad-or', 'library': '1', 'factory': 'OR Gate',
                            'location': {'x': 300, 'y': 340}, 'attributes': {'facing': 'diagonal'}}
                with self.assertRaises(describe.CircuitToolError) as rejected:
                    call('wire_candidate', additions=[bad_gate], connections=[])
                self.assertEqual(rejected.exception.code, 'NATIVE_COMPONENT_TEMPLATE_REJECTED')
                templates = rejected.exception.as_dict()['context']['nativeTemplates']
                self.assertEqual(templates[0]['id'], 'bad-or')
                self.assertTrue(templates[0]['effectiveAttributes'])
                self.assertTrue(templates[0]['ports'])
                for attrs in [{'facing': 'diagonal'}, {'value': '0x100'}, {'value': '0x100000000'}]:
                    with self.subTest(edit=attrs), self.assertRaises(describe.CircuitToolError):
                        call('edit_candidate', candidateId=added['id'], artifactSha256=observed['artifactSha256'],
                             edits=[{'componentId': by_y[100]['componentId'], 'attributes': attrs}])
                self.assertEqual(call('inspect_circuit', candidateId=added['id'])['artifactSha256'], observed['artifactSha256'])
                self.assertEqual((w.revision_id, w.history.record, w.frozen_path.read_bytes()), before)
                self.assertEqual(source.read_bytes(), original)
                EVIDENCE.append({'runtime': '2.15.0', 'integerFormats': True, 'describe': True,
                                 'wireCandidateCanonicalValues': True, 'editCandidateCanonicalValues': True,
                                 'invalidFallbacksAndTruncationRejected': True, 'sourceUnchanged': True})
            finally:
                w.close()

    def test_rejected_requests_expose_native_choices_for_correction(self):
        # Errors must be actionable without accepting native parser fallbacks.
        cases = [
            ({'library': '20', 'tool': 'OR'}, ['OR Gate', 'AND Gate'],
             {'library': '20', 'tool': 'OR Gate'}),
            ({'library': '99', 'tool': 'OR Gate'}, ['10, 20, 30', '空字符串'],
             {'library': '20', 'tool': 'OR Gate'}),
            ({'library': '20', 'tool': 'OR Gate', 'attributes': {'widht': '4'}},
             ['widht', '当前可编辑属性:', 'width'],
             {'library': '20', 'tool': 'OR Gate', 'attributes': {'width': '4'}}),
            ({'library': '10', 'tool': 'Bit Extender', 'attributes': {'type': 'sign extension'}},
             ['type=sign extension', '可选值:', 'sign'],
             {'library': '10', 'tool': 'Bit Extender', 'attributes': {'type': 'sign'}}),
            ({'library': '10', 'tool': 'Constant', 'attributes': {'width': '8', 'value': '0x100'}},
             ['value=0x100', '实际保留: 0x0'],
             {'library': '10', 'tool': 'Constant', 'attributes': {'width': '8', 'value': '0x7f'}}),
            ({'library': '10', 'tool': 'Pin', 'attributes': {'output': 'banana'}},
             ['output=banana', '可选值:', 'true', 'false'],
             {'library': '10', 'tool': 'Pin', 'attributes': {'output': 'true'}}),
            ({'library': '10', 'tool': 'Splitter', 'attributes': {'fanout': '2', 'incoming': '9', 'bit8': '2'}},
             ['bit8=2', 'none, 0, 1'],
             {'library': '10', 'tool': 'Splitter', 'attributes': {'fanout': '2', 'incoming': '9', 'bit8': '1'}}),
        ]
        for version in describe.RUNTIMES:
            fixture = describe.DescribeComponent()
            with self.subTest(runtime=version), fixture.opened(version):
                for bad, expected, corrected in cases:
                    with self.subTest(request=bad):
                        with self.assertRaises(describe.CircuitToolError) as caught:
                            fixture.call(**bad)
                        message = str(caught.exception)
                        for fragment in expected:
                            self.assertIn(fragment, message)
                        self.assertFalse(caught.exception.retryable)
                        self.assertLess(len(message), 2200)
                        result = fixture.call(**corrected)
                        fixture.roundtrip(result)
                        for key, value in corrected.get('attributes', {}).items():
                            self.assertEqual(describe.values(result)[key], value)
                        EVIDENCE.append({'runtime': version, 'request': bad, 'message': message,
                                         'corrected': corrected, 'nativeReloadPassed': True})
                # An invalid Boolean is not silently replaced by the parser's
                # false fallback, and a wide part does not flood the error.
                with self.assertRaises(describe.CircuitToolError) as caught:
                    fixture.template(library='10', tool='Splitter', incoming='32', unsupported='x')
                self.assertIn('…（共', str(caught.exception))
                self.assertLess(len(str(caught.exception)), 2200)

    def test_splitter_templates_xml_connections_and_all_input_values(self):
        groups = [[0]*8 + [1], [0,1,2,0,1,2], [1,1,1,0,0], [None,0,1,0]]
        for version in describe.RUNTIMES:
            fixture = describe.DescribeComponent()
            with self.subTest(runtime=version), fixture.opened(version):
                w = fixture.w
                baseline = fixture.template(tool='Splitter', library='10')
                for destinations in groups:
                    with self.subTest(destinations=destinations):
                        overrides = grouping(destinations)
                        if version == '2.16.2.2':
                            overrides['order'] = 'ascending'
                        template = fixture.template(tool='Splitter', library='10', **overrides)
                        self.assertEqual({k:describe.values(template)[k] for k in overrides}, overrides)
                        fanout = int(overrides['fanout'])
                        self.assertEqual([p['width'] for p in template['ports']],
                                         [len(destinations)] + [destinations.count(g) for g in range(fanout)])
                        for attr in template['attributes']:
                            if attr['name'].startswith('bit'):
                                self.assertEqual([o['value'] for o in attr['options']], ['none'] + list(map(str, range(fanout))))
                                self.assertTrue(all(o['label'] for o in attr['options']))
                        # Reversed JSON keys must not change effective attributes/geometry.
                        w.application.placement.cache.clear()
                        reverse = fixture.template(tool='Splitter', library='10', **dict(reversed(list(overrides.items()))))
                        self.assertEqual(reverse['xml'], template['xml'])
                        fixture.roundtrip(template)

                        # Independent raw XML loading uses attr.parse -> setValue,
                        # not our template adapter, and supplies properties in reverse order.
                        raw = ET.Element('comp', name='Splitter', lib='10')
                        for name, value in reversed(list(overrides.items())):
                            ET.SubElement(raw, 'a', name=name, val=value)
                        root, _ = document_with(fixture, raw)
                        xml_path = fixture.root / 'native-xml.circ'
                        xml_path.write_bytes(ET.tostring(root))
                        actual = w.observer.run_full(xml_path, 'main')['focus']['components'][0]
                        self.assertEqual({a['name']:a['standard'] for a in actual['attributes']}, describe.values(template))
                        for attr in actual['attributes']:
                            if attr['name'].startswith('bit'):
                                self.assertEqual([o['value'] for o in attr['options']], ['none'] + list(map(str, range(fanout))))

                        root, circuit = document_with(fixture, ET.fromstring(template['xml']))
                        for port in template['ports']:
                            index, width = port['index'], port['width']
                            endpoint = (400 + port['x'], 300 + port['y'])
                            pin_location = (100 if index == 0 else 650, endpoint[1])
                            loc = lambda p: f'({p[0]},{p[1]})'
                            pin = ET.SubElement(circuit, 'comp', name='Pin', lib='10', loc=loc(pin_location))
                            for key, value in {'label':'A' if index == 0 else f'Y{index-1}', 'width':str(width),
                                               'output':str(index != 0).lower(), 'facing':'east' if index == 0 else 'west'}.items():
                                ET.SubElement(pin, 'a', name=key, val=value)
                            ET.SubElement(circuit, 'wire', {'from':loc(pin_location), 'to':loc(endpoint)})
                        wired = fixture.root / 'wired.circ'
                        wired.write_bytes(ET.tostring(root, encoding='utf-8', xml_declaration=True))
                        original = wired.read_bytes()
                        request = ET.Element('simulate', circuit='main')
                        for n in range(1 << len(destinations)):
                            ET.SubElement(ET.SubElement(request, 'vector'), 'input', name='A', value=str(n))
                        result = w.workbench._native(wired, request)
                        rows = result.findall('vector')
                        self.assertEqual(len(rows), 1 << len(destinations))
                        for n, row in enumerate(rows):
                            self.assertEqual(row.get('oscillating'), 'false')
                            expected = {f'Y{g}':sum(((n >> source) & 1) << target for target, source in
                                        enumerate(i for i, destination in enumerate(destinations) if destination == g))
                                        for g in range(fanout)}
                            self.assertEqual({out.get('name'):int(out.get('value')) for out in row.findall('output')}, expected)
                        self.assertEqual(wired.read_bytes(), original, 'stimuli must not rewrite the source')
                        EVIDENCE.append({'runtime':version, 'grouping':destinations, 'arguments':overrides,
                                         'ports':template['ports'], 'xml':template['xml'], 'vectors':len(rows),
                                         'allValuesMatched':True, 'sourceUnchanged':True,
                                         'runtimeJarSha256':result.get('runtimeJarSha256'),
                                         'runtimeVersion':result.get('runtimeVersion'),
                                         'artifactSha256':hashlib.sha256(original).hexdigest()})
                self.assertEqual(fixture.template(tool='Splitter', library='10')['xml'], baseline['xml'],
                                 'choice introspection and template overrides must not mutate library defaults')

    def test_invalid_attributes_and_runtime_specific_order(self):
        for version in describe.RUNTIMES:
            fixture = describe.DescribeComponent()
            with self.subTest(runtime=version), fixture.opened(version):
                legal = grouping([0]*8 + [1])
                for invalid in [{'bit8':'2'}, {'bit0':'-2'}, {'bit0':'junk'}, {'bit9':'0'}, {'bit-1':'0'},
                                {'bit32':'0'}, {'fanout':'0'}, {'incoming':'33'}, {'incoming':'1', 'bit8':'0'},
                                {'appear':'diagonal'}]:
                    with self.subTest(invalid=invalid), self.assertRaises(describe.CircuitToolError) as caught:
                        fixture.template(tool='Splitter', library='10', **{**legal, **invalid})
                    message = str(caught.exception)
                    self.assertNotIn('ClassCastException', message)
                    self.assertNotIn('cannot be cast', message)
                    self.assertTrue(any(name in message for name in invalid), message)
                    self.assertFalse(caught.exception.retryable)
                    EVIDENCE.append({'runtime':version, 'invalid':invalid, 'message':message})
                if version == '2.15.0':
                    with self.assertRaisesRegex(describe.CircuitToolError, '未知或当前配置不支持的属性: order'):
                        fixture.template(tool='Splitter', library='10', **legal, order='ascending')
                else:
                    fixture.template(tool='Splitter', library='10', **legal, order='ascending')

    def test_manual_template_placement_property_proposal_edit_and_undo(self):
        for version in describe.RUNTIMES:
            fixture = describe.DescribeComponent()
            with self.subTest(runtime=version), fixture.opened(version, read_only=False):
                w = fixture.w
                def body(**args):
                    return dict(projectId=w.history.record['id'], revisionId=w.revision_id, circuit='main', **args)
                overrides = grouping([0]*8 + [1])
                template = w.application.placement.query('template', body(library='10', tool='Splitter', attributes=overrides))
                self.assertTrue(template['image']['url'].startswith('data:image/png'))
                self.assertEqual(template['ports'], fixture.template(tool='Splitter', library='10', **overrides)['ports'])
                w.application.project_action('place', body(library='10', tool='Splitter', attributes=overrides, x=400, y=300))
                component = next(c for c in w.circuit_view('main')['circuit']['components'] if c['factory'] == 'Splitter')
                before = deepcopy(w.history.record), w.revision_id, w.frozen_path.read_bytes()
                observation = w.observer.run_full(w.frozen_path, 'main')
                proposed = w.workbench._native(w.frozen_path, ET.Element('property', circuit='main', factory='Splitter',
                                                x='400', y='300', attribute='bit7', value='1'))
                self.assertEqual(proposed.text, '1')
                for attribute, value in [('bit7','2'), ('bit8','bad'), ('bit9','0')]:
                    with self.assertRaises(ValueError) as caught:
                        w.application.project_action('edit', body(componentId=component['componentId'], attribute=attribute, value=value))
                    self.assertIn(attribute, str(caught.exception))
                    self.assertNotIn('cannot be cast', str(caught.exception))
                self.assertEqual((w.history.record, w.revision_id, w.frozen_path.read_bytes()), before)
                self.assertEqual(w.observer.run_full(w.frozen_path, 'main'), observation,
                                 'options, proposals and failed edits cannot change the resident snapshot')
                w.application.project_action('edit', body(componentId=component['componentId'], attribute='bit7', value='1'))
                edited = w.observer.run_full(w.frozen_path, 'main')['focus']['components'][0]
                self.assertEqual([p['width'] for p in edited['ends']], [9,7,2])
                self.assertEqual(next(a['standard'] for a in edited['attributes'] if a['name'] == 'bit7'), '1')
                # Exercise the independent observer compiler as well as worker and simulation compilers.
                fresh = w.observer._run_json([str(w.observer.full_runner), '--full', str(w.frozen_path), 'main'],
                                             w.observer._environment(w.observer.prepare()))
                self.assertEqual(fresh['focus']['components'][0]['attributes'], edited['attributes'])
                w.application.project_action('undo', body())
                self.assertEqual(w.revision_id, before[1])
                self.assertEqual(w.frozen_path.read_bytes(), before[2])
                EVIDENCE.append({'runtime':version, 'manualTemplate':True, 'placement':True,
                                 'propertyProposalIsolated':True, 'invalidEditIsolated':True,
                                 'committedPortWidths':[9,7,2], 'undoRestoresArtifact':True,
                                 'standaloneObserverParity':True})


if __name__ == '__main__':
    report = None
    if '--report' in sys.argv:
        i = sys.argv.index('--report')
        report = Path(sys.argv[i + 1])
        del sys.argv[i:i + 2]
    program = unittest.main(exit=False)
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps({'passed':program.result.wasSuccessful(), 'modelCalls':0, 'evidence':EVIDENCE},
                                     ensure_ascii=False, indent=2) + '\n')
    sys.exit(0 if program.result.wasSuccessful() else 1)
