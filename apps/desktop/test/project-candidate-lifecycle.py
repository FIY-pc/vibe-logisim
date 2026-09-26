"""Real Logisim import/apply/recovery across two equal-content projects.

Runs entirely in temporary copies. No model calls or user state are used.
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import skip_unless_samples
from studio.application.workspace import Workspace
from studio.domain.errors import LensError


@skip_unless_samples(REPO, 'archive/tooling/tmp/half_adder.circ')
class CandidateLifecycle(unittest.TestCase):
    def test_rejected_edit_never_publishes_prepared_snapshot(self):
        original = (REPO / 'archive/tooling/tmp/half_adder.circ').read_bytes()
        with tempfile.TemporaryDirectory(prefix='vibe-rejected-edit-') as temporary:
            root = Path(temporary)
            source = root / 'design.circ'
            source.write_bytes(original)
            w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'test')
            try:
                w.application.open_path(source)
                component = w.workbench.inspect({'circuit': 'main'})['components'][0]
                revision, state = w.revision_id, w.project_store.state
                pointer = (root / 'state/current.json').read_bytes()
                record = json.dumps(w.history.record, sort_keys=True)
                def reject(snapshot, *args):
                    self.assertNotEqual(snapshot.revision_id, revision)
                    self.assertIs(w.project_store.state, state)
                    self.assertEqual((root / 'state/current.json').read_bytes(), pointer)
                    raise ValueError('injected native inspection failure')
                actions = [
                    ('edit', {'componentId': component['componentId'], 'attribute': 'label', 'value': 'renamed'}),
                    ('delete', {'wireIds': ['xml:w0000']}),
                ]
                for action, details in actions:
                    with self.subTest(action=action), patch.object(w.application.editor, 'inspect_snapshot', side_effect=reject):
                        with self.assertRaisesRegex(ValueError, 'injected'):
                            w.application.project_action(action, {
                                'projectId': w.history.record['id'], 'revisionId': revision,
                                'circuit': 'main', **details,
                            })
                self.assertIs(w.project_store.state, state)
                self.assertEqual(w.revision_id, revision)
                self.assertEqual(json.dumps(w.history.record, sort_keys=True), record)
                self.assertEqual((root / 'state/current.json').read_bytes(), pointer)
                self.assertEqual(source.read_bytes(), original)
            finally:
                w.close()

    def test_equal_content_projects_and_legacy_history(self):
        original = (REPO / 'archive/tooling/tmp/half_adder.circ').read_bytes()
        with tempfile.TemporaryDirectory(prefix='vibe-candidate-lifecycle-') as temporary:
            root = Path(temporary)
            a, b = root / 'a.circ', root / 'b.circ'
            a.write_bytes(original)
            b.write_bytes(original)

            def workspace():
                return Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'test')

            def binding(w):
                return {'projectId': w.history.record['id'], 'revisionId': w.revision_id}

            def action(w, name, **extra):
                return w.application.project_action(name, {**binding(w), **extra})

            w = workspace()
            try:
                w.application.open_path(a)
                project_a, revision = w.history.record['id'], w.revision_id
                # Change only a pin label; import must load and render the real
                # native circuit and produce the same candidate users review.
                changed = original.decode().replace('val="sum"', 'val="result"')
                self.assertNotEqual(changed.encode(), original)
                candidate = w.application.agent_tool({
                    **binding(w), 'tool': 'import_candidate',
                    'arguments': {'circuitXml': changed, 'title': 'Rename sum'},
                })
                identifier = candidate['id']
                self.assertEqual(candidate['projectId'], project_a)
                self.assertTrue(w.workbench.diff(identifier)['access']['canApply'])
                self.assertEqual([c['id'] for c in w.workbench.list()], [identifier])
                self.assertEqual(w.revision_id, revision)
                self.assertEqual(a.read_bytes(), original)

                selection = w.focus.save_selection({**binding(w), 'circuit': 'main'})
                self.assertEqual(selection['projectId'], project_a)
                w.application.open_path(b)
                for read in [lambda: w.focus.get_selection(), lambda: w.focus.get_selection(revision, selection['id'])]:
                    with self.assertRaises(LensError):
                        read()
                with self.assertRaises(LensError):
                    w.focus.save_selection({'projectId': project_a, 'revisionId': revision, 'circuit': 'main'})
                self.assertNotEqual(w.history.record['id'], project_a)
                self.assertEqual(w.revision_id, revision)
                self.assertEqual(w.workbench.list(), [])
                with self.assertRaisesRegex(ValueError, '另一个工程'):
                    action(w, 'apply', candidateId=identifier)
                with self.assertRaisesRegex(ValueError, '另一个工程'):
                    w.workbench.archive(identifier)

                w.application.open_path(a)
                action(w, 'apply', candidateId=identifier)
                applied_revision = w.revision_id
                self.assertNotEqual(applied_revision, revision)
                self.assertEqual(a.read_bytes(), original)
                action(w, 'save')
                self.assertEqual(a.read_bytes(), changed.encode())
                self.assertEqual(b.read_bytes(), original)
            finally:
                w.close()

            w = workspace()
            try:
                w.application.open_path(a)
                self.assertEqual(w.history.record['id'], project_a)
                self.assertEqual(w.revision_id, applied_revision)
                self.assertEqual(w.workbench.diff(identifier)['id'], identifier)
                self.assertFalse(w.workbench.diff(identifier)['access']['canApply'])
                # Emulate the pre-projectId format without changing user data.
                file = root / 'state/candidates' / identifier / 'candidate.json'
                metadata = json.loads(file.read_text())
                del metadata['projectId']
                file.write_text(json.dumps(metadata))
                legacy_bytes = file.read_bytes()
                self.assertEqual(w.workbench.diff(identifier)['id'], identifier)
                self.assertTrue(w.workbench.archive(identifier))
                action(w, 'undo')
                self.assertEqual(w.revision_id, revision)
                self.assertEqual(w.workbench.list(), [])
                self.assertFalse(w.workbench.diff(identifier)['access']['canApply'])
                with self.assertRaisesRegex(ValueError, '缺少工程归属'):
                    action(w, 'apply', candidateId=identifier)
                w.application.open_path(b)
                self.assertEqual(w.workbench.list(), [])
                with self.assertRaisesRegex(ValueError, '缺少工程归属'):
                    w.workbench.diff(identifier)
                self.assertEqual(file.read_bytes(), legacy_bytes)
                self.assertEqual(b.read_bytes(), original)
            finally:
                w.close()


if __name__ == '__main__':
    unittest.main()
