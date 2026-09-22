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
        CircuitPlugin._validate_schema_constraints(arguments, schema, "arguments")

    @staticmethod
    def _validate_schema_constraints(value: Any, schema: dict[str, Any], path: str) -> None:
        """Enforce the executable limits declared in the shared tool catalog.

        This is deliberately a small JSON Schema subset. The catalog uses
        these constraints for bounded native observations and generated
        candidates; validating them at the plugin boundary keeps invalid
        calls out of Java and workspace-owned commands.
        """
        expected = schema.get("type")
        valid = {
            "string": isinstance(value, str),
            "object": isinstance(value, dict),
            "array": isinstance(value, list),
            "boolean": isinstance(value, bool),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        }.get(expected, True)
        if not valid:
            raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 类型错误，应为 {expected}",
                                   hint="按照当前工具目录中的 inputSchema 修正参数。", context={"path": path, "expected": expected})
        if "enum" in schema and value not in schema["enum"]:
            raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 取值无效",
                                   hint="使用 inputSchema.enum 中的值。", context={"path": path, "allowed": schema["enum"]})
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 不能小于 {schema['minimum']}",
                                       hint=f"将 {path} 调整到不小于 {schema['minimum']}。",
                                       context={"path": path, "minimum": schema["minimum"]})
            if "maximum" in schema and value > schema["maximum"]:
                raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 不能大于 {schema['maximum']}",
                                       hint=f"将 {path} 调整到不大于 {schema['maximum']}。",
                                       context={"path": path, "maximum": schema["maximum"]})
        if isinstance(value, str):
            if "minLength" in schema and len(value) < schema["minLength"]:
                raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 长度不足",
                                       context={"path": path, "minLength": schema["minLength"]})
            if "maxLength" in schema and len(value) > schema["maxLength"]:
                raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 长度超过上限",
                                       context={"path": path, "maxLength": schema["maxLength"]})
        if isinstance(value, list):
            if "minItems" in schema and len(value) < schema["minItems"]:
                raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 至少需要 {schema['minItems']} 项",
                                       context={"path": path, "minItems": schema["minItems"]})
            if "maxItems" in schema and len(value) > schema["maxItems"]:
                raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 最多允许 {schema['maxItems']} 项",
                                       hint=f"将 {path} 的项目数量减少到 {schema['maxItems']} 项以内。",
                                       context={"path": path, "maxItems": schema["maxItems"]})
            item_schema = schema.get("items")
            if isinstance(item_schema, dict):
                for index, item in enumerate(value):
                    CircuitPlugin._validate_schema_constraints(item, item_schema, f"{path}[{index}]")
        if isinstance(value, dict):
            if 'minProperties' in schema and len(value) < schema['minProperties']:
                raise CircuitToolError('INVALID_ARGUMENT', f"参数 {path} 至少需要 {schema['minProperties']} 个字段",
                                       hint='按照 inputSchema.minProperties 补齐对象字段。',
                                       context={'path': path, 'minProperties': schema['minProperties']})
            required = schema.get("required", [])
            missing = [name for name in required if name not in value]
            if missing:
                raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 缺少必填字段: {', '.join(missing)}",
                                       hint="补齐 inputSchema.required 中的字段。", context={"path": path, "required": missing})
            properties = schema.get("properties", {})
            additional = schema.get("additionalProperties", True)
            unknown = sorted(set(value) - set(properties)) if additional is False else []
            if unknown:
                raise CircuitToolError("INVALID_ARGUMENT", f"参数 {path} 包含未声明字段: {', '.join(unknown)}",
                                       hint="只使用当前工具目录 inputSchema.properties 中的字段。",
                                       context={"path": path, "allowed": list(properties)})
            for name, item in value.items():
                child_schema = properties.get(name)
                if child_schema is None and isinstance(additional, dict):
                    child_schema = additional
                if isinstance(child_schema, dict):
                    CircuitPlugin._validate_schema_constraints(item, child_schema, f"{path}.{name}")

    def invoke(self, invocation: CircuitInvocation) -> dict[str, Any]:
        identity = {
            "projectId": invocation.project_id,
            "revisionId": invocation.revision_id,
            "observationId": invocation.observation_id,
            "threadId": invocation.thread_id,
            "turnId": invocation.turn_id,
            "callId": invocation.call_id,
            "tool": invocation.tool,
        }
        try:
            if not isinstance(invocation.arguments, dict):
                raise CircuitToolError("INVALID_ARGUMENT", "工具参数必须为对象")
            registered = self._tools.get(invocation.tool)
            if registered is None:
                raise CircuitToolError(
                    "UNKNOWN_TOOL", "Unknown circuit tool",
                    context={"availableTools": [
                        name for name, item in self._tools.items() if item.spec.exposure == "direct"
                    ]},
                )
            record = self.workspace.history.record
            if invocation.project_id is not None and (not record or invocation.project_id != record["id"]):
                raise CircuitToolError("STALE_PROJECT", "工程身份已变化，请重新发起操作")
            if invocation.revision_id != self.workspace.revision_id:
                raise CircuitToolError("STALE_REVISION", "工程版本已变化，请重新发起操作")
            self._validate_arguments(registered.spec, invocation.arguments)
            result = registered.handler(invocation)
        except CircuitToolError as error:
            context = error.context if isinstance(error.context, dict) else {}
            error.context = {**context, "invocation": identity}
            raise
        except Exception as error:
            failure = tool_error_from_exception(invocation.tool, error)
            context = failure.context if isinstance(failure.context, dict) else {}
            failure.context = {**context, "invocation": identity}
            raise failure from error
        if isinstance(result, dict):
            result["invocation"] = identity
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
