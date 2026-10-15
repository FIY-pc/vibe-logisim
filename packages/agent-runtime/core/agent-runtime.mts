import type {
  RuntimeOptions,
  RuntimeKind,
  ConversationRecord,
  ConversationChange,
  ResumeWorkspace,
  AskRequest,
  ProtocolObject,
} from "./types.mts";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodexBackend } from "./codex-backend.mts";
import { BuiltinBackend } from "./builtin-backend.mts";
import { ConversationStore } from "./conversation-store.mts";
import { atomic } from "./builtin-provider.mts";

// One desktop-facing interface; each persisted conversation owns its runtime.
class AgentRuntime extends EventEmitter {
  declare options: RuntimeOptions;
  declare store: ConversationStore;
  declare settingsFile: string;
  declare defaultRuntime: RuntimeKind;
  declare backends: { builtin: BuiltinBackend; codex: CodexBackend };
  declare kind: RuntimeKind;
  declare workspaceKey: string | null;
  declare switching: boolean;
  declare revisionId: string | null | undefined;

  constructor(options: RuntimeOptions) {
    super();
    this.options = options;
    this.store = new ConversationStore(options.sessionStorePath);
    this.settingsFile = path.join(options.profileDir, "runtime-selection.json");
    this.defaultRuntime = "builtin";
    try {
      const settings = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
      if (!["builtin", "codex"].includes(settings.runtime))
        throw new Error("Unknown runtime");
      this.defaultRuntime = settings.runtime;
    } catch (e: any) {
      if (e.code !== "ENOENT")
        throw new Error("运行时设置无法读取，原文件已保留");
    }
    this.store.defaultRuntime = this.defaultRuntime;
    this.backends = {
      builtin: new BuiltinBackend(options),
      codex: new CodexBackend(options),
    };
    this.kind = this.defaultRuntime;
    this.workspaceKey = null;
    this.switching = false;
    for (const [kind, backend] of Object.entries(this.backends)) {
      backend.on("log", (message: any) => this.emit("log", message));
      backend.on("event", (event: any) => {
        if (this.kind === kind)
          this.emit(
            "event",
            event.type === "status" ? { ...event, ...this.snapshot() } : event,
          );
      });
    }
  }
  get active() {
    return this.backends[this.kind];
  }
  get status() {
    return this.active.status;
  }
  get workDir() {
    return this.active.workDir;
  }
  set workDir(value: string) {
    for (const b of Object.values(this.backends)) b.workDir = value;
  }
  set currentCwd(value: string) {
    for (const b of Object.values(this.backends)) b.currentCwd = value;
  }
  get profileDir() {
    return this.options.profileDir;
  }
  get threadId() {
    return this.active.threadId;
  }
  snapshot() {
    return {
      ...this.active.snapshot(),
      runtimeInstall: this.options.runtimeInstaller?.snapshot() || null,
      runtime: this.kind,
      defaultRuntime: this.defaultRuntime,
      busy: this.switching || this.active.snapshot().busy,
    };
  }
  emitStatus() {
    this.emit("event", { type: "status", ...this.snapshot() });
  }
  async start() {
    const downloading =
      this.kind === "codex" &&
      this.options.runtimeInstaller &&
      !this.options.runtimeInstaller.ready();
    const pending = this.active.start();
    if (downloading)
      void pending.catch((error: any) => this.emit("log", error.message));
    else await pending;
    return this.snapshot();
  }
  async stop() {
    await Promise.all(Object.values(this.backends).map((b: any) => b.stop()));
  }
  async activate(kind: RuntimeKind) {
    if (this.kind === kind) return;
    await this.active.stop();
    this.kind = kind;
  }
  recordRuntime(record: ConversationRecord) {
    return record.runtime;
  }
  async resumeWorkspace(info: ResumeWorkspace) {
    const record = this.store.ensure(info.workspaceKey),
      kind = this.recordRuntime(record);
    if (!["builtin", "codex"].includes(kind))
      throw new Error("这条对话的运行时不可用");
    this.workspaceKey = info.workspaceKey;
    this.revisionId = info.revisionId;
    await this.activate(kind);
    // Hydrate local history before starting the process. A missing CLI must
    // prevent sending, not hide the conversation the user just opened.
    const result = await this.active.resumeWorkspace(info);
    if (this.options.startOnResume !== false || kind !== "codex")
      await this.start();
    return result;
  }
  conversationState(key: string) {
    this.store.ensure(key);
    return { workspaceKey: key, ...this.store.state(key) };
  }
  async changeConversation(
    key: string,
    action: string,
    request: ConversationChange,
  ) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    if (action === "fork")
      return this.active.changeConversation(key, action, request);
    const before = this.store.active(key),
      next = this.store.change(key, action, request);
    if (
      action === "new" &&
      !next.conversation.threadId &&
      !next.conversation.messages.length
    )
      this.store.runtimeData(
        key,
        { runtime: this.defaultRuntime },
        next.activeId,
      );
    if (
      next.activeId !== before?.id ||
      this.workspaceKey !== key ||
      this.kind !== this.recordRuntime(this.store.ensure(key))
    ) {
      await this.active.resetWorkspace("conversation-changed");
      await this.resumeWorkspace({
        workspaceKey: key,
        revisionId: this.revisionId,
      });
    }
    const result = this.conversationState(key);
    this.emit("event", {
      type: "conversations-changed",
      activate: next.activeId !== before?.id,
      ...result,
    });
    return result;
  }
  setDefaultRuntime(kind: RuntimeKind) {
    if (!["builtin", "codex"].includes(kind)) throw new Error("未知运行时");
    atomic(this.settingsFile, { runtime: kind });
    this.defaultRuntime = kind;
    this.store.defaultRuntime = kind;
    this.emitStatus();
    return this.snapshot();
  }
  async newRuntimeConversation(kind: RuntimeKind) {
    if (!["builtin", "codex"].includes(kind)) throw new Error("未知运行时");
    if (this.snapshot().busy) throw new Error("请先停止当前回答");
    this.switching = true;
    this.emitStatus();
    try {
      if (this.workspaceKey) {
        const saved = this.store.ensure(this.workspaceKey);
        if (saved.threadId || saved.messages?.length)
          this.store.change(this.workspaceKey, "new");
        const current = this.store.ensure(this.workspaceKey);
        this.store.runtimeData(
          this.workspaceKey,
          { runtime: kind },
          current.id,
        );
        await this.active.resetWorkspace("runtime-changed");
        await this.activate(kind);
        await this.active.resumeWorkspace({
          workspaceKey: this.workspaceKey,
          revisionId: this.revisionId,
        });
      } else await this.activate(kind);
      await this.start();
    } finally {
      this.switching = false;
      this.emitStatus();
    }
    return this.snapshot();
  }
  async ask(request: AskRequest) {
    await this.resumeForAsk(request);
    return this.active.ask(request);
  }
  async resumeForAsk(request: AskRequest) {
    const record = this.store.ensure(request.workspaceKey);
    if (
      this.recordRuntime(record) !== this.kind ||
      this.active.workspaceKey !== request.workspaceKey
    )
      await this.resumeWorkspace({
        workspaceKey: request.workspaceKey,
        revisionId: request.context?.revisionId,
      });
  }
  async resetWorkspace(reason: any) {
    await this.active.resetWorkspace(reason);
    this.workspaceKey = null;
  }
  async login() {
    if (this.kind !== "codex") await this.newRuntimeConversation("codex");
    return this.backends.codex.login();
  }
  async cancelLogin() {
    return this.backends.codex.cancelLogin();
  }
  async logout() {
    if (this.kind !== "codex") throw new Error("请先切换到 Codex 运行时");
    return this.backends.codex.logout();
  }

  listModels(refresh = false) {
    return this.active.listModels(refresh);
  }
  selectModel(selection: ProtocolObject | null) {
    return this.active.selectModel(selection);
  }
  bindProvider(request: ProtocolObject) {
    return this.active.bindProvider(request);
  }
  defaultProvider(request: ProtocolObject) {
    return this.active.defaultProvider(request);
  }
  reconnect() {
    return this.active.reconnect();
  }
  canReconnect() {
    return this.active.canReconnect();
  }
  networkStatus(url?: string) {
    return this.active.networkStatus(url);
  }
  probeCustomProvider(action: string, input: ProtocolObject) {
    return this.active.probeCustomProvider(action, input);
  }
  configureCustomProvider(input: ProtocolObject) {
    return this.active.configureCustomProvider(input);
  }
  clearCustomProvider(input: ProtocolObject = {}) {
    return this.active.clearCustomProvider(input);
  }
  capabilityReport() {
    return this.active.capabilityReport();
  }
  invalidateRevision(revision?: string) {
    return this.active.invalidateRevision(revision);
  }
  setChangeMode(mode: string) {
    return this.active.setChangeMode(mode);
  }
  answer(requestId: string, answers: ProtocolObject) {
    return this.active.answer(requestId, answers);
  }
  interrupt() {
    return this.active.interrupt();
  }
}
export { AgentRuntime };
