"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const GRACEFUL_STOP_MS = 1_500;
const FORCED_STOP_MS = 2_000;
const {ConversationStore}=require('./conversation-store.cjs');
const {forkThroughReply}=require('./conversation-fork.cjs');
const {splitContext,keptObservationContext,materialContext}=require("./conversation-context.cjs");
const MAX_CONTEXT_BYTES = 512 * 1024;
const DISABLED_CODEX_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "network_proxy",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "shell_snapshot",
  "shell_snapshot_v2",
  "skill_mcp_dependency_install",
  "sleep_tool",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "workspace_dependencies",
];
const THREAD_CONFIG = Object.freeze({
  ...Object.fromEntries(DISABLED_CODEX_FEATURES.map((feature) => [`features.${feature}`, false])),
  "features.memories": false,
  "features.code_mode": true,
  "features.code_mode_host": true,
  web_search: "live",
  "shell_environment_policy.inherit": "core",
  allow_login_shell: false,
});

const { CircuitPlugin } = require("./circuit-plugin.cjs");
const { writeProvider } = require("./provider-config.cjs");
const {isolatedSpawn, resolveExecutable} = require("./agent-process.cjs");
const { AgentModels } = require("./agent-models.cjs");
const { classifyModelError } = require("./model-errors.cjs");
const { TurnHealth } = require("./turn-health.cjs");
const { revertThroughMessage } = require("./conversation-edit.cjs");
const { dynamicToolResponse, modelMediaEvidence } = require("./model-tool-output.cjs");
const { DEVELOPER_INSTRUCTIONS } = require('./agent-instructions.cjs');

function delay(milliseconds, value) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), milliseconds);
    timer.unref?.();
  });
}

function plainError(error, fallback = "Codex request failed.") {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

function shortText(value, limit = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function commandActivityLabel(command) {
  const value = String(command ?? "").trim();
  if (!value) return "执行本地操作";
  if (/\b(rg|grep|find|ls|fd|cat|head|tail|sed|awk|pwd|sha256sum|git\s+(?:status|diff|log|show))\b/.test(value)) {
    return "查阅工程资料";
  }
  if (/\b(?:node|npm|npx|python(?:3)?|pytest|javac|java|cargo|go)\b/.test(value)) {
    return "运行本地检查";
  }
  if (/\bgit\s+(?:add|commit|checkout|restore)\b/.test(value)) {
    return "处理工程改动";
  }
  return "执行本地操作";
}

function itemErrorText(item) {
  if (item?.success !== false && item?.status !== "failed") return null;
  const content = Array.isArray(item?.contentItems)
    ? item.contentItems.map((entry) => entry?.text || entry?.message || "").filter(Boolean).join("\n")
    : "";
  let structured = null;
  try {
    const parsed = JSON.parse(content);
    structured = parsed?.error || null;
  } catch {}
  const message = structured?.message || item?.error?.message || content || item?.message || "这次操作没有完成";
  const details = [message];
  if (structured?.hint) details.push(`建议：${structured.hint}`);
  if (Array.isArray(structured?.availableInputs) && structured.availableInputs.length) {
    details.push(`可用输入：${structured.availableInputs.join("、")}`);
  }
  return shortText(details.join(" "), 500);
}

function isMissingThreadError(error) {
  return Number(error?.code) === -32600 && /no rollout found|thread.+not found|unknown thread/i.test(error.message || "");
}

function workspaceChangedError() {
  const error = new Error("电路工作区已经变化，这条问题没有发送；请基于当前电路重新提问。");
  error.code = "WORKSPACE_CHANGED";
  return error;
}



function itemActivity(item, circuitRegistry) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "reasoning") {
    return { kind: "reasoning", label: "分析电路与问题", activityKey: "reasoning" };
  }
  if (item.type === "commandExecution") {
    const label = commandActivityLabel(item.command);
    return { kind: "command", label, activityKey: `command:${label}`, detail: shortText(item.command, 500) };
  }
  if (item.type === "mcpToolCall") {
    return { kind: "tool", label: "调用外部工具", activityKey: `mcp:${item.server || "unknown"}:${item.tool || "unknown"}`, detail: `${shortText(item.server, 80)} / ${shortText(item.tool, 100)}` };
  }
  if (item.type === "dynamicToolCall") {
    return { kind: "tool", label: circuitRegistry?.label(item.tool) || "使用电路工具", activityKey: `circuit:${item.tool || "unknown"}`, detail: item.tool || null };
  }
  if (item.type === "webSearch") {
    return { kind: "web", label: "检索资料", activityKey: "web-search" };
  }
  if (item.type === "fileChange") {
    return { kind: "file", label: "处理工程改动", activityKey: "file-change" };
  }
  return null;
}

class CodexBackend extends EventEmitter {
  constructor({
    codex = process.env.VIBE_LOGISIM_CODEX || "codex",
    workDir,
    runtimeRoot = null,
    profileDir,
    sessionStorePath,
    version = "0.1.0",
    ephemeral = false,
    circuitTool = null,
    circuitManifest = null,
    agentWorkspace = null,
    developerInstructions = DEVELOPER_INSTRUCTIONS,
    includeCircuitContext = true,
    captureModelMedia = false,
    captureCodeMode = false,
  }) {
    super();
    this.codex = codex;
    this.runtimeRoot = runtimeRoot;
    this.loginId = null;
    this.workDir = path.resolve(workDir);
    this.runtimeWorkDir = "/workspace";
    this.profileDir = path.resolve(profileDir || path.join(workDir, "codex-home"));
    this.sessionStorePath = sessionStorePath;
    this.conversations = new ConversationStore(sessionStorePath);
    this.conversationId = null;
    this.version = version;
    this.ephemeral = ephemeral;
    this.circuitTool = circuitTool;
    this.circuitManifest = circuitManifest;
    this.circuitManifestState = null;
    this.agentWorkspace = agentWorkspace;
    this.circuitTools = new CircuitPlugin({
      invoke: payload => this.circuitTool?.(payload),
      workspace: this.agentWorkspace,
    });
    // Controlled comparisons can reuse the identical transport/isolation without
    // exposing the circuit application's instructions to a generic baseline.
    this.developerInstructions = developerInstructions;
    this.includeCircuitContext = includeCircuitContext;
    this.captureModelMedia = captureModelMedia;
    this.captureCodeMode = captureCodeMode;
    this.changeMode = "review";
    this.finalizing = false;
    this.model = process.env.VIBE_LOGISIM_MODEL || null;
    this.effort = process.env.VIBE_LOGISIM_EFFORT || null;
    this.userRequests = new Map();
    this.child = null;
    this.isolationUnit = null;
    this.sharedAuthPath = null;
    this.stdoutLines = null;
    this.processGroupId = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.startPromise = null;
    this.childEpoch = 0;
    this.stopping = false;
    this.lastStderr = "";
    this.status = "idle";
    this.statusDetail = null;
    this.account = null;
    this.threadId = null;
    this.workspaceKey = null;
    this.threadRevisionId = null;
    this.activeTurnId = null;
    this.activeTurnEpoch = null;
    this.pendingTurn = null;
    this.turnStarting = false;
    this.workspaceTransitioning = false;
    this.workspaceEpoch = 0;
    this.workspaceOperation = Promise.resolve();
    // Native circuit calls are serialized like a host-side tool executor. A
    // stopped or superseded turn is checked again when its queued call starts.
    this.circuitGeneration = 0;
    this.completedTurnIds = new Set();
    this.history = [];
    this.health = new TurnHealth();
    this.reconnecting = null;
    this.modelSettings = new AgentModels({request:(method, params)=>this.#request(method, params),
      preferencesPath:sessionStorePath ? path.join(path.dirname(sessionStorePath), "model-selection.json") : null});
  }

  snapshot() {
    return {
      status: this.status,
      detail: this.statusDetail,
      available: ["ready", "busy"].includes(this.status),
      account: this.account
        ? { type: this.account.type || "unknown", planType: this.account.planType || null }
        : null,
      threadId: this.threadId,
      conversationId: this.conversationId,
      revisionId: this.threadRevisionId,
      turnId: this.activeTurnId,
      busy: this.finalizing || this.workspaceTransitioning || this.turnStarting || Boolean(this.activeTurnId) || Boolean(this.reconnecting),
      policy: this.agentWorkspace?.synchronize ? "direct" : this.changeMode,
      model: this.model,
      effort: this.effort,
      modelSelection: this.modelSettings.selection,
      inheritedModel: this.inheritedModel || null,
      inheritedEffort: this.inheritedEffort || null,
      providerName: this.providerName || "本机 Codex",
      modelCatalog: this.modelSettings.state(),
      transmission: this.health.snapshot(),
      canReconnect: this.canReconnect(),
      isolation: "systemd-linux",
      accountMode: this.runtimeRoot ? "application" : "shared",
      signingIn: Boolean(this.loginId),
      messages: this.history.slice(-60),
    };
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    const attempt = this.#startOnce();
    this.startPromise = attempt;
    attempt.catch((error) => {
      if (this.startPromise === attempt) this.startPromise = null;
      if (!this.child && !this.stopping && this.status !== "unavailable") {
        this.#setStatus("unavailable", plainError(error, "Unable to start Codex App Server."));
      }
    });
    return attempt;
  }

  async #startOnce() {
    fs.mkdirSync(this.workDir, { recursive: true });
    this.#prepareProfile();
    this.#setStatus("starting");
    this.lastStderr = "";
    this.stopping = false;

    const args = ["app-server", "--listen", "stdio://", "--strict-config"];
    for (const feature of DISABLED_CODEX_FEATURES) args.push("--disable", feature);
    args.push(
      "--disable",
      "memories",
      "-c",
      'web_search="live"',
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
      "-c",
      'shell_environment_policy.inherit="core"',
      "-c",
      "allow_login_shell=false",
    );
    const generation = ++this.childEpoch;
    const spawnSpec = isolatedSpawn(this, args, this.#childEnvironment());
    this.isolationUnit = spawnSpec.unit;
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.processGroupId = child.pid || null;
    this.stdoutLines = readline.createInterface({ input: child.stdout });
    this.stdoutLines.on("line", (line) => this.#handleStdoutLine(line, generation));
    child.stdin.on("error", (error) => {
      if (!this.stopping) this.#handleProcessError(error, generation);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const message = chunk.trimEnd();
      if (!message) return;
      this.lastStderr = `${this.lastStderr}\n${message}`.trim().slice(-8_000);
      this.emit("log", message);
    });
    child.once("error", (error) => this.#handleProcessError(error, generation));
    child.once("exit", (code, signal) => this.#handleExit(code, signal, generation));

    try {
      await this.#request(
        "initialize",
        {
          clientInfo: {
            name: "vibe_logisim",
            title: "Vibe Logisim Desktop",
            version: this.version,
          },
          capabilities: { experimentalApi: true },
        },
        START_TIMEOUT_MS,
      );
      this.#notify("initialized", {});
      const accountState = await this.#request("account/read", { refreshToken: false });
      this.account = accountState?.account || null;
      if (!this.account && accountState?.requiresOpenaiAuth) {
        this.#setStatus("auth-required");
      } else {
        this.#setStatus("ready");
      }
      // The native Codex config is the default. An app-level preference may
      // override it only after the current app-server catalog validates it.
      // This prevents an old model identifier from reaching turn/start.
      try {
        await this.modelSettings.list();
        const selected = this.modelSettings.selection;
        this.model = selected?.model || this.inheritedModel || null;
        this.effort = selected ? selected.effort : (this.inheritedEffort || null);
        this.#setStatus(this.status);
      } catch (_) {
        // The inherited configuration remains usable if catalog refresh is
        // temporarily unavailable; the picker will expose the error later.
      }
      return this.snapshot();
    } catch (error) {
      if (generation !== this.childEpoch) throw error;
      const diagnostic = this.lastStderr ? `\n${this.lastStderr}` : "";
      const wrapped = new Error(`${plainError(error, "Codex did not become ready.")}${diagnostic}`);
      this.#setStatus("unavailable", wrapped.message);
      await this.stop();
      this.#setStatus("unavailable", wrapped.message);
      throw wrapped;
    }
  }

  #prepareProfile() {
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.profileDir, 0o700);
    } catch (_) {
      // Windows and some mounted filesystems do not expose POSIX modes.
    }

    if (this.runtimeRoot) {
      // A standalone installation owns its login. Never import or duplicate
      // another Codex installation's rotating credentials or private config.
      this.sharedAuthPath = null;
      const provider = writeProvider(path.join(this.profileDir, "provider.toml"), this.profileDir);
      this.inheritedModel = provider.model || null;
      this.inheritedEffort = provider.effort || null;
      this.model = this.inheritedModel;
      this.effort = this.inheritedEffort;
      this.providerName = provider.name || "OpenAI";
      this.providerEnvironment = provider.environment;
      return;
    }
    const sourceRoot = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    const configPath = path.join(sourceRoot, "config.toml");
    const targetRoot = path.resolve(this.profileDir);
    let canonicalSourceRoot = sourceRoot;
    try {
      canonicalSourceRoot = fs.realpathSync(sourceRoot, { encoding: "utf8" });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const canonicalTargetRoot = fs.realpathSync(targetRoot, { encoding: "utf8" });
    if (sourceRoot === targetRoot || canonicalSourceRoot === canonicalTargetRoot) {
      throw new Error("Vibe Logisim 的 Codex profile 必须与用户主 Codex profile 隔离。");
    }
    const sourceAuth = path.join(sourceRoot, "auth.json");
    const targetAuth = path.join(targetRoot, "auth.json");
    this.sharedAuthPath = null;
    const sourceStat = fs.statSync(sourceAuth, { throwIfNoEntry: false });
    if (sourceStat && !sourceStat.isFile()) {
      throw new Error("用户主 Codex profile 中的 auth.json 不是普通文件。");
    }

    const targetStat = fs.lstatSync(targetAuth, { throwIfNoEntry: false });
    if (targetStat && !targetStat.isFile() && !targetStat.isSymbolicLink()) {
      throw new Error("隔离 Codex profile 中的 auth.json 不是普通文件。");
    }
    if (targetStat) {
      if (
        targetStat.isFile() &&
        sourceStat &&
        targetStat.dev === sourceStat.dev &&
        targetStat.ino === sourceStat.ino
      ) {
        throw new Error("用户主 Codex 认证文件不能物理地位于隔离 profile 内。");
      }
      // Older builds copied credentials into the isolated profile. Keeping that
      // second rotating refresh token can invalidate the user's primary login.
      fs.unlinkSync(targetAuth);
    }

    if (sourceStat) this.sharedAuthPath = fs.realpathSync(sourceAuth);
    const provider = writeProvider(configPath, targetRoot);
    this.inheritedModel = process.env.VIBE_LOGISIM_MODEL || provider.model || null;
    this.inheritedEffort = process.env.VIBE_LOGISIM_EFFORT || provider.effort || null;
    this.model = this.inheritedModel;
    this.effort = this.inheritedEffort;
    this.providerName = provider.name || "OpenAI";
    this.providerEnvironment = provider.environment;
  }

  async listModels(refresh = false) {
    await this.start();
    return {models:await this.modelSettings.list({refresh}), state:this.snapshot()};
  }

  async login() {
    await this.start();
    if (!this.runtimeRoot) throw new Error('当前开发环境沿用本机 Codex 登录；独立应用使用应用内登录。');
    if (this.snapshot().busy) throw new Error('请先停止当前回答，再登录。');
    if (this.loginId) await this.cancelLogin();
    const generation = this.childEpoch;
    const result = await this.#request('account/login/start', {type: 'chatgpt'});
    if (generation !== this.childEpoch) throw new Error('连接已变化，请重新登录。');
    this.loginId = result.loginId;
    this.#setStatus('auth-required');
    return {authUrl: result.authUrl};
  }

  async cancelLogin() {
    const loginId = this.loginId;
    this.loginId = null;
    if (loginId) await this.#request('account/login/cancel', {loginId});
    this.#setStatus(this.account ? 'ready' : 'auth-required');
    return this.snapshot();
  }

  async logout() {
    if (!this.runtimeRoot || this.snapshot().busy) throw new Error('当前无法退出登录。');
    await this.cancelLogin();
    await this.#request('account/logout', {});
    this.account = null;
    this.modelSettings.invalidate();
    this.#setStatus('auth-required');
    return this.snapshot();
  }

  async #refreshAccount() {
    const generation = this.childEpoch;
    try {
      const state = await this.#request('account/read', {refreshToken: false});
      if (generation !== this.childEpoch || this.stopping) return;
      this.account = state.account || null;
      if (!this.snapshot().busy) this.#setStatus(!this.account && state.requiresOpenaiAuth ? 'auth-required' : 'ready');
    } catch (error) {
      if (generation === this.childEpoch && !this.stopping) this.#setStatus('auth-required', plainError(error));
    }
  }

  async selectModel(selection) {
    if (this.snapshot().busy) throw new Error("请先停止当前回答，再切换模型");
    const generation = this.childEpoch;
    const selected = await this.modelSettings.validate(selection);
    if (generation !== this.childEpoch || this.snapshot().busy) throw new Error("连接或回答状态已变化，请重新选择");
    this.modelSettings.save(selected);
    this.model = selected?.model || this.inheritedModel || null;
    this.effort = selected ? selected.effort : (this.inheritedEffort || null);
    this.#setStatus(this.status);
    return this.snapshot();
  }

  async reconnect() {
    if (this.reconnecting) return this.reconnecting;
    if (!this.canReconnect()) throw new Error("请先停止当前回答，再重新连接");
    const operation = (async () => {
      await this.stop();
      this.modelSettings.invalidate();
      this.health.clear();
      await this.start();
    })();
    this.reconnecting = operation;
    try { await operation; }
    finally { this.reconnecting = null; this.#setStatus(this.status, this.statusDetail); }
    return this.snapshot();
  }

  canReconnect() {
    if (this.reconnecting || this.finalizing || this.turnStarting) return false;
    return !this.activeTurnId && !this.workspaceTransitioning || this.health.value?.phase === "retrying" ||
      ["unavailable", "stopped"].includes(this.status);
  }

  #childEnvironment() {
    const environment = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: this.profileDir,
      CODEX_HOME: this.profileDir,
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || "C.UTF-8",
      NO_COLOR: "1",
      ...this.providerEnvironment,
    };
    for (const name of [
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "TZ",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ]) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    return environment;
  }


  async ask({ question, context, workspaceKey, editMessageId = null }) {
    if (this.finalizing || this.turnStarting || this.activeTurnId || this.workspaceTransitioning) {
      throw new Error("Codex 正在回答上一条问题；请先等待或停止当前回答。");
    }
    const revisionId = context?.revisionId;
    if (!context?.folder && (typeof revisionId !== "string" || !revisionId)) {
      throw new Error("电路上下文没有绑定 revision。");
    }
    if (typeof workspaceKey !== "string" || !workspaceKey) {
      throw new Error("电路上下文没有稳定的 workspace identity。");
    }
    const { binding, untrustedEvidence } = splitContext(context);
    const encodedBinding = JSON.stringify(binding);
    const encodedEvidence = JSON.stringify(untrustedEvidence);
    const momentContext=keptObservationContext(context);
    if (Buffer.byteLength(encodedBinding, "utf8") + Buffer.byteLength(encodedEvidence, "utf8") > MAX_CONTEXT_BYTES) {
      throw new Error("选区证据超过当前 Codex 上下文上限，请缩小选区后再问。");
    }
    const changesWorkspace = Boolean(this.threadId && this.workspaceKey !== workspaceKey);
    const requestEpoch = changesWorkspace ? ++this.workspaceEpoch : this.workspaceEpoch;
    if (changesWorkspace) this.workspaceTransitioning = true;
    this.turnStarting = true;
    const clientMessageId = `vibe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const frozenContext = {
      projectId:context.projectId,
      plugin: context.plugin ? {id:context.plugin.id, version:context.plugin.version} : null,
      folderId:context.folder?.id,
      moments:(context.keptMoments||[]).map(m=>({id:m.id,projectId:m.projectId,title:m.title})),
      materials:(context.materials||[]).map(m=>({id:m.id,name:m.name,pathVersion:m.pathVersion,page:m.page,quote:m.quote,reference:m.reference})),
      revisionId,
      selectionId: context.selectionId || null,
      circuit: context.circuit || null,
      summary: context.summary || null,
      authority: context.authority || "unknown",
      observationId: context.displayedSimulation?.id || null,
      simulationSessionId: context.displayedSimulation?.sessionId || null,
      simulationTick: context.displayedSimulation?.ticks ?? null,
      simulationInstancePath: context.displayedSimulation?.instancePath || [],
      simulationRootCircuit: context.displayedSimulation?.rootCircuit || null,
    };
    let generation = this.childEpoch;
    try {
      const startPromise = this.start();
      if (this.status === "ready") this.#setStatus("busy");
      await startPromise;
      generation = this.childEpoch;
      this.#assertWorkspace(requestEpoch, generation);
      if (this.status === "auth-required") {
        throw new Error("请先在 AI 设置中登录 ChatGPT。");
      }
      if (!this.child || !["ready", "busy"].includes(this.status)) {
        throw new Error("Codex App Server 当前不可用。");
      }

      return await this.#queueWorkspaceOperation(async () => {
        this.#assertWorkspace(requestEpoch, generation);
        if (changesWorkspace) {
          await this.#resetWorkspaceNow("workspace-changed", requestEpoch, true);
          this.#assertWorkspace(requestEpoch, generation);
        }
        const work = this.agentWorkspace ? await this.agentWorkspace.prepare(revisionId) : null;
        const turnCwd = work ? path.posix.join(this.runtimeWorkDir, work.relative) : this.runtimeWorkDir;
        this.currentCwd = turnCwd;
        await this.#ensureThread(workspaceKey, revisionId, requestEpoch, generation);
        this.#assertWorkspace(requestEpoch, generation);
        if (editMessageId) {
          const source = this.conversations.get(workspaceKey, this.conversationId);
          const edited = await revertThroughMessage({
            source,
            messageId:editMessageId,
            request:(method, params) => this.#request(method, params),
            assertCurrent:() => this.#assertWorkspace(requestEpoch, generation),
          });
          this.history = this.#historyFromThread(edited.thread, edited.messageContexts);
          if (!this.ephemeral) {
            this.conversations.replaceHistory(workspaceKey, {
              threadId:this.threadId,
              messages:this.history,
              messageContexts:edited.messageContexts,
            });
            this.emit("event", {type:"conversations-changed", workspaceKey, ...this.conversations.state(workspaceKey)});
          }
          this.emit("event", {type:"history", messages:this.history.slice(-60)});
        }

        const threadId = this.threadId;
        this.emit("event", {
          type: "user-message",
          id: clientMessageId,
          text: question,
          context: frozenContext,
        });
        this.history.push({
          type: "user",
          id: clientMessageId,
          text: question,
          context: frozenContext,
        });
        if (!this.ephemeral) this.#rememberMessageContext(workspaceKey, clientMessageId, frozenContext);

        this.pendingTurn = {
          epoch: requestEpoch,
          childEpoch: generation,
          threadId,
          clientMessageId,
          turnId: null,
          projectId: work?.projectId || context.projectId || null,
          revisionId,
          observationId: context?.displayedSimulation?.id || null,
          work,
          changeMode: this.changeMode,
        };
        this.#setStatus("busy");
        let result;
        try {
          result = await this.#request("turn/start", {
            threadId,
            clientUserMessageId: clientMessageId,
            input: [{ type: "text", text: question, text_elements: [] }],
            cwd: turnCwd,
            approvalPolicy: "never",
            // systemd is the external sandbox. Nesting Codex's bubblewrap here
            // fails under the service's filesystem namespace on this host.
            sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
            ...(this.model ? {model:this.model} : {}),
            ...(this.effort ? {effort:this.effort} : {}),
            runtimeWorkspaceRoots: [turnCwd],
            ...(this.includeCircuitContext ? { additionalContext: {
              "vibe-logisim.binding": { value: encodedBinding, kind: "application" },
              "vibe-logisim.evidence": { value: encodedEvidence, kind: "untrusted" },
              ...momentContext,
              ...materialContext(context),
              "vibe-logisim.workspace": {value: JSON.stringify({cwd:turnCwd, file:context.folder?.activeFile || null, folderId:context.folder?.id, changeMode:"direct"}), kind:"application"},
            } } : {}),
          });
        } catch (error) {
          const modelError = classifyModelError(error, {phase:"turn", model:this.model});
          if (modelError) {
            this.#setStatus("unavailable", modelError.message);
            throw modelError;
          }
          throw error;
        }
        const returnedTurnId = result?.turn?.id || null;
        if (returnedTurnId) this.#bindPendingTurn(returnedTurnId, threadId, true);
        this.#assertWorkspace(requestEpoch, generation);
        if (returnedTurnId && !this.completedTurnIds.has(returnedTurnId)) {
          this.activeTurnId = returnedTurnId;
          this.activeTurnEpoch = requestEpoch;
        }
        this.threadRevisionId = revisionId;
        return { threadId, turnId: returnedTurnId, revisionId };
      });
    } catch (error) {
      const ownsPending = this.pendingTurn?.clientMessageId === clientMessageId;
      if (ownsPending && !this.activeTurnId && this.pendingTurn?.epoch === this.workspaceEpoch) {
        this.pendingTurn = null;
      }
      if (error?.code !== "WORKSPACE_CHANGED") {
        this.emit("event", { type: "error", message: plainError(error) });
      }
      this.#restoreLiveStatus(generation, requestEpoch);
      throw error;
    } finally {
      this.turnStarting = false;
      if (changesWorkspace && requestEpoch === this.workspaceEpoch) {
        this.workspaceTransitioning = false;
      }
      this.#restoreLiveStatus(generation, requestEpoch);
    }
  }

  async interrupt() {
    const threadId = this.threadId;
    const turnId = this.activeTurnId || this.pendingTurn?.turnId;
    if (!threadId || !turnId) return { interrupted: false };
    // A native call may still be finishing in the host. Its result must not
    // be delivered to Codex after the user stopped this turn.
    this.circuitGeneration += 1;
    await this.#request("turn/interrupt", { threadId, turnId });
    return { interrupted: true, turnId };
  }

  setChangeMode(mode) {
    if (!["review", "auto"].includes(mode)) throw new Error("未知的改动模式");
    if (this.snapshot().busy) throw new Error("请等当前任务结束后切换模式");
    this.changeMode = mode;
    this.#setStatus(this.status);
    return this.snapshot();
  }

  answer(requestId, answers) {
    const request = this.userRequests.get(String(requestId));
    if (!request || !this.#matchesCurrentTurn(request.params)) throw new Error("这个问题已经过期");
    const result = {};
    for (const q of request.params.questions || []) {
      const text = answers?.[q.id];
      if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new Error("请回答每个问题");
      result[q.id] = {answers:[text]};
    }
    this.userRequests.delete(String(requestId));
    this.#write({id:request.id, result:{answers:result}});
    return {answered:true};
  }

  async resumeWorkspace({ workspaceKey, revisionId }) {
    // Restore visible conversation without fabricating a new user turn.
    if (this.ephemeral) return {resumed:false};
    const saved = this.conversations.ensure(workspaceKey);
    if (this.workspaceKey !== workspaceKey || this.conversationId !== saved.id) {
      if (this.threadId) throw workspaceChangedError();
      this.workspaceKey = workspaceKey; this.conversationId = saved.id;
      this.history = saved.messages || [];
      this.emit('event', {type:'conversations-changed', activate:true, workspaceKey, ...this.conversations.state(workspaceKey)});
    }
    if (this.threadId) return {resumed:true, threadId:this.threadId};
    if (!saved.threadId) return {resumed:false};
    const epoch = this.workspaceEpoch;
    await this.start();
    const generation = this.childEpoch;
    return this.#queueWorkspaceOperation(async () => {
      this.#assertWorkspace(epoch, generation);
      await this.#ensureThread(workspaceKey, revisionId, epoch, generation);
      return { resumed: true, threadId: this.threadId };
    });
  }

  async resetWorkspace(reason = "workspace-changed") {
    const epoch = ++this.workspaceEpoch;
    this.workspaceTransitioning = true;
    if (["busy", "ready"].includes(this.status)) this.#setStatus(this.status);
    try {
      return await this.#queueWorkspaceOperation(() => this.#resetWorkspaceNow(reason, epoch, false));
    } finally {
      if (epoch === this.workspaceEpoch) {
        this.workspaceTransitioning = false;
        this.#restoreLiveStatus(this.childEpoch, epoch);
      }
    }
  }

  async invalidateRevision(reason = "revision-changed") {
    const epoch = ++this.workspaceEpoch;
    this.workspaceTransitioning = true;
    try {
      return await this.#queueWorkspaceOperation(async () => {
        if (epoch !== this.workspaceEpoch) return { invalidated: false };
        const threadId = this.threadId || this.pendingTurn?.threadId;
        const turnId = this.activeTurnId || this.pendingTurn?.turnId;
        this.activeTurnId = this.activeTurnEpoch = null;
        this.pendingTurn = null;
        this.turnStarting = false;
        this.health.clear();
        this.emit("event", { type: "revision-changed", reason });
        if (threadId && turnId && this.child) {
          await this.#request("turn/interrupt", { threadId, turnId }).catch(() => {});
        }
        return { invalidated: true, threadId: this.threadId };
      });
    } finally {
      if (epoch === this.workspaceEpoch) {
        this.workspaceTransitioning = false;
        this.#restoreLiveStatus(this.childEpoch, epoch);
      }
    }
  }

  async stop() {
    this.loginId = null;
    const child = this.child;
    if (!child) {
      this.startPromise = null;
      return;
    }
    ++this.workspaceEpoch;
    this.workspaceTransitioning = false;
    this.turnStarting = false;
    this.pendingTurn = null;
    this.activeTurnId = null;
    this.activeTurnEpoch = null;
    this.threadId = null;
    this.workspaceKey = null;
    this.conversationId = null;
    this.threadRevisionId = null;
    const processGroupId = this.processGroupId;
    this.stopping = true;
    this.child = null;
    this.startPromise = null;
    this.stdoutLines?.close();
    this.stdoutLines = null;
    this.#rejectPending(new Error("Codex App Server stopped."));
    if (child.exitCode !== null || child.signalCode !== null) {
      this.processGroupId = null;
      this.#setStatus("stopped");
      return;
    }
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(GRACEFUL_STOP_MS, false),
    ]);
    if (!graceful) {
      await this.#stopIsolationUnit();
      this.#terminateTree(child, processGroupId, false);
      const terminated = await Promise.race([
        exited.then(() => true),
        delay(FORCED_STOP_MS, false),
      ]);
      if (!terminated) {
        this.#terminateTree(child, processGroupId, true);
        await exited;
      }
    }
    this.processGroupId = null;
    this.isolationUnit = null;
    this.#setStatus("stopped");
  }

  async #ensureThread(workspaceKey, revisionId, expectedEpoch, generation) {
    if (this.circuitTool) {
      if (!this.circuitManifest) throw new Error("电路插件 manifest 不可用，已拒绝启动 Codex 电路会话");
      const manifest = await this.circuitManifest();
      this.#assertWorkspace(expectedEpoch, generation);
      const registry = this.circuitTools.configure(manifest, {live: Boolean(this.threadId)});
      this.circuitManifestState = {...registry.identity, signature: registry.signature};
    }
    if (this.threadId) {
      if (this.workspaceKey !== workspaceKey) throw workspaceChangedError();
      return;
    }
    const savedWorkspace = this.ephemeral ? null : this.conversations.ensure(workspaceKey);
    this.conversationId = savedWorkspace?.id || null;
    const savedThreadId = savedWorkspace?.threadId;
    const currentToolContract = this.circuitTool ? this.circuitManifestState : null;
    const compatibleThread = !this.circuitTool || !savedThreadId || (
      savedWorkspace?.toolContract?.signature &&
      savedWorkspace.toolContract.signature === currentToolContract?.signature
    );
    const resumableThreadId = compatibleThread ? savedThreadId : null;
    const capabilityReset = Boolean(savedThreadId && !resumableThreadId);
    let result = null;
    let provisionalThreadId = null;
    try {
      if (typeof resumableThreadId === "string" && resumableThreadId) {
        try {
          result = await this.#request("thread/resume", {
            threadId: resumableThreadId,
            cwd: this.currentCwd || this.runtimeWorkDir,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            ...(this.model ? {model:this.model} : {}),
            dynamicTools: this.circuitTool ? this.circuitTools.registry.tools : [],
            config: THREAD_CONFIG,
            developerInstructions: this.developerInstructions,
          });
        } catch (error) {
          if (!isMissingThreadError(error)) throw error;
          throw new Error("这条对话的原始会话暂时不可用，已有记录仍保留。可重试连接，或新建对话继续。");
        }
      }
      provisionalThreadId = result?.thread?.id || null;
      this.#assertWorkspace(expectedEpoch, generation);
      if (!result) {
        result = await this.#request("thread/start", {
          cwd: this.currentCwd || this.runtimeWorkDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ...(this.model ? {model:this.model} : {}),
          config: THREAD_CONFIG,
          serviceName: "vibe_logisim",
          ephemeral: this.ephemeral,
          ...(this.captureModelMedia || this.captureCodeMode ? {experimentalRawEvents: true} : {}),
          developerInstructions: this.developerInstructions,
          dynamicTools: this.circuitTool ? this.circuitTools.registry.tools : [],
        });
        provisionalThreadId = result?.thread?.id || null;
      }
      this.#assertWorkspace(expectedEpoch, generation);
      const threadId = result?.thread?.id;
      if (typeof threadId !== "string" || !threadId) {
        throw new Error("Codex did not return a thread id.");
      }
      const mcpStatus = await this.#request("mcpServerStatus/list", { threadId });
      this.#assertWorkspace(expectedEpoch, generation);
      const mcpServers = Array.isArray(mcpStatus?.data) ? mcpStatus.data : [];
      if (mcpServers.length) {
        await this.#request("thread/unsubscribe", { threadId }).catch(() => {});
        provisionalThreadId = null;
        throw new Error("隔离失败：Circuit Agent 检测到继承的 MCP 服务，已拒绝启动该会话。");
      }
      this.threadId = threadId;
      this.workspaceKey = workspaceKey;
      this.threadRevisionId = revisionId;
      provisionalThreadId = null;
      const restoredContexts = resumableThreadId === threadId ? savedWorkspace?.messageContexts : null;
      const restoredHistory = this.#historyFromThread(result.thread, restoredContexts);
      this.history = restoredHistory.length ? restoredHistory : savedWorkspace?.messages || [];
      if (!this.ephemeral) this.#rememberThread(workspaceKey, threadId, {rebind:capabilityReset});
      this.emit("event", { type: "thread-started", threadId, revisionId,
        resumed: Boolean(resumableThreadId), capabilityReset });
      if (this.history.length) {
        this.emit("event", { type: "history", messages: this.history.slice(-60) });
      }
    } catch (error) {
      if (provisionalThreadId && this.child) {
        await this.#request("thread/unsubscribe", { threadId: provisionalThreadId }).catch(() => {});
      }
      throw error;
    }
  }

  #queueWorkspaceOperation(operation) {
    const run = this.workspaceOperation.catch(() => {}).then(operation);
    this.workspaceOperation = run.catch(() => {});
    return run;
  }

  async #resetWorkspaceNow(reason, expectedEpoch, preserveTurnStarting) {
    if (expectedEpoch !== this.workspaceEpoch) return { reset: false };
    const oldThreadId = this.threadId || this.pendingTurn?.threadId || null;
    const oldTurnId = this.activeTurnId || this.pendingTurn?.turnId || null;

    this.threadId = null;
    this.workspaceKey = null;
    this.conversationId = null;
    this.threadRevisionId = null;
    this.activeTurnId = null;
    this.activeTurnEpoch = null;
    this.pendingTurn = null;
    if (!preserveTurnStarting) this.turnStarting = false;
    this.completedTurnIds.clear();
    this.history = [];
    this.health.clear();
    this.emit("event", { type: "workspace-reset", reason });

    if (oldThreadId && oldTurnId && this.child) {
      await this.#request("turn/interrupt", { threadId: oldThreadId, turnId: oldTurnId }).catch(() => {});
    }
    if (oldThreadId && this.child) {
      await this.#request("thread/unsubscribe", { threadId: oldThreadId }).catch(() => {});
    }
    return { reset: true };
  }

  #assertWorkspace(expectedEpoch, generation) {
    if (
      expectedEpoch !== this.workspaceEpoch ||
      generation !== this.childEpoch ||
      !this.child
    ) {
      throw workspaceChangedError();
    }
  }

  #bindPendingTurn(turnId, threadId, allowStale = false) {
    if (!turnId || !this.pendingTurn || this.pendingTurn.threadId !== threadId) return false;
    if (this.pendingTurn.childEpoch !== this.childEpoch) return false;
    if (this.pendingTurn.turnId && this.pendingTurn.turnId !== turnId) {
      this.emit("log", "Codex sent conflicting turn ids for one client message; ignoring the later event.");
      return false;
    }
    this.pendingTurn.turnId = turnId;
    const current = this.pendingTurn.epoch === this.workspaceEpoch;
    if (current || allowStale) {
      if (current && !this.completedTurnIds.has(turnId)) {
        this.activeTurnId = turnId;
        this.activeTurnEpoch = this.pendingTurn.epoch;
      }
      return current;
    }
    return false;
  }

  #matchesCurrentTurn(params) {
    const turnId = params?.turnId || params?.turn?.id || null;
    if (!turnId || params?.threadId !== this.threadId) return false;
    if (this.activeTurnId === turnId && this.activeTurnEpoch === this.workspaceEpoch) return true;
    return Boolean(
      this.pendingTurn &&
      this.pendingTurn.epoch === this.workspaceEpoch &&
      this.pendingTurn.childEpoch === this.childEpoch &&
      this.pendingTurn.threadId === params.threadId &&
      this.pendingTurn.turnId === turnId
    );
  }

  #restoreLiveStatus(generation, expectedEpoch) {
    if (
      generation !== this.childEpoch ||
      expectedEpoch !== this.workspaceEpoch ||
      !this.child ||
      ["auth-required", "unavailable", "stopped", "starting"].includes(this.status)
    ) {
      return;
    }
    this.#setStatus(
      this.finalizing || this.workspaceTransitioning || this.turnStarting || this.activeTurnId ? "busy" : "ready",
    );
  }

  conversationState(workspaceKey) {
    if (!this.conversations.active(workspaceKey)) this.conversations.ensure(workspaceKey);
    return {workspaceKey, ...this.conversations.state(workspaceKey)};
  }

  async changeConversation(workspaceKey, action, request) {
    if (this.snapshot().busy) throw new Error('请先停止当前回答，再管理对话');
    this.workspaceTransitioning = true;
    const epoch = ++this.workspaceEpoch;
    try {
      return await this.#queueWorkspaceOperation(async () => {
        if (epoch !== this.workspaceEpoch) throw workspaceChangedError();
        const previous = this.conversations.active(workspaceKey)?.id;
        let state;
        if (action === 'fork') {
          const source = this.conversations.get(workspaceKey, previous);
          await this.start();
          const generation = this.childEpoch;
          this.#assertWorkspace(epoch, generation);
          if (this.status === 'auth-required') throw new Error('请先登录，再创建对话分支');
          const fork = await forkThroughReply({source, messageId:request.messageId,
            request:(method, params) => this.#request(method, params), assertCurrent:() => this.#assertWorkspace(epoch, generation),
            options:{cwd:this.currentCwd || this.runtimeWorkDir, approvalPolicy:'never', sandbox:'danger-full-access',
              config:THREAD_CONFIG, developerInstructions:this.developerInstructions, ...(this.model ? {model:this.model} : {})}});
          this.#assertWorkspace(epoch, generation);
          state = this.conversations.fork(workspaceKey, {sourceId:source.id, sourceThreadId:source.threadId,
            messageId:request.messageId, turnId:fork.turnId, threadId:fork.thread.id, messageContexts:fork.messageContexts,
            messages:this.#historyFromThread(fork.thread, fork.messageContexts), toolContract:this.circuitManifestState});
        } else state = this.conversations.change(workspaceKey, action, request);
        const activate = state.activeId !== previous || this.workspaceKey !== workspaceKey;
        if (activate) {
          await this.#resetWorkspaceNow('conversation-changed', epoch, false);
          if (epoch !== this.workspaceEpoch) throw workspaceChangedError();
          this.workspaceKey = workspaceKey; this.conversationId = state.activeId;
          this.history = state.conversation.messages || [];
        }
        const result = {workspaceKey, ...state};
        this.emit('event', {type:'conversations-changed', activate, ...result});
        return result;
      });
    } finally {
      if (epoch === this.workspaceEpoch) {
        this.workspaceTransitioning = false;
        if (['ready', 'busy'].includes(this.status)) this.#restoreLiveStatus(this.childEpoch, epoch);
      }
    }
  }

  #rememberThread(workspaceKey, threadId, {rebind = false} = {}) {
    if (rebind) {
      this.conversations.rebind(workspaceKey, {threadId, messages:this.history,
        toolContract:this.circuitManifestState, reason:'circuit-plugin-capability-updated'});
    } else {
      this.conversations.remember(workspaceKey, {threadId, messages:this.history,
        toolContract:this.circuitManifestState});
    }
    this.emit('event', {type:'conversations-changed', workspaceKey, ...this.conversations.state(workspaceKey)});
  }

  #rememberMessageContext(workspaceKey, messageId, context) {
    if (!this.threadId) return;
    this.conversations.remember(workspaceKey, {threadId:this.threadId, messages:this.history, messageId, context});
    this.emit('event', {type:'conversations-changed', workspaceKey, ...this.conversations.state(workspaceKey)});
  }

  #historyFromThread(thread, messageContexts = null) {
    const messages = [];
    for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        if (item?.type === "userMessage") {
          const text = (Array.isArray(item.content) ? item.content : [])
            .filter((part) => part?.type === "text")
            .map((part) => String(part.text || ""))
            .join("\n")
            .trim();
          if (text) {
            messages.push({
              type: "user",
              id: item.id,
              text,
              context: messageContexts?.[item.clientId || item.id] || null,
            });
          }
        } else if (item?.type === "agentMessage" && item.text) {
          messages.push({
            type: "assistant",
            id: item.id,
            text: String(item.text),
            phase: item.phase || null,
          });
        }
      }
    }
    return messages.slice(-60);
  }

  #request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.child || this.child.stdin.destroyed) {
      return Promise.reject(new Error("Codex App Server is not running."));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex ${method} request timed out.`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(String(id), { method, resolve, reject, timeout });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        this.pending.delete(String(id));
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  #notify(method, params) {
    this.#write({ method, params });
  }

  #write(message) {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error("Codex App Server stdin is unavailable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  #handleStdoutLine(line, generation) {
    if (generation !== this.childEpoch) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      if (line.trim()) this.emit("log", line);
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined && message.id !== null && message.method) {
      this.#handleServerRequest(message);
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      if (message.error) {
        const detail = message.error?.message || JSON.stringify(message.error);
        const error = new Error(`Codex ${pending.method} failed: ${detail}`);
        error.code = message.error?.code;
        error.data = message.error?.data;
        error.method = pending.method;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.#handleNotification(message.method, message.params || {});
  }

  #handleNotification(method, params) {
    if (method === 'rawResponseItem/completed') {
      // Explicit controlled-experiment observer only. No reasoning, user text,
      // output bodies or images; the subscriber bounds/redacts before storage.
      if (this.captureCodeMode && this.#matchesCurrentTurn(params)
          && params.item?.type === 'custom_tool_call' && params.item.name === 'exec'
          && typeof params.item.input === 'string') {
        this.emit('telemetry', {method:'model/code', params:{threadId:params.threadId,
          turnId:params.turnId, callId:params.item.call_id, code:params.item.input}});
      }
      if (this.captureModelMedia && this.#matchesCurrentTurn(params)) {
        const evidence = modelMediaEvidence(params.item);
        if (evidence) this.emit('telemetry', {method:'model/media', params:{turnId:params.turnId, ...evidence}});
      }
      return;
    }
    if (method === 'account/login/completed') {
      if (params.loginId !== this.loginId) return;
      this.loginId = null;
      if (params.success) { this.modelSettings.invalidate(); void this.#refreshAccount(); }
      else this.#setStatus('auth-required', params.error || '登录未完成，可以重试。');
      return;
    }
    if (method === 'account/updated') { void this.#refreshAccount(); return; }
    // Opt-in observers receive actual per-thread counters and completed work,
    // not account-wide quota percentages or estimates from displayed text.
    if (["thread/tokenUsage/updated", "item/completed", "turn/started", "turn/completed"].includes(method)) {
      this.emit("telemetry", {method, params});
    }
    if (method === "turn/started") {
      const turnId = params.turn?.id || null;
      if (!this.#bindPendingTurn(turnId, params.threadId, true)) return;
      this.completedTurnIds.delete(turnId);
      this.health.clear();
      this.#setStatus("busy");
      this.emit("event", { type: "turn-started", turnId });
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn || {};
      if (!this.#matchesCurrentTurn(params)) return;
      if (turn.id) {
        this.completedTurnIds.add(turn.id);
        if (this.completedTurnIds.size > 50) {
          this.completedTurnIds.delete(this.completedTurnIds.values().next().value);
        }
      }
      const pending = this.pendingTurn;
      this.finalizing = true;
      this.#finishTurn(turn, pending).catch(error => this.emit("event", {type:"error", message:plainError(error)}));
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (!this.#matchesCurrentTurn(params)) return;
      if (this.health.clear()) this.#setStatus("busy");
      this.emit("event", {
        type: "assistant-delta",
        itemId: params.itemId,
        turnId: params.turnId,
        delta: String(params.delta || ""),
      });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      if (!this.#matchesCurrentTurn(params)) return;
      if (this.health.clear()) this.#setStatus("busy");
      this.emit("event", {
        type: "reasoning-delta",
        itemId: params.itemId,
        turnId: params.turnId,
        delta: String(params.delta || ""),
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item || {};
      if (
        method === "item/started" &&
        item.type === "userMessage" &&
        item.clientId &&
        item.clientId === this.pendingTurn?.clientMessageId
      ) {
        this.#bindPendingTurn(params.turnId, params.threadId, true);
      }
      if (!this.#matchesCurrentTurn(params)) return;
      if (item.type === "agentMessage") {
        if (this.health.clear()) this.#setStatus("busy");
        if (method === "item/completed" && item.text) {
          const existing = this.history.find((entry) => entry.id === item.id);
          const complete = {
            type: "assistant",
            id: item.id,
            text: String(item.text),
            phase: item.phase || null,
          };
          if (existing) Object.assign(existing, complete);
          else this.history.push(complete);
          if (!this.ephemeral && this.workspaceKey) {
            try { this.conversations.remember(this.workspaceKey, {threadId:this.threadId, messages:this.history}); }
            catch (error) { this.emit('event', {type:'warning', message:error.message}); }
          }
        }
        this.emit("event", {
          type: method === "item/started" ? "assistant-started" : "assistant-completed",
          itemId: item.id,
          turnId: params.turnId,
          text: String(item.text || ""),
          phase: item.phase || null,
        });
        return;
      }
      const activity = itemActivity(item, this.circuitTools.registry);
      if (activity) {
        // New model activity proves the retry resumed even without text deltas.
        // A previous tool may finish while the stream is still retrying.
        if (method === "item/started" && this.health.value?.phase === "retrying") {
          this.health.clear();
          this.#setStatus("busy");
        }
        const status = method === "item/started"
          ? "running"
          : (item.status === "failed" || item.success === false ? "failed" : (item.status || "completed"));
        this.emit("event", {
          type: "activity",
          itemId: item.id,
          turnId: params.turnId,
          status,
          ...activity,
          detail: method === "item/completed" ? itemErrorText(item) || activity.detail || null : null,
        });
      }
      return;
    }
    if (method === "error") {
      if (!this.#matchesCurrentTurn(params)) return;
      const message = params.error?.message || params.message || "Codex turn failed.";
      if (params.willRetry) this.health.retry(params.turnId, message);
      else this.health.finish(params.turnId, "failed", message);
      this.#setStatus(this.status);
      return;
    }
    if (method === "warning" || method === "configWarning") {
      if (params.threadId && params.threadId !== this.threadId) return;
      const warning = shortText(params.message || params.summary || params.details || params, 500);
      this.emit("event", {
        type: "warning",
        message: warning,
      });
    }
  }

  #handleServerRequest(message) {
    const method = message.method;
    const params = message.params || {};
    if (method === "item/tool/call") {
      const epoch = this.workspaceEpoch;
      const generation = this.childEpoch;
      const circuitGeneration = this.circuitGeneration;
      const request = {
        ...params,
        threadId: params.threadId || this.pendingTurn?.threadId || null,
        callId: params.callId || params.itemId || String(message.id),
        turnId: params.turnId || this.pendingTurn?.turnId || null,
      };
      const current = () => generation === this.childEpoch && epoch === this.workspaceEpoch
        && circuitGeneration === this.circuitGeneration
        && this.#matchesCurrentTurn(request);
      const allowed = Boolean(this.circuitTool && this.circuitTools.registry
        && this.circuitTools.registry.get(params.tool) && current());
      const invoke = async () => {
        if (!allowed || !current()) throw new Error("电路工具调用已过期或未授权");
        const pending = this.pendingTurn;
        const scope = {
          pending,
          assertCurrent: () => {
            if (!current() || this.pendingTurn !== pending) throw new Error("电路工具调用已过期");
          },
          updateBinding: session => {
            const revisionId = session?.revision?.id;
            const projectId = session?.workspace?.id || null;
            if (this.pendingTurn !== pending) return;
            if (pending.projectId !== projectId || pending.revisionId !== revisionId) pending.observationId = null;
            pending.projectId = projectId;
            pending.revisionId = revisionId;
            this.threadRevisionId = revisionId;
          },
          emit: event => this.emit("event", event),
        };
        const result = await this.circuitTools.call(request, scope);
        scope.assertCurrent();
        return dynamicToolResponse(result);
      };
      Promise.resolve().then(invoke)
        .catch(error => ({
          contentItems: [{type: "inputText", text: JSON.stringify({
            error: error.toolError || {
              code: error.code || "CIRCUIT_TOOL_FAILED",
              message: plainError(error),
              retryable: false,
              hint: "检查当前工作区和连接状态后再决定是否重试。",
            },
          })}],
          success: false,
        }))
        .then(result => {
          // An interrupted, switched or restarted turn has no response target.
          if (current() && this.child?.stdin?.writable) {
            this.#write({id: message.id, result});
          }
        })
        .catch(error => this.emit("log", "Circuit tool response dropped: " + plainError(error)));
      return;
    }
    if (method === "item/tool/requestUserInput" && this.#matchesCurrentTurn(params)) {
      this.userRequests.set(String(message.id), {id:message.id, params});
      this.emit("event", {type:"question", requestId:String(message.id), questions:params.questions || []});
      return;
    }
    const scope = {
      command: shortText(params.command, 300) || null,
      cwd: shortText(params.cwd, 200) || null,
      reason: shortText(params.reason, 300) || null,
    };
    if (!params.threadId || this.#matchesCurrentTurn(params)) {
      this.emit("event", {type:"blocked-request", requestId:String(message.id), method, scope});
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.#write({id:message.id, result:{decision:"decline"}});
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.#write({ id: message.id, result: { answers: {} } });
      return;
    }
    this.#write({
      id: message.id,
      error: {
        code: -32601,
        message: "This capability is outside the delegated project workspace.",
      },
    });
  }

  async #finishTurn(turn, pending) {
    const isCurrent = () => pending?.epoch === this.workspaceEpoch && pending?.childEpoch === this.childEpoch;
    try {
      if (pending?.work && isCurrent()) {
        const outcome = await this.agentWorkspace.finish(pending.work, {
          apply:pending.changeMode === "auto", completed:turn.status === "completed", isCurrent});
        if (outcome && isCurrent()) {
          if (outcome.applied) this.threadRevisionId = outcome.session.revision.id;
          this.emit("event", {type:"circuit-change", ...outcome});
        }
      }
    } catch (error) {
      if (isCurrent()) this.emit("event", {type:"error", message:"文件改动已留在工作区，但刷新未完成：" + plainError(error)});
    } finally {
      this.finalizing = false;
      if (this.pendingTurn === pending) {
        this.activeTurnId = null;
        this.activeTurnEpoch = null;
        this.pendingTurn = null;
        this.userRequests.clear();
        this.health.finish(turn.id, turn.status, turn.error?.message);
        this.#setStatus(this.turnStarting ? "busy" : "ready");
        this.emit("event", {type:"turn-completed", turnId:turn.id, status:turn.status, error:turn.error?.message || null});
      }
    }
  }

  #handleProcessError(error, generation) {
    if (generation !== this.childEpoch) return;
    const message = plainError(error, "Unable to start Codex App Server.");
    this.#rejectPending(new Error(message));
    this.#setStatus("unavailable", message);
  }

  #handleExit(code, signal, generation) {
    if (generation !== this.childEpoch) return;
    const expected = this.stopping;
    const processGroupId = this.processGroupId;
    this.child = null;
    this.startPromise = null;
    this.processGroupId = null;
    this.isolationUnit = null;
    this.activeTurnId = null;
    this.activeTurnEpoch = null;
    this.pendingTurn = null;
    this.turnStarting = false;
    this.threadId = null;
    this.workspaceKey = null;
    this.threadRevisionId = null;
    this.conversationId = null;
    this.#rejectPending(new Error("Codex App Server exited."));
    if (expected) {
      this.#setStatus("stopped");
      return;
    }
    this.#terminateTree(null, processGroupId, true);
    const diagnostic = this.lastStderr ? `\n${this.lastStderr}` : "";
    const message = `Codex App Server exited (${signal || (code ?? "unknown")}).${diagnostic}`;
    this.#setStatus("unavailable", message);
    this.emit("event", { type: "error", message });
  }

  #setStatus(status, detail = null) {
    this.status = status;
    this.statusDetail = detail ? shortText(detail, 600) : null;
    const {messages, ...state} = this.snapshot();
    this.emit("event", {type:"status", ...state});
  }

  #terminateTree(child, processGroupId, force) {
    if (process.platform === "win32") {
      const pid = child?.pid || processGroupId;
      if (!pid) return;
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => child?.kill());
      return;
    }
    if (!processGroupId) return;
    try {
      process.kill(-processGroupId, force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") child?.kill(force ? "SIGKILL" : "SIGTERM");
    }
  }

  async #stopIsolationUnit() {
    const unit = this.isolationUnit;
    if (!unit || process.platform !== "linux") return;
    let systemctl;
    try {
      systemctl = resolveExecutable("systemctl");
    } catch (_) {
      return;
    }
    await new Promise((resolve) => {
      const stopper = spawn(systemctl, ["--user", "stop", unit], {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
        env: this.#childEnvironment(),
      });
      const timeout = setTimeout(() => {
        stopper.kill("SIGKILL");
        resolve();
      }, FORCED_STOP_MS);
      timeout.unref?.();
      stopper.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
      stopper.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = { CodexBackend, itemErrorText };
