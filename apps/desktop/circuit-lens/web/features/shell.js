import { firstDefined } from '../core/values.js';

export const modelDependencies = ["project", "canvas", "agent", "shell"];

export const dependencies = ["cancelWiring","renderSimulationControls","renderWirePreview","cancelPlacement","renderProjectInfo","setWorkspacePanel","closeWorkspaceDrawers","renderConnections","hasSelection","queryIntent","updateComposerState"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, canvas: canvasState, agent: agentState, shell: shellState} = models;
function inferCapabilityState(capabilities = projectState.capabilities, circuitPayload = null) {
    const connectivity = firstDefined(
      capabilities?.connectivity,
      capabilities?.staticConnectivity,
      capabilities?.exactConnectivity,
      circuitPayload?.connectivityAuthority,
    );
    if (
      connectivity === true ||
      ["exact", "supported", "authoritative", "runtime-exact"].includes(String(connectivity).toLowerCase())
    ) return "exact";
    if (connectivity === false || ["none", "unsupported", "geometry-only", "unavailable"].includes(String(connectivity).toLowerCase())) {
      return "geometry";
    }
    if (capabilities?.geometry === true || capabilities?.selection === true || projectState.circuit) return "geometry";
    return "idle";
  }

function updateCapabilityState(circuitPayload = null) {
    projectState.capabilityState = inferCapabilityState(projectState.capabilities, circuitPayload);
    ports.renderProjectInfo();
    if (projectState.sourceChanged) {
      ui.askButton.disabled = true;
      ui.askButton.title = projectState.staleKind === "workspace" ? "先明确读取当前版本" : "先重新载入新版本";
      ports.updateComposerState();
      return;
    }
    if (projectState.capabilityState === "exact") {
      const selectionReady = ports.hasSelection();
      const query = ports.queryIntent();
      ui.askButton.disabled = !selectionReady;
      ui.askButton.title = !ports.hasSelection()
        ? "先选择组件或区域"
        : !selectionReady
          ? "正在冻结选区引用"
          : query.kind === "overview"
            ? "大选区只查询区域概览；缩小到 4 个以内可逐项查询"
            : "查询当前选区的逐项证据";
    } else if (projectState.capabilityState === "geometry") {
      ui.askButton.disabled = true;
      ui.askButton.title = "几何模式不能查询连通证据";
      setCanvasStatus("未能读取电路连接。可继续查看图面；请在工程信息中检查运行环境和组件库。", "warning");
    }
    ports.updateComposerState();
  }

function setCanvasStatus(message, kind = "warning") {
    ui.canvasStatus.hidden = !message;
    ui.canvasStatus.textContent = message || "";
    ui.canvasStatus.dataset.kind = kind;
  }

function setMode(mode) {
    if(mode!=="place")ports.cancelPlacement();
    if (mode !== canvasState.mode && canvasState.wireStart) {
      ports.cancelWiring(); setCanvasStatus('');
    }
    canvasState.mode = mode;
    ui.circuitCanvas.dataset.mode = mode;
    [ui.selectTool, ui.wireTool, ui.pokeTool, ui.panTool].forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    ports.renderSimulationControls();
  }

function switchReviewTab(tab) {
    const selected = tab === "agent" && agentState.enabled ? "agent" : tab === "proposal" ? "proposal" : "evidence";
    ui.reviewPanel.dataset.activeTab = selected;
    if (selected === "evidence") ports.renderConnections();
    const tabs = {
      agent: [ui.agentTab, ui.agentPane],
      evidence: [ui.evidenceTab, ui.evidencePane],
      proposal: [ui.proposalTab, ui.proposalPane],
    };
    Object.entries(tabs).forEach(([name, [button, pane]]) => {
      const active = name === selected;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      pane.hidden = !active;
    });
  }

function openReviewPanel() { ports.setWorkspacePanel('review', true); }

function closeMobilePanels() { ports.closeWorkspaceDrawers(); }

function showToast(message) {
    if (shellState.toastTimer) window.clearTimeout(shellState.toastTimer);
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    shellState.toastTimer = window.setTimeout(() => {
      ui.toast.hidden = true;
    }, 3400);
  }

function resizeQuestion() {
    ui.questionInput.style.height = "auto";
    ui.questionInput.style.height = `${Math.min(ui.questionInput.scrollHeight, Math.min(240, window.innerHeight * .28))}px`;
  }
  return Object.freeze({inferCapabilityState, updateCapabilityState, setCanvasStatus, setMode, switchReviewTab, openReviewPanel, closeMobilePanels, showToast, resizeQuestion});
}
