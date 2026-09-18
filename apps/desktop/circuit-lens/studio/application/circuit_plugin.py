"""Executable contract between the base Agent Harness and circuit tools."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from studio.domain.plugin import CAPABILITIES


@dataclass(frozen=True, slots=True)
class CircuitInvocation:
    project_id: str | None
    revision_id: str
    tool: str
    arguments: dict[str, Any]
    observation_id: str | None = None
    thread_id: str | None = None
    turn_id: str | None = None
    call_id: str | None = None


@dataclass(frozen=True, slots=True)
class CircuitToolSpec:
    name: str
    description: str
    category: str
    exposure: str = "direct"
    source_mutation: bool = False
    candidate: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "exposure": self.exposure,
            "sourceMutation": self.source_mutation,
            "candidate": self.candidate,
        }


Handler = Callable[[CircuitInvocation], dict[str, Any]]


@dataclass(slots=True)
class _RegisteredTool:
    spec: CircuitToolSpec
    handler: Handler


class CircuitPlugin:
    """Registry and executor for one circuit-domain plugin instance."""

    def __init__(self, workspace):
        self.workspace = workspace
        self._tools: dict[str, _RegisteredTool] = {}

    def register(self, spec: CircuitToolSpec, handler: Handler) -> None:
        if spec.name in self._tools:
            raise ValueError(f"重复注册电路工具: {spec.name}")
        self._tools[spec.name] = _RegisteredTool(spec, handler)

    def spec(self, name: str) -> CircuitToolSpec:
        try:
            return self._tools[name].spec
        except KeyError as error:
            raise ValueError(f"Unknown circuit tool: {name}") from error

    def names(self) -> tuple[str, ...]:
        return tuple(self._tools)

    def manifest_tools(self) -> list[dict[str, Any]]:
        return [item.spec.as_dict() for item in self._tools.values()]

    def invoke(self, invocation: CircuitInvocation) -> dict[str, Any]:
        if not isinstance(invocation.arguments, dict):
            raise ValueError("工具参数必须为对象")
        registered = self._tools.get(invocation.tool)
        if registered is None:
            raise ValueError("Unknown circuit tool")
        if invocation.revision_id != self.workspace.revision_id:
            raise ValueError("工程版本已变化，请重新发起操作")
        result = registered.handler(invocation)
        if isinstance(result, dict):
            result.setdefault("invocation", {
                "projectId": invocation.project_id,
                "revisionId": invocation.revision_id,
                "threadId": invocation.thread_id,
                "turnId": invocation.turn_id,
                "callId": invocation.call_id,
                "tool": invocation.tool,
            })
        return result


def default_specs() -> dict[str, CircuitToolSpec]:
    return {
        item.name: CircuitToolSpec(
            name=item.name,
            description=item.description,
            category=item.category,
            source_mutation=item.source_mutation,
            candidate=item.candidate,
        )
        for item in CAPABILITIES
    }
