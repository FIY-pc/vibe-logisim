// Circuit tool failures: a stable code, a message for the model, an optional
// hint and context.

export const ERROR_SCHEMA = "vibe-logisim.circuit-plugin.error/v1";

const DEFAULT_HINT = "根据 message 修正参数或先读取当前电路，再决定是否重试。";

export interface CircuitToolErrorOptions {
  retryable?: boolean;
  hint?: string | null;
  availableInputs?: unknown;
  context?: Record<string, unknown> | null;
}

export class CircuitToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly hint: string | null;
  readonly availableInputs: unknown;
  readonly context: Record<string, unknown> | null;

  constructor(
    code: string,
    message: string,
    options: CircuitToolErrorOptions = {},
  ) {
    super(message);
    this.name = "CircuitToolError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.hint = options.hint ?? null;
    this.availableInputs = options.availableInputs;
    this.context = options.context ?? null;
  }

  asDict(): Record<string, unknown> {
    const value: Record<string, unknown> = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      hint: this.hint || DEFAULT_HINT,
    };
    if (this.availableInputs !== undefined && this.availableInputs !== null)
      value.availableInputs = this.availableInputs;
    if (this.context && Object.keys(this.context).length)
      value.context = this.context;
    return value;
  }

  asJson(): { schema: string; error: Record<string, unknown> } {
    return { schema: ERROR_SCHEMA, error: this.asDict() };
  }
}
