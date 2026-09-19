"""Exercise the circuit plugin through the real Studio Workbench/native runtime.

This is intentionally model-free: it validates the model-facing contract
without spending a Codex turn.
"""
from pathlib import Path
import hashlib
import base64
import json
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps/desktop/circuit-lens"))

from studio.domain.tool_errors import CircuitToolError
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
                self.assertIn("compare_circuit", {item["name"] for item in manifest["capabilities"]})
                self.assertIn("harness_run", manifest["registeredToolNames"])
                self.assertEqual(set(manifest["hostTools"]), {"open_circuit", "submit_circuit", "checkout_candidate"})

                revision = workspace.revision_id
                inspection = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": revision,
                    "tool": "inspect_circuit",
                    "arguments": {"circuit": "main"},
                })
                self.assertIn("connectivityIssues", inspection)
                self.assertEqual(inspection["connectivityIssues"]["unconnectedInputs"], [])
                self.assertEqual(inspection["connectivityIssues"]["widthIncompatibilities"], [])

                rendered = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": revision,
                    "threadId": "thread-render",
                    "turnId": "turn-render",
                    "callId": "call-render",
                    "tool": "render_circuit",
                    "arguments": {"circuit": "main"},
                })
                self.assertEqual(rendered["feedback"]["status"], "observed")
                self.assertEqual(rendered["run"]["kind"], "render")
                self.assertTrue(rendered["result"]["imageIncluded"])
                image_item = rendered["modelContentItems"][0]
                self.assertEqual(image_item["type"], "inputImage")
                self.assertTrue(base64.b64decode(image_item["imageData"]).startswith(b"\x89PNG\r\n\x1a\n"))

                viewport_render = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": revision,
                    "threadId": "thread-render",
                    "turnId": "turn-render",
                    "callId": "call-render-viewport",
                    "tool": "render_circuit",
                    "arguments": {"circuit": "main", "viewport": {
                        "x": 0, "y": 0, "width": 600, "height": 400, "scale": 1,
                    }},
                })
                self.assertEqual(viewport_render["result"]["kind"], "viewport")
                self.assertEqual(viewport_render["result"]["pixelWidth"], 600)
                self.assertEqual(viewport_render["result"]["pixelHeight"], 400)

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

                with self.assertRaisesRegex(CircuitToolError, "找不到输入引脚") as unknown_input:
                    workspace.application.agent_tool({
                        "projectId": workspace.history.record["id"],
                        "revisionId": revision,
                        "tool": "simulate_circuit",
                        "arguments": {
                            "circuit": "main",
                            "vectors": [{"inputs": {"wrong": 1}}],
                        },
                    })
                self.assertEqual(unknown_input.exception.code, "UNKNOWN_INPUT")
                self.assertEqual(unknown_input.exception.available_inputs, ["a", "b"])
                error_hint = unknown_input.exception.as_dict()
                self.assertEqual(error_hint["availableInputs"], ["a", "b"])
                recovered = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": revision,
                    "tool": "simulate_circuit",
                    "arguments": {
                        "circuit": "main",
                        "vectors": [{
                            "inputs": {name: 1 for name in error_hint["availableInputs"]},
                            "expected": {"sum": 0, "carry": 1},
                        }],
                    },
                })
                self.assertEqual(recovered["rows"][0]["passed"], True)

                with self.assertRaisesRegex(ValueError, "工程版本已变化"):
                    workspace.workbench.call("0" * 64, "harness_run", {})

                with self.assertRaisesRegex(CircuitToolError, "缺少必填参数") as missing:
                    workspace.workbench.call(revision, "read_project_resource", {})
                self.assertEqual(missing.exception.code, "INVALID_ARGUMENT")
                self.assertFalse(missing.exception.retryable)
                self.assertIn("required", missing.exception.hint)

                with self.assertRaisesRegex(CircuitToolError, "参数 arguments.rowCount 不能大于 60") as bounded:
                    workspace.workbench.call(revision, "read_project_resource", {
                        "resourceId": "missing", "rowCount": 61,
                    })
                self.assertEqual(bounded.exception.code, "INVALID_ARGUMENT")
                self.assertEqual(bounded.exception.context["path"], "arguments.rowCount")
                self.assertEqual(bounded.exception.context["maximum"], 60)

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

    def test_historical_trace_comparison_is_native_and_explicit(self):
        source_bytes = (REPO / "archive/tooling/scripts/fixtures/live-interaction.circ").read_bytes()
        with tempfile.TemporaryDirectory(prefix="vibe-circuit-compare-") as temporary:
            root = Path(temporary)
            source = root / "live-interaction.circ"
            source.write_bytes(source_bytes)
            workspace = Workspace(
                REPO,
                root / "state",
                REPO / "apps/desktop/circuit-lens/lensctl.py",
                "circuit-plugin-compare",
            )
            try:
                workspace.open_path(source)
                inspection = workspace.workbench.inspect({"circuit": "交互与传播"})
                clock = next(item["componentId"] for item in inspection["components"] if item["factory"] == "Clock")
                prepared = workspace.project_store.freeze(source_bytes + b"\n", "path", source.name, source)
                workspace.history.advance("edit", "保留行为的快照变化", prepared.revision_id, prepared=prepared)
                result = workspace.application.agent_tool({
                    "projectId": workspace.history.record["id"],
                    "revisionId": workspace.revision_id,
                    "tool": "compare_circuit",
                    "arguments": {
                        "mode": "trace",
                        "circuit": "交互与传播",
                        "ticks": 2,
                        "inputs": {"三态输入": 0, "四位输入": 0},
                        "watches": [{"name": "clock", "component": clock, "port": 0}],
                    },
                })
                self.assertEqual(result["feedback"]["status"], "passed")
                self.assertEqual(result["comparison"]["caseCount"], 3)
                self.assertEqual(result["comparison"]["cases"][1]["status"], "passed")
                self.assertEqual(result["result"]["reference"]["revisionId"], workspace.history.record["history"][0]["revisionId"])
            finally:
                workspace.close()

    def test_workspace_verifier_binds_external_oracle_to_revision(self):
        source_bytes = (REPO / "archive/tooling/tmp/half_adder.circ").read_bytes()
        with tempfile.TemporaryDirectory(prefix="vibe-circuit-verifier-") as temporary:
            root = Path(temporary)
            source = root / "half_adder.circ"
            source.write_bytes(source_bytes)
            (root / "verify.py").write_text(
                "import hashlib, json, sys\n"
                "data = open(sys.argv[1], 'rb').read()\n"
                "print(json.dumps({'status': 'passed', 'sha': hashlib.sha256(data).hexdigest()}))\n",
                encoding="utf-8",
            )
            (root / "vibe-verification.json").write_text(json.dumps({
                "schema": "vibe-logisim.verification/v1",
                "verifications": [{
                    "id": "fixture",
                    "label": "fixture oracle",
                    "command": ["python3", "verify.py", "${artifact}"],
                    "result": "json-status",
                }],
            }), encoding="utf-8")
            workspace = Workspace(
                REPO,
                root / "state",
                REPO / "apps/desktop/circuit-lens/lensctl.py",
                "circuit-plugin-verifier",
            )
            try:
                workspace.open_path(source)
                identity = {"projectId": workspace.history.record["id"], "revisionId": workspace.revision_id}
                listed = workspace.application.agent_tool({**identity, "tool": "list_verifications", "arguments": {}})
                self.assertEqual([item["id"] for item in listed["verifications"]], ["fixture"])
                result = workspace.application.agent_tool({
                    **identity,
                    "tool": "run_verification",
                    "arguments": {"id": "fixture", "circuit": "main"},
                })
                self.assertEqual(result["feedback"]["status"], "passed")
                self.assertEqual(result["result"]["parsed"]["status"], "passed")
                self.assertEqual(result["binding"]["revisionId"], workspace.revision_id)
                self.assertEqual(result["binding"]["artifactSha256"], workspace.artifact_sha256)
                self.assertEqual(result["result"]["parsed"]["sha"], workspace.artifact_sha256)
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

                invalid_body = {
                    "projectId": workspace.history.record["id"],
                    "revisionId": workspace.revision_id,
                    "tool": "read_project_resource",
                    "arguments": {},
                }
                invalid_request = Request(
                    f"{base}/api/agent/tool",
                    data=json.dumps(invalid_body).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(HTTPError) as rejected:
                    urlopen(invalid_request)
                with rejected.exception as response:
                    error_payload = json.loads(response.read())
                self.assertEqual(error_payload["schema"], "vibe-logisim.circuit-plugin.error/v1")
                error_detail = error_payload["error"]
                self.assertEqual(error_detail["code"], "INVALID_ARGUMENT")
                self.assertFalse(error_detail["retryable"])
                self.assertIn("补齐", error_detail["hint"])

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
