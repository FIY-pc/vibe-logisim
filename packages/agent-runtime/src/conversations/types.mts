import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProtocolObject } from "../protocol/types.mts";
import type { ServiceSelection } from "../models/types.mts";
import type { FolderChange } from "../protocol/host.mts";

/** One entry of the conversation the UI shows: user, assistant, reasoning, activity or turn. */
export interface RuntimeMessage {
  id: string;
  type: string;
  text?: string;
  phase?: string;
  status?: string;
  startedAt?: number;
  elapsedMs?: number;
  error?: string | null;
  context?: ProtocolObject;
  turnId?: string | null;
  itemId?: string;
  kind?: string;
  label?: string;
  activityKey?: string;
  detail?: string | null;
  resultStatus?: string;
  canEdit?: boolean;
  /** On a turn record: the files the turn changed; `undone` once the user undid them. */
  change?: FolderChange & { undone?: boolean };
}
export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messages: RuntimeMessage[];
  customTitle?: boolean;
  titleGenerated?: boolean;
  selection?: ServiceSelection | null;
  /** The model transcript and where each message starts in it and in `messages`. */
  transcript?: AgentMessage[];
  checkpoints?: Record<string, { raw: number; history: number }>;
}
export interface ConversationWorkspace {
  activeId: string;
  conversations: Record<string, ConversationRecord>;
}
export interface ConversationIndex {
  schema: string;
  workspaces: Record<string, ConversationWorkspace>;
}
export interface ConversationChange {
  id?: string;
  title?: string;
  reuseEmpty?: boolean;
  draftTitle?: string;
}
