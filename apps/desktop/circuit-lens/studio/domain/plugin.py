"""Model-facing domain plugin contracts.

The Codex thread/turn runtime owns the agent loop.  This module describes the
capabilities exposed by the circuit domain and the identity carried by a
domain observation.  It deliberately contains no workflow orchestration.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


PLUGIN_SCHEMA = "vibe-logisim.circuit-plugin/v1"
RESULT_SCHEMA = "vibe-logisim.circuit-plugin.result/v1"
PLUGIN_ID = "vibe-logisim.circuit"
PLUGIN_VERSION = "1.0.0"


@dataclass(frozen=True, slots=True)
class Capability:
    """A model-visible domain capability, independent of its transport."""

    name: str
    category: str
    description: str
    source_mutation: bool = False
    candidate: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "category": self.category,
            "description": self.description,
            "sourceMutation": self.source_mutation,
            "candidate": self.candidate,
        }


CAPABILITIES = (
    Capability("open_circuit", "context", "Bind an existing .circ file to the shared canvas."),
    Capability("inspect_circuit", "observe", "Read exact native structure, ports and connectivity when available."),
    Capability("read_kept_observation", "observe", "Read a frozen user-kept runtime observation."),
    Capability("read_project_resource", "observe", "Read bounded project reference material."),
    Capability("build_candidate", "construct", "Build an independent candidate from a constrained synthesis request.", candidate=True),
    Capability("wire_candidate", "construct", "Build an independent candidate with explicit native connections.", candidate=True),
    Capability("submit_circuit", "construct", "Load direct file edits into a reviewable candidate.", candidate=True),
    Capability("checkout_candidate", "mutate", "Write a candidate into the selected source file.", source_mutation=True),
    Capability("simulate_circuit", "observe", "Run combinational vectors through the exact native runtime."),
    Capability("trace_circuit", "observe", "Run clocked behavior and return bounded native trace rows."),
    Capability("harness_run", "evaluate", "Run a user-directed native observation or evaluation experiment."),
    Capability("evaluate_circuit", "evaluate", "Compare native observations with an explicit user-supplied test specification."),
)


def plugin_manifest(workspace=None) -> dict[str, Any]:
    """Return the descriptor a host can expose to the agent and UI.

    Availability is intentionally runtime state, while the capability list is
    stable.  A missing project therefore disables a binding without changing
    what the plugin means.
    """

    open_project = bool(workspace and getattr(workspace, "revision_id", None))
    profile = None
    if workspace is not None:
        try:
            profile = workspace.observer.profile()
        except Exception as error:  # pragma: no cover - defensive status path
            profile = {"id": None, "status": "unavailable", "error": str(error)}
    return {
        "schema": PLUGIN_SCHEMA,
        "id": PLUGIN_ID,
        "version": PLUGIN_VERSION,
        "displayName": "Vibe Logisim Circuit Plugin",
        "purpose": "Give a model reliable circuit-domain observation, editing and native runtime feedback.",
        "workflow": "user-directed",
        "capabilities": [capability.as_dict() for capability in CAPABILITIES],
        "availability": {
            "workspaceOpen": open_project,
            "nativeRuntime": profile,
            "sourceMutation": bool(open_project and getattr(workspace, "source_path", None)),
        },
    }


def binding_for(workspace, *, circuit=None, candidate_id=None, artifact_sha256=None) -> dict[str, Any]:
    """Create the stable identity attached to a plugin operation."""

    record = getattr(workspace.history, "record", None)
    profile = workspace.observer.profile()
    return {
        "schema": PLUGIN_SCHEMA,
        "pluginId": PLUGIN_ID,
        "pluginVersion": PLUGIN_VERSION,
        "projectId": record.get("id") if record else None,
        "revisionId": getattr(workspace, "revision_id", None),
        "circuit": circuit,
        "candidateId": candidate_id or None,
        "artifactSha256": artifact_sha256 or getattr(workspace, "artifact_sha256", None),
        "runtimeProfileId": profile.get("id"),
        "runtimeProfile": profile,
    }


def result_envelope(*, binding: dict[str, Any], run: dict[str, Any], observation: Any, feedback=None) -> dict[str, Any]:
    """Wrap a raw domain result without hiding the legacy result fields."""

    value = {
        "schema": RESULT_SCHEMA,
        "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION},
        "binding": binding,
        "run": run,
        "result": observation,
    }
    if feedback is not None:
        value["feedback"] = feedback
    return value
