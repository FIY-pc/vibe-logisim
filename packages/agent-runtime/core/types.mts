import type {
  Agent,
  AgentMessage,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { RuntimeInstaller } from "./runtime-installer.mts";

/** JSON owned by external runtimes or tool adapters. Validate at the consuming boundary. */
export type ProtocolObject = Record<string, any>;
export type NativeRequest = (
  method: string,
  params: ProtocolObject,
  options?: ProtocolObject,
) => Promise<ProtocolObject>;
export type RuntimeKind = "builtin" | "codex";
export interface ModelSelection {
  model: string;
  effort: string | null;
}
export interface ServiceConfig {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  model: string;
  effort: Exclude<ThinkingLevel, "off"> | "none";
  contextWindow: number;
  vision: boolean;
  models?: string[];
}
export type PublicService = Omit<ServiceConfig, "apiKey"> & {
  apiKeyHint: string;
};
export interface ServiceSelection extends Omit<
  ServiceConfig,
  "id" | "name" | "apiKey"
> {
  serviceId: string;
}
export interface ModelRow {
  model: string;
  name: string;
  description: string;
  isDefault: boolean;
  defaultEffort: string | null;
  efforts: { value: string; description: string }[];
}
export interface RuntimeMessage {
  id: string;
  type: string;
  text?: string;
  clientId?: string;
  phase?: string;
  status?: string;
  contextTransferred?: boolean;
  startedAt?: number;
  elapsedMs?: number;
  completedAt?: number;
  error?: string | null;
  delivery?: string;
  context?: ProtocolObject;
  turnId?: string | null;
  itemId?: string;
  kind?: string;
  label?: string;
  activityKey?: string;
  detail?: string | null;
  resultStatus?: string;
}
export interface ContextTransfer {
  id: string;
  reason: string;
  pending: boolean;
  truncated: boolean;
  prefix: RuntimeMessage[];
  sourceThreadIds: string[];
  acknowledgedTurnId?: string;
}
export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  runtime: RuntimeKind;
  threadId: string | null;
  toolContract: ProtocolObject | null;
  messages: RuntimeMessage[];
  messageContexts: Record<string, ProtocolObject>;
  customTitle?: boolean;
  titleGenerated?: boolean;
  runtimeSelection?: ServiceSelection | null;
  runtimeMessages?: AgentMessage[];
  runtimeQueued?: AgentMessage[];
  runtimeCheckpoints?: Record<string, { raw: number; history: number }>;
  contextTransfer?: ContextTransfer | null;
  supersededThreadIds?: string[];
  lastRebind?: { reason: string; at: string };
  forkedFrom?: {
    conversationId: string;
    threadId: string | null;
    messageId: string;
    turnId: string | null;
  };
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
  messageId?: string;
}
export interface ResumeWorkspace {
  workspaceKey: string;
  revisionId?: string | null;
}
export interface AskRequest {
  question: string;
  workspaceKey: string;
  context: ProtocolObject;
  editMessageId?: string | null;
  expectedTurnId?: string | null;
}
export interface ToolHost {
  readonly tools: readonly {
    name: string;
    description: string;
    inputSchema: ProtocolObject;
  }[];
  mode?: string;
  prepare(options?: ProtocolObject): Promise<ProtocolObject>;
  get(name: string): unknown;
  label(name: string): string;
  call(request: ProtocolObject, scope: ProtocolObject): Promise<ProtocolObject>;
  errorPayload(
    error: unknown,
    request?: ProtocolObject,
    scope?: ProtocolObject,
  ): unknown;
}
export interface ContextHost {
  prepare(context: ProtocolObject): ProtocolObject;
  images?(prepared: ProtocolObject): { data: string; mimeType: string }[];
  additionalContext(
    prepared: ProtocolObject,
    options?: ProtocolObject,
  ): ProtocolObject;
}
export interface WorkspaceHost {
  mode?: string;
  prepare(
    revision: string | null | undefined,
    context?: ProtocolObject,
  ): Promise<ProtocolObject>;
  finish(
    work: ProtocolObject,
    options?: ProtocolObject,
  ): Promise<ProtocolObject | null>;
  finishEvent(outcome: ProtocolObject | null): ProtocolObject | null;
  abort(work?: ProtocolObject, options?: ProtocolObject): Promise<unknown>;
}
export interface RuntimeOptions {
  workDir: string;
  profileDir: string;
  sessionStorePath?: string;
  codex?: string;
  runtimeRoot?: string | null;
  codexRoot?: string | null;
  runtimeInstaller?: RuntimeInstaller | null;
  nodeExecutable?: string | null;
  ownProfile?: boolean;
  version?: string;
  ephemeral?: boolean;
  toolHost?: ToolHost | null;
  workspaceHost?: WorkspaceHost | null;
  contextHost?: ContextHost | null;
  developerInstructions?: string | null;
  instructions?: string;
  includeAgentContext?: boolean;
  startOnResume?: boolean;
  captureModelMedia?: boolean;
  captureCodeMode?: boolean;
  resolveProxy?: ((url: string) => Promise<string>) | null;
  networkFetch?:
    ((network: ProtocolObject) => Promise<typeof fetch> | typeof fetch) | null;
  streamFn?: StreamFn;
}
export interface RuntimeSnapshot extends ProtocolObject {
  runtime?: RuntimeKind;
  busy: boolean;
  messages: RuntimeMessage[];
  status: string;
  threadId: string | null;
  conversationId: string | null;
}
export interface BuiltinTurn {
  threadId: string;
  turnId: string;
  work?: ProtocolObject;
  projectId: string;
  revisionId: string | null;
  observationId: string | null;
}
export type BuiltinAgent = Agent;
