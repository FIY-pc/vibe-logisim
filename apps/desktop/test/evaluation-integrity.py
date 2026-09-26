"""Native observations must not turn missing assertions or unsettled values into a pass."""
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import runtime_versions
from studio.application.workspace import Workspace
from studio.domain.tool_errors import CircuitToolError


def fixture(version):
    root = ET.Element('project', source=version, version='1.0')
    for library, name in [('0', 'Wiring'), ('1', 'Gates')]:
        ET.SubElement(root, 'lib', name=library, desc='#' + name)
    ET.SubElement(root, 'main', name='main')
    ET.SubElement(ET.SubElement(root, 'options'), 'a', name='simlimit', val='32')
    circuit = ET.SubElement(root, 'circuit', name='main')

    def part(factory, library, x, y, **attributes):
        comp = ET.SubElement(circuit, 'comp', name=factory, lib=library, loc=f'({x},{y})')
        for key, value in attributes.items():
            ET.SubElement(comp, 'a', name=key, val=str(value))

    part('Pin', '0', 100, 80, label='Enable')
    part('NAND Gate', '1', 200, 100, inputs='2', size='50')
    part('Constant', '0', 350, 200, value='0x0')
    part('Pin', '0', 400, 200, label='Stable', output='true', facing='west')
    part('Pin', '0', 400, 300, label='Floating', output='true', facing='west')
    # Enable=0 establishes the feedback NAND output at 1. Raising Enable
    # produces oscillation; the independent Stable output remains exactly 0.
    for a, b in [((100, 80), (150, 80)), ((200, 100), (220, 100)),
                 ((220, 100), (220, 160)), ((220, 160), (120, 160)),
                 ((120, 160), (120, 120)), ((120, 120), (150, 120)),
                 ((350, 200), (400, 200))]:
        ET.SubElement(circuit, 'wire', {'from': f'({a[0]},{a[1]})', 'to': f'({b[0]},{b[1]})'})
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


class EvaluationIntegrity(unittest.TestCase):
    @contextmanager
    def opened(self, version):
        with tempfile.TemporaryDirectory(prefix='vibe-evaluation-integrity-') as directory:
            root = Path(directory)
            source = root / 'test.circ'
            original = fixture(version)
            source.write_bytes(original)
            self.w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'evaluation-integrity')
            try:
                self.w.open_path(source)
                before = deepcopy((self.w.revision_id, self.w.artifact_sha256, self.w.history.record))
                frozen = self.w.frozen_path.read_bytes()
                inspected = self.call('inspect_circuit', circuit='main')
                pins = {c['label']: c['componentId'] for c in inspected['components'] if c['factory'] == 'Pin'}
                self.trace = dict(circuit='main', mode='trace', ticks=2, inputs={'Enable': 0}, watches=[
                    {'name': name, 'component': pins[name], 'port': 0} for name in ('Stable', 'Floating')
                ])
                try:
                    yield
                finally:
                    self.assertEqual(source.read_bytes(), original)
                    self.assertEqual(self.w.frozen_path.read_bytes(), frozen)
                    self.assertEqual((self.w.revision_id, self.w.artifact_sha256, self.w.history.record), before)
            finally:
                self.w.close()

    def call(self, tool, **arguments):
        return self.w.application.agent_tool({
            'projectId': self.w.history.record['id'], 'revisionId': self.w.revision_id,
            'tool': tool, 'arguments': arguments,
        })

    def test_empty_assertions_are_rejected_before_running(self):
        with self.opened('2.16.2.2'):
            for expected in ([], [{'tick': 0, 'values': {}}],
                             [{'tick': 0, 'values': {'Stable': 0}}, {'tick': 1, 'values': {}}]):
                with self.subTest(expected=expected), patch.object(self.w.workbench, '_native') as native:
                    with self.assertRaises(CircuitToolError):
                        self.call('evaluate_circuit', **self.trace, expectedRows=expected)
                    native.assert_not_called()

    def test_defined_mismatch_unknown_and_matching_values_agree_in_both_modes(self):
        for version in runtime_versions(REPO):
            with self.subTest(runtime=version), self.opened(version):
                for expected, status, reason in [({'Stable': 0}, 'passed', None),
                                                 ({'Stable': 1}, 'failed', 'mismatch'),
                                                 ({'Floating': 0}, 'unknown', 'undefined-signal'),
                                                 ({'Stable': 1, 'Floating': 0}, 'failed', 'mismatch'),
                                                 ({'Stable': 0, 'Floating': 0}, 'unknown', 'undefined-signal')]:
                    vector = {'inputs': {'Enable': 0}, 'expected': expected}
                    for mode in ('simulate', 'trace'):
                        args = (dict(circuit='main', mode=mode, vectors=[vector]) if mode == 'simulate'
                                else {**self.trace, 'expectedRows': [{'tick': 0, 'values': expected}]})
                        result = self.call('evaluate_circuit', **args)
                        case = result['evaluation']['cases'][0]
                        self.assertEqual((result['evaluation']['status'], case['status'], case.get('reason')),
                                         (status, status, reason), (mode, expected))
                        if status == 'unknown':
                            self.assertEqual(result['feedback']['firstUnknown'], case)
                            self.assertIsNone(result['feedback']['firstFailure'])
                    observed = self.call('harness_run', circuit='main', mode='simulate', vectors=[vector])
                    self.assertEqual(observed['feedback']['status'], status)
                    row = observed['result']['rows'][0]
                    self.assertEqual(row['passed'], {'passed': True, 'failed': False}.get(status))
                    self.assertIsNone(row['outputs']['Floating'])
                    self.assertIn('x', row['bits']['Floating'].lower())
                observed = self.call('harness_run', circuit='main', mode='simulate', vectors=[{'inputs': {'Enable': 0}}])
                self.assertEqual(observed['feedback']['status'], 'observed')

    def test_oscillation_cannot_pass_even_when_watched_output_is_defined_and_matches(self):
        for version in runtime_versions(REPO):
            with self.subTest(runtime=version), self.opened(version):
                args = {**self.trace, 'inputEvents': [{'tick': 1, 'name': 'Enable', 'value': 1}]}
                expected = [{'tick': i, 'values': {'Stable': 0}} for i in range(3)]
                result = self.call('evaluate_circuit', **args, expectedRows=expected)
                rows = result['result']['rows']
                self.assertEqual([(row['tick'], row['oscillating'], row['values']['Stable']) for row in rows],
                                 [(0, False, 0), (1, True, 0)])
                self.assertEqual(result['evaluation']['status'], 'unknown')
                self.assertEqual([(c['status'], c.get('reason')) for c in result['evaluation']['cases']],
                                 [('passed', None), ('unknown', 'oscillating'), ('unknown', 'missing-sample')])
                self.assertEqual(result['feedback']['firstUnknown']['tick'], 1)
                observation = self.call('harness_run', **args)
                self.assertEqual(observation['feedback']['status'], 'unknown')
                self.assertTrue(observation['feedback']['firstUnknown']['oscillating'])
                # A definite violation in a settled earlier row is still a
                # counterexample; later missing rows must not hide it.
                failed = self.call('evaluate_circuit', **args, expectedRows=[
                    {'tick': 0, 'values': {'Stable': 1}}, {'tick': 2, 'values': {'Stable': 0}},
                ])
                self.assertEqual(failed['evaluation']['status'], 'failed')
                self.assertEqual(failed['feedback']['firstFailure']['tick'], 0)


if __name__ == '__main__':
    unittest.main()
