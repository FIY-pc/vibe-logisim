"""Native acceptance of optional path repair, with independent pin propagation.

Self-contained crossing buses and fanout; no course files or model calls.
"""
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


def fixture(fanout=False):
    root = ET.fromstring('''<project source="2.16.2.2" version="1.0">
      <lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"/>
      <circuit name="untouched"><comp lib="0" name="Pin" loc="(80,80)"/></circuit>
    </project>''')
    circuit = root.find('circuit')
    for label, loc, output, facing in [
        ('a', '(80,120)', False, 'east'), ('out_a', '(400,120)', True, 'west'),
        ('b', '(220,60)', False, 'south'), ('out_b', '(220,300)', True, 'north'),
        *([('fanout', '(400,240)', True, 'west')] if fanout else []),
    ]:
        c = ET.SubElement(circuit, 'comp', lib='0', name='Pin', loc=loc)
        for key, val in {'label': label, 'width': '4', 'output': str(output).lower(), 'facing': facing}.items():
            ET.SubElement(c, 'a', name=key, val=val)
    wires = [((80,120),(160,120)), ((160,120),(160,180)), ((160,180),(320,180)),
             ((320,180),(320,120)), ((320,120),(400,120)), ((220,60),(220,300))]
    if fanout:
        wires += [((320,180),(320,240)), ((320,240),(400,240))]
    for a, b in wires:
        ET.SubElement(circuit, 'wire', {'from': f'({a[0]},{a[1]})', 'to': f'({b[0]},{b[1]})'})
    return ET.tostring(root)


class Rerouting(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='vibe-native-rerouting-')
        cls.root = Path(cls.temp.name)
        cls.w = Workspace(REPO, cls.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'rerouting')

    @classmethod
    def tearDownClass(cls):
        cls.w.close()
        cls.temp.cleanup()

    def open(self, source):
        self.source = self.root / (self.id().split('.')[-1] + '.circ')
        self.source.write_bytes(source)
        self.w.open_path(self.source)
        self.original = source
        self.revision = self.w.revision_id
        return self.call('inspect_circuit', {'circuit': 'main', 'includeWires': True})

    def call(self, tool, arguments):
        return self.w.application.agent_tool({'projectId': self.w.history.record['id'],
            'revisionId': self.w.revision_id, 'tool': tool, 'arguments': arguments})

    def propose(self, inspection, ids, **extra):
        return self.call('reroute_candidate', {'circuit': 'main',
            'artifactSha256': inspection['artifactSha256'], 'wireIds': ids, **extra})

    def assert_source_unchanged(self):
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(self.w.revision_id, self.revision)

    def test_crossing_buses_and_native_truth_table(self):
        before = self.open(fixture())
        geometry = before['wireGeometry']
        selected = [x['wireId'] for x in geometry['wires'] if x['from']['x'] != 220]
        candidate = self.propose(before, selected)
        summary = candidate['changes'][0]['routing']
        self.assertLess(summary['lengthAfter'], summary['lengthBefore'])
        self.assertEqual(candidate['changes'][0]['wiringProof']['checkedPortBits'], 16)
        directory, _ = self.w.workbench._metadata(candidate['id'])
        xml = ET.parse(directory / 'artifact.circ').getroot()
        source_xml = ET.fromstring(self.original)
        self.assertEqual(ET.tostring(xml.findall('circuit')[1]), ET.tostring(source_xml.findall('circuit')[1]))
        self.assertEqual([ET.tostring(c) for c in xml.find('circuit').findall('comp')],
                         [ET.tostring(c) for c in source_xml.find('circuit').findall('comp')])
        self.assertTrue(any(w.get('from') == '(220,60)' and w.get('to') == '(220,300)'
                            for w in xml.find('circuit').findall('wire')), 'unselected wire retained')
        result = self.call('simulate_circuit', {'circuit': 'main', 'candidateId': candidate['id'],
            'vectors': [{'inputs': {'a': a, 'b': b}, 'expected': {'out_a': a, 'out_b': b}}
                        for a in range(16) for b in range(16)]})
        self.assertEqual((result['passed'], result['failed']), (256, 0))
        self.assert_source_unchanged()

    def test_subset_keeps_fanout_and_candidate_can_be_composed(self):
        before = self.open(fixture(fanout=True))
        wires = before['wireGeometry']['wires']
        ids = [w['wireId'] for w in wires if w['from']['y'] <= 180 and w['to']['y'] <= 180]
        first = self.propose(before, ids)
        view = self.call('inspect_circuit', {'circuit': 'main', 'candidateId': first['id'], 'includeWires': True})
        second = self.propose(view, [w['wireId'] for w in view['wireGeometry']['wires']], candidateId=first['id'])
        self.assertEqual(second['parentCandidateId'], first['id'])
        result = self.call('simulate_circuit', {'circuit': 'main', 'candidateId': second['id'],
            'vectors': [{'inputs': {'a': 9, 'b': 6}, 'expected': {'out_a': 9, 'out_b': 6, 'fanout': 9}}]})
        self.assertEqual(result['passed'], 1)
        self.assert_source_unchanged()

    def test_stale_ids_and_native_rejection_do_not_publish(self):
        before = self.open(fixture())
        ids = [w['wireId'] for w in before['wireGeometry']['wires'] if w['from']['x'] != 220]
        existing = self.w.workbench.list()
        with self.assertRaises(CircuitToolError) as caught:
            self.propose({**before, 'artifactSha256': 'outdated'}, ids)
        self.assertEqual(caught.exception.code, 'STALE_REVISION')
        # A faulty planner that branches into a foreign bus must be rejected
        # by the separate native electrical authority (plain crossings are legal).
        bad = [{'from': {'x':80, 'y':120}, 'to': {'x':220, 'y':120}},
               {'from': {'x':220, 'y':120}, 'to': {'x':400, 'y':120}},
               {'from': {'x':220, 'y':120}, 'to': {'x':220, 'y':60}}]
        with patch('studio.project.rerouting.reroute', return_value=(bad, {})):
            with self.assertRaises(CircuitToolError):
                self.propose(before, ids)
        self.assertEqual(self.w.workbench.list(), existing)
        self.assert_source_unchanged()

    def test_geometry_pagination_and_loop_rejection(self):
        before = self.open(fixture())
        paged = self.call('inspect_circuit', {'circuit': 'main', 'includeWires': True, 'wireOffset': 1, 'wireLimit': 2})
        self.assertEqual(paged['wireGeometry']['wires'], before['wireGeometry']['wires'][1:3])
        self.assertTrue(paged['wireGeometry']['wiresTruncated'])
        self.assertNotIn('wireGeometry', self.call('inspect_circuit', {'circuit': 'main'}))
        self.assertEqual(before['artifactSha256'], paged['artifactSha256'])
        root = ET.fromstring(fixture())
        circuit = root.find('circuit')
        for a, b in [('(80,120)','(80,80)'), ('(80,80)','(120,80)'),
                     ('(120,80)','(120,120)'), ('(120,120)','(80,120)')]:
            ET.SubElement(circuit, 'wire', {'from': a, 'to': b})
        before = self.open(ET.tostring(root))
        with self.assertRaises(CircuitToolError):
            self.propose(before, [w['wireId'] for w in before['wireGeometry']['wires']])
        self.assert_source_unchanged()

    def test_reuses_document_editor_without_dropping_comments(self):
        decoy = b'<!-- <circuit name="main"><wire from="(1,1)" to="(2,2)"/></circuit> -->'
        original = fixture().replace(b'<circuit name="main">', b'<circuit name="main"><!-- user note -->')
        original = original.replace(b'<main', decoy + b'<main', 1)
        before = self.open(original)
        candidate = self.propose(before, [w['wireId'] for w in before['wireGeometry']['wires']])
        directory, _ = self.w.workbench._metadata(candidate['id'])
        changed = (directory / 'artifact.circ').read_bytes()
        self.assertIn(decoy, changed)
        self.assertIn(b'<!-- user note -->', changed)
        self.assert_source_unchanged()


if __name__ == '__main__':
    unittest.main()
