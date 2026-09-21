from __future__ import annotations

import base64
import uuid

from studio.application.inspection import InspectionService
from studio.domain.references import object_link
from studio.project.candidates import CandidateService
from studio.runtime.harness import NativeCircuitRuntime
from studio.runtime.native import NativeOperations
from studio.runtime.verification import VerificationService
from studio.domain.plugin import binding_for, plugin_manifest, result_envelope
from studio.application.circuit_plugin import CircuitInvocation, CircuitPlugin, default_specs


class Workbench:
    def __init__(self, workspace):
        self.workspace = workspace
        self.native = NativeOperations(workspace, self)
        self.runtime = NativeCircuitRuntime(workspace, self)
        self.verification = VerificationService(workspace)
        self.candidate = CandidateService(workspace, self)
        self.inspection = InspectionService(workspace, self)
        self.plugin = CircuitPlugin(workspace)
        self._register_plugin_tools()

    def _register_plugin_tools(self):
        specs = default_specs()
        handlers = {
            "read_kept_observation": self._read_kept_observation,
            "inspect_circuit": self._inspect_circuit,
            "describe_component": self._describe_component,
            "render_circuit": self._render_circuit,
            "read_project_resource": self._read_project_resource,
            "import_candidate": self._import_candidate,
            "build_candidate": self._build_candidate,
            "wire_candidate": self._wire_candidate,
            "reroute_candidate": self._reroute_candidate,
            "move_candidate": self._move_candidate,
            "edit_candidate": self._edit_candidate,
            "trace_circuit": self._trace_circuit,
            "simulate_circuit": self._simulate_circuit,
            "harness_run": self._harness_run,
            "compare_circuit": self._compare_circuit,
            "list_verifications": self._list_verifications,
            "run_verification": self._run_verification,
            "evaluate_circuit": self._evaluate_circuit,
        }
        expected = {name for name, spec in specs.items() if spec.owner == "studio"}
        if set(handlers) != expected:
            raise ValueError("电路工具定义和执行器清单不一致")
        for name, handler in handlers.items():
            self.plugin.register(specs[name], handler)

    def call(self, revision: str, tool: str, arguments: dict, observation_id=None, *, project_id=None,
             thread_id=None, turn_id=None, call_id=None):
        invocation = CircuitInvocation(
            project_id=project_id,
            revision_id=revision,
            tool=tool,
            arguments=arguments,
            observation_id=observation_id,
            thread_id=thread_id,
            turn_id=turn_id,
            call_id=call_id,
        )
        with self.workspace.lock:
            return self.plugin.invoke(invocation)

    def _read_kept_observation(self, call):
        return self.workspace.application.moments.inspect(call.arguments)

    def _describe_component(self, call):
        return self.workspace.application.placement.describe({
            **call.arguments, 'projectId': self.workspace.history.record['id'], 'revisionId': call.revision_id,
        })

    def _inspect_circuit(self, call):
        arguments, revision = call.arguments, call.revision_id
        if 'componentDirectory' in arguments or 'portConnections' in arguments:
            # Static pages include the real invocation in their byte budget.
            # Return directly without live samples or object references.
            return self.inspect(arguments, response_metadata={'invocation': {
                'projectId': call.project_id, 'revisionId': revision,
                'threadId': call.thread_id, 'turnId': call.turn_id,
                'callId': call.call_id, 'tool': call.tool,
            }})
        result = self.inspect(arguments)
        if not arguments.get("candidateId") and arguments.get("circuit"):
            result["objectReferenceTemplate"] = object_link(
                self.workspace.history.record["id"], revision, arguments["circuit"], "COMPONENT_ID"
            )
            if len(result.get("components", [])) <= 64:
                for component in result.get("components", []):
                    component["reference"] = object_link(
                        self.workspace.history.record["id"], revision, arguments["circuit"], component["componentId"]
                    )
        if call.observation_id and not arguments.get("candidateId"):
            sample = self.workspace.simulation.observation(revision, call.observation_id)
            if arguments.get("circuit") == sample["circuit"]:
                ids = arguments.get("componentIds") or []
                if ids:
                    sample["components"] = [c for c in sample["components"] if c["componentId"] in ids]
                result["displayedSimulation"] = sample
                for component in result.get("components", []):
                    component["reference"] = object_link(
                        self.workspace.history.record["id"], revision,
                        sample["circuit"], component["componentId"], sample
                    )
            else:
                result["simulationScope"] = {
                    "id": sample["id"],
                    "rootCircuit": sample.get("rootCircuit", sample["circuit"]),
                    "circuit": sample["circuit"],
                    "instancePath": sample["instancePath"],
                    "note": "Live values belong only to this observed instance and moment.",
                }
        return result

    def _render_circuit(self, call):
        data, metadata = self.workspace.circuits_service.render_for_agent(call.arguments)
        binding = binding_for(
            self.workspace,
            circuit=metadata['circuit'],
            artifact_sha256=metadata['artifactSha256'],
            candidate_id=metadata.get('candidateId'),
            runtime_profile=metadata.get('runtimeProfile'),
        )
        if metadata.get('candidateId'):
            binding.update(baseRevisionId=metadata['baseRevisionId'],
                           currentArtifactSha256=metadata['currentArtifactSha256'])
        run = {
            'id': 'render-' + uuid.uuid4().hex[:16],
            'label': '原生电路图面',
            'kind': 'render',
            'status': 'completed',
            'authority': metadata['authority'],
            'runtimeProfileId': metadata['runtimeProfileId'],
        }
        result = result_envelope(
            binding=binding,
            run=run,
            observation={
                **metadata,
                'imageIncluded': True,
                'note': '这是几何和标签观察，不证明连接关系或功能行为。',
            },
            feedback={
                'status': 'observed',
                'kind': 'visual-render',
                'note': ('图像来自候选快照和原生 Logisim；baseRevisionId 是候选基线，revisionId 是本次调用的当前版本。'
                         if metadata.get('candidateId') else
                         '图像来自当前 revision 和原生 Logisim；需要用 inspect_circuit 或运行工具判断连接和行为。'),
            },
        )
        # This field is consumed by Electron and converted to the native
        # app-server inputImage content item. It is removed from the text JSON.
        result['modelContentItems'] = [{
            'type': 'inputImage',
            'mimeType': 'image/png',
            'imageData': base64.b64encode(data).decode('ascii'),
        }]
        return result

    def _read_project_resource(self, call):
        return self.resource(call.arguments)

    def _import_candidate(self, call):
        if self.workspace.source_status().get("stale"):
            raise ValueError("源工程已变化，请先处理外部改动")
        from studio.collaboration.bundle import import_circuit
        return import_circuit(self, call.arguments)

    def _build_candidate(self, call):
        if self.workspace.source_status().get("stale"):
            raise ValueError("源工程已变化，请先重新载入")
        return self.build(call.arguments)

    def _wire_candidate(self, call):
        if self.workspace.source_status().get("stale"):
            raise ValueError("源工程已变化，请先重新载入")
        from studio.runtime.wiring import wire_candidate
        return wire_candidate(self, call.arguments)

    def _reroute_candidate(self, call):
        if self.workspace.source_status().get("stale"):
            raise ValueError("源工程已变化，请先重新载入")
        from studio.project.rerouting import reroute_candidate
        return reroute_candidate(self, call.arguments)

    def _move_candidate(self, call):
        if self.workspace.source_status().get("stale"):
            raise ValueError("源工程已变化，请先重新载入")
        from studio.project.moving import move_candidate
        return move_candidate(self, call.arguments)

    def _edit_candidate(self, call):
        if self.workspace.source_status().get("stale"):
            raise ValueError("源工程已变化，请先重新载入")
        from studio.project.attribute_edits import edit_candidate
        return edit_candidate(self, call.arguments)

    def _trace_circuit(self, call):
        report = self.trace(call.arguments)
        row_start = call.arguments.get("rowStart", 0)
        row_limit = call.arguments.get("rowLimit", 32)
        if type(row_start) is not int or row_start < 0 or type(row_limit) is not int or not 1 <= row_limit <= 256:
            raise ValueError("rowStart 必须为非负整数，rowLimit 必须在 1–256 之间")
        rows = report["rows"]
        selected = rows[row_start:row_start + row_limit]
        return {
            **report, "rows": selected, "rowCount": len(rows), "rowStart": row_start,
            "rowLimit": row_limit, "rowsTruncated": len(selected) != len(rows),
        }

    def _simulate_circuit(self, call):
        report = self.simulate(call.arguments)
        if len(report["rows"]) <= 32:
            return report
        chosen = []
        for status, limit in ((False, 12), (None, 12), (True, 8)):
            chosen.extend(
                (i, row)
                for i, row in list((i, r) for i, r in enumerate(report["rows"]) if r["passed"] is status)[:limit]
            )
        return {
            **report, "rowCount": len(report["rows"]),
            "rows": [{"index": i, **row} for i, row in sorted(chosen)],
            "rowsTruncated": True,
            "note": "Counts cover all vectors. Rows are bounded samples prioritizing failures and unknowns. Candidate review/export retains every row; rerun a narrower input set to investigate.",
        }

    def _harness_run(self, call):
        return self.harness_run(call.arguments)

    def _compare_circuit(self, call):
        return self.runtime.compare_circuit(call.arguments)

    def _list_verifications(self, call):
        return self.verification.list(call.arguments)

    def _run_verification(self, call):
        return self.verification.run(call.arguments)

    def _evaluate_circuit(self, call):
        return self.evaluate_circuit(call.arguments)

    def plugin_manifest(self):
        manifest = plugin_manifest(self.workspace)
        manifest["registeredToolNames"] = list(self.plugin.names())
        return manifest

    def _native(self, *args, **kwargs):
        return self.native._native(*args, **kwargs)

    def harness_run(self, *args, **kwargs):
        return self.runtime.harness_run(*args, **kwargs)

    def evaluate_circuit(self, *args, **kwargs):
        return self.runtime.evaluate(*args, **kwargs)

    def simulate(self, *args, **kwargs):
        return self.runtime.simulate(*args, **kwargs)

    def trace(self, *args, **kwargs):
        return self.runtime.trace(*args, **kwargs)

    def _record_observation(self, *args, **kwargs):
        return self.runtime._record_observation(*args, **kwargs)

    def _metadata(self, *args, **kwargs):
        return self.candidate._metadata(*args, **kwargs)

    def diff(self, *args, **kwargs):
        return self.candidate.diff(*args, **kwargs)

    def list(self, *args, **kwargs):
        return self.candidate.list(*args, **kwargs)

    def build(self, *args, **kwargs):
        return self.candidate.build(*args, **kwargs)

    def _save(self, *args, **kwargs):
        return self.candidate._save(*args, **kwargs)

    def archive(self, *args, **kwargs):
        return self.candidate.archive(*args, **kwargs)

    def working_copy(self, *args, **kwargs):
        return self.candidate.working_copy(*args, **kwargs)

    def inspect(self, *args, **kwargs):
        return self.inspection.inspect(*args, **kwargs)

    def resource(self, *args, **kwargs):
        return self.inspection.resource(*args, **kwargs)
