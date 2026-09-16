"""Commit failures and actual process exit around the authoritative record write."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace
from studio.project import store as storage


class CommitRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='vibe-commit-recovery-')
        self.root = Path(self.temp.name)
        self.source = self.root / 'design.circ'
        self.original = (REPO / 'archive/tooling/tmp/half_adder.circ').read_bytes()
        self.source.write_bytes(self.original)
        self.w = self.open_workspace()
        self.before = self.w.revision_id
        self.record = copy.deepcopy(self.w.history.record)
        self.pointer = (self.root / 'state/current.json').read_bytes()
        changed = self.original.replace(b'val="sum"', b'val="result"')
        self.target = self.w.project_store.freeze(changed, 'path', self.source.name, self.source).revision_id

    def open_workspace(self):
        w = Workspace(REPO, self.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'test')
        w.application.open_path(self.source)
        return w

    def tearDown(self):
        self.w.close()
        self.temp.cleanup()

    def test_record_write_failure_preserves_active_project(self):
        state = self.w.project_store.state
        circuit = state.document.circuit(state.raw_project['mainCircuit'])
        circuit.set('test-local-edit', 'prepared')
        prepared = self.w.project_store.freeze_circuit(circuit)
        self.assertIs(self.w.project_store.state, state)
        self.assertIsNone(state.document.circuit(circuit.get('name')).get('test-local-edit'))
        original_write = storage.atomic_write_json
        def fail_record(path, value):
            if path.parent.name == 'projects':
                raise OSError('injected record failure')
            return original_write(path, value)
        with patch.object(storage, 'atomic_write_json', side_effect=fail_record):
            with self.assertRaisesRegex(OSError, 'record failure'):
                self.w.history.advance('edit', 'Local edit', prepared.revision_id, prepared=prepared)
        self.assertIs(self.w.project_store.state, state)
        self.assertEqual(self.w.history.record, self.record)
        self.assertEqual((self.root / 'state/current.json').read_bytes(), self.pointer)
        self.w.close()
        self.w = self.open_workspace()
        self.assertEqual(self.w.revision_id, self.before)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_pointer_failure_keeps_committed_result_and_recovers(self):
        with patch.object(self.w.project_store, 'write_current_pointer', side_effect=OSError('injected pointer failure')):
            result = self.w.history.advance('edit', 'Rename', self.target)
            self.assertEqual(result['revision']['id'], self.target)
            self.assertFalse(result['connectionIndex']['available'])
            self.assertEqual(self.w.history.record['currentRevisionId'], self.target)
            self.assertEqual((self.root / 'state/current.json').read_bytes(), self.pointer)
        result = self.w.session()
        self.assertTrue(result['connectionIndex']['available'])
        self.assertEqual(json.loads((self.root / 'state/current.json').read_text())['revisionId'], self.target)
        self.w.close()
        self.w = self.open_workspace()
        self.assertEqual(self.w.revision_id, self.target)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_source_saved_but_record_failure_is_explicit_and_recoverable(self):
        self.w.history.advance('edit', 'Rename', self.target)
        record = copy.deepcopy(self.w.history.record)
        with patch.object(storage, 'atomic_write_json', side_effect=OSError('injected record failure')):
            with self.assertRaisesRegex(ValueError, '电路文件已写入'):
                self.w.history.save(record['id'], self.target)
        self.assertEqual(self.w.history.record, record)
        self.assertNotEqual(self.source.read_bytes(), self.original)
        self.assertTrue(self.w.history.summary()['dirty'])
        self.w.close()
        self.w = self.open_workspace()
        self.assertTrue(self.w.history.disk_status()['changed'])
        self.w.history.reload()
        self.assertFalse(self.w.history.summary()['dirty'])
        self.assertFalse(self.w.history.disk_status()['changed'])
        self.assertEqual(self.w.revision_id, self.target)

    def test_process_exit_after_record_commit_restores_committed_revision(self):
        self.w.close()
        child = '''
import os, sys
from pathlib import Path
from unittest.mock import patch
from studio.application.workspace import Workspace
from studio.project import store
repo, root, target = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
w = Workspace(repo, root / 'state', repo / 'apps/desktop/circuit-lens/lensctl.py', 'crash-test')
w.application.open_path(root / 'design.circ')
original = store.atomic_write_json
def exit_after_record(path, value):
    original(path, value)
    if path.parent.name == 'projects':
        os._exit(73)
with patch.object(store, 'atomic_write_json', side_effect=exit_after_record):
    w.history.advance('edit', 'Rename', target)
'''
        result = subprocess.run([sys.executable, '-c', 'import sys; sys.path.insert(0, ' + repr(str(REPO / 'apps/desktop/circuit-lens')) + ')\n' + child, str(REPO), str(self.root), self.target], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertEqual(json.loads((self.root / 'state/current.json').read_text())['revisionId'], self.before)
        self.w = self.open_workspace()
        self.assertEqual(self.w.revision_id, self.target)
        self.assertEqual(self.w.history.record['history'][-1]['title'], 'Rename')
        self.assertEqual(json.loads((self.root / 'state/current.json').read_text())['revisionId'], self.target)
        self.assertEqual(self.source.read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()
