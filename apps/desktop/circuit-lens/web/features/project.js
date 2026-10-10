import { asArray, displayName, firstDefined, normalizeBounds, responseRevision, revisionValue, statusErrorMessage } from '../core/values.js';
import { makeElement, makeSvg } from '../core/dom.js';
import { API } from '../core/endpoints.js';

export const modelDependencies = ["project", "review"];

export const dependencies = ["refreshWorkspaceLayout","prepareCircuitRendering","discardCircuitRendering","cancelPlacement","componentsContextChanged","placementContextChanged","workspaceFolderChanged","renderConnections","openDraftProject","restoreDraftFocus","materialsProjectChanged","momentsProjectChanged","renderSimulation","prepareCircuitNavigation","resetComparison","closeCandidateEvidence","invalidateComparison","resetRendering","resetNavigation","didNavigateCircuit","restoreEntrySelection","selectionSnapshot","invalidateSimulation","clearSelection","closeMemory","closeMobilePanels","loadCandidates","loadReview","loadSelection","pollSimulation","renderCircuit","renderInspector","renderProjectHistory","setCanvasStatus","renderProjectInfo","showToast","startReviewPolling","updateCapabilityState","updateSelectionDock"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, review: reviewState} = models;
  const request = client.request;
  let bootstrapEpoch=0;
  const canvas=window.vibeDesktop?.canvas;
  const viewState=(status,circuit=null)=>({status,circuit,folderId:projectState.folder?.id??null,
    projectId:projectState.session?.workspace?.id??null,revisionId:projectState.revision??null});
  const reportView=(status,circuit=null)=>canvas?.report(viewState(status,circuit)).catch(()=>{});
  canvas?.onNavigate(async target=>{
    let result;
    try { result=await bootstrap({circuit:target.circuit,target}); }
    catch(error){result={...target,status:'failed',circuit:null,error:statusErrorMessage(error,'无法打开电路')};}
    await canvas.complete(target.id,result||{...target,status:'superseded',circuit:null});
  });
function sessionHasWorkspace(session) {
    if (!session) return false;
    if (session.workspace === null || session.hasWorkspace === false || session.status === "no-workspace") return false;
    return Boolean(
      session.workspace ||
        session.revision ||
        session.currentCircuit ||
        (Array.isArray(session.circuits) && session.circuits.length),
    );
  }

async function bootstrap({ preserveStale = false, circuit = null, target = null } = {}) {
    const token=++bootstrapEpoch;
    ++projectState.circuitRequestEpoch;
    ports.setCanvasStatus("正在读取本地电路工作区…", "loading");
    let session;
    try {
      session = await request(API.session);
    } catch (error) {
      if(token!==bootstrapEpoch)return;
      if (error.status === 404 && error.payload?.code === "NO_WORKSPACE") {
        session = { workspace: null, status: "no-workspace" };
      } else {
        showNoServer(error);
        if(target)return {...target,status:'failed',circuit:null,error:statusErrorMessage(error,'无法读取工作区')};
        return;
      }
    }

    if(token!==bootstrapEpoch)return;
    if(target && (session.folder?.id!==target.folderId || session.workspace?.id!==target.projectId ||
      session.revision?.id!==target.revisionId))return;
    projectState.folder=session.folder||null;
    ports.workspaceFolderChanged(projectState.folder);
    if (!sessionHasWorkspace(session)) {
      await showEmptyWorkspace();
      return;
    }

    const revision = revisionValue(firstDefined(session.revision, session.workspace?.revision));
    const sameProject = Boolean(projectState.session?.workspace?.id) && projectState.session.workspace.id === session.workspace?.id;
    if(!sameProject){projectState.circuit=null;ports.resetComparison();ports.closeCandidateEvidence();}
    if (projectState.session?.workspace?.id !== session.workspace?.id || projectState.revision !== revision) {
      ports.invalidateSimulation();

    }
    projectState.session = session;

    projectState.revision = revision;
    const draftFocus = await ports.openDraftProject();
    if(token!==bootstrapEpoch)return;
    ports.momentsProjectChanged();
    ports.materialsProjectChanged();
    projectState.sourceChanged = Boolean(firstDefined(
      session.sourceStatus?.stale,
      session.sourceStatus?.changed,
      session.sourceChanged,
      session.stale,
      false,
    ));
    projectState.staleKind = "source";
    projectState.capabilities = session.capabilities || session.workspace?.capabilities || {};
    projectState.runtime = session.runtime || null;
    ports.updateCapabilityState();
    updateSessionChrome();

    let circuits = asArray(firstDefined(session.circuits, session.workspace?.circuits));
    if (!circuits.length) {
      try {
        const circuitResponse = await request(API.circuits);
        circuits = asArray(firstDefined(circuitResponse?.circuits, circuitResponse));
      } catch (_) {
        circuits = [];
      }
    }
    if(token!==bootstrapEpoch)return;
    projectState.circuits = circuits;
    renderCircuitList();

    const preferred = firstDefined(
      circuits.some(c => displayName(c) === circuit) ? circuit : null,
      sameProject && circuits.some(c => displayName(c) === projectState.circuitName) ? projectState.circuitName : null,
      !sameProject && circuits.some(c=>displayName(c)===draftFocus?.circuit) ? draftFocus.circuit : null,
      session.activeCircuit,
      session.currentCircuit,
      session.workspace?.currentCircuit,
      session.project?.mainCircuit,
      session.mainCircuit,
      circuits[0],
    );
    if (preferred) {
      const result=await loadCircuit(displayName(preferred), { clearSelection: !preserveStale,
        navigation: {kind:target?.circuit?'definition':'refresh'}, draftFocus:!sameProject&&!target?.circuit?draftFocus:null, fromBootstrap:true });
      if(token!==bootstrapEpoch)return;
      ports.startReviewPolling();
      return result;
    } else {
      await showEmptyWorkspace("这份项目没有可读取的电路定义。");
    }
    ports.startReviewPolling();
  }

function showNoServer(error) {
    ui.emptyState.hidden = false;
    ui.emptyState.querySelector("h2").textContent = "暂时无法读取工作区";
    ui.emptyState.querySelector("p").textContent = "";
    ui.emptyOpenButton.textContent = "重新连接";
    ui.emptyOpenButton.dataset.action = "retry";
    ui.emptyOpenButton.hidden = false;
    ui.emptyHint.textContent = statusErrorMessage(error, "无法连接本地服务");
    ports.setCanvasStatus("", "idle");
  }

function showEmptyWorkspace(detail) {
    ports.invalidateSimulation();
    ++projectState.circuitRequestEpoch;
    ports.resetRendering();
    ports.resetNavigation();
    projectState.session = projectState.folder ? {folder:projectState.folder,workspace:null} : null;
    projectState.circuit = null;
    projectState.circuitName = null;
    projectState.revision = null;
    ports.refreshWorkspaceLayout();
    reportView('shown');
    const draftLoading = ports.openDraftProject();
    ports.momentsProjectChanged();
    ports.materialsProjectChanged();
    projectState.capabilities = {};
    projectState.capabilityState = "idle";
    projectState.sourceChanged = false;
    projectState.staleKind = "source";
    projectState.circuits = [];
    ports.clearSelection({ notifyServer: false });
    renderCircuitList();
    ui.emptyState.hidden = false;
    ui.emptyState.querySelector("h2").textContent = projectState.folder ? "选择或新建电路" : "尚未打开项目";
    ui.emptyState.querySelector("p").textContent = projectState.folder ? "打开一份 .circ 文件，或在对话中描述要做的电路。" : "";
    ui.emptyOpenButton.textContent = "打开文件夹";
    ui.emptyOpenButton.dataset.action = "open";
    ui.emptyOpenButton.hidden = Boolean(projectState.folder);
    ui.emptyHint.textContent = detail || "";
    ui.workspaceName.textContent = "尚未选择 .circ";
    ports.placementContextChanged();
    ports.componentsContextChanged();
    ports.renderProjectInfo();
    ui.staleBanner.hidden = true;
    ports.setCanvasStatus("", "idle");
    return draftLoading;
  }

function updateSessionChrome() {
    ports.refreshWorkspaceLayout();
    ports.placementContextChanged();
    ports.componentsContextChanged();
    const workspace = projectState.session?.workspace;
    ui.workspaceName.textContent = firstDefined(
      typeof workspace === "object" ? workspace.name : workspace,
      projectState.session?.project?.name,
      projectState.session?.source?.name,
      projectState.session?.filename,
      "电路项目",
    );
    ui.connectionWarning.hidden = projectState.session?.connectionIndex?.available !== false;
    ui.appShell.setAttribute("aria-busy", String(projectState.projectBusy));
    ui.undoButton.disabled = !workspace?.canUndo || projectState.projectBusy || projectState.sourceChanged;
    ui.deleteSelectionButton.disabled = !(ports.selectionSnapshot().componentIds.length || ports.selectionSnapshot().wireIds.length) || projectState.projectBusy || projectState.sourceChanged;
    ports.renderProjectHistory();
    ports.renderProjectInfo();
    ui.staleBanner.hidden = !projectState.sourceChanged;
    if (projectState.sourceChanged) {
      ui.staleBanner.querySelector("strong").textContent = projectState.staleKind === "workspace" ? "工作区版本已切换" : "源文件已改变";
      ui.reloadRevisionButton.textContent = projectState.staleKind === "workspace" ? "读取当前版本" : "重新载入新版本";
    }
  }

function normalizeCircuitResponse(payload) {
    const circuit = payload?.circuit || payload;
    return {
      raw: circuit,
      name: firstDefined(circuit?.name, payload?.name, projectState.circuitName, "main"),
      bounds: normalizeBounds(circuit?.bounds),
      render: circuit?.render || null,
      components: asArray(circuit?.components),
      wires: asArray(circuit?.wires),
      nets: asArray(circuit?.nets),
      bundles: asArray(firstDefined(circuit?.bundles, circuit?.wireBundles)),
      instances: asArray(circuit?.instances),
      instancePaths: asArray(circuit?.instancePaths),
      unknowns: asArray(firstDefined(payload?.unknowns, circuit?.unknowns)),
      observerError: firstDefined(payload?.observerError, circuit?.observerError),
    };
  }

async function refreshEditedProject(session, circuit) {
    if(session.workspace?.id!==projectState.session?.workspace?.id)throw new Error('工程已切换');
    ++bootstrapEpoch;
    ports.invalidateSimulation();
    projectState.session=session;
    projectState.revision=revisionValue(session.revision);
    projectState.sourceChanged=Boolean(session.sourceStatus?.stale||session.sourceStatus?.changed);
    projectState.capabilities=session.capabilities||{};
    projectState.circuits=asArray(session.project?.circuits);
    const target=projectState.circuits.some(c=>displayName(c)===circuit)?circuit:session.project?.mainCircuit;
    // An edit does not reopen the folder, restore a draft, reload materials or
    // recover conversations. Only its document and affected bindings changed.
    await loadCircuit(target,{navigation:{kind:'refresh'},editing:true});
    void ports.loadCandidates();
}

async function loadCircuit(name, { clearSelection: shouldClear = true, navigation = {kind:"definition"}, draftFocus = null, editing = false, fromBootstrap = false } = {}) {
    if (!name) return;
    if(!fromBootstrap)++bootstrapEpoch;
    if(name!==projectState.circuitName)ports.cancelPlacement();
    ports.prepareCircuitNavigation(name,navigation);
    const epoch = ++projectState.circuitRequestEpoch;
    const projectId = projectState.session?.workspace?.id;
    reportView('loading');
    if(!editing)ports.setCanvasStatus(`正在打开 ${name}…`, "loading");
    try {
      const payload = await request(`${API.circuit}?name=${encodeURIComponent(name)}`);
      if (epoch !== projectState.circuitRequestEpoch || projectId !== projectState.session?.workspace?.id) return;

      const nextCircuit = normalizeCircuitResponse(payload);
      const nextRevision = firstDefined(responseRevision(payload), projectState.revision);
      const preparedFrame = await ports.prepareCircuitRendering(nextCircuit, {revision:nextRevision, preserveCamera:editing});
      if (epoch !== projectState.circuitRequestEpoch || projectId !== projectState.session?.workspace?.id) {
        ports.discardCircuitRendering(preparedFrame); return;
      }

      projectState.circuitName = name;
      ports.closeMemory();
      ui.currentCircuitName.textContent = name;

      projectState.circuit = nextCircuit;
      projectState.revision = nextRevision;
      projectState.capabilities = payload?.capabilities || projectState.capabilities || {};
      projectState.runtime = payload?.runtime || projectState.runtime;
      projectState.sourceChanged = Boolean(firstDefined(
        payload?.sourceStatus?.stale,
        payload?.sourceStatus?.changed,
        payload?.sourceChanged,
        projectState.sourceChanged,
      ));
      if (shouldClear) ports.clearSelection({ notifyServer: false });
      ports.updateCapabilityState(payload);
      updateSessionChrome();
      renderCircuitList();
      ports.renderCircuit({preserveCamera:editing, preparedFrame});
      ports.placementContextChanged();
      ports.componentsContextChanged();
      const returnEntry = ports.didNavigateCircuit(name, navigation);
      // Restore before asynchronous observation/review loads expose a usable
      // composer; an old server selection must not replace the draft's focus.
      if(draftFocus)ports.restoreDraftFocus(draftFocus);
      ui.emptyState.hidden = true;
      if (projectState.capabilityState === "exact" && !projectState.circuit.observerError) ports.setCanvasStatus("", "idle");
      if (projectState.circuit.observerError) {
        ports.setCanvasStatus(`精确观察不可用：${statusErrorMessage(projectState.circuit.observerError, "目标运行时或外部库不可用")}`, "warning");
      }
      ui.documentKind.textContent = projectState.circuit.render ? "" : "图面预览";
      ports.renderInspector();
      ports.renderSimulation();
      ports.renderConnections();
      reportView('shown',name);
      if(!editing){await ports.pollSimulation();ports.loadCandidates();}
      if(!draftFocus&&!editing)await ports.loadSelection();
      if (epoch !== projectState.circuitRequestEpoch || projectId !== projectState.session?.workspace?.id) return;
      ports.restoreEntrySelection(returnEntry);
      if(!editing){await ports.loadReview({ quiet: true });ports.closeMobilePanels();}
      if(epoch!==projectState.circuitRequestEpoch || projectId!==projectState.session?.workspace?.id)return;
      return viewState('shown',name);
    } catch (error) {
      if (epoch !== projectState.circuitRequestEpoch || projectId !== projectState.session?.workspace?.id) return;
      ports.setCanvasStatus(statusErrorMessage(error, `无法读取电路 ${name}`), "error");
      ports.showToast(statusErrorMessage(error, "读取电路失败"));
      reportView('failed');
      if(editing)throw error;
      return {...viewState('failed'),error:statusErrorMessage(error,'无法打开电路')};
    }
  }

function renderCircuitList() {
    const filter = ui.circuitSearch.value.trim().toLocaleLowerCase();
    const circuits = projectState.circuits.filter((item) => displayName(item).toLocaleLowerCase().includes(filter));
    ui.circuitList.replaceChildren();
    ui.circuitCount.textContent = String(projectState.circuits.length);
    if (!circuits.length) {
      if(projectState.circuits.length)ui.circuitList.append(makeElement("p", "list-empty", "没有匹配的电路"));
      return;
    }
    circuits.forEach((item) => {
      const name = displayName(item);
      const button = makeElement("button", "circuit-item");
      button.type = "button";
      button.classList.toggle("is-active", name === projectState.circuitName);
      button.setAttribute("aria-current", name === projectState.circuitName ? "page" : "false");
      const icon = makeSvg("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" });
      icon.append(makeSvg("rect", { x: 3, y: 4, width: 14, height: 12 }), makeSvg("path", { d: "M1 8h2M17 8h2M1 12h2M17 12h2" }));
      button.append(icon, makeElement("strong", "", name));
      const count = firstDefined(item?.componentCount, item?.components);
      button.title = Number.isFinite(count) ? `${count} 个元件` : name;
      button.addEventListener("click", () => loadCircuit(name));
      ui.circuitList.append(button);
    });
    requestAnimationFrame(()=>ui.circuitList.querySelector('[aria-current="page"]')?.scrollIntoView({block:"nearest"}));
  }

async function pollSessionState() {
    try {
      const revisionAtStart = projectState.revision;
      const session = await request(API.session);
      if (projectState.projectBusy || projectState.revision !== revisionAtStart) return false;
      const currentRevision = responseRevision(session);
      if (currentRevision && projectState.revision && currentRevision !== projectState.revision) {
        if(projectState.folder){await bootstrap();return true;}
        ports.invalidateComparison();
        markStale("另一处操作更新了工程，读取最新版本后继续编辑。", "workspace");
        return false;
      }
      if (session?.sourceStatus?.stale || session?.sourceStatus?.changed) {
        markStale(firstDefined(session.sourceStatus.reason, "磁盘中的电路已更新，重新载入后继续编辑。"), "source");
        return false;
      }
      projectState.session = session;
      updateSessionChrome();
      return !projectState.sourceChanged;
    } catch (_) {
      return false;
    }
  }

function markStale(message, kind = "source") {
    projectState.sourceChanged = true;
    projectState.staleKind = kind;
    ui.staleBanner.hidden = false;
    ui.staleBanner.querySelector("strong").textContent = kind === "workspace" ? "工作区版本已切换" : "源文件已改变";
    ui.reloadRevisionButton.textContent = kind === "workspace" ? "读取当前版本" : "重新载入新版本";
    ui.staleBanner.querySelector("span").textContent = message || "重新载入后继续编辑，现有改动可从历史恢复。";
    ports.updateSelectionDock();
    ports.updateCapabilityState();
    updateSessionChrome();
  }

async function reloadRevision() {
    ui.reloadRevisionButton.disabled = true;
    ui.reloadRevisionButton.textContent = "正在重新载入…";
    try {
      if (window.vibeDesktop?.reloadCircuit) await window.vibeDesktop.reloadCircuit();
      else await request(API.reload, { method: "POST" });
      projectState.sourceChanged = false;
      reviewState.review = null;
      reviewState.reviewSignature = "";
      ports.clearSelection({ notifyServer: false });
      await bootstrap();
      ports.showToast("已读取磁盘版本，之前的工作仍保留在历史中。");
    } catch (error) {
      ports.showToast(`重新载入失败：${error.message}`);
    } finally {
      ui.reloadRevisionButton.disabled = false;
      ui.reloadRevisionButton.textContent = "重新载入新版本";
    }
  }

async function handleStaleAction() {
    if (projectState.staleKind === "source") {
      await reloadRevision();
      return;
    }
    ui.reloadRevisionButton.disabled = true;
    ui.reloadRevisionButton.textContent = "正在读取…";
    try {
      ports.clearSelection({ notifyServer: false });
      projectState.sourceChanged = false;
      await bootstrap();
      ports.showToast("已读取当前工作区版本；旧引用没有自动映射，请重新选择。 ");
    } finally {
      ui.reloadRevisionButton.disabled = false;
    }
  }

async function openFile(file) {
    if (!file) return;
    if (!file.name.toLocaleLowerCase().endsWith(".circ")) {
      ports.showToast("请选择 Logisim .circ 文件。");
      return;
    }
    ports.setCanvasStatus(`正在打开 ${file.name}…`, "loading");
    try {
      const bytes = await file.arrayBuffer();
      if (window.vibeDesktop?.importCircuit) {
        await window.vibeDesktop.importCircuit({filename:file.name, bytes:new Uint8Array(bytes)});
      } else await request(API.open, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
        },
        body: bytes,
      });
      ports.clearSelection({ notifyServer: false });
      reviewState.review = null;
      reviewState.reviewSignature = "";
      await bootstrap();
    } catch (error) {
      ports.setCanvasStatus(`无法打开 ${file.name}：${error.message}`, "error");
      ports.showToast(`打开失败：${error.message}`);
    } finally {
      ui.fileInput.value = "";
    }
  }

async function openDesktopFile() {
    ports.setCanvasStatus("正在选择工作区文件夹…", "loading");
    try {
      const result = await window.vibeDesktop.folder.open();
      if (result?.canceled) {
        ports.setCanvasStatus("", "idle");
        return false;
      }
      projectState.sourceChanged = false;
      ui.staleBanner.hidden = true;
      ports.clearSelection({ notifyServer: false });
      reviewState.review = null;
      reviewState.reviewSignature = "";
      await bootstrap();
      return true;
    } catch (error) {
      ports.setCanvasStatus(`无法打开电路：${error.message}`, "error");
      ports.showToast(`打开失败：${error.message}`);
      return false;
    }
  }

function chooseCircuitFile() {
    if (window.vibeDesktop?.openCircuit) {
      openDesktopFile();
      return;
    }
    ui.fileInput.click();
  }
  return Object.freeze({sessionHasWorkspace, bootstrap, refreshEditedProject, showNoServer, showEmptyWorkspace, updateSessionChrome, normalizeCircuitResponse, loadCircuit, renderCircuitList, pollSessionState, markStale, reloadRevision, handleStaleAction, openFile, openDesktopFile, chooseCircuitFile});
}
