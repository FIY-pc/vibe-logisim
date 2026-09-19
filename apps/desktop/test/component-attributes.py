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
