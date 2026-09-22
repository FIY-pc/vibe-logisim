"""Circuit failures shared by runtime, application and transport adapters."""
from __future__ import annotations

from studio.domain.errors import LensError

ERROR_SCHEMA = "vibe-logisim.circuit-plugin.error/v1"


class CircuitToolError(ValueError):
    # retryable means repeating the unchanged call may help. Correcting an
    # argument or source file is a new call, not a transient retry.
    def __init__(self, code, message, *, retryable=False, hint=None,
                 available_inputs=None, context=None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.hint = hint
        self.available_inputs = available_inputs
        self.context = context

    def as_dict(self):
        value = {
            "code": self.code,
            "message": str(self),
            "retryable": self.retryable,
            "hint": self.hint or "根据 message 修正参数或先读取当前电路，再决定是否重试。",
        }
        if self.available_inputs is not None:
            value["availableInputs"] = self.available_inputs
        if self.context:
            value["context"] = self.context
        return value

    def as_json(self):
        return {"schema": ERROR_SCHEMA, "error": self.as_dict()}


class NativeRuntimeFailure(RuntimeError):
    """A native worker failure that remains a RuntimeError below the tool boundary."""
    def __init__(self, code, message, *, retryable=False, hint=None, context=None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.hint = hint
        self.context = context


def tool_error_from_exception(tool, error):
    if isinstance(error, CircuitToolError):
        return error
    if isinstance(error, NativeRuntimeFailure):
        return CircuitToolError(error.code, str(error), retryable=error.retryable,
                                hint=error.hint, context=error.context)
    if isinstance(error, LensError):
        return CircuitToolError(error.code, str(error), context={"detail": error.detail} if error.detail else None)
    # Legacy ValueError also represents compilation/loading failures. Do not
    # classify every such failure as an invalid argument or promise retrying it.
    return CircuitToolError(
        "TOOL_REJECTED" if isinstance(error, ValueError) else "TOOL_FAILED",
        str(error) or f"{tool} 执行失败",
    )
