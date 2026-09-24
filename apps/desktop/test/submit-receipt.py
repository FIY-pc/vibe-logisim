"""The write receipt: what a direct .circ edit changed, and why it does not load.

Runs check_native_loadability through the production Workspace after real disk
writes and reloads, the way the desktop host does after submit_circuit.
"""
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

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
