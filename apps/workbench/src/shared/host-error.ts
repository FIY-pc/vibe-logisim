import type { ErrorCode } from "../generated/ErrorCode";
import type { HostError as HostErrorShape } from "../generated/HostError";
import type { JsonValue } from "../generated/serde_json/JsonValue";

/** A failed host request. `message` and `String(error)` are the user-facing text. */
export class HostError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly context?: JsonValue;
  constructor(shape: HostErrorShape) {
    super(shape.message);
    this.name = "HostError";
    this.code = shape.code;
    this.hint = shape.hint;
    this.retryable = shape.retryable;
    this.context = shape.context;
  }
  override toString() {
    return this.message;
  }
  /** Normalizes a transport rejection: a host error object, or text from the transport itself. */
  static from(reason: unknown): HostError {
    if (reason instanceof HostError) return reason;
    if (
      reason &&
      typeof reason === "object" &&
      typeof (reason as HostErrorShape).code === "string" &&
      typeof (reason as HostErrorShape).message === "string"
    )
      return new HostError(reason as HostErrorShape);
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string" && reason
          ? reason
          : "请求失败";
    return new HostError({ code: "UNKNOWN", message, retryable: false });
  }
}
