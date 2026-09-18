"""Exercise the circuit plugin through the real Studio Workbench/native runtime.

This is intentionally model-free: it validates the model-facing contract
without spending a Codex turn.
"""
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps/desktop/circuit-lens"))

from studio.application.workspace import Workspace
from studio.transport.http import Handler, LensHTTPServer


class CircuitPluginContract(unittest.TestCase):
    def test_manifest_binding_and_native_evaluation(self):
        source_bytes = (REPO / "archive/tooling/tmp/half_adder.circ").read_bytes()
        with tempfile.TemporaryDirectory(prefix="vibe-circuit-plugin-") as temporary:
            root = Path(temporary)
            source = root / "half_adder.circ"
            source.write_bytes(source_bytes)
            workspace = Workspace(
                REPO,
                root / "state",
                REPO / "apps/desktop/circuit-lens/lensctl.py",
                "circuit-plugin-contract",
            )
            try:
                workspace.open_path(source)
                manifest = workspace.workbench.plugin_manifest()
                self.assertEqual(manifest["schema"], "vibe-logisim.circuit-plugin/v1")
                self.assertEqual(manifest["id"], "vibe-logisim.circuit")
                self.assertTrue(manifest["availability"]["workspaceOpen"])
                self.assertIn("harness_run", {item["name"] for item in manifest["capabilities"]})
                self.assertIn("harness_run", manifest["registeredToolNames"])
                self.assertEqual(set(manifest["hostTools"]), {"open_circuit", "submit_circuit", "checkout_candidate"})

                revision = workspace.revision_id
                result = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": revision,
                    "threadId": "thread-contract",
                    "turnId": "turn-contract",
                    "callId": "call-contract",
                    "tool": "harness_run",
                    "arguments": {
                        "mode": "simulate",
                        "circuit": "main",
                        "candidateId": "",
                        "vectors": [
                            {"inputs": {"a": 0, "b": 0}, "expected": {"sum": 0, "carry": 0}},
                            {"inputs": {"a": 0, "b": 1}, "expected": {"sum": 1, "carry": 0}},
                            {"inputs": {"a": 1, "b": 0}, "expected": {"sum": 1, "carry": 0}},
                            {"inputs": {"a": 1, "b": 1}, "expected": {"sum": 0, "carry": 1}},
                        ],
                        "watches": [],
                    },
                })
                self.assertEqual(result["schema"], "vibe-logisim.circuit-plugin.result/v1")
                self.assertEqual(result["plugin"]["id"], "vibe-logisim.circuit")
                self.assertEqual(result["binding"]["revisionId"], revision)
                self.assertEqual(result["binding"]["artifactSha256"], hashlib.sha256(workspace.frozen_path.read_bytes()).hexdigest())
                self.assertRegex(result["run"]["id"], r"^run-[0-9a-f]{16}$")
                self.assertEqual(result["feedback"]["status"], "passed")
                self.assertEqual(result["feedback"]["checkedCount"], 4)
                self.assertEqual(result["result"]["passed"], 4)
                self.assertEqual(result["invocation"]["callId"], "call-contract")
                self.assertEqual(result["invocation"]["turnId"], "turn-contract")

                with self.assertRaisesRegex(ValueError, "工程版本已变化"):
                    workspace.workbench.call("0" * 64, "harness_run", {})

                with self.assertRaisesRegex(ValueError, "缺少必填参数"):
                    workspace.workbench.call(revision, "read_project_resource", {})

                evaluation = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": revision,
                    "tool": "evaluate_circuit",
                    "arguments": {
                        "mode": "simulate",
                        "circuit": "main",
                        "vectors": [{"inputs": {"a": 1, "b": 1}, "expected": {"sum": 0, "carry": 1}}],
                    },
                })
                self.assertEqual(evaluation["evaluation"]["status"], "passed")
                self.assertEqual(evaluation["feedback"]["status"], "passed")

                failed_evaluation = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": revision,
                    "tool": "evaluate_circuit",
                    "arguments": {
                        "mode": "simulate",
                        "circuit": "main",
                        "vectors": [{"inputs": {"a": 1, "b": 1}, "expected": {"sum": 1, "carry": 1}}],
                    },
                })
                self.assertEqual(failed_evaluation["evaluation"]["status"], "failed")
                self.assertEqual(failed_evaluation["evaluation"]["failedCount"], 1)

                with self.assertRaisesRegex(ValueError, "trace 模式"):
                    workspace.application.agent_tool({
                        "projectId": workspace.history.record["id"],
                        "revisionId": revision,
                        "tool": "harness_run",
                        "arguments": {
                            "mode": "simulate",
                            "circuit": "main",
                            "vectors": [{"inputs": {"a": 0, "b": 0}}],
                            "inputEvents": [{"tick": 1, "name": "a", "value": 1}],
                        },
                    })
            finally:
                workspace.close()

    def test_http_plugin_discovery_and_tool_call(self):
        source_bytes = (REPO / "archive/tooling/tmp/half_adder.circ").read_bytes()
        with tempfile.TemporaryDirectory(prefix="vibe-circuit-plugin-http-") as temporary:
            root = Path(temporary)
            source = root / "half_adder.circ"
            source.write_bytes(source_bytes)
            workspace = Workspace(
                REPO,
                root / "state",
                REPO / "apps/desktop/circuit-lens/lensctl.py",
                "circuit-plugin-http",
            )
            server = None
            try:
                workspace.open_path(source)
                server = LensHTTPServer(("127.0.0.1", 0), Handler, workspace, REPO / "apps/desktop/circuit-lens/web")
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{server.server_port}"

                with urlopen(f"{base}/api/agent/plugin") as response:
                    manifest = json.loads(response.read())
                self.assertEqual(manifest["id"], "vibe-logisim.circuit")
                self.assertEqual(manifest["schema"], "vibe-logisim.circuit-plugin/v1")

                body = {
                    "projectId": workspace.history.record["id"],
                    "revisionId": workspace.revision_id,
                    "tool": "harness_run",
                    "arguments": {
                        "mode": "simulate",
                        "circuit": "main",
                        "vectors": [{"inputs": {"a": 1, "b": 1}, "expected": {"sum": 0, "carry": 1}}],
                        "watches": [],
                    },
                }
                request = Request(
                    f"{base}/api/agent/tool",
                    data=json.dumps(body).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request) as response:
                    result = json.loads(response.read())
                self.assertEqual(result["schema"], "vibe-logisim.circuit-plugin.result/v1")
                self.assertEqual(result["feedback"]["status"], "passed")
                self.assertEqual(result["run"]["kind"], "simulate")
            finally:
                if server is not None:
                    server.shutdown()
                    server.server_close()
                workspace.close()


if __name__ == "__main__":
    unittest.main()
