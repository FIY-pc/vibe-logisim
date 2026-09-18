from __future__ import annotations

from studio.application.inspection import InspectionService
from studio.domain.references import object_link
from studio.project.candidates import CandidateService
from studio.runtime.harness import HarnessService
from studio.runtime.native import NativeOperations
from studio.domain.plugin import plugin_manifest


class Workbench:
    def __init__(self, workspace):
        self.workspace = workspace
        self.native = NativeOperations(workspace, self)
        self.harness = HarnessService(workspace, self)
        self.candidate = CandidateService(workspace, self)
        self.inspection = InspectionService(workspace, self)

    def call(self, revision: str, tool: str, arguments: dict, observation_id=None):
        # Serialize binding check and action with workspace transitions. No model-chosen filesystem paths.
        with self.workspace.lock:
            if revision != self.workspace.revision_id:
                raise ValueError("工程版本已变化，请重新发起操作")
            if not isinstance(arguments, dict):
                raise ValueError("工具参数必须为对象")
            if tool == "read_kept_observation":
                return self.workspace.application.moments.inspect(arguments)
            if tool == "inspect_circuit":
                result = self.inspect(arguments)
                if not arguments.get('candidateId') and arguments.get('circuit'):
                    result['objectReferenceTemplate']=object_link(self.workspace.history.record['id'],revision,arguments['circuit'],'COMPONENT_ID')
                    if len(result.get('components',[]))<=64:
                        for component in result.get('components',[]):
                            component['reference']=object_link(self.workspace.history.record['id'],revision,arguments['circuit'],component['componentId'])
                if observation_id and not arguments.get("candidateId"):
                    sample = self.workspace.simulation.observation(revision, observation_id)
                    if arguments.get("circuit") == sample["circuit"]:
                        ids = arguments.get("componentIds") or []
                        if ids:
                            sample["components"] = [c for c in sample["components"] if c["componentId"] in ids]
                        result["displayedSimulation"] = sample
                        for component in result.get('components',[]):
                            component['reference']=object_link(self.workspace.history.record['id'],revision,sample['circuit'],component['componentId'],sample)
                    else:
                        result["simulationScope"] = {"id": sample["id"], "rootCircuit": sample.get("rootCircuit",sample["circuit"]),
                            "circuit":sample['circuit'], 'instancePath':sample['instancePath'],
                            "note": "Live values belong only to this observed instance and moment."}
                return result
            if tool == "read_project_resource":
                return self.resource(arguments)
            if tool == "submit_circuit":
                if self.workspace.source_status().get("stale"):
                    raise ValueError("源工程已变化，请先处理外部改动")
                from studio.collaboration.bundle import import_circuit
                return import_circuit(self, arguments)
            if tool == "build_candidate":
                if self.workspace.source_status().get("stale"):
                    raise ValueError("源工程已变化，请先重新载入")
                return self.build(arguments)
            if tool == "wire_candidate":
                if self.workspace.source_status().get("stale"):
                    raise ValueError("源工程已变化，请先重新载入")
                from studio.runtime.wiring import wire_candidate
                return wire_candidate(self, arguments)
            if tool == "trace_circuit":
                report = self.trace(arguments)
                row_start = arguments.get("rowStart", 0)
                row_limit = arguments.get("rowLimit", 32)
                if type(row_start) is not int or row_start < 0 or type(row_limit) is not int or not 1 <= row_limit <= 256:
                    raise ValueError("rowStart 必须为非负整数，rowLimit 必须在 1–256 之间")
                rows = report["rows"]
                selected = rows[row_start:row_start + row_limit]
                return {**report, "rows": selected, "rowCount": len(rows), "rowStart": row_start,
                        "rowLimit": row_limit, "rowsTruncated": len(selected) != len(rows)}
            if tool == "simulate_circuit":
                report = self.simulate(arguments)
                if len(report["rows"]) <= 32:
                    return report
                # Keep the full report with the candidate, not in every model turn.
                # Failures and unknowns have priority; totals still cover every vector.
                chosen = []
                for status, limit in ((False, 12), (None, 12), (True, 8)):
                    chosen.extend((i, row) for i, row in list((i, r) for i, r in enumerate(report["rows"]) if r["passed"] is status)[:limit])
                return {**report, "rowCount": len(report["rows"]),
                        "rows": [{"index": i, **row} for i, row in sorted(chosen)], "rowsTruncated": True,
                        "note": "Counts cover all vectors. Rows are bounded samples prioritizing failures and unknowns. Candidate review/export retains every row; rerun a narrower input set to investigate."}
            if tool == "harness_run":
                return self.harness_run(arguments)
            if tool == "evaluate_circuit":
                return self.evaluate_circuit(arguments)
            raise ValueError("Unknown circuit tool")

    def plugin_manifest(self):
        """Describe the circuit plugin without starting a model turn.

        The host can discover this independently from the dynamic tool list;
        keeping discovery separate lets the model use the same plugin through
        another transport later.
        """
        return plugin_manifest(self.workspace)

    def _native(self, *args, **kwargs):
        return self.native._native(*args, **kwargs)

    def harness_run(self, *args, **kwargs):
        return self.harness.harness_run(*args, **kwargs)

    def evaluate_circuit(self, *args, **kwargs):
        return self.harness.evaluate(*args, **kwargs)

    def simulate(self, *args, **kwargs):
        return self.harness.simulate(*args, **kwargs)

    def trace(self, *args, **kwargs):
        return self.harness.trace(*args, **kwargs)

    def _record_observation(self, *args, **kwargs):
        return self.harness._record_observation(*args, **kwargs)

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
