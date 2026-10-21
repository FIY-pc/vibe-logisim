/** One failure contract for circuit tools, from the thrower to the model payload. */
export const ERROR_SCHEMA = "vibe-logisim.circuit-plugin.error/v1";
export const DEFAULT_HINT =
  "根据 message 修正参数或先读取当前电路，再决定是否重试。";
const FALLBACK_HINT = "检查当前工作区和连接状态后再决定是否重试。";

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
  context?: Record<string, unknown>;
}
export interface ToolRequest {
  threadId?: string | null;
  turnId?: string | null;
  callId?: string | null;
  tool?: string | null;
  arguments?: unknown;
}
export interface PendingBinding {
  projectId?: string | null;
  revisionId?: string | null;
  observationId?: string | null;
}
export interface HostError {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
  context?: unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `retryable` means the identical call may later succeed unchanged. */
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

/** A well-formed call the tool declines to carry out. */
export class ToolRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRejected";
  }
}

/** Failures relayed from the Rust host keep their code, hint, retryable and context. */
export function isHostError(error: unknown): error is HostError {
  return (
    record(error) &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  );
}

function fromHost(error: HostError) {
  return new CircuitToolError(error.code, error.message, {
    retryable: error.retryable,
    hint: typeof error.hint === "string" ? error.hint : null,
    context: error.context,
  });
}

/** Failures of tool handlers, mapped the way the native tool service mapped them. */
export function toolErrorFromException(
  tool: string,
  error: unknown,
): CircuitToolError {
  const failure =
    error instanceof CircuitToolError
      ? error
      : isHostError(error)
        ? fromHost(error)
        : new CircuitToolError(
            error instanceof ToolRejected ? "TOOL_REJECTED" : "TOOL_FAILED",
            (error instanceof Error ? error.message : String(error ?? "")) ||
              `${tool} 执行失败`,
          );
  failure.toolError.hint ||= DEFAULT_HINT;
  return failure;
}

/** Failures of the host-owned tools stay as thrown; host failures keep their fields. */
export function hostToolFailure(error: unknown) {
  return isHostError(error) && !(error instanceof CircuitToolError)
    ? fromHost(error)
    : error;
}

export function invocationIdentity(
  request: ToolRequest | null | undefined,
  pending: PendingBinding | null | undefined,
) {
  return {
    projectId: pending?.projectId || null,
    revisionId: pending?.revisionId || null,
    observationId: pending?.observationId || null,
    threadId: request?.threadId || null,
    turnId: request?.turnId || null,
    callId: request?.callId || null,
    tool: request?.tool || null,
  };
}

// The model needs to know which document and revision a failure belongs to
// before it repairs, observes or retries. Arguments, paths and native output
// never enter this identity.
export function attachInvocationIdentity(
  error: unknown,
  request: ToolRequest | null | undefined,
  pending: PendingBinding | null | undefined,
): Error & { toolError: ToolError } {
  const target = (
    error instanceof Error ? error : new Error(String(error))
  ) as Error & { toolError?: ToolError; code?: unknown };
  const current: ToolError = record(target.toolError)
    ? target.toolError
    : isHostError(target)
      ? fromHost(target).toolError
      : {
          code:
            typeof target.code === "string" && target.code
              ? target.code
              : "CIRCUIT_TOOL_FAILED",
          message: target.message || String(target),
          retryable: false,
          hint: FALLBACK_HINT,
        };
  target.toolError = {
    ...current,
    context: {
      ...(record(current.context) ? current.context : {}),
      invocation: invocationIdentity(request, pending),
    },
  };
  return target as Error & { toolError: ToolError };
}

export function modelErrorPayload(
  error: unknown,
  request: ToolRequest | null | undefined,
  pending: PendingBinding | null | undefined,
) {
  return {
    ...attachInvocationIdentity(error, request, pending).toolError,
    schema: ERROR_SCHEMA,
  };
}

interface IndexedCircuitFile {
  path: string;
  mainCircuit?: string | null;
  circuits?: { name: string; components: number; wireSegments: number }[];
}

/** NO_CIRCUIT_OPEN lists the indexed .circ files so the model can choose one. */
export function enrichNoCircuitOpen(
  error: unknown,
  workspaceIndex:
    { circuits?: IndexedCircuitFile[]; truncated?: boolean } | null | undefined,
) {
  if (!(error instanceof CircuitToolError)) return error;
  const toolError = error.toolError;
  if (toolError.code !== "NO_CIRCUIT_OPEN") return error;
  const files = Array.isArray(workspaceIndex?.circuits)
    ? workspaceIndex.circuits
    : [];
  const availableFiles = files.map((file) => ({
    path: file.path,
    mainCircuit: file.mainCircuit || null,
    circuits: Array.isArray(file.circuits)
      ? file.circuits.map((circuit) => ({
          name: circuit.name,
          components: circuit.components,
          wireSegments: circuit.wireSegments,
        }))
      : [],
  }));
  error.toolError = {
    ...toolError,
    hint: availableFiles.length
      ? "先从 context.availableFiles 选择目标 .circ 的 path，再调用 open_circuit({path, circuit})；不要根据文件名猜测电路定义。"
      : "当前工作区索引中没有可用的 .circ 文件；先确认文件已放入工作区，再调用 open_circuit。",
    context: {
      ...(toolError.context || {}),
      availableFiles,
      indexTruncated: Boolean(workspaceIndex?.truncated),
    },
  };
  return error;
}
