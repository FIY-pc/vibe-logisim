"""Regression contract for workspace-owned external verification.

These tests deliberately exercise the real Workspace -> VerificationService
path with a temporary workspace.  They describe safety boundaries that an
external verifier must provide:

* a verifier cannot mutate the materialized artifact and still report passed;
* a timed-out verifier must not leave descendants running;
* evidence identifies both the manifest bytes and the normalized recipe.

    The identity assertions ensure the evidence cannot silently outlive the
    verification recipe that produced it.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
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


SOURCE_FIXTURE = REPO / "archive/tooling/tmp/half_adder.circ"
LENSCTL = REPO / "apps/desktop/circuit-lens/lensctl.py"
IDENTITY_FIELDS = ("manifestSha256", "recipeSha256")


def recipe_document(recipe: dict) -> dict:
    """Return the stable, semantic identity payload for one recipe.

    Formatting, object key order, and omitted defaults must not change an
    entry's identity.  The fixture spells out all defaults so this payload is
    also easy for a future implementation to reproduce from its normalized
    recipe.
    """

    return {
        "id": recipe["id"],
        "label": recipe["label"],
        "description": recipe["description"],
        "command": recipe["command"],
        "cwd": recipe["cwd"],
        "timeoutSeconds": recipe["timeoutSeconds"],
        "result": recipe["result"],
    }


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_recipe(recipe: dict) -> str:
    canonical = json.dumps(
        recipe_document(recipe),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256_bytes(canonical)


def pid_is_alive(pid: int) -> bool:
    """Observe a Linux process without treating a zombie as still running."""

    proc_stat = Path(f"/proc/{pid}/stat")
    try:
        fields = proc_stat.read_text(encoding="utf-8").split()
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return False
    # /proc/<pid>/stat field 3 is the process state.  A zombie is already
    # terminated for this test's purpose, even if its parent has not waited.
    return len(fields) > 2 and fields[2] != "Z"


class VerificationHardening(unittest.TestCase):
    @contextmanager
    def opened(self, recipes: list[dict]):
        with tempfile.TemporaryDirectory(prefix="vibe-verification-hardening-") as directory:
            root = Path(directory)
            source = root / "half_adder.circ"
            source_bytes = SOURCE_FIXTURE.read_bytes()
            source.write_bytes(source_bytes)
            manifest = {
                "schema": "vibe-logisim.verification/v1",
                "verifications": recipes,
            }
            manifest_path = root / "vibe-verification.json"
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            workspace = Workspace(
                REPO,
                root / "state",
                LENSCTL,
                "verification-hardening",
            )
            try:
                workspace.open_path(source)
                yield workspace, root, source, source_bytes, manifest_path
            finally:
                workspace.close()

    @staticmethod
    def run_verification(workspace: Workspace, identifier: str):
        identity = {
            "projectId": workspace.history.record["id"],
            "revisionId": workspace.revision_id,
        }
        return workspace.application.agent_tool({
            **identity,
            "tool": "run_verification",
            "arguments": {"id": identifier, "circuit": "main"},
        })

    def test_artifact_mutation_cannot_be_reported_as_passed(self):
        script = """
import json
import os
import pathlib
import sys

artifact = pathlib.Path(sys.argv[1])
os.chmod(artifact, 0o644)
artifact.write_bytes(artifact.read_bytes() + b"\nmutated by verifier\n")
print(json.dumps({"status": "passed"}))
"""
        with self.opened([{
            "id": "mutates-artifact",
            "label": "mutates artifact",
            "description": "writes to the disposable artifact before claiming success",
            "command": [sys.executable, "-c", script, "${artifact}"],
            "cwd": ".",
            "timeoutSeconds": 10,
            "result": "json-status",
        }]) as (workspace, _root, source, source_bytes, _manifest):
            result = self.run_verification(workspace, "mutates-artifact")

            # A verifier may decide that its own mutation invalidates the
            # observation (unknown) or that the check failed.  It must never
            # be allowed to present a changed artifact as a successful run.
            self.assertIn(result["feedback"]["status"], {"failed", "unknown"})
            self.assertEqual(source.read_bytes(), source_bytes)

    def test_timeout_returns_unknown_and_reaps_verifier_process_tree(self):
        with tempfile.TemporaryDirectory(prefix="vibe-verification-timeout-aux-") as auxiliary:
            pid_path = Path(auxiliary) / "child.pid"
            script = """
import pathlib
import subprocess
import sys
import time

pid_path = pathlib.Path(sys.argv[2])
child = subprocess.Popen([
    sys.executable,
    "-c",
    "import time; time.sleep(60)",
])
pid_path.write_text(str(child.pid), encoding="ascii")
while True:
    time.sleep(1)
"""
            recipes = [{
                "id": "timeout-tree",
                "label": "timeout tree",
                "description": "leaves a child alive unless the process tree is reaped",
                "command": [sys.executable, "-c", script, "${artifact}", str(pid_path)],
                "cwd": ".",
                "timeoutSeconds": 1,
                "result": "exit-code",
            }]
            child_pid = None
            try:
                with self.opened(recipes) as (workspace, _root, _source, _source_bytes, _manifest):
                    result = self.run_verification(workspace, "timeout-tree")
                    deadline = time.monotonic() + 2.0
                    while not pid_path.exists() and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(pid_path.exists(), "verifier did not record its child PID")
                    child_pid = int(pid_path.read_text(encoding="ascii"))

                    self.assertEqual(result["feedback"]["status"], "unknown")
                    self.assertTrue(result["result"]["timedOut"])

                    deadline = time.monotonic() + 2.0
                    while pid_is_alive(child_pid) and time.monotonic() < deadline:
                        time.sleep(0.05)
                    self.assertFalse(
                        pid_is_alive(child_pid),
                        f"timed-out verifier left child process {child_pid} alive",
                    )
            finally:
                # Keep this regression test hermetic even when the current
                # implementation fails the assertion: old implementations
                # kill only the direct verifier and can orphan this child.
                if child_pid is not None and pid_is_alive(child_pid):
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_result_carries_manifest_and_recipe_identity_hashes(self):
        script = "import json; print(json.dumps({'status': 'passed'}))"
        recipe = {
            "id": "identity",
            "label": "identity",
            "description": "reports a stable identity target",
            "command": [sys.executable, "-c", script, "${artifact}"],
            "cwd": ".",
            "timeoutSeconds": 10,
            "result": "json-status",
        }
        with self.opened([recipe]) as (workspace, _root, _source, _source_bytes, manifest_path):
            result = self.run_verification(workspace, "identity")
            observation = result["result"]
            manifest_sha = sha256_bytes(manifest_path.read_bytes())
            recipe_sha = sha256_recipe(recipe)

            self.assertEqual(observation["manifestSha256"], manifest_sha)
            self.assertEqual(observation["recipeSha256"], recipe_sha)
            for field in IDENTITY_FIELDS:
                self.assertRegex(observation[field], r"^[0-9a-f]{64}$")

    def test_nonzero_json_verifier_cannot_claim_passed(self):
        script = "import json, sys; print(json.dumps({'status': 'passed'})); sys.exit(7)"
        with self.opened([{
            "id": "nonzero-json",
            "label": "nonzero json",
            "description": "writes a passing verdict but exits unsuccessfully",
            "command": [sys.executable, "-c", script, "${artifact}"],
            "cwd": ".",
            "timeoutSeconds": 10,
            "result": "json-status",
        }]) as (workspace, _root, _source, _source_bytes, _manifest):
            result = self.run_verification(workspace, "nonzero-json")
            self.assertEqual(result["feedback"]["status"], "unknown")
            self.assertEqual(result["result"]["exitCode"], 7)
            self.assertIn("非零退出码", result["result"]["error"])


if __name__ == "__main__":
    unittest.main()
