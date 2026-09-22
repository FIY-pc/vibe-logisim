"""Native worker failures become structured only at the circuit-tool boundary."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'circuit-lens'))

from studio.domain.tool_errors import NativeRuntimeFailure, tool_error_from_exception
from studio.runtime.native import NativeOperations
import xml.etree.ElementTree as ET


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

    def test_direct_native_command_timeout_has_execution_identity(self):
        error = NativeOperations._runtime_failure(
            'NATIVE_RUNTIME_TIMEOUT', '原生 CircuitWorkbench 响应超时',
            ET.Element('component-templates', circuit='main'),
            'a' * 64, 'b' * 64, 'request',
        )
        self.assertEqual(error.code, 'NATIVE_RUNTIME_TIMEOUT')
        self.assertEqual(error.as_dict()['context']['artifactSha256'], 'a' * 64)
        self.assertEqual(error.as_dict()['context']['runtimeJarSha256'], 'b' * 64)


if __name__ == '__main__':
    unittest.main()
