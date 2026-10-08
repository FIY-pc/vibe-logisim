"""The write receipt: what a direct .circ edit changed, and why it does not load.

Runs check_native_loadability through the production Workspace after real disk
writes and reloads, the way the desktop host does after submit_circuit.
"""
from pathlib import Path
import hashlib
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.project.changes import circuit_changes


def project():
    root = ET.Element('project', source='2.16.2.2', version='1.0')
    for library, descriptor in [('0', '#Wiring'), ('1', '#Gates'), ('4', '#Memory')]:
        ET.SubElement(root, 'lib', name=library, desc=descriptor)
    ET.SubElement(root, 'main', name='main')
    main = ET.SubElement(root, 'circuit', name='main')
    ET.SubElement(main, 'comp', name='Pin', lib='0', loc='(80,80)')
    ET.SubElement(main, 'comp', name='Pin', lib='0', loc='(200,80)')
    ET.SubElement(main, 'wire', {'from': '(80,80)', 'to': '(200,80)'})
    other = ET.SubElement(root, 'circuit', name='Other')
    pin = ET.SubElement(other, 'comp', name='Pin', lib='0', loc='(80,80)')
    ET.SubElement(pin, 'a', name='label', val='A')
    ET.SubElement(other, 'comp', name='AND Gate', lib='1', loc='(160,80)')
    return root


class SubmitReceipt(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='vibe-submit-receipt-')
        root = Path(self.directory.name)
        self.document = project()
        self.source = root / 'design.circ'
        self.write()
        self.w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'submit-receipt')
        self.w.open_path(self.source)

    def tearDown(self):
        self.w.close()
        self.directory.cleanup()

    def write(self):
        self.source.write_bytes(ET.tostring(self.document, encoding='utf-8', xml_declaration=True))

    def check(self, previous, circuit='main'):
        return self.w.workbench.call(self.w.revision_id, 'check_native_loadability',
                                     {'circuit': circuit, **({'previousRevisionId': previous} if previous else {})})

    def test_unchanged_file_and_changes_outside_the_target_circuit(self):
        first = self.w.revision_id
        same = self.check(first)
        self.assertEqual(same['status'], 'loadable')
        self.assertEqual(same['fileChange'], {'previousRevisionId': first, 'revisionId': first,
                                              'changed': False, 'circuits': [], 'outsideTarget': []})
        self.assertNotIn('fileChange', self.check(None), 'no previous revision, no change summary')

        main = self.document.find("circuit[@name='main']")
        other = self.document.find("circuit[@name='Other']")
        ET.SubElement(main, 'comp', name='Constant', lib='0', loc='(120,140)')
        other.remove(other.find("comp[@name='AND Gate']"))
        other.find("comp[@name='Pin']").set('loc', '(80,120)')
        self.write()
        self.w.reload()
        second = self.w.revision_id
        self.assertNotEqual(first, second)

        receipt = self.check(first)
        self.assertEqual(receipt['status'], 'loadable')
        self.assertEqual(receipt['layoutReview']['status'], 'observed')
        self.assertEqual(receipt['layoutReview']['otherChangedDefinitions'], ['Other'])
        change = receipt['fileChange']
        self.assertEqual((change['previousRevisionId'], change['revisionId'], change['changed']), (first, second, True))
        self.assertEqual(change['outsideTarget'], ['Other'])
        self.assertFalse(change['projectSettingsChanged'])
        by_name = {c['circuit']: c for c in change['circuits']}
        self.assertEqual(set(by_name), {'main', 'Other'})
        self.assertEqual(by_name['main']['componentChanges'], {'added': 1, 'removed': 0, 'modified': 0})
        self.assertEqual(by_name['main']['samples'], [{'change': 'added', 'factory': 'Constant', 'location': {'x': 120, 'y': 140}}])
        self.assertEqual(by_name['Other']['componentChanges'], {'added': 0, 'removed': 1, 'modified': 1})
        self.assertEqual(by_name['Other']['components'], {'before': 2, 'after': 1})
        self.assertIn({'change': 'modified', 'factory': 'Pin', 'location': {'x': 80, 'y': 120}, 'label': 'A'},
                      by_name['Other']['samples'])

        missing = self.check('0' * 64)
        self.assertEqual(missing['status'], 'loadable')
        self.assertTrue(missing['fileChange']['changed'])
        self.assertIn('unavailable', missing['fileChange'])
        self.assertNotIn('circuits', missing['fileChange'])

    def test_direct_edit_geometry_and_explicit_review_agree_without_mutating_source(self):
        main = self.document.find("circuit[@name='main']")
        # Native bus Pin displays overlap at a 20-unit pitch; anchors differ.
        for y in (180, 200):
            pin = ET.SubElement(main, 'comp', name='Pin', lib='0', loc=f'(300,{y})')
            ET.SubElement(pin, 'a', name='width', val='32')
        for i in range(9):
            t = ET.SubElement(main, 'comp', name='Tunnel', lib='0', loc=f'({500+i*10},300)')
            ET.SubElement(t, 'a', name='label', val='LONG_SIGNAL_'+str(i))
        before = self.w.revision_id
        self.write()
        self.w.reload()
        original = self.source.read_bytes()
        revision = self.w.revision_id
        receipt = self.check(before)['layoutReview']
        self.assertGreater(receipt['overlapPairs'], 24)
        self.assertGreater(receipt['byKind']['component-body'], 0)
        self.assertEqual(receipt['artifactSha256'], hashlib.sha256(original).hexdigest())
        review = self.w.workbench.call(revision, 'inspect_circuit', {'circuit': 'main', 'layoutReview': {}})
        self.assertEqual(receipt['examples'], review['layoutReview']['examples'])
        self.assertEqual(len(receipt['examples']), 24)
        page = self.w.workbench.call(revision, 'inspect_circuit', {'circuit': 'main',
            'layoutReview': {'issueOffset': 24, 'artifactSha256': review['artifactSha256']}})
        self.assertTrue(page['layoutReview']['examples'])
        self.assertNotEqual(page['layoutReview']['examples'][0], receipt['examples'][0])
        # Produce a real native crop using the suggested region, not just schema checks.
        rendered = self.w.workbench.call(revision, 'render_circuit',
            {'circuit': 'main', 'viewport': receipt['examples'][0]['viewport']})
        self.assertTrue(rendered['result']['imageIncluded'])
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(self.w.revision_id, revision)
        # The old page cannot silently refer to newly moved objects.
        main.find("comp[@name='Tunnel']").set('loc', '(900,900)')
        self.write(); self.w.reload()
        with self.assertRaisesRegex(Exception, '图面已改变'):
            self.w.workbench.call(self.w.revision_id, 'inspect_circuit', {'circuit': 'main',
                'layoutReview': {'issueOffset': 24, 'artifactSha256': review['artifactSha256']}})

    def test_geometry_unavailable_does_not_overwrite_successful_load(self):
        with patch.object(self.w.observer, 'run_full', side_effect=RuntimeError('fixture observation unavailable')):
            result = self.check(None)
        self.assertEqual(result['status'], 'loadable')
        self.assertEqual(result['layoutReview']['status'], 'unavailable')
        self.assertNotIn('overlapPairs', result['layoutReview'])

    def test_cumulative_scope_retains_a_child_changed_before_the_latest_write(self):
        baseline=self.w.revision_id
        other=self.document.find("circuit[@name='Other']")
        other.find("comp[@name='Pin']").set('loc','(80,120)')
        self.write();self.w.reload()
        previous=self.w.revision_id
        ET.SubElement(self.document.find("circuit[@name='main']"),'comp',name='Constant',lib='0',loc='(300,200)')
        self.write();self.w.reload()
        receipt=self.w.workbench.call(self.w.revision_id,'check_native_loadability',
            {'circuit':'main','previousRevisionId':previous,'turnBaselineRevisionId':baseline})
        self.assertEqual([c['circuit'] for c in receipt['fileChange']['circuits']],['main'])
        self.assertEqual({c['circuit'] for c in receipt['turnChanges']['circuits']},{'main','Other'})
        again=self.w.workbench.call(self.w.revision_id,'check_native_loadability',
            {'circuit':'main','previousRevisionId':self.w.revision_id,'turnBaselineRevisionId':baseline})
        self.assertFalse(again['fileChange']['changed'])
        self.assertEqual(again['turnChanges'],receipt['turnChanges'])
        self.assertNotIn('completed',again['turnChanges'])
        self.assertNotIn('reviewed',again['turnChanges'])

    def test_load_failures_explain_missing_or_wrong_lib(self):
        before = self.w.revision_id
        main = self.document.find("circuit[@name='main']")
        stray = ET.SubElement(main, 'comp', name='Constant', loc='(120,200)')
        self.write()
        self.w.reload()
        receipt = self.check(before)
        self.assertEqual(receipt['status'], 'not-loadable')
        self.assertEqual(receipt['error']['code'], 'NATIVE_LOAD_FAILED')
        self.assertIn("component `Constant' not found", receipt['error']['message'])
        self.assertIn('lib', receipt['error']['hint'])
        self.assertIn('0=#Wiring', receipt['error']['hint'])
        self.assertEqual([c['circuit'] for c in receipt['fileChange']['circuits']], ['main'],
                         'the change summary is reported even when the file does not load')

        stray.set('lib', '4')
        self.write()
        self.w.reload()
        wrong = self.check(None)
        self.assertEqual(wrong['status'], 'not-loadable')
        self.assertIn("missing from library `4'", wrong['error']['message'])
        self.assertIn('原生名称', wrong['error']['hint'])

        stray.set('lib', '7')
        self.write()
        self.w.reload()
        unknown = self.check(None)
        self.assertIn("library `7' not found", unknown['error']['message'])
        self.assertIn('<lib>', unknown['error']['hint'])

    def test_circuit_changes_ignores_untouched_definitions_and_reports_settings(self):
        before = project()
        after = project()
        self.assertEqual(circuit_changes(before, after, 'main'),
                         {'circuits': [], 'outsideTarget': [], 'projectSettingsChanged': False,
                          'scope': 'serialized-components-and-wire-segments'})
        ET.SubElement(after, 'lib', name='5', desc='#Plexers')
        ET.SubElement(after, 'circuit', name='New')
        after.remove(after.find("circuit[@name='Other']"))
        summary = circuit_changes(before, after, 'main')
        self.assertTrue(summary['projectSettingsChanged'])
        self.assertEqual([(c['circuit'], c['status']) for c in summary['circuits']], [('Other', 'removed'), ('New', 'added')])
        self.assertEqual(summary['outsideTarget'], ['Other', 'New'])


if __name__ == '__main__':
    unittest.main()
