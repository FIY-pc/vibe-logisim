"""Native worker failures become structured only at the circuit-tool boundary."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'circuit-lens'))

from studio.domain.tool_errors import NativeRuntimeFailure, tool_error_from_exception


class NativeWorkerErrors(unittest.TestCase):
    def test_runtime_failure_keeps_native_exception_type_below_boundary(self):
        error = NativeRuntimeFailure(
            'NATIVE_RUNTIME_TIMEOUT', '原生编辑服务响应超时',
            context={'service': 'native-worker', 'phase': 'request', 'workerStopped': True},
        )
        self.assertIsInstance(error, RuntimeError)
        mapped = tool_error_from_exception('inspect_circuit', error)
        self.assertEqual(mapped.code, 'NATIVE_RUNTIME_TIMEOUT')
        self.assertEqual(mapped.as_dict()['context']['service'], 'native-worker')


if __name__ == '__main__':
    unittest.main()
