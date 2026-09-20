"""Contract tests for external verification execution and verdict states.

These tests use a real temporary Workspace and invoke the same model-facing
tool path as the desktop harness.  ``execution`` describes what happened to
the verifier process and its inputs; ``verdict`` describes the verifier's
domain result.  A verifier cannot turn an incomplete or identity-invalid run
into a passed verdict.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps/desktop/circuit-lens"))

from studio.application.workspace import Workspace


SOURCE_FIXTURE = REPO / "archive/tooling/tmp/half_adder.circ"
LENSCTL = REPO / "apps/desktop/circuit-lens/lensctl.py"


class VerificationExecutionContract(unittest.TestCase):
    @contextmanager
    def opened(self, recipe: dict):
        with tempfile.TemporaryDirectory(prefix="vibe-verification-execution-") as directory:
            root = Path(directory)
            source = root / "half_adder.circ"
            source.write_bytes(SOURCE_FIXTURE.read_bytes())
            manifest_path = root / "vibe-verification.json"
            manifest_path.write_text(
                json.dumps({
                    "schema": "vibe-logisim.verification/v1",
                    "verifications": [recipe],
                }, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            workspace = Workspace(REPO, root / "state", LENSCTL, "verification-execution-contract")
            try:
                workspace.open_path(source)
                yield workspace, root, manifest_path
            finally:
                workspace.close()

    @staticmethod
    def run_verification(workspace: Workspace, identifier: str):
        return workspace.application.agent_tool({
            "projectId": workspace.history.record["id"],
            "revisionId": workspace.revision_id,
            "tool": "run_verification",
            "arguments": {"id": identifier, "circuit": "main"},
        })

    def assert_state(self, result, *, execution: str, verdict: str):
        observation = result["result"]
        feedback = result["feedback"]
        self.assertEqual(observation["execution"], execution)
        self.assertEqual(observation["verdict"], verdict)
        self.assertEqual(feedback["execution"], execution)
        self.assertEqual(feedback["verdict"], verdict)

    def test_json_status_passed_is_completed_with_passed_verdict(self):
        recipe = {
            "id": "passed",
            "label": "passed",
            "command": [
                sys.executable,
                "-c",
                "import json; print(json.dumps({'status': 'passed'}))",
            ],
            "cwd": ".",
            "timeoutSeconds": 10,
            "result": "json-status",
        }
        with self.opened(recipe) as (workspace, _root, _manifest):
            result = self.run_verification(workspace, "passed")
        self.assert_state(result, execution="completed", verdict="passed")

    def test_timeout_is_timed_out_with_unknown_verdict(self):
        recipe = {
            "id": "timeout",
            "label": "timeout",
            "command": [sys.executable, "-c", "import time; time.sleep(10)"],
            "cwd": ".",
            "timeoutSeconds": 1,
            "result": "json-status",
        }
        with self.opened(recipe) as (workspace, _root, _manifest):
            result = self.run_verification(workspace, "timeout")
        self.assert_state(result, execution="timed-out", verdict="unknown")

    def test_nonzero_json_status_is_completed_with_unknown_verdict(self):
        recipe = {
            "id": "nonzero-json",
            "label": "nonzero json",
            "command": [
                sys.executable,
                "-c",
                "import json, sys; print(json.dumps({'status': 'passed'})); sys.exit(7)",
            ],
            "cwd": ".",
            "timeoutSeconds": 10,
            "result": "json-status",
        }
        with self.opened(recipe) as (workspace, _root, _manifest):
            result = self.run_verification(workspace, "nonzero-json")
        self.assert_state(result, execution="completed", verdict="unknown")

    def test_materialized_input_identity_change_is_identity_changed_with_unknown_verdict(self):
        script = """
import pathlib
import sys

artifact = pathlib.Path(sys.argv[1])
artifact.chmod(0o644)
artifact.write_bytes(artifact.read_bytes() + b"\\nchanged by verifier\\n")
print('{"status": "passed"}')
"""
        recipe = {
            "id": "mutates-input",
            "label": "mutates input",
            "command": [sys.executable, "-c", script, "${artifact}"],
            "cwd": ".",
            "timeoutSeconds": 10,
            "result": "json-status",
        }
        with self.opened(recipe) as (workspace, _root, _manifest):
            result = self.run_verification(workspace, "mutates-input")
        self.assert_state(result, execution="identity-changed", verdict="unknown")

    def test_manifest_identity_change_is_identity_changed_with_unknown_verdict(self):
        script = """
import pathlib
import sys

manifest = pathlib.Path(sys.argv[1])
manifest.write_text(manifest.read_text(encoding='utf-8') + '\\n', encoding='utf-8')
print('{"status": "passed"}')
"""
        recipe = {
            "id": "mutates-manifest",
            "label": "mutates manifest",
            "command": [sys.executable, "-c", script, "${workspace}/vibe-verification.json"],
            "cwd": ".",
            "timeoutSeconds": 10,
            "result": "json-status",
        }
        with self.opened(recipe) as (workspace, _root, _manifest):
            result = self.run_verification(workspace, "mutates-manifest")
        self.assert_state(result, execution="identity-changed", verdict="unknown")


if __name__ == "__main__":
    unittest.main()
