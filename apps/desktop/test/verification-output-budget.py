"""Real subprocess checks for useful logs, complete JSON and hard deadlines."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps/desktop/circuit-lens"))
from studio.application.workspace import Workspace
from studio.runtime.verification_process import execute_verifier, JSON_RESULT_BYTES, PREVIEW_BYTES

SOURCE = b'''<?xml version="1.0" encoding="UTF-8"?>
<project source="2.16.2.2" version="1.0"><lib desc="#Wiring" name="0"/>
<main name="main"/><circuit name="main"><comp lib="0" loc="(100,100)" name="Pin">
<a name="label" val="A"/></comp></circuit></project>'''


class VerificationOutputBudget(unittest.TestCase):
    @contextmanager
    def opened(self):
        with tempfile.TemporaryDirectory(prefix="vibe-verifier-output-") as directory:
            root = Path(directory)
            source = root / "source.circ"
            source.write_bytes(SOURCE)
            workspace = Workspace(REPO, root / "state", REPO / "apps/desktop/circuit-lens/lensctl.py", "output-check")
            try:
                workspace.open_path(source)
                yield workspace, root
                self.assertEqual(source.read_bytes(), SOURCE)
            finally:
                workspace.close()

    @staticmethod
    def run_script(workspace, root, script, result="exit-code"):
        (root / "vibe-verification.json").write_text(json.dumps({
            "schema": "vibe-logisim.verification/v1", "verifications": [{
                "id": "check", "command": [sys.executable, "-c", script],
                "cwd": ".", "timeoutSeconds": 4, "result": result,
            }],
        }))
        return workspace.application.agent_tool({
            "projectId": workspace.history.record["id"], "revisionId": workspace.revision_id,
            "tool": "run_verification", "arguments": {"id": "check", "circuit": "main"},
        })["result"]

    def test_verbose_scripts_finish_and_retain_the_final_result(self):
        with self.opened() as (workspace, root):
            for code, verdict in ((0, "passed"), (2, "failed")):
                result = self.run_script(workspace, root, f'''
import os, sys
os.write(1, b'BEGIN\\n')
for _ in range(128):
    os.write(1, b'x' * 65536)
    os.write(2, b'e' * 65536)
os.write(1, b'\\nFINAL RESULT\\n')
sys.exit({code})
''')
                self.assertEqual((result["execution"], result["verdict"], result["exitCode"]), ("completed", verdict, code))
                self.assertFalse(result["timedOut"] or result["outputLimited"])
                self.assertTrue(result["stdout"].startswith("BEGIN\n"))
                self.assertTrue(result["stdout"].endswith("\nFINAL RESULT\n"))
                for stream in ("stdout", "stderr"):
                    self.assertTrue(result[stream + "Truncated"])
                    self.assertGreaterEqual(result[stream + "Bytes"], 8 * 1024 * 1024)
                    self.assertLess(len(result[stream]), PREVIEW_BYTES + 100)

    def test_json_parsing_is_independent_of_log_preview(self):
        with self.opened() as (workspace, root):
            result = self.run_script(workspace, root,
                "import json; print(json.dumps({'status':'passed','detail':'x'*40000}))", "json-status")
            self.assertEqual(result["verdict"], "passed")
            self.assertEqual(len(result["parsed"]["detail"]), 40000)
            self.assertTrue(result["stdoutTruncated"])
            self.assertFalse(result["outputLimited"])
            result = self.run_script(workspace, root,
                f"import os,time; os.write(1,b'x'*{JSON_RESULT_BYTES + 65536}); time.sleep(30)", "json-status")
            self.assertEqual((result["execution"], result["verdict"]), ("output-limited", "unknown"))
            self.assertFalse(result["timedOut"])
            self.assertIsNone(result["parsed"])
            for script in ("print('{bad')", "print('{\"status\":[]}')", "import os; os.write(1,b'\\xff')"):
                result = self.run_script(workspace, root, script, "json-status")
                self.assertEqual((result["exitCode"], result["verdict"]), (0, "unknown"))
                self.assertTrue(result["error"])

    def test_exited_parent_cannot_leave_a_descendant_holding_pipes(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "child.pid"
            child = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)"
            script = f"import subprocess,pathlib; p=subprocess.Popen([{sys.executable!r},'-c',{child!r}]); pathlib.Path({str(pid_file)!r}).write_text(str(p.pid)); print('parent done')"
            started = time.monotonic()
            try:
                result = execute_verifier([sys.executable, "-c", script], cwd=directory,
                                          environment=os.environ.copy(), timeout=.3)
                self.assertLess(time.monotonic() - started, 2)
                self.assertTrue(result.timed_out)
                self.assertFalse(result.output_limited)
                self.assertIn("parent done", result.stdout)
                pid = int(pid_file.read_text())
                # Orphans can briefly be zombies awaiting their host's reaper.
                for _ in range(100):
                    stat = Path(f"/proc/{pid}/stat")
                    if not stat.exists() or stat.read_text().split()[2] == "Z":
                        break
                    time.sleep(.01)
                else:
                    self.fail("verifier descendant survived the deadline")
            finally:
                if pid_file.exists():
                    try:
                        os.kill(int(pid_file.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main()
