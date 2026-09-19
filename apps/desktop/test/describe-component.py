"""Native component reference through the production plugin, without model calls.

Both supported runtimes load XML returned by the tool into an independent file;
the observer checks the resulting component rather than trusting the template.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.domain.tool_errors import CircuitToolError

RUNTIMES = ('2.16.2.2', '2.15.0')


def project(version):
    root = ET.Element('project', source=version, version='1.0')
    # Deliberately not Logisim's usual library IDs.
    for library, descriptor in [('10', '#Wiring'), ('20', '#Gates'), ('30', '#Memory')]:
        lib = ET.SubElement(root, 'lib', name=library, desc=descriptor)
        if descriptor == '#Gates':
            tool = ET.SubElement(lib, 'tool', name='OR Gate')
            ET.SubElement(tool, 'a', name='inputs', val='3')
    ET.SubElement(root, 'main', name='main')
    ET.SubElement(root, 'circuit', name='main')
    child = ET.SubElement(root, 'circuit', name='Child')
    for x, output in [(80, False), (180, True)]:
        pin = ET.SubElement(child, 'comp', name='Pin', lib='10', loc=f'({x},80)')
        ET.SubElement(pin, 'a', name='output', val=str(output).lower())
    ET.SubElement(child, 'wire', {'from': '(80,80)', 'to': '(180,80)'})
    return root


def values(template):
    return {a['name']: a['value'] for a in template['attributes']}


class DescribeComponent(unittest.TestCase):
    @contextmanager
    def opened(self, version, *, read_only=True):
        with tempfile.TemporaryDirectory(prefix='vibe-describe-component-') as directory:
            self.root = Path(directory)
            self.document = project(version)
            source = self.root / 'source.circ'
            original = ET.tostring(self.document, encoding='utf-8', xml_declaration=True)
            source.write_bytes(original)
            workspace = Workspace(REPO, self.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'describe-component')
            self.w = workspace
            try:
                workspace.open_path(source)
                before = deepcopy((workspace.revision_id, workspace.artifact_sha256, workspace.history.record))
                frozen = workspace.frozen_path.read_bytes()
                try:
                    yield
                finally:
                    self.assertEqual(source.read_bytes(), original)
                    if read_only:
                        self.assertEqual(workspace.frozen_path.read_bytes(), frozen)
                        self.assertEqual((workspace.revision_id, workspace.artifact_sha256, workspace.history.record), before,
                                         'queries and rejected queries must not edit structure/history')
            finally:
                workspace.close()

    def call(self, **arguments):
        return self.w.application.agent_tool({
            'projectId': self.w.history.record['id'], 'revisionId': self.w.revision_id,
            'tool': 'describe_component', 'arguments': {'circuit': 'main', **arguments},
        })

    def template(self, tool='OR Gate', library='20', **attributes):
        return self.call(tool=tool, library=library, attributes=attributes)

    def roundtrip(self, template):
        root = deepcopy(self.document)
        circuit = next(c for c in root.findall('circuit') if c.get('name') == 'main')
        component = ET.fromstring(template['xml'])
        self.assertEqual(component.get('loc'), '(0,0)')
        self.assertEqual(component.get('lib', ''), template['library'])
        component.set('loc', '(400,300)')
        circuit.append(component)
        path = self.root / 'inserted.circ'
        path.write_bytes(ET.tostring(root, encoding='utf-8', xml_declaration=True))
        observed = self.w.observer.run_full(path, 'main')['focus']['components']
        self.assertEqual(len(observed), 1, 'the serialized part must load exactly once')
        actual = observed[0]
        self.assertEqual(actual['factoryName'], template['factory'])
        box = template['bounds']
        self.assertEqual(actual['bounds'], {**box, 'x': box['x'] + 400, 'y': box['y'] + 300})
        self.assertEqual([
            {'index': p['index'], 'x': p['location']['x'] - 400, 'y': p['location']['y'] - 300,
             'width': p['width'], 'direction': p['direction'], 'exclusive': p['exclusive'],
             'runtimeTooltip': p.get('runtimeTooltip')}
            for p in actual['ends']
        ], template['ports'])
        loaded = {a['name']: a['standard'] for a in actual['attributes']}
        for a in component.findall('a'):
            self.assertEqual(loaded[a.get('name')], a.get('val', a.text or ''),
                             'XML must preserve every serialized effective attribute')

    def test_catalog_defaults_and_no_image_generation(self):
        for version in RUNTIMES:
            with self.subTest(runtime=version), self.opened(version):
                with patch.object(self.w.observer.worker, 'request', wraps=self.w.observer.worker.request) as native:
                    catalog = self.call()
                    template = self.call(library='20', tool='OR Gate')
                    for call in native.call_args_list:
                        self.assertEqual(call.args[2].get('images'), 'false')
                self.assertNotIn('data:image', json.dumps(catalog))
                self.assertNotIn('data:image', json.dumps(template))
                self.assertNotIn('image', template)
                groups = {g['id']: g for g in catalog['groups']}
                self.assertTrue(any(t['name'] == 'OR Gate' for t in groups['20']['tools']))
                self.assertTrue(any(t['name'] == 'Register' for t in groups['30']['tools']))
                self.assertTrue(any(t['name'] == 'Child' for t in groups['']['tools']))
                self.assertEqual(values(template)['inputs'], '3', 'project tool defaults must be respected')
                self.assertEqual(len(template['ports']), 4)
                self.roundtrip(template)
                child = self.call(library='', tool='Child')
                self.assertNotIn('lib=', child['xml'])
                self.roundtrip(child)
                with self.assertRaises(CircuitToolError):
                    self.call(library='', tool='main')
                # UI projection still gets its image; it cannot contaminate the
                # model cache or vice versa, even with identical query args.
                body = dict(projectId=self.w.history.record['id'], revisionId=self.w.revision_id,
                            circuit='main', library='20', tool='OR Gate')
                ui = self.w.application.placement.query('template', body)
                self.assertTrue(ui['image']['url'].startswith('data:image/png;base64,'))
                self.assertEqual(ui['ports'], template['ports'])
                template['ports'].clear()
                self.assertEqual(len(self.call(library='20', tool='OR Gate')['ports']), 4)
                self.assertNotIn('image', self.call(library='20', tool='OR Gate'))

    def test_or_gate_variants_reload_with_exact_geometry(self):
        for version in RUNTIMES:
            with self.subTest(runtime=version), self.opened(version):
                for size in (30, 50, 70):
                    for inputs in (2, 3, 5):
                        for facing in ('east', 'north', 'west', 'south'):
                            with self.subTest(size=size, inputs=inputs, facing=facing):
                                requested = dict(size=str(size), inputs=str(inputs), facing=facing, width='4')
                                template = self.template(**requested)
                                self.assertEqual({k: values(template)[k] for k in requested}, requested)
                                ports = template['ports']
                                self.assertEqual(len(ports), inputs + 1)
                                self.assertEqual([p['index'] for p in ports], list(range(inputs + 1)))
                                self.assertEqual([p['direction'] for p in ports], ['output'] + ['input'] * inputs)
                                self.assertTrue(all(p['width'] == 4 for p in ports))
                                self.assertEqual((ports[0]['x'], ports[0]['y']), (0, 0))
                                for p in ports[1:]:
                                    self.assertEqual(p['x' if facing in ('east', 'west') else 'y'],
                                                     size * (-1 if facing in ('east', 'south') else 1))
                                self.roundtrip(template)
                standard = self.template(size='50', inputs='2', width='1')
                self.assertEqual(standard['bounds'], dict(x=-50, y=-25, width=50, height=50))
                self.assertEqual([(p['x'], p['y']) for p in standard['ports']], [(0, 0), (-50, -20), (-50, 20)])

    def test_register_ports_and_xml_escaping(self):
        for version in RUNTIMES:
            with self.subTest(runtime=version), self.opened(version):
                label = 'A & B <register> "Q"\n第二行'
                template = self.template(tool='Register', library='30', width='8', trigger='falling', label=label)
                self.assertEqual(values(template)['label'], label)
                self.assertEqual(values(template)['trigger'], 'falling')
                self.assertTrue(any(p['runtimeTooltip'] for p in template['ports']))
                self.assertEqual([(p['index'], p['x'], p['y'], p['width'], p['direction']) for p in template['ports']], [
                    (0, 0, 0, 8, 'output'), (1, -30, 0, 8, 'input'), (2, -20, 20, 1, 'input'),
                    (3, -10, 20, 1, 'input'), (4, -30, 10, 1, 'input'), (5, -30, -10, 1, 'input'),
                    (6, -10, -20, 1, 'input'),
                ])
                self.roundtrip(template)

    def test_invalid_or_normalized_attributes_fail_without_contamination(self):
        for version in RUNTIMES:
            with self.subTest(runtime=version), self.opened(version):
                bad_attributes = [
                    {'widht': '4'}, {'facing': 'diagonal'}, {'size': '40'}, {'inputs': '1'},
                    {'inputs': '1000'}, {'width': '0'}, {'width': '33'}, {'width': 'junk'},
                    {'negate0': 'yes'}, {'labelfont': 'Dialog plain 14'},
                    {'negate2': 'true', 'inputs': '2'},  # Later setter removes an earlier requested attribute.
                ]
                bad_calls = [
                    dict(library='20', tool='No Such Gate'), dict(library='99', tool='OR Gate'),
                    dict(tool='OR Gate'), dict(library='20'), dict(attributes={'width': '4'}),
                    dict(library='10', tool='Pin', attributes={'output': 'banana'}),
                    dict(library='20', tool='OR Gate', attributes={'width': 4}),
                    dict(library='20', tool='OR Gate', unexpected=True),
                ] + [dict(library='20', tool='OR Gate', attributes=a) for a in bad_attributes]
                original = self.template()
                for arguments in bad_calls:
                    with self.subTest(arguments=arguments):
                        with self.assertRaises(CircuitToolError) as caught:
                            self.call(**arguments)
                        self.assertFalse(caught.exception.retryable)
                self.assertEqual(self.template()['xml'], original['xml'])
                # Dynamic attributes resolve independently of JSON key order.
                first = self.template(negate7='true', inputs='8')
                self.w.application.placement.cache.clear()
                second = self.template(inputs='8', negate7='true')
                self.assertEqual(first['xml'], second['xml'])
                self.assertEqual(values(second)['negate7'], 'true')
                self.roundtrip(second)

    def test_manual_template_and_placement_keep_native_format_aliases(self):
        for version in RUNTIMES:
            with self.subTest(runtime=version), self.opened(version, read_only=False):
                service = self.w.application.placement

                def body(library, tool, attributes):
                    return dict(projectId=self.w.history.record['id'], revisionId=self.w.revision_id,
                                circuit='main', library=library, tool=tool, attributes=attributes)

                color = {'labelcolor': '#ABCDEF'}
                number = {'width': '8', 'value': '0X0F'}
                gate = service.query('template', body('20', 'OR Gate', color))
                self.assertEqual(values(gate)['labelcolor'], '#abcdef')
                constant = service.query('template', body('10', 'Constant', number))
                self.assertEqual(int(values(constant)['value'], 16), 15)
                for library, tool, attributes in [('20', 'OR Gate', color), ('10', 'Constant', number)]:
                    with self.assertRaises(CircuitToolError):
                        self.call(library=library, tool=tool, attributes=attributes)
                for attributes in ({'widht': '4'}, {'negate2': 'true', 'inputs': '2'}):
                    with self.assertRaises(ValueError):
                        service.query('template', body('20', 'OR Gate', attributes))
                # Exercise the real manual placement path after the previews;
                # structural revisions are intentional here, source save is not.
                self.w.application.project_action('place', {**body('20', 'OR Gate', color), 'x': 400, 'y': 300})
                self.w.application.project_action('place', {**body('10', 'Constant', number), 'x': 100, 'y': 100})
                components = self.w.circuit_view('main')['circuit']['components']
                gate = next(c for c in components if c['factory'] == 'OR Gate')
                constant = next(c for c in components if c['factory'] == 'Constant')
                self.assertEqual(gate['attributes']['labelcolor'], '#abcdef')
                self.assertEqual(int(constant['attributes']['value'], 16), 15)


if __name__ == '__main__':
    unittest.main()
