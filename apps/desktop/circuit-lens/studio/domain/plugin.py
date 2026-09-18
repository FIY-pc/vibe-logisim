"""Model-facing domain plugin contracts.

The Codex thread/turn runtime owns the agent loop.  This module describes the
capabilities exposed by the circuit domain and the identity carried by a
domain observation.  It deliberately contains no workflow orchestration.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

# This catalog is shipped with Studio and discovered over the local protocol.
# Electron does not carry a second copy of tool names/descriptions/schemas.
_CATALOG = json.loads(Path(__file__).with_name("circuit-plugin.json").read_text())
PLUGIN_SCHEMA = _CATALOG["schema"]
RESULT_SCHEMA = _CATALOG["resultSchema"]
PLUGIN_ID = _CATALOG["id"]
PLUGIN_VERSION = _CATALOG["version"]


def tool_definitions():
    return copy.deepcopy(_CATALOG["tools"])


def plugin_manifest(workspace=None) -> dict[str, Any]:
    manifest = copy.deepcopy(_CATALOG)
    manifest["capabilities"] = [
        {key: tool[key] for key in ("name", "description", "category", "sourceMutation", "candidate", "owner")}
        for tool in manifest["tools"] if tool["exposure"] != "hidden"
    ]
    manifest["hostTools"] = [tool["name"] for tool in manifest["tools"] if tool["owner"] == "host"]
    manifest["availability"] = {
        "workspaceOpen": bool(workspace and getattr(workspace, "revision_id", None)),
        "nativeRuntime": workspace.observer.profile() if workspace else None,
        "sourceMutation": bool(workspace and getattr(workspace, "source_path", None)),
    }
    return manifest


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
