"""Real subprocess exit diagnostics, bounded stderr and a fresh native recovery.

The crashing Java process is an explicit fault fixture, not a model episode.
The recovery loads a real circuit through the production Logisim worker.
"""
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
sys.path.insert(0, str(REPO / 'apps/desktop/test'))
from support.samples import runtime_versions
from studio.runtime.worker import NativeWorker
from studio.application.workspace import Workspace
from studio.infrastructure.files import sha256_file


class NativeFailureDiagnostics(unittest.TestCase):
    def test_short_stderr_is_available_before_a_hung_process_exits(self):
        with tempfile.TemporaryDirectory(prefix='vibe-native-stderr-') as directory:
            root = Path(directory)
            source = root / 'CircuitWorker.java'
            source.write_text('''package com.cburch.logisim.file;
public class CircuitWorker {
    public static void main(String[] args) throws Exception {
        System.out.println("ok\\tcmVhZHk=");
        System.err.println("SHORT_DIAGNOSTIC: 等待🙂");
        System.err.flush();
        Thread.sleep(60000);
    }
}''')
            subprocess.run(['javac', '-encoding', 'UTF-8', '-d', str(root), str(source)],
                           check=True, capture_output=True, timeout=30)
            runtime = REPO / 'apps/desktop/circuit-lens/native/Logisim-ITA.jar'
            worker = NativeWorker(REPO, root / 'state')
            try:
                with patch.object(worker, '_classes', return_value=root):
                    worker._start(runtime, sha256_file(runtime))
                deadline = time.monotonic() + 2
                while b'SHORT_DIAGNOSTIC' not in worker.stderr_tail and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertIn(b'SHORT_DIAGNOSTIC', worker.stderr_tail)
                self.assertIsNone(worker.process.poll())
                receive = worker.responses.get
                with patch.object(worker.responses, 'get', side_effect=lambda timeout: receive(timeout=0.01)):
                    with self.assertRaisesRegex(RuntimeError, '响应超时.*SHORT_DIAGNOSTIC: 等待🙂'):
                        worker._receive()
                self.assertIsNone(worker.process.poll())
            finally:
                worker.close()

    def test_bad_wire_feedback_reaches_product_actions_without_losing_source(self):
        with tempfile.TemporaryDirectory(prefix='vibe-native-boundary-') as directory:
            root = Path(directory)
            workspace = Workspace(REPO, root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'native-boundary')
            try:
                for version in runtime_versions(REPO):
                    with self.subTest(runtime=version):
                        good = root / (version + '.circ')
                        good.write_text(f'''<project source="{version}" version="1.0"><lib name="0" desc="#Wiring"/>
<main name="main"/><circuit name="main">
<comp name="Pin" lib="0" loc="(80,80)"><a name="label" val="In"/></comp>
<comp name="Pin" lib="0" loc="(180,80)"><a name="label" val="Out"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
<wire from="(80,80)" to="(180,80)"/></circuit></project>''')
                        bad = root / (version + '-bad.circ')
                        bad.write_text(good.read_text().replace('</circuit>', '<wire from="(240,140)" to="(280,160)"/></circuit>'))
                        original = bad.read_bytes()
                        workspace.open_path(good)
                        workspace.circuit_view('main')
                        starts = workspace.observer.worker.starts
                        args = {'circuit': 'main', 'vectors': [{'inputs': {'In': 1}, 'expected': {'Out': 1}}]}
                        self.assertEqual(workspace.workbench.simulate(args)['passed'], 1)
                        workspace.open_path(bad)
                        revision = workspace.revision_id
                        view = workspace.circuit_view('main')
                        detail = view['observerError']['message']
                        self.assertIn('main', detail)
                        self.assertIn('wire #2', detail)
                        self.assertIn('(240,140)', detail)
                        self.assertFalse(view['capabilities']['exactConnectivity'])
                        for action in [
                            lambda: workspace.circuits_service.render_for_agent({'circuit': 'main'}),
                            lambda: workspace.workbench.simulate(args),
                            lambda: workspace.simulation.start('main'),
                        ]:
                            with self.assertRaisesRegex(ValueError, 'wire #2'):
                                action()
                        self.assertEqual(workspace.revision_id, revision)
                        self.assertEqual(bad.read_bytes(), original)
                        # The standalone observer must use the same boundary too.
                        observer = workspace.observer
                        with self.assertRaisesRegex(RuntimeError, 'wire #2'):
                            observer._run_json([str(observer.full_runner), '--full', str(workspace.frozen_path), 'main'],
                                               observer._environment(observer.prepare()))
                        workspace.open_path(good)
                        self.assertEqual(workspace.workbench.simulate(args)['passed'], 1)
                        self.assertFalse(workspace.circuit_view('main').get('observerError'))
                        self.assertEqual(workspace.observer.worker.starts, starts)
                        workspace.simulation.start('main')
                        workspace.simulation.close()
                        self.assertEqual(bad.read_bytes(), original)
            finally:
                workspace.close()

    def test_fatal_exit_keeps_bounded_diagnostics_and_recovers(self):
        with tempfile.TemporaryDirectory(prefix='vibe-native-failure-') as directory:
            root = Path(directory)
            source = root / 'CircuitWorker.java'
            source.write_text('''package com.cburch.logisim.file;
import java.io.*;
public class CircuitWorker {
    public static void main(String[] args) throws Exception {
        System.out.println("ok\\tcmVhZHk=");
        new BufferedReader(new InputStreamReader(System.in)).readLine();
        System.err.print("discarded-head\\n");
        for (int i=0; i<200000; i++) System.err.print('x');
        System.err.println("\\nFAULT_FIXTURE: native process failed");
        System.exit(17);
    }
}''')
            subprocess.run(['javac', '-d', str(root), str(source)],
                           check=True, capture_output=True, timeout=30)
            artifact = root / 'circuit.circ'
            original = b'<project source="2.16.2.2" version="1.0"><main name="main"/><circuit name="main"/></project>'
            artifact.write_bytes(original)
            runtime = REPO / 'apps/desktop/circuit-lens/native/Logisim-ITA.jar'
            worker = NativeWorker(REPO, root / 'state')
            try:
                with patch.object(worker, '_classes', return_value=root):
                    with self.assertRaises(RuntimeError) as error:
                        worker.request(runtime, artifact, ET.Element('observe', circuit='main'))
                message = str(error.exception)
                self.assertIn('退出码 17', message)
                self.assertIn('FAULT_FIXTURE: native process failed', message)
                self.assertNotIn('discarded-head', message)
                self.assertNotIn('请重试', message)
                self.assertLess(len(message), 8300)
                self.assertIsNone(worker.process)
                response = worker.request(runtime, artifact, ET.Element('observe', circuit='main'))
                self.assertIn(b'"components"', response)
                self.assertEqual(worker.starts, 2)
                self.assertEqual(artifact.read_bytes(), original)
            finally:
                worker.close()


if __name__ == '__main__':
    unittest.main()
