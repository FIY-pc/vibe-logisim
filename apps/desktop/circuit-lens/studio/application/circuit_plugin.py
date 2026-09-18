"""Executable contract between the base Agent Harness and circuit tools."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from studio.domain.plugin import tool_definitions
from studio.domain.tool_errors import CircuitToolError, tool_error_from_exception


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
    input_schema: dict[str, Any]
    owner: str
    exposure: str = "direct"
    source_mutation: bool = False
    candidate: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "type": "function",
            "name": self.name,
            "inputSchema": self.input_schema,
            "owner": self.owner,
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

    @staticmethod
    def _validate_arguments(spec: CircuitToolSpec, arguments: dict[str, Any]) -> None:
        schema = spec.input_schema
        properties = schema.get("properties", {})
        missing = [name for name in schema.get("required", []) if name not in arguments]
        if missing:
            raise CircuitToolError("INVALID_ARGUMENT", f"工具缺少必填参数: {', '.join(missing)}",
                                   hint="补齐 required 中的参数后重新调用。", context={"required": missing})
        if schema.get("additionalProperties") is False:
            unknown = sorted(set(arguments) - set(properties))
            if unknown:
                raise CircuitToolError("INVALID_ARGUMENT", f"工具包含未声明的参数: {', '.join(unknown)}",
                                       hint="使用当前工具声明中的参数名。", context={"allowed": list(properties)})
        for name, value in arguments.items():
            expected = properties.get(name, {}).get("type")
            valid = {
                "string": isinstance(value, str),
                "object": isinstance(value, dict),
                "array": isinstance(value, list),
                "boolean": isinstance(value, bool),
                "integer": isinstance(value, int) and not isinstance(value, bool),
                "number": isinstance(value, (int, float)) and not isinstance(value, bool),
            }.get(expected, True)
            if not valid:
                raise CircuitToolError("INVALID_ARGUMENT", f"工具参数类型错误: {name} 应为 {expected}")
            enum = properties.get(name, {}).get("enum")
            if enum is not None and value not in enum:
                raise CircuitToolError("INVALID_ARGUMENT", f"工具参数取值无效: {name}", context={"allowed": enum})

    def invoke(self, invocation: CircuitInvocation) -> dict[str, Any]:
        try:
            if not isinstance(invocation.arguments, dict):
                raise CircuitToolError("INVALID_ARGUMENT", "工具参数必须为对象")
            registered = self._tools.get(invocation.tool)
            if registered is None:
                raise CircuitToolError("UNKNOWN_TOOL", "Unknown circuit tool", context={"availableTools": list(self.names())})
            record = self.workspace.history.record
            if invocation.project_id is not None and (not record or invocation.project_id != record["id"]):
                raise CircuitToolError("STALE_PROJECT", "工程身份已变化，请重新发起操作")
            if invocation.revision_id != self.workspace.revision_id:
                raise CircuitToolError("STALE_REVISION", "工程版本已变化，请重新发起操作")
            self._validate_arguments(registered.spec, invocation.arguments)
            result = registered.handler(invocation)
        except CircuitToolError:
            raise
        except Exception as error:
            raise tool_error_from_exception(invocation.tool, error) from error
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
        item["name"]: CircuitToolSpec(
            name=item["name"], description=item["description"], category=item["category"],
            input_schema=item["inputSchema"], owner=item["owner"], exposure=item["exposure"],
            source_mutation=item["sourceMutation"], candidate=item["candidate"],
        )
        for item in tool_definitions()
    }
