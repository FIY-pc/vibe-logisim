"""Model-facing group movement: native connectivity, composition and rejection."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import skip_unless_samples
from studio.application.workspace import Workspace
from studio.domain.tool_errors import CircuitToolError


class CandidateMovement(unittest.TestCase):
    @skip_unless_samples(REPO, 'experiments/005-harness-effect/fixtures/half-adder.circ')
    def test_move_compose_and_reject_without_touching_source(self):
        original = (REPO / 'experiments/005-harness-effect/fixtures/half-adder.circ').read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'design.circ'
            source.write_bytes(original)
            w = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'move-candidate')
            try:
                w.open_path(source)
                revision = w.revision_id
                def call(tool, **arguments):
                    return w.application.agent_tool({'projectId': w.history.record['id'],
                        'revisionId': w.revision_id, 'tool': tool, 'arguments': {'circuit': 'main', **arguments}})
                before = call('inspect_circuit')
                first = call('move_candidate', artifactSha256=before['artifactSha256'],
                    componentIds=[c['componentId'] for c in before['components']], delta={'x': 40, 'y': 20})
                moved = call('inspect_circuit', candidateId=first['id'])
                self.assertEqual(
                    {(c['factory'], c['location']['x']+40, c['location']['y']+20) for c in before['components']},
                    {(c['factory'], c['location']['x'], c['location']['y']) for c in moved['components']})
                second = call('move_candidate', candidateId=first['id'], artifactSha256=moved['artifactSha256'],
                    componentIds=[c['componentId'] for c in moved['components']], delta={'x': 20, 'y': 20})
                self.assertEqual(second['parentCandidateId'], first['id'])
                self.assertGreater(second['changes'][0]['wiringProof']['checkedPortBits'], 0)
                evaluated = call('evaluate_circuit', candidateId=second['id'], mode='simulate', vectors=[
                    {'inputs': {'a': a, 'b': b}, 'expected': {'sum': a ^ b, 'carry': a & b}}
                    for a in range(2) for b in range(2)])
                self.assertEqual(evaluated['feedback']['status'], 'passed')
                published = {p.name for p in (w.state_root / 'candidates').iterdir()}
                with self.assertRaises(CircuitToolError):
                    call('move_candidate', candidateId=first['id'], artifactSha256=before['artifactSha256'],
                         componentIds=[moved['components'][0]['componentId']], delta={'x': 20, 'y': 20})
                a, b = (next(c for c in moved['components'] if c['label'] == label) for label in ('a', 'b'))
                with self.assertRaisesRegex(CircuitToolError, '重叠'):
                    call('move_candidate', candidateId=first['id'], artifactSha256=moved['artifactSha256'],
                         componentIds=[a['componentId']],
                         delta={k: b['location'][k]-a['location'][k] for k in ('x', 'y')})
                self.assertEqual(published, {p.name for p in (w.state_root / 'candidates').iterdir()})
                self.assertEqual(w.revision_id, revision)
                self.assertEqual(source.read_bytes(), original)
                parent = w.state_root / 'candidates' / first['id'] / 'artifact.circ'
                self.assertEqual(hashlib.sha256(parent.read_bytes()).hexdigest(), first['artifactSha256'])
            finally:
                w.close()


if __name__ == '__main__':
    unittest.main()
