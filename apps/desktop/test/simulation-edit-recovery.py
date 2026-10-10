"""Edits invalidate a real run without masquerading as a runtime failure."""
import sys
import runpy
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
def fixture():
    return '<project source="2.7.1" version="1.0"><lib name="0" desc="#Wiring"/><main name="Root"/><circuit name="Root"><comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="A"/><a name="tristate" val="false"/></comp><comp lib="0" name="Pin" loc="(300,150)"><a name="label" val="Q"/><a name="facing" val="west"/><a name="output" val="true"/></comp></circuit></project>'

class EditRecovery(unittest.TestCase):
    def test_wiring_a_hierarchy_preserves_subcircuit_identity(self):
        hierarchy = runpy.run_path(str(REPO / 'apps/desktop/test/simulation-instances.py'))['fixture']
        with tempfile.TemporaryDirectory(prefix='vibe-hierarchy-wire-') as directory:
            root = Path(directory)
            source = root / 'example.circ'
            source.write_text(hierarchy())
            original = source.read_bytes()
            w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'hierarchy-wire')
            try:
                w.application.open_path(source)
                before = w.workbench.inspect({'circuit':'Root'})['components']
                w.application.project_action('wire', dict(projectId=w.history.record['id'], revisionId=w.revision_id,
                    circuit='Root', points=[{'x':100,'y':210},{'x':100,'y':400},{'x':500,'y':400},{'x':500,'y':210}]))
                after = w.workbench.inspect({'circuit':'Root'})['components']
                identity = lambda components: [(c['componentId'],c['factory'],c.get('subcircuit'),c['attributes']) for c in components]
                self.assertEqual(identity(before), identity(after))
                self.assertEqual(source.read_bytes(), original)
            finally:
                w.close()

    def test_edit_restart_and_runtime_failure_remain_distinct(self):
        with tempfile.TemporaryDirectory(prefix='vibe-edit-recovery-') as directory:
            root = Path(directory)
            source = root / 'example.circ'
            source.write_text(fixture())
            original = source.read_bytes()
            w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'edit-recovery')
            try:
                w.application.open_path(source)
                def body(**values):
                    return dict(projectId=w.history.record['id'], revisionId=w.revision_id, circuit='Root', **values)
                first = w.application.simulation_action(body(action='start'))
                original_revision = w.revision_id
                w.application.project_action('wire', body(points=[{'x':100,'y':100},{'x':300,'y':100},{'x':300,'y':150}]))
                changed = w.simulation.status()
                self.assertIsNone(changed['session'])
                self.assertEqual(changed['reasonCode'], 'revision-changed')
                self.assertNotEqual(w.revision_id, original_revision)
                restarted = w.application.simulation_action(body(action='start'))
                self.assertNotEqual(restarted['session']['id'], first['session']['id'])
                self.assertIsNone(restarted['reasonCode'])
                self.assertEqual(restarted['observation']['ticks'], 0)
                self.assertEqual(source.read_bytes(), original)
                # An unexpected native exit must still be exposed as an error.
                w.simulation.process.terminate()
                w.simulation.process.wait(timeout=5)
                failed = w.simulation.status()
                self.assertIsNone(failed['session'])
                self.assertIsNone(failed['reasonCode'])
                self.assertIn('退出', failed['reason'])
                w.application.project_action('undo', body())
                self.assertEqual(w.revision_id, original_revision)
                self.assertEqual(source.read_bytes(), original)
            finally:
                w.close()

if __name__ == '__main__':
    unittest.main()
