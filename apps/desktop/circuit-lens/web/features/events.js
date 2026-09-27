

export const modelDependencies = ["project", "canvas"];

export const dependencies = ["mountCanvasViewport","mountGrid","mountConversations","mountConversationStarters","mountComponents","mountPlacement","mountFiles","mountProjectInfo","mountDraft","mountMaterials","mountMoments","mountInterfaces","mountManipulation","mountComparison","mountNavigation","mountRendering","mountAgentConnection","mountAgentPreferences","mountFeedback","mountFinder","openFinder","mountLayout","selectionSnapshot","mountMemoryControls","mountHistoryControls","mountCandidateEvidence","mountSimulationControls","askAgent","bootstrap","chooseCircuitFile","clearSelection","closeMobilePanels","copyReference","draftPrompt","fitCircuit","handleStaleAction","initializeAgent","interruptAgent","loadCandidates","loadCircuit","onPointerDown","onPointerMove","onPointerUp","openFile","performProjectAction","renderCircuitList","renderWirePreview","requestSave","resizeQuestion","setCanvasStatus","setMode","showToast","switchReviewTab","updateCapabilityState","updateComposerState","zoomAt"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, canvas: canvasState} = models;
function bindEvents() {
    ports.mountLayout();
    ports.mountCanvasViewport();
    ports.mountGrid();
    ports.mountComponents();
    ports.mountPlacement();
    ports.mountProjectInfo();
    ports.mountMoments();
    ports.mountConversations();
    ports.mountDraft();
    ports.mountConversationStarters();
    ports.mountMaterials();
    ports.mountInterfaces();
    ports.mountManipulation();
    ports.mountNavigation();
    ports.mountComparison();
    ports.mountRendering();
    ports.mountFinder();
    ports.mountAgentConnection();
    ports.mountAgentPreferences();
    ports.mountFeedback();
    ui.clearObjectSelection.addEventListener("click", () => ports.clearSelection());
    ui.clearComposerContext.addEventListener("click", () => ports.clearSelection());
    ui.undoButton.addEventListener("click", () => ports.performProjectAction("undo"));
    ui.deleteSelectionButton.addEventListener("click", () => ports.performProjectAction("delete", {
      circuit: projectState.circuitName,
      wireIds:ports.selectionSnapshot().wireIds,componentIds:ports.selectionSnapshot().componentIds,
    }));
    ui.saveButton.addEventListener("click", ports.requestSave);
    ui.cancelSave.addEventListener("click", () => ui.saveDialog.close());
    ui.confirmSave.addEventListener("click", async () => {
      ui.confirmSave.disabled = ui.cancelSave.disabled = true;
      try { if (await ports.performProjectAction("save", projectState.saveBinding)) ui.saveDialog.close(); }
      finally { ui.confirmSave.disabled = ui.cancelSave.disabled = false; }
    });
    ui.saveDialog.addEventListener("cancel", event => { if (projectState.projectBusy) event.preventDefault(); });
    document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => ports.draftPrompt(button.dataset.prompt)));
    ui.openButton.addEventListener("click", ports.chooseCircuitFile);
    ui.emptyOpenButton.addEventListener("click", ports.chooseCircuitFile);
    ui.fileInput.addEventListener("change", () => ports.openFile(ui.fileInput.files[0]));
    ui.reloadRevisionButton.addEventListener("click", ports.handleStaleAction);
    ui.circuitSearch.addEventListener("input", ports.renderCircuitList);
    ui.selectTool.addEventListener("click", () => ports.setMode("select"));
    ui.pokeTool.addEventListener("click", () => ports.setMode("poke"));
    ui.panTool.addEventListener("click", () => ports.setMode("pan"));
    ui.fitButton.addEventListener("click", () => ports.fitCircuit());
    ui.zoomInButton.addEventListener("click", () => {
      const rect = ui.circuitCanvas.getBoundingClientRect();
      ports.zoomAt(0.82, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    ui.zoomOutButton.addEventListener("click", () => {
      const rect = ui.circuitCanvas.getBoundingClientRect();
      ports.zoomAt(1.22, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    ui.copyReferenceButton.addEventListener("click", ports.copyReference);
    ui.askButton.addEventListener("click", ports.askAgent);
    ui.interruptButton.addEventListener("click", ports.interruptAgent);
    ui.questionInput.addEventListener("input", () => {
      ports.resizeQuestion();
      ports.updateComposerState();
    });
    ui.questionInput.addEventListener("keydown", (event) => {
      if (!event.isComposing && event.keyCode !== 229 && !event.shiftKey && event.key === "Enter") { event.preventDefault(); ports.askAgent(); }
    });
    ui.agentTab.addEventListener("click", () => ports.switchReviewTab("agent"));
    ui.evidenceTab.addEventListener("click", () => ports.switchReviewTab("evidence"));
    ui.proposalTab.addEventListener("click", () => { ports.switchReviewTab("proposal"); ports.loadCandidates(); });

    const tabs=[ui.agentTab,ui.evidenceTab,ui.proposalTab];
    for(const tab of tabs)tab.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const visible=tabs.filter(t=>!t.hidden),index=visible.indexOf(tab);
      const next=event.key==='Home'?0:event.key==='End'?visible.length-1:(index+(event.key==='ArrowRight'?1:visible.length-1))%visible.length;
      visible[next]?.click();visible[next]?.focus();
    });

    ui.circuitCanvas.setAttribute("aria-keyshortcuts", "Alt");
    ui.circuitCanvas.setAttribute("aria-description", "选择端口后按住 Alt 点击网格添加拐点");
    ui.circuitCanvas.addEventListener("pointerdown", ports.onPointerDown);
    ui.circuitCanvas.addEventListener("pointermove", ports.onPointerMove);
    ui.circuitCanvas.addEventListener("pointerup", ports.onPointerUp);
    ui.circuitCanvas.addEventListener("pointercancel", ports.onPointerUp);
    ui.circuitCanvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      ports.zoomAt(event.deltaY > 0 ? 1.13 : 0.885, event.clientX, event.clientY);
    }, { passive: false });

    document.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      const inField = event.target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
      // Canvas objects are keyboard-operable role=button elements too, so keep
      // them eligible for Delete and canvas shortcuts. Other controls belong
      // to the surrounding UI and must never mutate the circuit accidentally.
      const isUiControl = event.target.closest?.("button, summary, a, input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='tab'], [role='menuitem'], [role='option']");
      const canControlCanvas = !isUiControl;
      const dialogOpen = document.querySelector("dialog[open]");
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); ports.requestSave(); return; }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        if (inField || isUiControl || dialogOpen) return;
        event.preventDefault();
        ports.performProjectAction("undo");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && (!dialogOpen || dialogOpen === ui.finderDialog)) {
        event.preventDefault(); ports.openFinder(); return;
      }
      if (dialogOpen || document.querySelector(":popover-open")) return;
      if (canControlCanvas && event.key === "Escape" && canvasState.wireStart) {
        event.preventDefault();
        canvasState.wireStart = null;
        canvasState.wirePoints = [];
        ports.renderWirePreview();
        ui.circuitCanvas.querySelectorAll(".wire-port-hit.is-wire-start").forEach(node => node.classList.remove("is-wire-start"));
        ports.setCanvasStatus("已取消端口连接", "idle");
        return;
      }
      if (canControlCanvas && ["Delete", "Backspace"].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !ui.deleteSelectionButton.disabled) {
        event.preventDefault();
        ui.deleteSelectionButton.click();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (canControlCanvas && event.key === "/") {
        event.preventDefault();
        ui.circuitSearch.focus();
      }
      if (canControlCanvas && event.key.toLowerCase() === "v") ports.setMode("select");
      if (canControlCanvas && event.key.toLowerCase() === "p") ports.setMode("poke");
      if (canControlCanvas && event.key.toLowerCase() === "h") ports.setMode("pan");
      if (canControlCanvas && event.key.toLowerCase() === "f") ports.fitCircuit();
      if (canControlCanvas && event.key === "Escape") {
        ports.clearSelection({ notifyServer: false });
        ports.closeMobilePanels();
        ports.updateCapabilityState();
      }
      if (canControlCanvas && event.code === "Space" && !event.repeat) {
        canvasState.heldSpace = true;
        ui.circuitCanvas.dataset.mode = "pan";
      }
    });
    document.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        canvasState.heldSpace = false;
        ui.circuitCanvas.dataset.mode = canvasState.mode;
      }
    });

    // Desktop file drops belong to the explorer. Prevent Chromium navigation
    // elsewhere without intercepting ordinary text drags or covering the app.
    const hasFiles = event => Array.from(event.dataTransfer?.types || []).some(type=>['Files','application/x-vibe-workspace-entry'].includes(type));
    document.addEventListener('dragover', event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (window.vibeDesktop?.folder) event.dataTransfer.dropEffect = 'none';
    });
    document.addEventListener('drop', event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (!window.vibeDesktop?.folder) ports.openFile(event.dataTransfer.files[0]);
    });
  }
  function mount() {
    ports.mountFiles();
bindEvents();
ports.mountMemoryControls();
ports.mountHistoryControls();
ports.mountCandidateEvidence();
ports.mountSimulationControls();
new ResizeObserver(() => {
    ui.canvasStage.style.setProperty("--run-height", `${ui.simulationDock.hidden ? 0 : ui.simulationDock.offsetHeight + 20}px`);
  }).observe(ui.simulationDock);
ports.initializeAgent();
ports.setMode("select");
ports.bootstrap();
  }

  return Object.freeze({bindEvents, mount});
}
