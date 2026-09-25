"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  clipboard,
  nativeImage,
} = require("electron");
const { LensBackend } = require("./backend.cjs");
const { CodexBackend } = require("./codex-backend.cjs");
const {DirectAgentWorkspace} = require("./direct-agent-workspace.cjs");
const {CircuitPlugin} = require("./circuit-plugin.cjs");
const {AgentToolHost} = require("./agent-tool-host.cjs");
const {AgentContextHost} = require("./agent-context-host.cjs");
const {AgentWorkspaceHost} = require("./agent-workspace-host.cjs");
const {CircuitContextProvider} = require("./circuit-context-host.cjs");
const {DesktopWorkspace} = require("./desktop-workspace.cjs");
const {registerFolderIpc} = require("./folder-ipc.cjs");
const {CanvasNavigation,registerCanvasIpc} = require('./canvas-navigation.cjs');
const {MaterialStore}=require('./material-store.cjs');
const {registerMaterialIpc}=require('./material-ipc.cjs');
const {registerConversationIpc}=require('./conversation-ipc.cjs');
const {ConversationDraftStore}=require('./conversation-drafts.cjs');
const {registerDraftIpc}=require('./draft-ipc.cjs');
const {resolveStartupTarget}=require('./startup-target.cjs');

// The desktop launcher may close its diagnostic pipe before child-process
// shutdown finishes. Losing a log line must not crash the main process.
process.stderr.on("error", (error) => {
  if (error.code !== "EPIPE") process.nextTick(() => { throw error; });
});

const {repoRoot, runtimeRoot} = require('./runtime-paths.cjs').configureRuntime(app);
const preloadPath = path.join(__dirname, "preload.cjs");
const backend = new LensBackend({ repoRoot,
  stateDir: process.env.VIBE_LOGISIM_STATE_DIR || (runtimeRoot ? path.join(app.getPath('userData'), 'circuit-state') : null) });

let mainWindow = null;
let codex = null;
let agentWorkspace = null;
let desktopWorkspace = null;
let materials = null;
let startupArgumentError = null;
let pendingOpenTarget = startupTarget(process.argv);
let backendReady = false;
let quitting = false;
let quitRequested = false;
let workspaceGeneration = 0;
let workspaceTransitioning = false;
let workspaceTransitionQueue = Promise.resolve();

const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) {
  app.quit();
} else {
  registerLifecycle();
}

function startupTarget(argv, workingDirectory = process.cwd()) {
  const parsed = resolveStartupTarget(argv.slice(1), {
    workingDirectory,
    repoRoot,
    // In development argv[1] is the Electron app directory; packaged builds
    // start with the executable at argv[0], so slicing from argv[1] handles
    // both shapes. The app path is still ignored for safety in dev mode.
    ignoredPaths: [app.getAppPath(), __dirname],
  });
  if (parsed?.error) startupArgumentError = parsed.error;
  return parsed;
}

function recentProject() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "recent-project.json"), "utf8"));
    if (typeof saved.path === "string" && path.extname(saved.path).toLowerCase() === ".circ" && fs.statSync(saved.path).isFile()) return saved.path;
  } catch (_) { /* A moved project opens the empty workspace, never a guessed replacement. */ }
  return null;
}

function rememberProject(filePath) {
  const target = path.join(app.getPath("userData"), "recent-project.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + ".tmp", JSON.stringify({ path: filePath }), { mode: 0o600 });
  fs.renameSync(target + ".tmp", target);
}

function isTrustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !backend.baseUrl) return false;
  try {
    return new URL(event.senderFrame.url).origin === new URL(backend.baseUrl).origin;
  } catch (_) {
    return false;
  }
}

function workspaceChangedError() {
  return new Error("电路工作区正在切换，这条问题没有发送；请基于当前电路重新提问。");
}

function transitionWorkspace(reason, operation, { preserveConversation = false } = {}) {
  const generation = ++workspaceGeneration;
  workspaceTransitioning = true;
  if (codex?.snapshot().busy) console.error(`[workspace] transition '${reason}' while a turn is running (preserveConversation=${preserveConversation})`);
  // Invalidate old turn bindings immediately, even when the project and its
  // conversation survive this change of circuit state.
  const reset = (preserveConversation ? codex?.invalidateRevision(reason) : codex?.resetWorkspace(reason)) || Promise.resolve();
  const run = workspaceTransitionQueue.catch(() => {}).then(async () => {
    await reset;
    if(desktopWorkspace?.turnActive){desktopWorkspace.turnActive=false;await desktopWorkspace.run(()=>desktopWorkspace.refresh({checkpoint:true,title:'AI 文件改动'}));}
    if (generation !== workspaceGeneration) throw workspaceChangedError();
    const result = await operation();
    if (generation !== workspaceGeneration) throw workspaceChangedError();
    return result;
  });
  workspaceTransitionQueue = run.catch(() => {});
  run.finally(() => {
    if (generation === workspaceGeneration) workspaceTransitioning = false;
  }).catch(() => {});
  return run;
}

async function restoreAgentConversation() {
  const generation = workspaceGeneration;
  try {
    const session = await backend.session();
    if (!session.folder || generation !== workspaceGeneration || workspaceTransitioning) return;
    await codex.resumeWorkspace({ workspaceKey: session.folder.conversationKey, revisionId: session.revision?.id });
  } catch (error) {
    console.error(`[codex] Conversation restore: ${error.message}`);
  }
}

function registerLifecycle() {
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    const absolute = path.resolve(filePath);
    if (path.extname(absolute).toLowerCase() !== ".circ") return;
    queueOperatingSystemOpen(absolute);
  });

  app.on("second-instance", (_event, argv, workingDirectory) => {
    const target = startupTarget(argv, workingDirectory);
    if (target?.error) dialog.showErrorBox("无法打开启动目标", target.error);
    else if (target) queueOperatingSystemOpen(target);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(startApplication).catch((error) => {
    dialog.showErrorBox("Vibe Logisim 无法启动", error.message);
    app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow && backend.baseUrl) createWindow(backend.baseUrl);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || quitRequested) app.quit();
  });

  app.on("before-quit", (event) => {
    // Let the window flush unsent drafts (or cancel closing after a disk error)
    // before tearing down the services it still needs to continue editing.
    if(mainWindow&&!mainWindow.isDestroyed()) {
      event.preventDefault();quitRequested=true;mainWindow.close();return;
    }
    if (quitting || (!backend.child && !codex?.child)) return;
    event.preventDefault();
    quitting = true;
    Promise.allSettled([backend.stop(), codex?.stop()]).finally(() => app.quit());
  });
}

async function startApplication() {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  backend.on("log", (message) => console.error(`[circuit-lens] ${message}`));
  backend.on("exit", (error) => {
    const hadReadyBackend = backendReady;
    backendReady = false;
    console.error(`[circuit-lens] exited: ${error.message}`);
    if (!quitting && hadReadyBackend) dialog.showErrorBox("Circuit Lens 已停止", error.message);
  });

  const hasFolderHistory=fs.existsSync(path.join(app.getPath('userData'),'folder-workspaces','recent.json'));
  const initialTarget = pendingOpenTarget;
  const initialOpenPath = initialTarget?.kind === 'circuit'
    ? initialTarget.path
    : (!hasFolderHistory ? recentProject() : null);
  pendingOpenTarget = null;
  if (startupArgumentError) throw new Error(startupArgumentError);
  const ready = await backend.start(initialOpenPath);
  // The agent has networking, but only the desktop owner can mutate the
  // accepted project. The credential stays out of renderer JS and agent cwd.
  session.defaultSession.webRequest.onBeforeSendHeaders({urls:[`${backend.baseUrl}/*`]}, (details, callback) => {
    details.requestHeaders["X-Vibe-Control"] = backend.controlToken;
    callback({requestHeaders:details.requestHeaders});
  });
  if (initialOpenPath) rememberProject(initialOpenPath);
  backendReady = true;
  const agentRoot = path.join(app.getPath("userData"), "circuit-agent");
  materials=new MaterialStore({root:path.join(agentRoot,'materials'),workspaceRoot:path.join(agentRoot,'workspace')});
  desktopWorkspace = new DesktopWorkspace({stateRoot:path.join(app.getPath('userData'),'folder-workspaces'),backend,materials});
  desktopWorkspace.canvas = new CanvasNavigation(request=>mainWindow.webContents.send('vibe-logisim:canvas-navigate',request));
  const initialSession = await backend.session();
  const folderRoot = initialTarget?.kind === 'folder'
    ? initialTarget.path
    : initialOpenPath ? path.dirname(initialOpenPath) : desktopWorkspace.folder.recent();
  const activeFile = initialTarget?.kind === 'circuit' ? initialTarget.path : initialOpenPath;
  if(folderRoot)await desktopWorkspace.open(folderRoot,{activeFile,conversationKey:initialSession.workspace?.conversationKey});
  agentWorkspace = new DirectAgentWorkspace(desktopWorkspace);
  const workspaceHost = new AgentWorkspaceHost({adapter:agentWorkspace, mode:'direct'});
  const circuitPlugin = new CircuitPlugin({
    invoke: payload => backend.circuitTool(payload),
    workspace: agentWorkspace,
  });
  const toolHost = new AgentToolHost({
    plugin: circuitPlugin,
    manifest: () => backend.circuitPlugin(),
    mode: 'circuit',
  });
  const contextHost = new AgentContextHost({provider:new CircuitContextProvider()});
  desktopWorkspace.on('changed', event => mainWindow?.webContents.send('vibe-logisim:folder-event',event));
  codex = new CodexBackend({
    runtimeRoot,
    workDir: desktopWorkspace.folder.current?.root || path.join(agentRoot, "workspace"),
    profileDir: path.join(agentRoot, "codex-home"),
    sessionStorePath: path.join(agentRoot, "sessions.json"),
    version: app.getVersion(),
    toolHost,
    contextHost,
    workspaceHost,
    // Chromium reads the Windows/macOS system proxy (Clash, v2rayN…) and the
    // proxy env on Linux; the Codex child only reads env, so CodexBackend
    // resolves here and forwards. The preflight probe runs in an in-memory
    // session pinned to the very same route.
    resolveProxy: url => session.defaultSession.resolveProxy(url),
    probeFetch: async proxyConfig => {
      const probeSession = session.fromPartition('vibe-provider-probe');
      await probeSession.setProxy(proxyConfig);
      return (input, init) => probeSession.fetch(input, init);
    },
  });
  codex.on("log", (message) => console.error(`[codex] ${message}`));
  codex.on("event", (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("vibe-logisim:agent-event", event);
    }
  });
  registerIpc();
  createWindow(ready.baseUrl);
  codex.start().then(restoreAgentConversation).catch((error) => console.error(`[codex] ${error.message}`));
  if (pendingOpenTarget) {
    const queued = pendingOpenTarget;
    pendingOpenTarget = null;
    await openFromOperatingSystem(queued);
  }
}

async function openFolder(root, activeFile = null) {
  const result = await transitionWorkspace('folder-opened', async () => {
    desktopWorkspace.turnActive = false;
    await codex.stop();
    const previous=await backend.session();
    try {
      return await desktopWorkspace.run(() => desktopWorkspace.open(root,{activeFile,conversationKey:previous.source?.directory===root?previous.workspace?.conversationKey:null}));
    } finally {
      codex.workDir = desktopWorkspace.folder.current?.root || codex.workDir;
      codex.currentCwd = null;
      // The folder has its own lifecycle. Agent startup reports its failure in
      // the conversation pane; it must not turn a successful folder open into
      // an error or mask a filesystem failure from the operation above.
      await codex.start().catch(error => console.error(`[codex] ${error.message}`));
    }
  });
  await restoreAgentConversation();
  return result;
}
async function selectFolderCircuit(relative,folderId=desktopWorkspace.folder.current?.id) {
  return transitionWorkspace('document-selected', () => desktopWorkspace.run(() => {
    desktopWorkspace.folder.assert(folderId);
    return desktopWorkspace.select(relative);
  }), {preserveConversation:true});
}
function registerIpc() {
  require('./canvas-preferences.cjs').registerCanvasPreferences({ipcMain,userData:app.getPath('userData'),trusted:isTrustedRenderer});
  registerCanvasIpc({ipcMain,trusted:isTrustedRenderer,canvas:desktopWorkspace.canvas});
  registerFolderIpc({ipcMain,dialog,shell,nativeImage,workspace:desktopWorkspace,trusted:isTrustedRenderer,window:()=>mainWindow,open:openFolder,select:selectFolderCircuit,mutate:operation=>{
    if(workspaceTransitioning)throw workspaceChangedError();
    if(codex.snapshot().busy||desktopWorkspace.turnActive)throw new Error('请先停止 AI 回答，再移动或删除文件');
    return transitionWorkspace('files-changed',()=>desktopWorkspace.run(operation),{preserveConversation:true});
  }});
  registerConversationIpc({ipcMain,backend,codex,trusted:isTrustedRenderer,transitioning:()=>workspaceTransitioning,
    generation:()=>workspaceGeneration,begin:()=>{workspaceTransitioning=true;return ++workspaceGeneration;},end:token=>{if(token===workspaceGeneration)workspaceTransitioning=false;}});
  registerDraftIpc({ipcMain,codex,store:new ConversationDraftStore(path.join(app.getPath('userData'),'conversation-drafts')),backend,trusted:isTrustedRenderer,transitioning:()=>workspaceTransitioning,generation:()=>workspaceGeneration,dialog,window:()=>mainWindow});
  registerMaterialIpc({ipcMain,dialog,nativeImage,store:materials,backend,codex:()=>codex,trusted:isTrustedRenderer,window:()=>mainWindow,transitioning:()=>workspaceTransitioning,generation:()=>workspaceGeneration});
  const layoutPath = path.join(app.getPath("userData"), "workspace-layout.json");
  ipcMain.handle("vibe-logisim:layout-read", event => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    try { return JSON.parse(fs.readFileSync(layoutPath, "utf8")); } catch { return null; }
  });
  ipcMain.handle("vibe-logisim:layout-write", (event, value) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (!value || !Number.isFinite(value.rail) || !Number.isFinite(value.review)) throw new Error("布局尺寸无效");
    const layout = {rail: Math.max(224, Math.min(420, value.rail)), review: Math.max(320, Math.min(820, value.review)),
      navigatorShare: Number.isFinite(value.navigatorShare) ? Math.max(.12, Math.min(.85, value.navigatorShare)) : .38,
      fileShare:Number.isFinite(value.fileShare)?Math.max(.1,Math.min(.8,value.fileShare)):.32, filesCollapsed:value.filesCollapsed===true,
      navigatorCollapsed: value.navigatorCollapsed === true, inspectorCollapsed: value.navigatorCollapsed !== true && value.inspectorCollapsed === true};
    fs.mkdirSync(path.dirname(layoutPath), {recursive: true});
    fs.writeFileSync(layoutPath + ".tmp", JSON.stringify(layout));
    fs.renameSync(layoutPath + ".tmp", layoutPath);
    return layout;
  });
  ipcMain.handle("vibe-logisim:agent-mode", (event, mode) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    return codex.setChangeMode(mode);
  });
  ipcMain.handle("vibe-logisim:agent-answer", (event, requestId, answers) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    return codex.answer(requestId, answers);
  });
  ipcMain.handle("vibe-logisim:copy-text", (event, value) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (typeof value !== "string" || value.length > 2 * 1024 * 1024) throw new Error("复制内容过长");
    return clipboard.writeText(value);
  });
  ipcMain.handle("vibe-logisim:open-web-link", (event, value) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (typeof value !== "string" || value.length > 8192) throw new Error("链接无效");
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("只能打开网页链接");
    return shell.openExternal(url.href);
  });
  ipcMain.handle("vibe-logisim:project-action", async (event, action, request) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (!["apply", "restore", "save", "edit", "place", "move", "wire", "delete", "undo", "interface"].includes(action) ||
        !/^project-[a-f0-9]{16}$/.test(request?.projectId || "") ||
        !/^[a-f0-9]{64}$/.test(request?.revisionId || "")) throw new Error("Invalid project action.");
    if (action === "apply") validateCandidateRequest(request);
    if (action === "restore" && !/^change-[a-f0-9]{16}$/.test(request.changeId || "")) throw new Error("Invalid history entry.");
    // Saving does not change the current circuit or interrupt its conversation.
    if (action === "save") {
      if (workspaceTransitioning) throw workspaceChangedError();
      return desktopWorkspace.run(async () => {
        const result = await backend.projectAction(action, request);
        if(desktopWorkspace.folder.current) { await desktopWorkspace.saveWorking(); await desktopWorkspace.refresh({checkpoint:true,title:'保存电路'}); }
        return result;
      });
    }
    return transitionWorkspace(`circuit-${action}`, () => desktopWorkspace.run(async () => {
      const result = await backend.projectAction(action, request);
      if (desktopWorkspace.folder.current) {
        await desktopWorkspace.saveWorking();
        await desktopWorkspace.refresh({checkpoint:true,title:'画布编辑'});
        return backend.session();
      }
      if (action === "apply") agentWorkspace?.clearRecovery(request.projectId);
      return result;
    }), { preserveConversation: true });
  });
  ipcMain.handle("vibe-logisim:open-candidate", async (event, request) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    validateCandidateRequest(request);
    const copy = await backend.candidateWorkingCopy(request);
    const child = spawn("java", ["-jar", copy.runtimeJar, copy.path], { cwd: path.dirname(copy.path), detached: true, stdio: "ignore", shell: false });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { path: copy.path };
  });
  ipcMain.handle("vibe-logisim:app-info", (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    return Object.freeze({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    });
  });

  ipcMain.handle("vibe-logisim:open-circuit", async (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "打开 Logisim 电路",
      properties: ["openFile"],
      filters: [
        { name: "Logisim circuit", extensions: ["circ"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (selection.canceled || selection.filePaths.length !== 1) return { canceled: true };
    await openFolder(path.dirname(selection.filePaths[0]),selection.filePaths[0]);
    const result = await backend.session();
    return {
      canceled: false,
      revisionId: result.revisionId || null,
      sourceName: result.sourceName || path.basename(selection.filePaths[0]),
    };
  });

  ipcMain.handle("vibe-logisim:import-circuit", async (event, request) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (typeof request?.filename !== "string" || !request.filename.toLowerCase().endsWith(".circ") ||
        !(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > 128 * 1024 * 1024)
      throw new Error("请选择有效的 .circ 文件（不超过 128 MB）");
    const result = await transitionWorkspace("circuit-imported", () => backend.openUpload(request.filename, request.bytes));
    restoreAgentConversation();
    return result;
  });

  ipcMain.handle("vibe-logisim:reload-circuit", async (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    return transitionWorkspace("circuit-reloaded", () => backend.reload(), { preserveConversation: true });
  });

  ipcMain.handle("vibe-logisim:agent-state", (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    return codex?.snapshot() || {
      status: "unavailable",
      available: false,
      busy: false,
      policy: "read-only",
      messages: [],
    };
  });
  ipcMain.handle("vibe-logisim:agent-capabilities", (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    return codex?.capabilityReport?.() || null;
  });

  ipcMain.handle("vibe-logisim:agent-recoveries", (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    return agentWorkspace?.listRecoveries() || [];
  });
  ipcMain.handle("vibe-logisim:agent-models", (event, refresh) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    return codex.listModels(refresh === true);
  });
  ipcMain.handle("vibe-logisim:agent-model-select", (event, selection) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (workspaceTransitioning) throw workspaceChangedError();
    return codex.selectModel(selection);
  });
  ipcMain.handle("vibe-logisim:agent-reconnect", async event => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (workspaceTransitioning) throw workspaceChangedError();
    if (!codex.canReconnect()) throw new Error("请先停止当前回答，再重新连接");
    ++workspaceGeneration;
    workspaceTransitioning = true;
    try {
      await codex.reconnect();
      const current = await backend.session();
      if (current.folder && codex.status === "ready") {
        await codex.resumeWorkspace({workspaceKey:current.folder.conversationKey,revisionId:current.revision?.id});
      }
      return codex.snapshot();
    } finally { workspaceTransitioning = false; }
  });
  ipcMain.handle('vibe-logisim:agent-account', async (event, action) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer.');
    if (workspaceTransitioning) throw workspaceChangedError();
    if (action === 'cancel') return codex.cancelLogin();
    if (action === 'logout') return codex.logout();
    if (action !== 'login') throw new Error('无效的登录操作。');
    const {authUrl} = await codex.login();
    try {
      const url = new URL(authUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('登录地址无效。');
      await shell.openExternal(url.href);
      return codex.snapshot();
    } catch (error) { await codex.cancelLogin().catch(() => {}); throw error; }
  });
  ipcMain.handle('vibe-logisim:agent-provider', async (event, request) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer.');
    const action = request?.action;
    // Preflight probes only talk to the student's endpoint; the workspace and
    // the running app-server are untouched, so no transition is needed.
    if (action === 'discover' || action === 'test') return codex.probeCustomProvider(action, request?.settings || {});
    if (action === 'network') return codex.networkStatus(request?.settings?.baseUrl || null);
    if (action !== 'save' && action !== 'clear') throw new Error('无效的接口设置操作。');
    if (workspaceTransitioning) throw workspaceChangedError();
    ++workspaceGeneration;
    workspaceTransitioning = true;
    try {
      const state = action === 'clear' ? await codex.clearCustomProvider() : await codex.configureCustomProvider(request?.settings || {});
      const current = await backend.session();
      if (current.folder && codex.status === 'ready') {
        await codex.resumeWorkspace({workspaceKey:current.folder.conversationKey, revisionId:current.revision?.id});
      }
      return state;
    } finally { workspaceTransitioning = false; }
  });
  ipcMain.handle("vibe-logisim:review-recovery", async (event, request) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (workspaceTransitioning || codex?.snapshot().busy) throw new Error("请等当前任务结束后查看草稿");
    const generation = workspaceGeneration;
    const current = await backend.session();
    if (generation !== workspaceGeneration || workspaceTransitioning || codex?.snapshot().busy ||
        current.workspace?.id !== request?.projectId || current.revision?.id !== request?.revisionId) throw workspaceChangedError();
    return agentWorkspace.reviewRecovery(request.projectId, request.revisionId);
  });

  ipcMain.handle("vibe-logisim:agent-ask", async (event, rawRequest) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (!codex) throw new Error("Codex App Server is not configured.");
    if (workspaceTransitioning) throw workspaceChangedError();
    const expectedGeneration = workspaceGeneration;
    desktopWorkspace.folder.assert(rawRequest.folderId);
    const request = validateAgentAsk(rawRequest);
    const current = await backend.session();
    const resolved = request.revisionId ? await backend.agentContext({...request,momentIds:[]}) : {context:{revisionId:null,summary:'工作区文件',authority:'folder'},evidence:null};
    resolved.workspaceKey = current.folder.conversationKey;
    resolved.context.folder = current.folder;
    resolved.context.diskIssue = desktopWorkspace.error || null;
    const momentRefs=rawRequest.momentRefs||request.momentIds.map(id=>({id,projectId:current.workspace?.id}));
    if(!Array.isArray(momentRefs)||momentRefs.length>2||momentRefs.some(ref=>!/^live-[a-f0-9]{16}$/.test(ref.id||'')||!current.folder.documentIds?.includes(ref.projectId)))throw new Error('观察不属于当前工作区');
    resolved.context.keptMoments=await backend.keptMoments(momentRefs);
    if (workspaceTransitioning || expectedGeneration !== workspaceGeneration) {
      throw workspaceChangedError();
    }
    if (rawRequest.conversationId && rawRequest.conversationId !== codex.conversationState(resolved.workspaceKey).activeId) throw new Error('对话已切换，问题仍保留在原对话');
    const accepted = await codex.ask({
      question: request.question,
      context: {...resolved.context,materials:desktopWorkspace.references(request.materialRefs)},
      workspaceKey: resolved.workspaceKey,
      editMessageId: request.editMessageId || null,
      expectedTurnId: request.expectedTurnId,
    });
    if (workspaceTransitioning || expectedGeneration !== workspaceGeneration) {
      throw workspaceChangedError();
    }
    return {
      ...accepted,
      evidence: resolved.evidence,
      context: {
        authority: resolved.context.authority,
        summary: resolved.context.summary,
        circuit: resolved.context.circuit,
        revisionId: resolved.context.revisionId,
        selectionId: resolved.context.selectionId,
      },
    };
  });

  ipcMain.handle("vibe-logisim:agent-interrupt", async (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (!codex) return { interrupted: false };
    return codex.interrupt();
  });
}

function validateCandidateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      !/^candidate-[0-9a-f]{16}$/.test(request.candidateId || "") ||
      !/^[0-9a-f]{64}$/.test(request.revisionId || "")) throw new Error("Invalid candidate");
}

function validateAgentAsk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent request must be an object.");
  }
  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question || question.length > 4_000) {
    throw new Error("问题不能为空，且不能超过 4000 个字符。");
  }
  const revisionId = typeof value.revisionId === "string" ? value.revisionId : "";
  if (revisionId && !/^[0-9a-f]{64}$/i.test(revisionId)) throw new Error("Invalid circuit revision.");
  const circuit = typeof value.circuit === "string" ? value.circuit.trim() : "";
  if (revisionId && (!circuit || circuit.length > 256)) throw new Error("Invalid current circuit.");
  const selectionId = typeof value.selectionId === "string" ? value.selectionId : "";
  if (revisionId && selectionId && !/^sel-[0-9a-f]{16}$/.test(selectionId)) throw new Error("Invalid circuit selection.");
  const kind = ["overview", "component", "net"].includes(value.kind) ? value.kind : "overview";
  const ids = Array.isArray(value.ids) ? [...new Set(value.ids)] : [];
  if (
    ids.length > 256 ||
    ids.some((item) => typeof item !== "string" || !item || item.length > 256)
  ) {
    throw new Error("Invalid circuit query ids.");
  }
  const observationId = value.observationId;
  if (observationId != null && !/^live-[a-f0-9]{16}$/.test(observationId)) throw new Error("Invalid simulation observation.");
  const momentIds=value.momentIds || [];
  if(!Array.isArray(momentIds)||momentIds.length>2||momentIds.some(id=>typeof id!=="string"||!/^live-[a-f0-9]{16}$/.test(id)))throw new Error("Invalid kept observations.");
  const editMessageId = typeof value.editMessageId === "string" ? value.editMessageId.trim() : "";
  if (editMessageId.length > 512) throw new Error("Invalid edited message.");
  const expectedTurnId = value.expectedTurnId ?? null;
  if (expectedTurnId !== null && (typeof expectedTurnId !== "string" || !expectedTurnId.trim() || expectedTurnId.length > 512)) throw new Error("Invalid active turn.");
  if (expectedTurnId !== null && editMessageId) throw new Error("不能在追加意见时编辑旧问题。");
  return { question, revisionId, circuit, selectionId, kind, ids, observationId, editMessageId, expectedTurnId, momentIds:[...new Set(momentIds)],materialRefs:value.materialRefs||[] };
}

function createWindow(baseUrl) {
  const allowedOrigin = new URL(baseUrl).origin;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#ffffff",
    title: "Vibe Logisim",
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  const allowOnlyLensOrigin = (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin === allowedOrigin) return;
    } catch (_) {
      // Invalid destinations are denied below.
    }
    event.preventDefault();
  };
  mainWindow.webContents.on("will-navigate", allowOnlyLensOrigin);
  mainWindow.webContents.on('did-start-navigation',details=>{
    if(details.isMainFrame && !details.isSameDocument)desktopWorkspace.canvas.reset();
  });
  mainWindow.webContents.on("will-redirect", allowOnlyLensOrigin);
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on('will-prevent-unload',()=>{quitRequested=false;});
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    desktopWorkspace.canvas.reset();
    mainWindow = null;
  });
  mainWindow.loadURL(`${baseUrl}/`);
}

async function openFromOperatingSystem(target) {
  try {
    const root = target.kind === 'folder' ? target.path : path.dirname(target.path);
    const activeFile = target.kind === 'circuit' ? target.path : null;
    await openFolder(root, activeFile);
    if (activeFile) rememberProject(activeFile);
    restoreAgentConversation();
    if (!mainWindow || mainWindow.isDestroyed()) createWindow(backend.baseUrl);
    else mainWindow.webContents.reloadIgnoringCache();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  } catch (error) {
    dialog.showErrorBox("无法打开电路", error.message);
  }
}

function queueOperatingSystemOpen(target) {
  if (typeof target === 'string') target = {kind: 'circuit', path: target};
  if (!backendReady) {
    pendingOpenTarget = target;
    return;
  }
  openFromOperatingSystem(target);
}
