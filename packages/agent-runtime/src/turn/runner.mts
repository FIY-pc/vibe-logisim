/**
 * One conversation at a time on one model service: the TurnRunner owns the
 * pi-agent-core Agent for the current turn, the conversation's UI history and
 * model transcript, the service selection, and the per-turn folder
 * checkpoint. The worker (worker.mts) dispatches UI methods onto it.
 *
 * A turn: `ask` builds the tool set (file tools rooted at the folder plus the
 * circuit tools), prepends the workspace context to the question, runs the
 * Agent and streams its events to the UI as RuntimeEvents. When the turn
 * ends, `folderCheckpoint` records every file the turn changed as one
 * undoable history entry and the UI is told (`files-changed`).
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { ServiceStore, modelFor, transport } from "../models/services.mts";
import {
  ModelCatalog,
  URL as CATALOG_URL,
  providerFor,
} from "../models/catalog.mts";
import { discoverModels } from "../models/probe.mts";
import { loadSdk } from "../models/sdk-loader.mts";
import {
  configurationIssue,
  recoverHistory,
  sameService,
  selectionFor,
} from "../models/selection.mts";
import type { ServiceConfig, ServiceSelection } from "../models/types.mts";
import { resolveSystemProxy } from "../network/system-proxy.mts";
import { networkFetch, systemProxy } from "../network/fetch.mts";
import { ConversationStore } from "../conversations/store.mts";
import type {
  ConversationRecord,
  RuntimeMessage,
} from "../conversations/types.mts";
import type { StoredReference } from "../conversations/reference-types.ts";
import { fileTools } from "../tools/files.mts";
import { circuitTools, TOOL_LABELS } from "../tools/index.mts";
import { ToolContext } from "../tools/context.mts";
import { toolActivity } from "./activity.mts";
import {
  CHARS_PER_TOKEN,
  clearOldToolOutput,
  contextSize,
} from "./context-budget.mts";
import { systemInstructions } from "./instructions.mts";
import type {
  FolderChange,
  HostClient,
  HostFolder,
  HostStatus,
} from "../protocol/host.mts";
import type { RuntimeEvent } from "../protocol/messages.mts";

export interface RunnerOptions {
  host: HostClient;
  /** `<state>/profile`: service registry and model metadata cache. */
  profileDir: string;
  /** `<state>/conversations.json`. */
  conversationsFile: string;
  /** Where the bundled Java runtime lives, for exec_command's PATH; optional. */
  runtimeRoot?: string | null;
  /** Replaces the system prompt entirely (tests). */
  instructions?: string | null;
}

/** What the UI asked, with everything the turn needs resolved. */
export interface AskRequest {
  question: string;
  references: StoredReference[];
  documentId: string | null;
  circuit: string | null;
  selection: string[];
  /** Resend from this user message: history and transcript are cut back first. */
  editMessageId?: string | null;
}

interface PendingTurn {
  turnId: string;
  conversationId: string;
  folder: HostFolder;
}

/** Called in `ask` from the model transcript so an interrupted call never looks finished. */
export function recoverTranscript(messages: AgentMessage[]): AgentMessage[] {
  const results = new Set(
    messages
      .filter((m: any) => m.role === "toolResult")
      .map((m: any) => m.toolCallId),
  );
  return messages.flatMap((m: any) => [
    m,
    ...(m.role === "assistant"
      ? (m.content || [])
          .filter((c: any) => c.type === "toolCall" && !results.has(c.id))
          .map((c: any) => ({
            role: "toolResult" as const,
            toolCallId: c.id,
            toolName: c.name,
            content: [
              {
                type: "text" as const,
                text: "应用在这次调用完成前退出，结果未知。请先检查工作区，不要直接重复有副作用的操作。",
              },
            ],
            isError: true,
            timestamp: Date.now(),
          }))
      : []),
  ]);
}

/** Relay overload answers come back as HTTP 400; make them retryable 503s for pi's retry loop. */
export function retryableFetch(
  fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status !== 400) return response;
    const text = await response.clone().text();
    if (
      !/overloaded|rate limit|too many requests|try again later|繁忙|稍后/i.test(
        text,
      )
    )
      return response;
    console.error("[model] overloaded answer, retrying: " + text.slice(0, 200));
    return new Response(text, {
      status: 503,
      statusText: "Service Unavailable",
      headers: response.headers,
    });
  };
}

type Sdk = Awaited<ReturnType<typeof loadSdk>>;
const STREAM_RETRY = {
  enabled: true,
  maxRetries: 6,
  baseDelayMs: 2000,
  maxAgentDelayMs: 30_000,
};

/** A gateway that loses its upstream answers HTTP 200 and then an error event
 * inside the stream, which no HTTP-level retry sees and the Agent reports as
 * a failed turn. Restart the request with backoff while nothing but the
 * opening event has reached the UI; an error after visible text is passed
 * through as before, so no text is shown twice. */
export function retryingStream(
  produce: () => AsyncIterable<any> | Promise<AsyncIterable<any>>,
  sdk: Pick<
    Sdk,
    "AssistantMessageEventStream" | "isRetryableAssistantError" | "retryDelayMs"
  >,
  signal: AbortSignal | undefined,
  report: {
    scheduled(attempt: number, max: number, delayMs: number): void;
    started(): void;
  },
) {
  const out = new sdk.AssistantMessageEventStream();
  (async () => {
    let started = false;
    for (let attempt = 0; ; attempt++) {
      let visible = false;
      let final: any = null;
      try {
        for await (const event of await produce()) {
          if (event.type === "start") {
            if (!started) {
              started = true;
              out.push(event);
            }
            continue;
          }
          if (event.type === "done" || event.type === "error") {
            final = event;
            break;
          }
          visible = true;
          out.push(event);
        }
      } catch (e: any) {
        final = {
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: e?.message || String(e),
            timestamp: Date.now(),
          },
        };
      }
      if (!final) {
        out.end();
        return;
      }
      const message = final.type === "done" ? final.message : final.error;
      if (
        final.type !== "error" ||
        visible ||
        signal?.aborted ||
        attempt >= STREAM_RETRY.maxRetries ||
        !sdk.isRetryableAssistantError(message)
      ) {
        out.push(final);
        out.end();
        return;
      }
      const delayMs = sdk.retryDelayMs(STREAM_RETRY, attempt + 1);
      report.scheduled(attempt + 1, STREAM_RETRY.maxRetries, delayMs);
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), delayMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });
      report.started();
      if (aborted) {
        const { errorMessage: _e, ...rest } = message;
        out.push({
          type: "error",
          reason: "aborted",
          error: { ...rest, stopReason: "aborted" },
        });
        out.end();
        return;
      }
    }
  })();
  return out;
}

/** SDK and transport failures arrive in English. Say what went wrong in
 * Chinese and keep the original text after it for diagnosis. */
const FAILURES: [RegExp, string][] = [
  [
    /\b401\b|unauthori[sz]ed|invalid.*(api[ _-]?key|token)|incorrect api key|authentication/i,
    "模型服务拒绝了 API 密钥",
  ],
  [/\b403\b|forbidden|permission denied/i, "模型服务拒绝了这次请求"],
  [
    /\b404\b|does not exist|not found|no such model|unknown model/i,
    "模型服务找不到这个模型或接口",
  ],
  [
    /\b429\b|rate limit|too many requests|quota|insufficient/i,
    "模型服务限流或额度不足",
  ],
  [
    /overloaded|\b5\d\d\b|service unavailable|bad gateway|server error/i,
    "模型服务暂时不可用",
  ],
  [/timed? ?out|timeout|ETIMEDOUT/i, "模型服务响应超时"],
  [
    /terminated|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|connection/i,
    "与模型服务的连接中断",
  ],
];
function failureText(message: string) {
  if (/[\u4e00-\u9fff]/.test(message)) return message;
  const known = FAILURES.find(([pattern]) => pattern.test(message));
  return known ? `${known[1]}（${message}）` : message;
}

export class TurnRunner extends EventEmitter {
  readonly services: ServiceStore;
  readonly conversations: ConversationStore;
  readonly catalog: ModelCatalog;
  private readonly host: HostClient;
  private readonly runtimeRoot: string | null;
  private readonly instructionsOverride: string | null;

  status: "idle" | "ready" | "auth-required" | "busy" | "stopped" = "idle";
  /** The conversation scope the UI bound: the folder id. */
  workspaceKey: string | null = null;
  conversationId: string | null = null;
  activeTurnId: string | null = null;
  history: RuntimeMessage[] = [];
  transcript: AgentMessage[] = [];
  checkpoints: Record<string, { raw: number; history: number }> = {};
  selection: ServiceSelection | null = null;
  /** The stream retry notice while the model service is busy; null otherwise. */
  transmission: { phase: string; message: string | null } | null = null;
  network: Record<string, unknown> | null = null;
  private agent: Agent | undefined;
  private pending: PendingTurn | null = null;
  private run: Promise<void> | null = null;
  private starting = false;
  private cancelStarting = false;
  private messageId = "";
  private partialText = "";
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private runError: string | null = null;

  constructor(options: RunnerOptions) {
    super();
    this.host = options.host;
    this.runtimeRoot = options.runtimeRoot ?? null;
    this.instructionsOverride = options.instructions ?? null;
    this.services = new ServiceStore(options.profileDir);
    this.conversations = new ConversationStore(options.conversationsFile);
    this.catalog = new ModelCatalog({
      profileDir: options.profileDir,
      fetchMetadata: async () =>
        networkFetch(await this.resolveNetwork(CATALOG_URL)),
      fetchProvider: (c: any) => this.requestFetch(c),
      onUpdate: () => this.emitStatus(),
    });
  }

  // ---- status -----------------------------------------------------------

  snapshot() {
    const config = this.services.visibleSelection(this.selection);
    const selected = this.selection || config;
    const issue = configurationIssue(
      this.selection,
      config,
      this.history.some((m) => m.type === "user"),
    );
    return {
      status: this.status,
      available: this.status === "ready" || this.status === "busy",
      busy: this.starting || Boolean(this.run) || Boolean(this.pending),
      conversationId: this.conversationId,
      model: selected?.model || null,
      effort: selected?.effort === "none" ? null : (selected?.effort ?? null),
      customProvider: config,
      services: this.services.list(),
      defaultServiceId: this.services.registry().defaultId,
      network: this.network,
      transmission: this.transmission,
      modelConfigurationError: issue,
      modelCatalog: this.catalog.status(this.services.resolve(this.selection)),
    };
  }
  /** The conversation as the window shows it. */
  messages() {
    return this.history.map((m) => ({
      ...m,
      canEdit: m.type === "user" && Boolean(this.checkpoints[m.id]),
    }));
  }
  /** The snapshot plus the whole conversation: what a window loads once
   * (binding, switching conversations, after missing events); afterwards
   * events carry every change. */
  historySnapshot() {
    return { ...this.snapshot(), messages: this.messages() };
  }
  emitStatus() {
    this.emit("event", { type: "status", ...this.snapshot() });
  }
  private emitEvent(event: RuntimeEvent) {
    this.emit("event", event);
  }
  /** Tells the window the conversation was replaced. */
  private emitHistory() {
    this.emitEvent({ type: "history", messages: this.messages() });
  }
  /** Tells the window one conversation entry was added or replaced. */
  private emitMessage(message: RuntimeMessage) {
    this.emitEvent({ type: "message", message: { ...message } });
  }
  async start() {
    this.status = this.services.resolve(this.selection)
      ? "ready"
      : "auth-required";
    this.emitStatus();
    return this.snapshot();
  }
  async reconnect() {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    return this.start();
  }
  async stop() {
    await this.interrupt();
    this.status = "stopped";
    this.emitStatus();
  }
  async interrupt() {
    this.cancelStarting = true;
    this.agent?.abort();
    if (this.run) await this.run;
    return { interrupted: true };
  }

  // ---- network ----------------------------------------------------------

  private resolveNetwork(url?: string) {
    return resolveSystemProxy({
      targetUrl: url || this.services.visible()?.baseUrl,
      env: process.env,
      resolver: systemProxy,
    });
  }
  private async requestFetch(config: { baseUrl: string }) {
    this.network = await this.resolveNetwork(config.baseUrl);
    return networkFetch(this.network as any);
  }

  // ---- services and models ---------------------------------------------

  /** `discover` lists the service's models; `test` runs one tiny completion. */
  async probeService(
    action: "discover" | "test",
    input: Partial<ServiceConfig>,
  ) {
    try {
      const config = this.services.validate({
        ...input,
        model: input.model || "probe",
      });
      const fetch = await this.requestFetch(config);
      if (action === "discover") {
        const data = await discoverModels({
          ...config,
          fetch,
          network: this.network,
        });
        return { ok: true, models: data?.models || null };
      }
      const { normalizeContext } =
        await import("@earendil-works/pi-ai/utils/transcript");
      const api = await transport(config.api);
      const started = Date.now();
      const output = await api.streamSimple(
        modelFor(config, this.catalog.metadataFor(config, config.model)),
        normalizeContext({
          messages: [
            { role: "user", content: "Reply OK.", timestamp: Date.now() },
          ],
        }),
        {
          apiKey: config.apiKey,
          fetch,
          signal: AbortSignal.timeout(30000),
          maxTokens: 64,
          reasoning: config.effort === "none" ? undefined : config.effort,
        },
      );
      const response = await output.result();
      if (["error", "aborted"].includes(response.stopReason))
        throw new Error(response.errorMessage || "连接检测失败");
      return { ok: true, elapsedMs: Date.now() - started };
    } catch (e: any) {
      return { ok: false, code: "connection", message: e.message };
    }
  }
  async configureService(settings: Partial<ServiceConfig>) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    const next = this.services.save(settings);
    if (this.selection && this.selection.serviceId === next.id) {
      this.selection = {
        ...this.selection,
        vision: next.vision,
        contextWindow: next.contextWindow,
      };
      this.persist();
    }
    // A blank conversation can use the newly added service; existing history never moves.
    if (!this.history.some((m) => m.type === "user") && this.workspaceKey) {
      this.selection = selectionFor(this.services.read(next.id));
      this.persist();
    }
    return this.start();
  }
  async removeService(settings: { id?: string } = {}) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    this.services.clear(settings.id);
    return this.start();
  }
  async defaultService(settings: { id: string }) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    this.services.setDefault(settings.id);
    this.emitStatus();
    return this.snapshot();
  }
  async listModels(refresh = false) {
    const c = this.services.resolve(this.selection);
    const scope = this.conversationId;
    if (refresh) await this.catalog.refresh(c);
    else if (providerFor(c)) void this.catalog.refreshMetadata();
    // An async refresh must never return rows for a different conversation or service.
    const current = this.services.resolve(this.selection);
    if (
      scope !== this.conversationId ||
      c?.id !== current?.id ||
      c?.baseUrl !== current?.baseUrl ||
      c?.apiKey !== current?.apiKey
    )
      throw new Error("模型服务已变化，请重新打开列表");
    const state = this.snapshot();
    return {
      state,
      models: state.modelConfigurationError
        ? []
        : this.catalog.rows(current, this.selection || current),
      warning: state.modelCatalog.error,
    };
  }
  async selectModel(selection: { model: string; effort?: string } | null) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    const c = this.services.resolve(this.selection);
    const issue = configurationIssue(
      this.selection,
      c,
      this.history.some((m) => m.type === "user"),
    );
    if (issue) throw new Error(issue.message);
    if (
      !c ||
      !this.catalog
        .rows(c, this.selection || c)
        .some((m: any) => m.model === selection?.model)
    )
      throw new Error("请选择当前服务的模型");
    const next = {
      ...this.services.validate({
        ...c,
        model: selection!.model,
        effort: (selection!.effort || "none") as any,
      }),
      id: c.id,
    };
    if (this.workspaceKey) {
      this.selection = selectionFor(next);
      this.persist();
    } else this.services.save(next);
    this.emitStatus();
    return this.snapshot();
  }
  async bindService(request: {
    id?: string;
    conversationId?: string;
    baseUrl?: string;
    api?: string;
  }) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    const c = this.services.read(request?.id);
    if (
      !this.workspaceKey ||
      request?.conversationId !== this.conversationId ||
      !c ||
      !sameService(request, c)
    )
      throw new Error("会话或服务已变化，请重试");
    this.selection = selectionFor(c);
    this.persist();
    return this.start();
  }

  // ---- conversations ----------------------------------------------------

  conversationState(key: string) {
    this.conversations.ensure(key);
    return { workspaceKey: key, ...this.conversations.state(key) };
  }
  /** Loads the active conversation of a scope (the folder id) into memory. */
  async resume(workspaceKey: string) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    const saved: ConversationRecord = this.conversations.ensure(workspaceKey);
    this.workspaceKey = workspaceKey;
    this.conversationId = saved.id;
    this.selection = saved.selection || null;
    this.history = recoverHistory(saved.messages || []);
    this.transmission = null;
    this.transcript = recoverTranscript(saved.transcript || []);
    this.checkpoints = saved.checkpoints || {};
    if (
      JSON.stringify(this.history) !== JSON.stringify(saved.messages || []) ||
      this.selection?.serviceId !== saved.selection?.serviceId
    )
      this.persist();
    this.emitEvent({
      type: "conversations-changed",
      activate: true,
      ...this.conversationState(workspaceKey),
    });
    this.emitHistory();
    this.emitStatus();
  }
  async changeConversation(key: string, action: string, request: any) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    this.conversations.change(key, action, request);
    await this.resume(key);
    return this.conversationState(key);
  }
  /** The window undid a turn's file change in the folder history. */
  markUndone(changeId: string) {
    const turn = this.history.find(
      (m) => m.type === "turn" && m.change?.id === changeId,
    );
    if (!turn?.change) throw new Error("这次改动不在当前对话里");
    turn.change = { ...turn.change, undone: true };
    this.persist();
    this.emitStatus();
    return { undone: true };
  }
  persist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.workspaceKey) return;
    const active = this.history.find(
      (m) =>
        m.type === "turn" &&
        m.id === this.activeTurnId &&
        m.status === "running",
    );
    if (active)
      active.elapsedMs = Date.now() - (active.startedAt || Date.now());
    this.conversations.remember(this.workspaceKey, {
      messages: this.history,
      expectedId: this.conversationId,
      data: {
        selection: this.selection,
        transcript: this.transcript,
        checkpoints: this.checkpoints,
      },
    });
  }

  // ---- turns ------------------------------------------------------------

  /** The message the model receives: the question plus what the app knows. */
  private async workspaceContext(request: AskRequest, status: HostStatus) {
    const current = request.documentId
      ? status.documents.find((d) => d.id === request.documentId)
      : null;
    return {
      folder: status.folder
        ? { path: status.folder.path, name: status.folder.name }
        : null,
      openDocuments: status.documents.map((d) => ({
        id: d.id,
        path: d.path,
        name: d.name,
        main: d.main,
        circuits: d.circuits,
      })),
      currentDocument: current
        ? { id: current.id, path: current.path, circuit: request.circuit }
        : null,
      selection: request.selection,
      references: request.references.map(
        ({ image: _image, workspaceKey: _key, text, ...rest }) => ({
          ...rest,
          text,
        }),
      ),
    };
  }
  private userContent(
    question: string,
    context: unknown,
    images: { data: string; mimeType: string }[],
  ) {
    const text =
      question +
      "\n\n<workspace_context>\n" +
      JSON.stringify(context) +
      "\n</workspace_context>";
    return images.length
      ? [
          { type: "text" as const, text },
          ...images.map((image) => ({ type: "image" as const, ...image })),
        ]
      : text;
  }
  private referenceImages(references: StoredReference[]) {
    return references
      .filter((r) => r.image)
      .map((r) => ({
        data: r.image!.replace(/^data:image\/png;base64,/, ""),
        mimeType: "image/png",
      }));
  }

  async ask(request: AskRequest) {
    const status = await this.host.call<HostStatus>({
      op: "status",
      summary: true,
    });
    if (!status.folder) throw new Error("请先打开工作文件夹");
    const images = this.referenceImages(request.references);
    if (this.snapshot().busy) throw new Error("请先等待或停止当前回答");
    const workspaceKey = status.folder.id;
    if (
      this.workspaceKey !== workspaceKey ||
      this.conversationId !== this.conversations.ensure(workspaceKey).id
    )
      await this.resume(workspaceKey);
    const service = this.services.resolve(this.selection);
    const issue = configurationIssue(
      this.selection,
      service,
      this.history.some((m) => m.type === "user"),
    );
    if (issue) throw new Error(issue.message);
    if (!service) throw new Error("请先添加模型服务");
    this.selection ||= selectionFor(service);
    const config = { ...service, ...this.selection };
    if (images.length && !config.vision)
      throw new Error(
        "当前模型服务未启用图片输入，请开启后重试，或移除图片引用",
      );
    this.starting = true;
    this.cancelStarting = false;
    this.emitStatus();
    try {
      const sdk = await loadSdk();
      const { Agent, createInitialSystemMessage, toToolDeclaration } = sdk;
      const api = await transport(config.api);
      const fetch = retryableFetch(await this.requestFetch(config));
      if (this.cancelStarting) throw new Error("已停止");
      if (request.editMessageId) {
        const point = this.checkpoints[request.editMessageId];
        if (!point) throw new Error("这条消息没有可编辑的运行记录");
        this.transcript = this.transcript.slice(0, point.raw);
        this.history = this.history.slice(0, point.history);
        this.checkpoints = Object.fromEntries(
          Object.entries(this.checkpoints).filter(
            ([, p]) => p.history < point.history,
          ),
        );
        this.emitHistory();
      }
      // The user's own edits before this turn get their own history entry so
      // the turn's checkpoint holds only what the AI changed.
      await this.host
        .call({
          op: "folderCheckpoint",
          folder_id: status.folder.id,
          title: "文件改动",
        })
        .catch(() => undefined);
      const turnId = randomUUID();
      const pending: PendingTurn = {
        turnId,
        conversationId: this.conversationId!,
        folder: status.folder,
      };
      this.activeTurnId = turnId;
      this.pending = pending;
      const assertCurrent = () => {
        if (this.pending !== pending || this.agent?.signal?.aborted)
          throw new Error("工具调用已停止或过期");
      };
      const context = new ToolContext({
        host: this.host,
        folder: status.folder,
        emit: (event) => this.emitEvent(event),
        assertCurrent,
        userDocumentId: request.documentId,
        userCircuit: request.circuit,
      });
      const tools = [
        ...fileTools({
          root: status.folder.path,
          runtimeRoot: this.runtimeRoot,
          assertCurrent,
        }),
        ...circuitTools({ context, vision: config.vision }),
      ];
      const instructions = systemInstructions(this.instructionsOverride);
      if (this.transcript[0]?.role === "system")
        this.transcript = [
          createInitialSystemMessage(
            instructions,
            tools.map(toToolDeclaration),
          )!,
          ...this.transcript.slice(1),
        ];
      const userId = randomUUID();
      this.checkpoints[userId] = {
        raw: this.transcript.length,
        history: this.history.length,
      };
      const frozen = {
        documentId: request.documentId,
        circuit: request.circuit,
        selection: request.selection,
        references: request.references.map(
          ({ text: _t, image: _i, workspaceKey: _k, ...r }) => r,
        ),
      };
      this.history.push({
        type: "user",
        id: userId,
        text: request.question,
        context: frozen,
      });
      this.emitEvent({
        type: "user-message",
        id: userId,
        text: request.question,
        context: frozen,
        canEdit: true,
      });
      this.transmission = null;
      const record: RuntimeMessage = {
        type: "turn",
        id: turnId,
        status: "running",
        startedAt: Date.now(),
      };
      this.history.push(record);
      this.emitMessage(record);
      // Earlier turns' tool output is the first thing to go when the
      // conversation outgrows the model's context (see context-budget.mts).
      const budget = config.contextWindow * CHARS_PER_TOKEN;
      this.transcript = clearOldToolOutput(this.transcript, budget);
      this.agent = new Agent({
        initialState: {
          model: modelFor(
            config,
            this.catalog.metadataFor(config, config.model),
          ),
          systemPrompt: instructions,
          messages: this.transcript,
          tools,
          thinkingLevel: config.effort === "none" ? "off" : config.effort,
        },
        toolExecution: "sequential",
        maxRetryDelayMs: 30_000,
        streamFn: (model: any, ctx: any, opts: any) =>
          retryingStream(
            () =>
              api.streamSimple(model, ctx, {
                ...opts,
                apiKey: config.apiKey,
                fetch,
                maxTokens: 8192,
                maxRetries: 8,
              }),
            sdk,
            opts?.signal,
            {
              scheduled: (attempt, max, delayMs) => {
                this.transmission = {
                  phase: "retrying",
                  message: `模型服务繁忙，${Math.ceil(delayMs / 1000)} 秒后重试（${attempt}/${max}）`,
                };
                this.emitStatus();
              },
              started: () => {
                this.transmission = null;
                this.emitStatus();
              },
            },
          ),
        prepareRequest: ({ context: requestContext }: any) => {
          // Old tool output is cleared within a long turn as well; the
          // instructions and tool declarations take their share first.
          const room =
            budget - JSON.stringify({ ...requestContext, messages: [] }).length;
          const messages = clearOldToolOutput(requestContext.messages, room);
          if (contextSize(messages) > room)
            throw new Error(
              "这次对话的内容超过了模型的上下文长度，请新建对话后继续",
            );
          return messages === requestContext.messages
            ? undefined
            : { context: { ...requestContext, messages } };
        },
      });
      this.agent.subscribe((e: any) => {
        if (this.pending === pending && this.activeTurnId === pending.turnId)
          this.onAgentEvent(e);
      });
      this.persist();
      this.status = "busy";
      this.starting = false;
      this.emitStatus();
      this.emitEvent({ type: "turn-started", turnId });
      const prompt: AgentMessage = {
        role: "user",
        content: this.userContent(
          request.question,
          await this.workspaceContext(request, status),
          images,
        ),
        timestamp: Date.now(),
      };
      this.run = this.runTurn(prompt, pending, request.question);
      return { turnId };
    } catch (e) {
      this.starting = false;
      this.pending = null;
      this.activeTurnId = null;
      this.status = "ready";
      this.emitStatus();
      throw e;
    }
  }

  private onAgentEvent(e: any) {
    if (!this.agent) return;
    const turnId = this.activeTurnId;
    if (e.type === "message_start" && e.message.role === "assistant") {
      this.messageId = randomUUID();
      this.partialText = "";
      this.emitEvent({
        type: "assistant-started",
        itemId: this.messageId,
        turnId,
      });
    }
    if (e.type === "message_update") {
      const delta = e.assistantMessageEvent;
      if (delta.type === "text_delta") {
        this.partialText += delta.delta;
        let m = this.history.find((m) => m.id === this.messageId);
        if (!m) {
          m = {
            type: "assistant",
            id: this.messageId,
            text: "",
            phase: "commentary",
          };
          this.history.push(m);
        }
        m.text = this.partialText;
        this.persistSoon();
        this.emitEvent({
          type: "assistant-delta",
          itemId: this.messageId,
          turnId,
          delta: delta.delta,
        });
      }
      if (delta.type === "thinking_delta") {
        const id = this.messageId + ":reasoning";
        let m = this.history.find((m) => m.id === id);
        if (!m) {
          m = { type: "reasoning", id, text: "" };
          this.history.push(m);
        }
        m.text += delta.delta;
        this.persistSoon();
        this.emitEvent({
          type: "reasoning-delta",
          itemId: id,
          turnId,
          delta: delta.delta,
        });
      }
    }
    if (
      [
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
      ].includes(e.type)
    ) {
      const activity: RuntimeMessage = {
        type: "activity",
        id: turnId + ":" + e.toolCallId,
        itemId: e.toolCallId,
        turnId,
        kind: "tool",
        label: TOOL_LABELS[e.toolName] || e.toolName,
        activityKey: "tool:" + e.toolName,
      };
      const existing = this.history.find(
        (m) => m.type === "activity" && m.id === activity.id,
      );
      if (
        existing &&
        existing.status !== "running" &&
        e.type !== "tool_execution_end"
      )
        return;
      Object.assign(activity, toolActivity(e, existing));
      if (existing) Object.assign(existing, activity);
      else this.history.push(activity);
      this.persistSoon();
      this.emitEvent(activity as any);
    }
    if (e.type === "turn_end" && this.checkpoints[this.messageId]) {
      this.checkpoints[this.messageId].raw = this.agent.state.messages.length;
      this.transcript = this.agent.state.messages;
      this.persistSoon();
    }
    if (e.type === "message_end") {
      if (e.message.role === "assistant") {
        const thought = this.history.find(
          (m) => m.id === this.messageId + ":reasoning",
        );
        if (thought)
          this.emitEvent({
            type: "assistant-completed",
            itemId: thought.id,
            turnId,
            text: thought.text!,
            phase: "commentary",
          });
        const text = (e.message.content || [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        const phase = (e.message.content || []).some(
          (c: any) => c.type === "toolCall",
        )
          ? "commentary"
          : "final";
        if (text) {
          const existing = this.history.find((m) => m.id === this.messageId);
          if (existing) Object.assign(existing, { text, phase });
          else
            this.history.push({
              type: "assistant",
              id: this.messageId,
              text,
              phase,
            });
        }
        this.emitEvent({
          type: "assistant-completed",
          itemId: this.messageId,
          turnId,
          text,
          phase,
        });
        if (["error", "aborted", "length"].includes(e.message.stopReason))
          this.runError =
            e.message.errorMessage ||
            (e.message.stopReason === "length"
              ? "模型输出达到长度限制，任务尚未完成"
              : "运行已停止");
        if (text)
          this.checkpoints[this.messageId] = {
            history: this.history.length,
            raw: this.agent.state.messages.length,
          };
      }
      this.transcript = this.agent.state.messages;
      this.persistSoon();
    }
  }
  /**
   * Saves the conversation within half a second. A running turn's events
   * (deltas, tool starts and ends, messages) are saved this way, not one by
   * one: every save writes the whole conversation store. The turn's end
   * saves at once.
   */
  private persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.persist();
      } catch (error: any) {
        // The turn's own save at its end reports the failure.
        console.error("conversation save failed:", error?.message ?? error);
      }
    }, 500);
  }

  private async runTurn(
    prompt: AgentMessage,
    pending: PendingTurn,
    question: string,
  ) {
    if (!this.agent) throw new Error("运行时未准备好");
    this.runError = null;
    let status = "completed";
    let error: string | null = null;
    try {
      await this.agent.prompt(prompt);
      if (this.agent.signal?.aborted) throw new Error("已停止");
      if (this.runError) throw new Error(this.runError);
    } catch (e: any) {
      status =
        this.agent.signal?.aborted || this.cancelStarting
          ? "interrupted"
          : "failed";
      error = status === "interrupted" ? "已停止" : failureText(e.message);
    } finally {
      let change: FolderChange | null = null;
      try {
        this.transcript = [...this.agent.state.messages];
        this.persist();
        // Everything the turn changed on disk becomes one undoable entry.
        const recorded = await this.host.call<{ change: FolderChange | null }>({
          op: "folderCheckpoint",
          folder_id: pending.folder.id,
          title: question.replace(/\s+/g, " ").trim().slice(0, 40) || "AI 修改",
        });
        change = recorded?.change ?? null;
        if (change)
          this.emitEvent({
            type: "files-changed",
            folderId: pending.folder.id,
            conversationId: pending.conversationId,
            change,
          });
      } catch (e: any) {
        status = "failed";
        error = "工作区刷新或会话保存失败：" + e.message;
      }
      this.pending = null;
      this.activeTurnId = null;
      this.run = null;
      this.status = "ready";
      const turn = this.history.find(
        (m) => m.type === "turn" && m.id === pending.turnId,
      );
      // The record says how the turn ended, how long it took and which
      // files it changed, so a reloaded window shows what the live one did.
      if (turn) {
        Object.assign(turn, {
          status,
          error,
          elapsedMs: Date.now() - (turn.startedAt || Date.now()),
          ...(change ? { change } : {}),
        });
        this.emitMessage(turn);
      }
      for (const m of this.history)
        if (
          m.type === "activity" &&
          m.turnId === pending.turnId &&
          m.status === "running"
        ) {
          m.status = "warning";
          m.resultStatus = "unknown";
          m.detail = [m.detail, "调用未确认结束，结果未知。"]
            .filter(Boolean)
            .join("\n");
          this.emitEvent(m as any);
        }
      try {
        this.persist();
      } catch (e: any) {
        status = "failed";
        error = "会话保存失败：" + e.message;
      }
      this.transmission = null;
      this.emitStatus();
      this.emitEvent({
        type: "turn-completed",
        turnId: pending.turnId,
        status,
        error,
      });
    }
  }
}
