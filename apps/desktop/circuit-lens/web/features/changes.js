import {wireOverlaps} from '../core/selection-geometry.js';

export const modelDependencies = ["project", "review"];

export const dependencies = ["selectWire","closeComparison","clearComparisonError","comparisonActionError","refreshEditedProject","clearSelection","selectComponent","pollSessionState","showToast","setCanvasStatus","updateSessionChrome"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, review: reviewState} = models;
  const request = client.request;
  let deferredDisplay=null;
  const idleWaiters=[];
  function releaseIdle() { while (idleWaiters.length) idleWaiters.shift()(); }
  async function waitForIdle(allowDeferred = false) {
    if (!projectState.projectBusy && (allowDeferred || !deferredDisplay)) return;
    await new Promise(resolve=>idleWaiters.push(resolve));
  }
function requestSave() {
    if (ui.saveButton.disabled || document.querySelector("dialog[open]")) return;
    projectState.saveBinding = { projectId: projectState.session.workspace.id, revisionId: projectState.revision };
    ui.saveFileName.textContent = projectState.session.source?.path || projectState.session.source?.name;
    ui.saveActionError.hidden = true;
    ui.saveDialog.showModal();
  }

// A burst may commit several independent native edits before requesting its
// final display. All other editing stays disabled until that display is current.
async function flushProjectEdits() {
    const binding=deferredDisplay;if(!binding)return;
    deferredDisplay=null;
    if(binding.projectId!==projectState.session?.workspace?.id||binding.circuit!==projectState.circuitName)return;
    projectState.projectBusy=true;ports.updateSessionChrome();
    try {await ports.refreshEditedProject(projectState.session,binding.circuit);}
    catch(error){ports.setCanvasStatus('电路已写入，画面刷新失败：'+error.message,'error');}
    finally {projectState.projectBusy=false;ports.updateSessionChrome();releaseIdle();}
}

async function performProjectAction(action, extra = {}, circuit = projectState.circuitName, options = {}) {
    await waitForIdle(options.allowDeferred);
    const projectId = projectState.session.workspace.id;
    const moved = action === 'move' ? projectState.circuit.components.filter(c=>(extra.componentIds || [extra.componentId]).includes(c.componentId)) : [];
    const anchor = moved.find(c=>c.componentId===extra.anchorId) || moved[0];
    const delta = extra.delta || (anchor?{x:extra.x-anchor.location.x,y:extra.y-anchor.location.y}:{x:0,y:0});
    const destinations = moved.map(c=>({factory:c.factory,x:c.location.x+delta.x,y:c.location.y+delta.y}));
    const movedWires = action === 'move' ? projectState.circuit.wires.filter(w=>extra.wireIds?.includes(w.wireId)).map(w=>Object.fromEntries(['from','to'].map(k=>[k,{x:w[k].x+delta.x,y:w[k].y+delta.y}]))) : [];
    projectState.projectBusy = true;
    ui.saveActionError.hidden = true;
    ports.clearComparisonError();
    ports.updateSessionChrome();
    let applied = false;
    try {
      const payload = { projectId: projectState.session.workspace.id, revisionId: projectState.revision, ...extra };
      const session = window.vibeDesktop?.projectAction
        ? await window.vibeDesktop.projectAction(action, payload)
        : await request(`/api/project/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      applied = true;
      projectState.session = session;
      if (action !== "save") {
        ports.clearSelection({ notifyServer: false });
        reviewState.review = null; reviewState.reviewSignature = "";
        projectState.sourceChanged = false;
        ports.closeComparison();
        if(action==='place'&&options.deferDisplay?.()) {
          projectState.revision=session.revision.id;
          deferredDisplay={projectId,circuit};
        } else {
          await ports.refreshEditedProject(session,circuit);
          deferredDisplay=null;
        }
        if (projectState.session.workspace.id === projectId && projectState.circuitName === circuit) {
          // This explicit move gives a unique relocation mapping. Never reuse
          // old traversal IDs across the refreshed revision.
          destinations.forEach((p,i)=>{
            const matches = projectState.circuit.components.filter(c=>c.factory===p.factory&&c.location.x===p.x&&c.location.y===p.y);
            if(matches.length===1)ports.selectComponent(matches[0].componentId,i>0,false);
          });
          for(const wire of projectState.circuit.wires){if(movedWires.some(w=>wireOverlaps(w,wire)))ports.selectWire(wire.wireId,true);}
        }
      }
      ports.updateSessionChrome();
      if(action!=="place")ports.showToast(action === "save" ? "已保存到当前文件" : action === "restore" ? "已恢复电路，对话和历史保留" : action === "undo" ? "已撤销上一步改动" : projectState.folder ? "已写入当前文件" : "改动已应用，尚未保存到文件");
      return true;
    } catch (error) {
      const message = `${applied ? "操作已完成，但界面刷新失败" : "操作未完成"}：${error.message}`;
      const errorNode = ui.saveDialog.open ? ui.saveActionError : null;
      if (errorNode) { errorNode.textContent = message; errorNode.hidden = false; }
      else if (!ports.comparisonActionError(message)) { ports.showToast(message); ports.setCanvasStatus(message, 'error'); }
      projectState.projectBusy = false;
      await ports.pollSessionState();
      return false;
    } finally {
      projectState.projectBusy = false;
      ports.updateSessionChrome();
      if (!deferredDisplay) releaseIdle();
    }
  }
  return Object.freeze({requestSave, performProjectAction, flushProjectEdits});
}
