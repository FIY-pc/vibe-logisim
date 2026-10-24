/**
 * The JSONL protocol between the Rust host and this process. One JSON object
 * per line in both directions; stdout carries nothing else. The host side is
 * crates/workbench-host/src/agent/mod.rs.
 */
import type { Request } from "../generated/Request.ts";
import type { HostError } from "../generated/HostError.ts";
import type { DocumentChange } from "../generated/DocumentChange.ts";

/** Host → sidecar. */
export type HostMessage =
  | { id: string; method: RuntimeMethod; args?: Record<string, any> }
  | { kind: "hostResult"; id: string; result?: unknown; error?: HostError };

/** Sidecar → host. */
export type WorkerMessage =
  | { kind: "ready" }
  | { kind: "result"; id: string; result?: unknown; error?: string }
  | { kind: "event"; event: RuntimeEvent }
  | { kind: "host"; id: string; request: Request };

/**
 * The methods the UI calls through `{"op":"agent","method":…,"args":…}`.
 * `events` is answered by the host from its buffer and never reaches here.
 */
export type RuntimeMethod =
  | "status"
  | "history"
  | "bind"
  | "ask"
  | "stop"
  | "reconnect"
  | "conversations"
  | "models"
  | "selectModel"
  | "configure"
  | "removeProvider"
  | "discover"
  | "probe"
  | "defaultProvider"
  | "bindProvider"
  | "stageReferences"
  | "readReferences";

/**
 * Methods that change which conversation or service is current. They run one
 * at a time so a bind cannot change the conversation under a starting turn.
 */
export const TRANSITIONS: ReadonlySet<RuntimeMethod> = new Set<RuntimeMethod>([
  "bind",
  "ask",
  "conversations",
  "configure",
  "removeProvider",
  "selectModel",
  "bindProvider",
  "defaultProvider",
  "reconnect",
]);

/** Events pushed to the UI (host topic `agent`, each wrapped as {sequence, event}). */
export type RuntimeEvent =
  /** The runtime's state (`status` without the conversation). */
  | ({ type: "status" } & Record<string, unknown>)
  /** The whole conversation, after it was replaced (switched, resumed or cut back for a resend). */
  | { type: "history"; messages: unknown[] }
  /** One conversation entry was added or replaced (matched by id): a turn record starting or ending. */
  | { type: "message"; message: unknown }
  | {
      type: "user-message";
      id: string;
      text: string;
      context?: unknown;
      delivery?: string;
      canEdit?: boolean;
    }
  | { type: "user-message-delivery"; id: string; delivery: string }
  | { type: "assistant-started"; itemId: string; turnId: string | null }
  | {
      type: "assistant-delta" | "reasoning-delta";
      itemId: string;
      turnId: string | null;
      delta: string;
    }
  | {
      type: "assistant-completed";
      itemId: string;
      turnId: string | null;
      text: string;
      phase: string;
    }
  | ({ type: "activity" } & Record<string, unknown>)
  | ({ type: "conversations-changed"; activate?: boolean } & Record<
      string,
      unknown
    >)
  | { type: "runtime-error"; message: string }
  | { type: "turn-started"; turnId: string }
  | {
      type: "turn-completed";
      turnId: string;
      status: string;
      error: string | null;
    }
  /** A tool edited an open document: what its edits changed, from the revision before its first edit. */
  | { type: "document-changed"; change: DocumentChange }
  /** A tool opened or created a document; the UI shows it. */
  | { type: "document-opened"; document: unknown }
  /** The turn's folder checkpoint recorded changed files; the UI offers 撤销 via folderHistoryUndo. */
  | {
      type: "files-changed";
      folderId: string;
      conversationId: string | null;
      change: unknown;
    };
