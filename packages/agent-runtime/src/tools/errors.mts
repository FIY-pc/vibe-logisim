/** Tool failures the model can act on: a code, a message and a hint. */
import { isHostError } from "../protocol/host.mts";

export const ERROR_SCHEMA = "vibe-logisim.circuit-tool.error/v2";
export const DEFAULT_HINT =
  "根据 message 修正参数或先读取当前电路，再决定是否重试。";

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
  context?: Record<string, unknown>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export class CircuitToolError extends Error {
  code: string;
  toolError: ToolError;
  constructor(
    code: string,
    message: string,
    {
      retryable = false,
      hint = null,
      context = null,
    }: {
      retryable?: boolean;
      hint?: string | null;
      context?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "CircuitToolError";
    this.code = code;
    this.toolError = {
      code,
      message,
      retryable,
      ...(hint ? { hint } : {}),
      ...(record(context) ? { context } : {}),
    };
  }
}

/** Any thrown value as a tool error the model can read. */
export function toolErrorFromException(tool: string, error: unknown) {
  const failure =
    error instanceof CircuitToolError
      ? error
      : isHostError(error)
        ? new CircuitToolError(error.code, error.message, {
            retryable: error.retryable,
            hint: typeof error.hint === "string" ? error.hint : null,
            context: error.context,
          })
        : new CircuitToolError(
            "TOOL_FAILED",
            (error instanceof Error ? error.message : String(error ?? "")) ||
              `${tool} 执行失败`,
          );
  failure.toolError.hint ||= DEFAULT_HINT;
  return failure;
}
