/**
 * The host as the sidecar sees it: one typed request at a time, answered or
 * refused with a HostError. The transport (stdin/stdout JSONL) lives in
 * worker.mts; everything else talks to the host only through HostClient.
 */
import type { Request } from "../generated/Request.ts";
import type { HostError } from "../generated/HostError.ts";
import type { DocumentView } from "../generated/DocumentView.ts";
import type { EditResult } from "../generated/EditResult.ts";

export type { Request, HostError, DocumentView, EditResult };

/** The open folder (`vibe_circuit_document::Folder`); not exported by ts-rs. */
export interface HostFolder {
  /** "folder:" + digest(path). */
  id: string;
  path: string;
  name: string;
}
/** What `{"op":"status"}` returns. */
export interface HostStatus {
  documents: DocumentView[];
  active: string | null;
  recoveryError: string | null;
  folder: HostFolder | null;
  runtime: unknown;
}
/** What `folderCheckpoint` returns: the recorded change, or none. */
export interface FolderChange {
  id: string;
  title: string;
  at: number;
  undoable: boolean;
  files: { path: string; kind: "added" | "modified" | "deleted" }[];
}
export interface HostClient {
  /** Sends one host request; rejects with an Error carrying the HostError fields. */
  call<T = any>(request: Request): Promise<T>;
}
/** Refusals arrive as Error objects carrying the HostError fields. */
export const isHostError = (error: unknown): error is Error & HostError =>
  error instanceof Error &&
  typeof (error as any).code === "string" &&
  typeof (error as any).retryable === "boolean";
