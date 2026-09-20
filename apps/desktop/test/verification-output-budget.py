"""Focused regression tests for bounded external-verifier output collection."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps/desktop/circuit-lens"))

from studio.application.workspace import Workspace
from studio.runtime import verification as verification_runtime
from studio.runtime.verification import VerificationService


SOURCE_FIXTURE = REPO / "archive/tooling/tmp/half_adder.circ"
LENSCTL = REPO / "apps/desktop/circuit-lens/lensctl.py"
TRUNCATION_MARKER = "\n…(输出已截断)"


class VerificationOutputBudget(unittest.TestCase):
    @staticmethod
    def execute(service, script, *, timeout=4):
        return service._execute(
            [sys.executable, "-c", script],
            cwd=REPO,
            environment=os.environ.copy(),
            timeout=timeout,
        )

    def test_runaway_stdout_is_stopped_before_unbounded_collection(self):
        script = (
            "import sys, time; "
            "sys.stdout.write('x' * 1000000); sys.stdout.flush(); time.sleep(30)"
        )
        service = VerificationService(None)
        started = time.monotonic()
        with patch.object(verification_runtime, "MAX_OUTPUT", 1024):
            exit_code, stopped, output_limited, stdout, stderr = self.execute(service, script)
        duration = time.monotonic() - started

        self.assertIsNone(exit_code)
        self.assertTrue(stopped)
        self.assertTrue(output_limited)
        self.assertLess(duration, 2)
        self.assertLessEqual(len(stdout), 1024 + len(TRUNCATION_MARKER))
        self.assertTrue(stdout.endswith(TRUNCATION_MARKER))
        self.assertEqual(stderr, "")

    @contextmanager
    def opened(self, recipe):
        with tempfile.TemporaryDirectory(prefix="vibe-verification-output-budget-") as directory:
            root = Path(directory)
            source = root / "half_adder.circ"
            source.write_bytes(SOURCE_FIXTURE.read_bytes())
            (root / "vibe-verification.json").write_text(
                json.dumps({
                    "schema": "vibe-logisim.verification/v1",
                    "verifications": [recipe],
                }, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            workspace = Workspace(REPO, root / "state", LENSCTL, "verification-output-budget")
            try:
                workspace.open_path(source)
                yield workspace
            finally:
                workspace.close()

    def test_budget_stop_keeps_incomplete_execution_and_unknown_verdict(self):
        recipe = {
            "id": "output-bomb",
            "label": "output bomb",
            "command": [
                sys.executable,
                "-c",
                "import sys, time; sys.stdout.write('x' * 1000000); sys.stdout.flush(); time.sleep(30)",
            ],
            "cwd": ".",
            "timeoutSeconds": 10,
            "result": "exit-code",
        }
        with self.opened(recipe) as workspace:
            with patch.object(verification_runtime, "MAX_OUTPUT", 1024):
                result = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": workspace.revision_id,
                    "tool": "run_verification",
                    "arguments": {"id": "output-bomb", "circuit": "main"},
                })

        observation = result["result"]
        feedback = result["feedback"]
        self.assertEqual(observation["execution"], "timed-out")
        self.assertEqual(observation["verdict"], "unknown")
        self.assertTrue(observation["timedOut"])
        self.assertTrue(observation["outputLimited"])
        self.assertIn("输出超过运行时预算", observation["error"])
        self.assertEqual(feedback["execution"], "timed-out")
        self.assertEqual(feedback["verdict"], "unknown")
        self.assertTrue(feedback["outputLimited"])


if __name__ == "__main__":
    unittest.main()
