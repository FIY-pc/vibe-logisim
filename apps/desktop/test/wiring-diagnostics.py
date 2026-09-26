"""Post-routing partition failures must name both ports and what was drawn.

A bare "要求连接的信号仍然断开: <port> bit 0" cannot be acted on by the model or
reproduced from a bug report. These tests pin the structured error.
"""
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.domain.routing import Partition
from studio.domain.tool_errors import CircuitToolError
from studio.runtime import wiring


def observation(nets):
    """Two one-bit Pins whose port nets are given as (pinA, pinB)."""
    def pin(x, net):
        return {"componentId": f"c{x}_80", "factoryName": "Pin", "location": {"x": x, "y": 80}, "attributes": [],
                "ends": [{"index": 0, "width": 1, "direction": "input", "location": {"x": x, "y": 80},
                          "netBits": [{"bit": 0, "netId": net}]}]}
    return {"focus": {"components": [pin(80, nets[0]), pin(200, nets[1])], "wires": [], "wireBundles": []}}


class ComparePartition(unittest.TestCase):
    def test_missing_join_names_both_ports(self):
        before, after = observation(("a", "b")), observation(("a", "b"))
        expected = Partition(); expected.join("a", "b")
        with self.assertRaises(wiring.PartitionMismatch) as caught:
            wiring.compare_partition(before, after, expected)
        error = caught.exception
        self.assertEqual(error.kind, "disconnected")
        self.assertTrue(str(error).startswith("要求连接的信号仍然断开"))
        self.assertEqual(error.key, (("Pin", (200, 80)), 0))
        self.assertEqual(error.other, (("Pin", (80, 80)), 0))
        self.assertEqual((error.after_net, error.other_after_net), ("b", "a"))

    def test_unrequested_short_names_both_ports(self):
        before, after = observation(("a", "b")), observation(("x", "x"))
        with self.assertRaises(wiring.PartitionMismatch) as caught:
            wiring.compare_partition(before, after)
        error = caught.exception
        self.assertEqual(error.kind, "short")
        self.assertTrue(str(error).startswith("出现未要求的短接"))
        self.assertEqual(error.key, (("Pin", (200, 80)), 0))
        self.assertEqual(error.other, (("Pin", (80, 80)), 0))

    def test_realized_join_counts_bits(self):
        before, after = observation(("a", "b")), observation(("x", "x"))
        expected = Partition(); expected.join("a", "b")
        self.assertEqual(wiring.compare_partition(before, after, expected), 2)


def fixture():
    root = ET.Element('project', source='2.7.1', version='1.0')
    for lib, desc in [('0', '#Wiring'), ('1', '#Gates')]:
        ET.SubElement(root, 'lib', name=lib, desc=desc)
    ET.SubElement(root, 'main', name='main')
    main = ET.SubElement(root, 'circuit', name='main')
    a = ET.SubElement(main, 'comp', name='Pin', lib='0', loc='(80,80)'); ET.SubElement(a, 'a', name='label', val='A')
    ET.SubElement(main, 'comp', name='AND Gate', lib='1', loc='(300,100)')
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


class WireCandidateDiagnostics(unittest.TestCase):
    """Native runtime in the loop; the after-observation is forced stale once."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='vibe-wiring-diag-'))
        (cls.tmp / 'design.circ').write_bytes(fixture())
        cls.workspace = Workspace(REPO, cls.tmp / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'diag')
        cls.workspace.open_path(cls.tmp / 'design.circ')

    @classmethod
    def tearDownClass(cls):
        cls.workspace.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, tool, args):
        result = self.workspace.workbench.call(self.workspace.revision_id, tool, args)
        return json.loads(result) if isinstance(result, (str, bytes)) else result

    def request(self):
        view = self.call('inspect_circuit', {'circuit': 'main'})
        gate = next(c for c in view['components'] if c['factory'] == 'AND Gate')
        pin = next(c for c in view['components'] if c['factory'] == 'Pin')
        first_input = next(e['index'] for e in gate['ends'] if e['direction'] == 'input')
        return gate, pin, {'circuit': 'main', 'title': 't', 'connections': [
            {'name': 'A->in', 'from': {'component': pin['componentId'], 'port': 0},
             'to': {'component': gate['componentId'], 'port': first_input}}]}

    def test_happy_path_still_publishes(self):
        _, _, args = self.request()
        result = self.call('wire_candidate', args)
        change = result['changes'][0]
        self.assertEqual(change['wiringProof']['missingConnections'], 0)
        self.assertGreater(change['wiresAfter'], 0)

    def test_stale_after_observation_is_reported_with_both_ports(self):
        gate, pin, args = self.request()
        observer = self.workspace.observer
        real = observer.run_full
        first = {}
        def stale(artifact, circuit, render_path=None, **kw):
            observed = real(artifact, circuit, render_path, **kw)
            if render_path is None:
                first.setdefault('baseline', copy.deepcopy(observed))
                return observed
            # Pretend the router's wires had no electrical effect.
            return {**observed, 'focus': copy.deepcopy(first['baseline']['focus'])}
        observer.run_full = stale
        try:
            with self.assertRaises(CircuitToolError) as caught:
                self.call('wire_candidate', args)
        finally:
            observer.run_full = real
        error = caught.exception
        self.assertEqual(error.code, 'TOOL_REJECTED')
        self.assertTrue(str(error).startswith('要求连接的信号仍然断开'), str(error))
        context = error.context
        self.assertEqual(context['kind'], 'disconnected')
        ports = {context['failingPort']['component'], context['expectedSameNetAs']['component']}
        self.assertEqual(ports, {gate['componentId'], pin['componentId']})
        self.assertEqual([c['name'] for c in context['requestedConnections']], ['A->in'])
        self.assertEqual(len(context['routedForThese']), 1)
        self.assertGreater(context['segmentsDrawnForThese'], 0)
        self.assertEqual(context['wiresBefore'], 0)
        self.assertRegex(context['artifactSha256'], r'^[0-9a-f]{64}$')
        self.assertIn('os', context['environment'])
        self.assertIn('failingPort', context['netsAfterReload'])
        self.assertIn('画了新导线', error.hint)


if __name__ == '__main__':
    unittest.main()
