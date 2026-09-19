"""Real Logisim register tasks through the public trace/evaluation tools.

Self-contained circuits, temporary workspace/state, no course circuit or model
calls. The two installed Logisim runtimes are required (see development.md).
"""
from contextlib import contextmanager
from copy import deepcopy
import hashlib
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


RUNTIMES = (
    ('2.16.2.2', REPO / 'apps/desktop/circuit-lens/native/Logisim-ITA.jar'),
    ('2.15.0', REPO / 'workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe'),
)


def register_circuit(version, high_duration=1):
    """Three rising-edge registers share Data, Load and asynchronous Reset.

    Their clocks are respectively a native Clock, an input Pin and a Button.
    Tunnels keep the fixture compact; every register control is explicitly wired.
    """
    project = ET.Element('project', source=version, version='1.0')
    for name, library in [('0', 'Wiring'), ('4', 'Memory'), ('5', 'I/O')]:
        ET.SubElement(project, 'lib', name=name, desc='#' + library)
    ET.SubElement(project, 'main', name='main')
    circuit = ET.SubElement(project, 'circuit', name='main')

    def component(factory, library, x, y, **attributes):
        node = ET.SubElement(circuit, 'comp', name=factory, lib=library, loc=f'({x},{y})')
        for key, value in attributes.items():
            ET.SubElement(node, 'a', name=key, val=str(value))

    def tunnel(name, width, x, y):
        component('Tunnel', '0', x, y, label=name, width=width)

    def wire(x1, y1, x2, y2):
        ET.SubElement(circuit, 'wire', {'from': f'({x1},{y1})', 'to': f'({x2},{y2})'})

    sources = [
        ('Pin', '0', 'Data', 4, {}),
        ('Pin', '0', 'Load', 1, {}),
        ('Pin', '0', 'Step', 1, {}),
        ('Clock', '0', 'NativeClock', 1, {'highDuration': high_duration, 'lowDuration': 1}),
        ('Button', '5', 'Capture', 1, {}),
        ('Button', '5', 'Reset', 1, {}),
        ('Constant', '0', 'Zero', 1, {'value': '0x0'}),
    ]
    for index, (factory, library, name, width, attributes) in enumerate(sources):
        y = 80 + 40 * index
        component(factory, library, 80, y, label=name, width=width, **attributes)
        wire(80, y, 100, y)
        tunnel(name, width, 100, y)

    for index, (clock, output) in enumerate([
        ('NativeClock', 'nativeQ'), ('Step', 'pinQ'), ('Capture', 'buttonQ'),
    ]):
        x, y = 380, 160 + 160 * index
        component('Register', '4', x, y, label=output + 'Register', width=4, trigger='rising')
        tunnel('Data', 4, x - 30, y)
        tunnel(clock, 1, x - 20, y + 20)
        tunnel('Reset', 1, x - 10, y + 20)
        tunnel('Load', 1, x - 30, y + 10)
        tunnel('Zero', 1, x - 30, y - 10)  # Active-low chip select.
        tunnel('Zero', 1, x - 10, y - 20)  # Asynchronous preset inactive.
        wire(x, y, x + 80, y)
        component('Pin', '0', x + 80, y, label=output, width=4, output='true', facing='west')
    return ET.tostring(project, encoding='utf-8', xml_declaration=True)


class TraceEvents(unittest.TestCase):
    @contextmanager
    def opened(self, version, high_duration=1):
        with tempfile.TemporaryDirectory(prefix='vibe-trace-events-') as directory:
            root = Path(directory)
            source = root / 'registers.circ'
            original = register_circuit(version, high_duration)
            source.write_bytes(original)
            workspace = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'trace-events')
            try:
                workspace.open_path(source)
                self.workspace = workspace
                before = (workspace.revision_id, workspace.artifact_sha256, deepcopy(workspace.history.record))
                frozen = workspace.frozen_path.read_bytes()
                inspection = self.call('inspect_circuit', {'circuit': 'main'})
                self.components = {
                    c['label']: c['componentId'] for c in inspection['components']
                    if c['factory'] != 'Tunnel'
                }
                self.assertEqual(inspection['connectivityIssues']['unconnectedInputs'], [])
                self.assertEqual(inspection['connectivityIssues']['widthIncompatibilities'], [])
                try:
                    yield source
                finally:
                    self.assertEqual(source.read_bytes(), original, 'stimuli must never save into the source')
                    self.assertEqual(workspace.frozen_path.read_bytes(), frozen)
                    self.assertEqual(
                        (workspace.revision_id, workspace.artifact_sha256, workspace.history.record), before,
                        'observations must not create structural revisions or edit history',
                    )
            finally:
                workspace.close()

    def call(self, tool, arguments):
        return self.workspace.application.agent_tool({
            'projectId': self.workspace.history.record['id'],
            'revisionId': self.workspace.revision_id,
            'tool': tool,
            'arguments': arguments,
        })

    def experiment(self):
        def button(tick, label, pressed):
            return {'tick': tick, 'component': self.components[label], 'pressed': pressed}

        inputs = [
            (0, 'Data', 3),
            # The native edge already captured 3. Pin edge captures 5, then
            # Data changes again before the Button edge captures 6.
            (1, 'Data', 5), (1, 'Step', 1), (1, 'Data', 6),
            (2, 'Data', 9), (2, 'Load', 0), (2, 'Step', 0),
            # Enable becomes 1 AFTER the native edge: nativeQ must hold 3.
            (3, 'Load', 1), (3, 'Step', 1),
            (4, 'Data', 12), (4, 'Step', 0), (4, 'Step', 1),
            # Held-high Pin/Button clocks must not recapture changing data.
            (5, 'Data', 2),
            (6, 'Data', 14), (6, 'Step', 0), (6, 'Step', 1),
            (9, 'Data', 15),  # Events at the final tick are included in its sample.
        ]
        return {
            'circuit': 'main', 'ticks': 9,
            'inputs': {'Data': 1, 'Load': 1, 'Step': 0},
            'resetButton': self.components['Reset'],
            'watches': [
                {'name': name, 'component': self.components[name], 'port': 0}
                for name in ('Data', 'Load', 'Step', 'NativeClock', 'Capture', 'Reset', 'nativeQ', 'pinQ', 'buttonQ')
            ],
            'inputEvents': [{'tick': tick, 'name': name, 'value': value} for tick, name, value in inputs],
            'buttonEvents': [
                button(0, 'Capture', True), button(0, 'Capture', False),
                button(1, 'Capture', True), button(2, 'Capture', False),
                button(3, 'Capture', True),
                button(4, 'Capture', False), button(4, 'Capture', True),
                button(6, 'Capture', False), button(6, 'Capture', True), button(6, 'Reset', True),
                button(7, 'Reset', False),
                button(9, 'Capture', False), button(9, 'Capture', True),
            ],
        }

    @staticmethod
    def expected_rows():
        # Independent, hand-calculated oracle, not generated from runtime rows.
        signals = {
            'Data':        [3, 6, 9, 9, 12, 2, 14, 14, 14, 15],
            'Load':        [1, 1, 0, 1, 1, 1, 1, 1, 1, 1],
            'Step':        [0, 1, 0, 1, 1, 1, 1, 1, 1, 1],
            'NativeClock': [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
            'Capture':     [0, 1, 0, 1, 1, 1, 1, 1, 1, 1],
            'Reset':       [0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
            'nativeQ':     [0, 3, 3, 3, 3, 12, 0, 0, 0, 14],
            'pinQ':        [0, 5, 5, 9, 12, 12, 0, 0, 0, 0],
            'buttonQ':     [3, 6, 6, 9, 12, 12, 0, 0, 0, 15],
        }
        return [{'tick': tick, 'values': {name: values[tick] for name, values in signals.items()}} for tick in range(10)]

    def test_register_capture_hold_reset_and_sampling_on_both_runtimes(self):
        for version, jar in RUNTIMES:
            with self.subTest(runtime=version), self.opened(version) as source:
                args = self.experiment()
                expected = self.expected_rows()
                trace = self.call('trace_circuit', args)
                self.assertEqual([{'tick': row['tick'], 'values': row['values']} for row in trace['rows']], expected)
                self.assertFalse(any(row['oscillating'] for row in trace['rows']))
                self.assertEqual(trace['execution']['runtimeJarSha256'], hashlib.sha256(jar.read_bytes()).hexdigest())
                self.assertEqual(trace['execution']['artifactSha256'], hashlib.sha256(source.read_bytes()).hexdigest())
                self.assertEqual(trace['runtimeProfile']['status'], 'observed')
                self.assertEqual(trace['plugin']['version'], '1.7.0')

                evaluated = self.call('evaluate_circuit', {**args, 'mode': 'trace', 'expectedRows': expected})
                self.assertEqual(evaluated['evaluation']['status'], 'passed')
                self.assertEqual(evaluated['result']['rows'], trace['rows'])
                self.assertEqual(evaluated['run']['stimulusSha256'], trace['stimulusSha256'])

                # A plausible off-by-one sampling assumption must fail explicitly.
                failed = self.call('evaluate_circuit', {
                    **args, 'mode': 'trace', 'expectedRows': [{'tick': 1, 'values': {'nativeQ': 6}}],
                })
                self.assertEqual(failed['evaluation']['status'], 'failed')
                self.assertEqual(failed['feedback']['firstFailure']['tick'], 1)
                self.assertEqual(failed['feedback']['firstFailure']['actual']['nativeQ'], 3)
                unknown = self.call('evaluate_circuit', {
                    **args, 'mode': 'trace', 'expectedRows': [{'tick': 10, 'values': {'nativeQ': 14}}],
                })
                self.assertEqual(unknown['evaluation']['status'], 'unknown')

                window = self.call('trace_circuit', {**args, 'rowStart': 3, 'rowLimit': 3})
                self.assertEqual(window['rows'], trace['rows'][3:6])
                self.assertEqual(window['rowCount'], 10)
                self.assertTrue(window['rowsTruncated'])

                # A later call starts fresh, with no retained Pin or Button state.
                fresh = self.call('trace_circuit', {
                    **{key: value for key, value in args.items() if key not in ('inputEvents', 'buttonEvents')},
                    'ticks': 2, 'inputs': {'Data': 7, 'Load': 1, 'Step': 0},
                })
                self.assertEqual([row['values']['nativeQ'] for row in fresh['rows']], [0, 7, 7])
                for row in fresh['rows']:
                    self.assertEqual({key: row['values'][key] for key in ('pinQ', 'buttonQ', 'Capture', 'Reset')},
                                     {'pinQ': 0, 'buttonQ': 0, 'Capture': 0, 'Reset': 0})

    def test_native_tick_is_not_always_a_clock_transition(self):
        for version, _jar in RUNTIMES:
            with self.subTest(runtime=version), self.opened(version, high_duration=2):
                args = self.experiment()
                trace = self.call('trace_circuit', {
                    **args, 'ticks': 4, 'inputs': {'Data': 3, 'Load': 1, 'Step': 0},
                    'inputEvents': [{'tick': 2, 'name': 'Data', 'value': 9}], 'buttonEvents': [],
                })
                self.assertEqual([row['values']['NativeClock'] for row in trace['rows']], [0, 1, 1, 0, 1])
                self.assertEqual([row['values']['nativeQ'] for row in trace['rows']], [0, 3, 3, 3, 9])

    def test_invalid_events_are_rejected_by_the_public_tools(self):
        # Catalog/type checks and dynamic target/range checks are shared by both
        # runtimes. Wrap only the native executor to observe whether it was called.
        with self.opened(RUNTIMES[0][0]):
            args = self.experiment()
            bad_input = {'tick': 1, 'name': 'Data', 'value': 3}
            bad_button = {'tick': 1, 'component': self.components['Capture'], 'pressed': True}
            invalid = [
                ('inputEvents', [{**bad_input, 'tick': -1}], 'INVALID_ARGUMENT'),
                ('inputEvents', [{**bad_input, 'tick': True}], 'INVALID_ARGUMENT'),
                ('inputEvents', [{**bad_input, 'tick': 10}], 'TOOL_REJECTED'),
                ('inputEvents', [{**bad_input, 'value': True}], 'INVALID_ARGUMENT'),
                ('inputEvents', [{**bad_input, 'value': 2**32}], 'INVALID_ARGUMENT'),
                ('inputEvents', [{'tick': 1, 'name': 'Data'}], 'INVALID_ARGUMENT'),
                ('inputEvents', [{**bad_input, 'unexpected': 0}], 'INVALID_ARGUMENT'),
                ('inputEvents', [bad_input] * 1001, 'INVALID_ARGUMENT'),
                ('inputEvents', [{**bad_input, 'name': 'missing'}], 'UNKNOWN_INPUT'),
                ('inputEvents', [{**bad_input, 'name': 'nativeQ'}], 'UNKNOWN_INPUT'),
                ('inputEvents', [{**bad_input, 'name': 'NativeClock'}], 'UNKNOWN_INPUT'),
                ('buttonEvents', [{**bad_button, 'tick': -1}], 'INVALID_ARGUMENT'),
                ('buttonEvents', [{**bad_button, 'tick': 1.5}], 'INVALID_ARGUMENT'),
                ('buttonEvents', [{**bad_button, 'tick': 10}], 'TOOL_REJECTED'),
                ('buttonEvents', [{**bad_button, 'pressed': 1}], 'INVALID_ARGUMENT'),
                ('buttonEvents', [{**bad_button, 'component': 'missing'}], 'TOOL_REJECTED'),
                ('buttonEvents', [{**bad_button, 'component': self.components['Data']}], 'TOOL_REJECTED'),
            ]
            for tool in ('trace_circuit', 'evaluate_circuit'):
                base = args if tool == 'trace_circuit' else {**args, 'mode': 'trace', 'expectedRows': self.expected_rows()}
                for field, events, code in invalid:
                    with self.subTest(tool=tool, field=field, event=events[0], count=len(events)):
                        with patch.object(self.workspace.workbench, '_native', wraps=self.workspace.workbench._native) as native:
                            with self.assertRaises(CircuitToolError) as rejected:
                                self.call(tool, {**base, field: events})
                            native.assert_not_called()
                        self.assertEqual(rejected.exception.code, code)
                        self.assertFalse(rejected.exception.retryable)
                        self.assertTrue(rejected.exception.as_dict()['hint'])
                        if code == 'UNKNOWN_INPUT':
                            self.assertEqual(rejected.exception.available_inputs, ['Data', 'Load', 'Step'])

            # Explicit combinational evaluation must not silently ignore events.
            for field, event in [('inputEvents', bad_input), ('buttonEvents', bad_button)]:
                with self.subTest(mode='simulate', field=field):
                    with patch.object(self.workspace.workbench, '_native', wraps=self.workspace.workbench._native) as native:
                        with self.assertRaisesRegex(CircuitToolError, 'trace 模式'):
                            self.call('evaluate_circuit', {
                                'circuit': 'main', 'mode': 'simulate', field: [event],
                                'vectors': [{'inputs': args['inputs'], 'expected': {'nativeQ': 0}}],
                            })
                        native.assert_not_called()

    def test_pin_width_overflow_is_rejected_by_actual_logisim(self):
        # The public scalar limit is uint32; the native Pin enforces its own
        # narrower width. A 4-bit value of 16 must fail, never wrap to zero.
        for version, _jar in RUNTIMES:
            with self.subTest(runtime=version), self.opened(version):
                args = {**self.experiment(), 'inputEvents': [{'tick': 1, 'name': 'Data', 'value': 16}]}
                for tool in ('trace_circuit', 'evaluate_circuit'):
                    with self.subTest(tool=tool):
                        if tool == 'evaluate_circuit':
                            args = {**args, 'mode': 'trace', 'expectedRows': self.expected_rows()}
                        with self.assertRaisesRegex(CircuitToolError, 'Input event out of range') as rejected:
                            self.call(tool, args)
                        self.assertFalse(rejected.exception.retryable)


if __name__ == '__main__':
    unittest.main()
