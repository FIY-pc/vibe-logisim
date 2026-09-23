"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const CONTROL_SCHEMA = "vibe-logisim.circuit-lens.desktop-control/v0";
const START_TIMEOUT_MS = 20_000;
const CONTROL_TIMEOUT_MS = 30_000;
const GRACEFUL_STOP_MS = 1_500;
const FORCED_STOP_MS = 2_000;

function delay(milliseconds, value) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), milliseconds);
    timer.unref?.();
  });
}

class LensBackend extends EventEmitter {
  constructor({
    repoRoot,
    python = process.env.VIBE_LOGISIM_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    stateDir = process.env.VIBE_LOGISIM_STATE_DIR || null,
  }) {
    super();
    this.repoRoot = path.resolve(repoRoot);
    this.python = python;
    this.serverPath = path.join(this.repoRoot, "apps", "desktop", "circuit-lens", "server.py");
    this.stateDir = stateDir ? path.resolve(stateDir) : null;
    this.child = null;
    this.baseUrl = null;
    this.controlToken = null;
    this.statePath = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stopping = false;
    this.ready = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.stdoutLines = null;
    this.processGroupId = null;
    this.lastStderr = "";
  }

  async start(initialCircuit = null) {
    if (this.child) throw new Error("Circuit Lens backend is already running.");
    if (!fs.existsSync(this.serverPath)) {
      throw new Error(`Circuit Lens backend is missing: ${this.serverPath}`);
    }
    this.lastStderr = "";

    const args = [
      "-u",
      this.serverPath,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-browser",
      "--desktop-control",
    ];
    if (this.stateDir) args.push("--state-dir", this.stateDir);
    if (initialCircuit) args.push(path.resolve(initialCircuit));

    this.stopping = false;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.child = spawn(this.python, args, {
      cwd: this.repoRoot,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.processGroupId = this.child.pid || null;

    this.stdoutLines = readline.createInterface({ input: this.child.stdout });
    this.stdoutLines.on("line", (line) => this.#handleStdoutLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      const message = chunk.trimEnd();
      if (message) {
        this.lastStderr = `${this.lastStderr}\n${message}`.trim().slice(-4_000);
        this.emit("log", message);
      }
    });
    this.child.once("error", (error) => this.#failStart(error));
    this.child.once("exit", (code, signal) => this.#handleExit(code, signal));

    const timeout = setTimeout(() => {
      this.#failStart(new Error("Circuit Lens backend did not become ready in time."));
    }, START_TIMEOUT_MS);
    timeout.unref?.();

    try {
      const ready = await this.ready;
      clearTimeout(timeout);
      await this.#checkHealth();
      return ready;
    } catch (error) {
      clearTimeout(timeout);
      await this.stop();
      throw error;
    }
  }

  async openPath(filePath) {
    const absolute = path.resolve(filePath);
    if (path.extname(absolute).toLowerCase() !== ".circ") {
      throw new Error("Only Logisim .circ files can be opened.");
    }
    const stat = await fs.promises.stat(absolute).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Circuit file does not exist: ${absolute}`);
    return this.#request("open-path", { path: absolute });
  }

  async movePath(folderId, from, to) { return this.#request("move-path", {folderId, from, to}); }

  async setFolder(folder, clear=false) { return this.#request("set-folder", {folder, clear}); }

  async reload() {
    return this.#request("reload", {});
  }

  async openUpload(filename, bytes) {
    return this.#requestJson("/api/open", {method:"POST", rawBody:Buffer.from(bytes),
      headers:{"Content-Type":"application/octet-stream", "X-Filename":encodeURIComponent(filename)}});
  }

  async session() {
    return this.#requestJson("/api/session");
  }

  async circuitTool(payload) {
    return this.#requestJson("/api/agent/tool", { method: "POST", body: payload });
  }

  async circuitPlugin() {
    return this.#requestJson("/api/agent/plugin");
  }

  async agentBundle(revisionId, candidateId = null) {
    return this.#request("agent-bundle", { revisionId, candidateId });
  }

  async candidateReview(candidateId) {
    return this.#requestJson(`/api/candidate/diff?id=${encodeURIComponent(candidateId)}`);
  }

  async candidateWorkingCopy(payload) {
    return this.#requestJson("/api/candidate/working-copy", { method: "POST", body: payload });
  }

  async projectAction(action, payload) {
    if (!["apply", "restore", "save", "edit", "place", "move", "wire", "delete", "undo", "interface"].includes(action)) throw new Error("Unknown project action.");
    return this.#requestJson(`/api/project/${action}`, { method: "POST", body: payload });
  }

  async keptMoments(refs) {
    return Promise.all(refs.map(async ref => {
      const moment=await this.#requestJson('/api/moments?'+new URLSearchParams({projectId:ref.projectId,id:ref.id}));
      const {render,sample,...summary}=moment;
      return {...summary,historical:true};
    }));
  }

  async agentContext({ revisionId, circuit, selectionId, kind, ids, question, observationId, momentIds = [] }) {
    const queryIds = Array.isArray(ids) ? ids : [];
    const [session, plugin] = await Promise.all([
      this.#requestJson("/api/session"),
      this.circuitPlugin(),
    ]);
    if (session?.revision?.id !== revisionId) {
      throw new Error("当前 Circuit Lens revision 已经变化，请重新加载当前电路后再问。");
    }
    const workspaceKey = session.workspace?.conversationKey;
    if (!workspaceKey) throw new Error("当前工程尚未建立身份，请重新打开工程。");
    const knownCircuits = new Set((session.project?.circuits || []).map(item => item?.name).filter(Boolean));
    const activeCircuit = circuit || session.activeCircuit || session.project?.mainCircuit;
    if (!activeCircuit || (knownCircuits.size && !knownCircuits.has(activeCircuit))) {
      throw new Error("当前电路已经变化，请重新打开后再问。");
    }
    const projectContext = {
      projectId: session.workspace.id,
      projectHistory: session.workspace.history.slice(0, 6),
    };
    const source = {
      mode: session.source?.mode || "unknown",
      name: session.source?.name || "circuit.circ",
    };

    // No selection means the user asked about the current circuit as a
    // whole. Keep this path cheap and honest: it binds the active revision
    // and circuit, but does not run a full-canvas selection observer or claim
    // that the model has already inspected every component.
    if (!selectionId) {
      return {
        workspaceKey,
        context: {
          schema: "vibe-logisim.agent-context/v0",
          plugin,
          ...projectContext,
          authority: "workspace-binding",
          revisionId,
          selectionId: null,
          circuit: activeCircuit,
          source,
          summary: `当前电路 ${activeCircuit}；尚未指定局部选区。请按问题需要使用 inspect_circuit 读取精确结构和接口。`,
          selection: {
            reference: null,
            wireIds: [], wires: [], intent: null,
            rectangle: null, componentIds: [], netIds: [],
          },
          query: {kind: "overview", ids: []},
          evidence: null,
        },
        evidence: null,
      };
    }

    const selection = await this.#requestJson(
      `/api/selection?revisionId=${encodeURIComponent(revisionId)}&selectionId=${encodeURIComponent(selectionId)}`,
    );
    if (
      selection?.id !== selectionId ||
      selection?.revisionId !== revisionId ||
      typeof selection?.circuit !== "string"
    ) {
      throw new Error("当前选区与发送请求不匹配，请重新选择后再问。");
    }
    const allowedIds = new Set(
      kind === "component"
        ? selection.componentIds || []
        : kind === "net"
          ? selection.netIds || []
          : [],
    );
    if ((kind === "overview" && queryIds.length) || queryIds.some((id) => !allowedIds.has(id))) {
      throw new Error("查询对象不属于当前冻结选区，请重新选择后再问。");
    }
    projectContext.keptMoments=await Promise.all(momentIds.map(async id=>{
      const moment=await this.#requestJson(`/api/moments?${new URLSearchParams({projectId:session.workspace.id,id})}`);
      const {render,sample,...summary}=moment;
      return {...summary,historical:moment.revisionId!==revisionId,
        note:"User-kept runtime observation. It does not describe the current state or resume a simulation. Compare only explicit recorded signals; unrecorded intervals are unknown."};
    }));
    projectContext.objectReferences=[...(selection.componentIds||[]).map(componentId=>({componentId})),...(selection.wireIds||[]).map(wireId=>({wireId}))].map(target=>({
      ...target,url:'circuit://object?'+new URLSearchParams({projectId:session.workspace.id,revisionId,circuit:selection.circuit,...target})}));
    if (observationId) {
      const sample = await this.#requestJson(`/api/simulation/observation?revisionId=${encodeURIComponent(revisionId)}&id=${encodeURIComponent(observationId)}&circuit=${encodeURIComponent(selection.circuit)}`);
      projectContext.objectReferences=projectContext.objectReferences.map(ref=>{
        const url=new URL(ref.url);url.searchParams.set('sessionId',sample.sessionId);url.searchParams.set('instancePath',JSON.stringify(sample.instancePath));return {...ref,url:url.href};
      });
      const selected = new Set(selection.componentIds || []);
      const components = selected.size ? sample.components.filter(c => selected.has(c.componentId)) : sample.components.filter(c => c.label && ["Register", "Pin", "Probe", "Clock", "Button"].includes(c.factory)).slice(0, 16);
      projectContext.displayedSimulation = { ...sample, components, componentCount: sample.components.length,
        note: "Frozen state the user saw when asking. Other ports of this observed instance can be read with inspect_circuit. rootCircuit and instancePath identify the precise instance. Tick counts clock advances, not retired instructions. Other definitions and other copies of this definition do not inherit these values." };
    }
    try {
      const query = await this.#requestJson("/api/query", {
        method: "POST",
        body: { revisionId, selectionId, kind, ids: queryIds, question },
      });
      return {
        workspaceKey,
        context: {
          schema: "vibe-logisim.agent-context/v0",
          plugin,
          ...projectContext,
          authority: "exact-runtime",
          revisionId,
          selectionId,
          circuit: selection.circuit,
          source,
          summary: this.#selectionSummary(selection, true),
          selection: {
            reference: selection.reference,
            wireIds: selection.wireIds || [], wires: selection.wires || [], intent: selection.intent,
            rectangle: selection.rectangle,
            componentIds: selection.componentIds,
            netIds: selection.netIds,
          },
          query: {
            kind: query.kind,
            ids: query.ids,
            observationProfileId: query.observationProfileId,
          },
          evidence: query.result,
        },
        evidence: query,
      };
    } catch (error) {
      if (error?.code !== "EXACT_QUERY_UNAVAILABLE") throw error;
    }

    const view = await this.#requestJson(
      `/api/circuit?name=${encodeURIComponent(selection.circuit)}`,
    );
    if (view?.revision?.id !== revisionId) {
      throw new Error("几何观察结果不属于当前 revision。");
    }
    const selectedIds = new Set(selection.componentIds || []);
    const components = (view.circuit?.components || [])
      .filter((component) => selectedIds.has(component.componentId))
      .map((component) => ({
        componentId: component.componentId,
        factory: component.factory,
        displayName: component.displayName || null,
        label: component.label || null,
        location: component.location,
        bounds: component.bounds,
        attributes: component.attributes || {},
        subcircuit: component.subcircuit || null,
      }));
    const context = {
      schema: "vibe-logisim.agent-context/v0",
      plugin,
      ...projectContext,
      authority: "geometry-only",
      revisionId,
      selectionId,
      circuit: selection.circuit,
      source,
      summary: this.#selectionSummary(selection, false),
      selection: {
        reference: selection.reference,
        wireIds: selection.wireIds || [], wires: selection.wires || [], intent: selection.intent,
        rectangle: selection.rectangle,
        componentIds: selection.componentIds,
        netIds: [],
      },
      evidence: {
        components,
        circuitWireSegmentCount: view.circuit?.wires?.length || 0,
        capabilities: view.capabilities,
        coverage: view.coverage,
        unknowns: view.unknowns,
        observerError: view.observerError,
        warning: "Geometry-only evidence does not establish electrical connectivity.",
      },
    };
    return { workspaceKey, context, evidence: null };
  }

  #selectionSummary(selection, exact) {
    const components = Array.isArray(selection?.componentIds) ? selection.componentIds.length : 0;
    const wires = Array.isArray(selection?.wireIds) ? selection.wireIds.length : 0;
    const nets = Array.isArray(selection?.netIds) ? selection.netIds.length : 0;
    const objects = [components && `${components} 个元件`, wires && `${wires} 段导线`].filter(Boolean).join('，');
    return `${objects || '当前区域'}，${nets} 个 bit-net · ${exact ? "精确运行时" : "仅几何"}`;
  }

  async #requestJson(endpoint, { method = "GET", body = null, rawBody, headers = {} } = {}) {
    if (!this.baseUrl) throw new Error("Circuit Lens backend is not ready.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint === "/api/agent/tool" || endpoint.startsWith("/api/candidate/diff") ? 180_000 : CONTROL_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(this.controlToken ? {"X-Vibe-Control":this.controlToken} : {}),
          ...(body === null ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: rawBody ?? (body === null ? undefined : JSON.stringify(body)),
        cache: "no-store",
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("json") ? await response.json() : await response.text();
      if (!response.ok) {
        const error = new Error(
          payload?.message || payload?.error?.message || `Circuit Lens returned HTTP ${response.status}.`,
        );
        error.code = payload?.code || payload?.error?.code || null;
        error.status = response.status;
        if (payload?.schema === "vibe-logisim.circuit-plugin.error/v1" && payload.error) {
          error.toolError = payload.error;
        }
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    const processGroupId = this.processGroupId;
    this.stopping = true;
    this.child = null;
    this.baseUrl = null;
    this.statePath = null;
    this.stdoutLines?.close();
    this.stdoutLines = null;
    this.#rejectPending(new Error("Circuit Lens backend stopped."));

    if (child.exitCode !== null || child.signalCode !== null) {
      this.processGroupId = null;
      return;
    }
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(GRACEFUL_STOP_MS, false),
    ]);
    if (!graceful) {
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
  }

  #handleStdoutLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      if (line.trim()) this.emit("log", line);
      return;
    }
    if (!message || message.schema !== CONTROL_SCHEMA) return;
    if (message.event === "ready") {
      try {
        const url = new URL(message.baseUrl);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
          throw new Error("Backend advertised a non-local address.");
        }
        this.baseUrl = url.origin;
        this.controlToken = message.controlToken || null;
        this.statePath = typeof message.statePath === "string" ? message.statePath : null;
        this.readyResolve?.({ baseUrl: this.baseUrl, statePath: this.statePath });
      } catch (error) {
        this.#failStart(error);
      }
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    clearTimeout(pending.timeout);
    if (message.ok) pending.resolve(message.result || {});
    else {
      const error = new Error(message.error?.message || "Desktop control request failed.");
      error.code = message.error?.code || null;
      if (message.errorSchema === "vibe-logisim.circuit-plugin.error/v1") error.toolError = message.error;
      pending.reject(error);
    }
  }

  #request(method, params) {
    if (!this.child || !this.baseUrl || this.child.stdin.destroyed) {
      return Promise.reject(new Error("Circuit Lens backend is not ready."));
    }
    const id = String(this.nextRequestId++);
    const payload = `${JSON.stringify({ schema: CONTROL_SCHEMA, id, method, ...params })}\n`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Circuit Lens ${method} request timed out.`));
      }, CONTROL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(payload, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        reject(error);
      });
    });
  }

  async #checkHealth() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Circuit Lens health check returned HTTP ${response.status}.`);
      const health = await response.json();
      if (!health?.ok || health?.service !== "circuit-lens") {
        throw new Error("Circuit Lens health check returned an unexpected service identity.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  #failStart(error) {
    if (this.baseUrl) return;
    this.readyReject?.(error);
  }

  #handleExit(code, signal) {
    const expected = this.stopping;
    const processGroupId = this.processGroupId;
    this.child = null;
    this.baseUrl = null;
    this.statePath = null;
    this.#rejectPending(new Error("Circuit Lens backend exited."));
    if (!expected) {
      this.#terminateTree(null, processGroupId, true);
      this.processGroupId = null;
      const diagnostic = this.lastStderr ? `\n${this.lastStderr}` : "";
      const error = new Error(
        `Circuit Lens backend exited (${signal || (code ?? "unknown")}).${diagnostic}`,
      );
      this.#failStart(error);
      this.emit("exit", error);
    }
  }

  #terminateTree(child, processGroupId, force) {
    if (process.platform === "win32") {
      const pid = child?.pid || processGroupId;
      if (!pid) return;
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(pid), "/t", "/f"],
        { stdio: "ignore", windowsHide: true },
      );
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

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = { LensBackend };
