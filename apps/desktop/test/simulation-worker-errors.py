"""Model-facing classification for native simulation worker failures."""
import queue
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'circuit-lens'))

from studio.domain.tool_errors import CircuitToolError
from studio.runtime.simulation_worker import SimulationWorker


class EmptyResponses:
    def get(self, timeout):
        raise queue.Empty


class SimulationWorkerErrors(unittest.TestCase):
    def worker(self):
        worker = SimulationWorker(Path('/tmp/vibe-logisim-test-repo'), Path('/tmp/vibe-logisim-test-state'))
        worker.responses = EmptyResponses()
        worker._stop = Mock()
        return worker

    def test_timeout_is_distinguishable_and_stops_worker(self):
        worker = self.worker()
        with self.assertRaises(CircuitToolError) as caught:
            worker._receive('request', {
                'operation': 'simulate',
                'circuit': 'main',
                'artifactSha256': 'a' * 64,
            })
        error = caught.exception
        self.assertEqual(error.code, 'NATIVE_RUNTIME_TIMEOUT')
        self.assertEqual(error.as_dict()['context'], {
            'service': 'simulation-worker',
            'phase': 'request',
            'timeoutSeconds': 60,
            'workerStopped': True,
            'operation': 'simulate',
            'circuit': 'main',
            'artifactSha256': 'a' * 64,
        })
        worker._stop.assert_called_once_with()

    def test_start_timeout_keeps_start_phase(self):
        worker = self.worker()
        with self.assertRaises(CircuitToolError) as caught:
            worker._receive('startup')
        self.assertEqual(caught.exception.as_dict()['context']['phase'], 'startup')


if __name__ == '__main__':
    unittest.main()
