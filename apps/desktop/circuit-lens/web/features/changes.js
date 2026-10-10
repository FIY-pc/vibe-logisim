import {wireOverlaps} from '../core/selection-geometry.js';

export const modelDependencies = ["project", "review"];

export const dependencies = ["selectWire","closeComparison","clearComparisonError","comparisonActionError","refreshEditedProject","clearSelection","selectComponent","pollSessionState","showToast","setCanvasStatus","updateSessionChrome","beginOptimisticDeletion","rollbackOptimisticDeletion"];

export function createController({models, ui, client, ports}) {
  const {project: projectState, review: reviewState} = models;
  const request = client.request;
  let deferredDisplay=null;
  let saveOperation=null;
  const idleWaiters=[];
  function releaseIdle() { while (idleWaiters.length) idleWaiters.shift()(); }
  async function waitForIdle(allowDeferred = false) {
    if (!projectState.projectBusy && (allowDeferred || !deferredDisplay)) return;
    await new Promise(resolve=>idleWaiters.push(resolve));
  }
  function saveState() {
    const workspace=projectState.session?.workspace;
    const operation=saveOperation?.projectId===workspace?.id&&saveOperation?.revisionId===projectState.revision?saveOperation:null;
    return {pending:Boolean(operation?.pending),error:workspace?.dirty?operation?.error||'':'',
      canSave:Boolean(workspace?.dirty&&workspace?.canSave&&!projectState.projectBusy&&!projectState.sourceChanged&&!operation?.pending)};
  }
  function dismissSaveError(){saveOperation=null;ports.updateSessionChrome();}
  async function requestSave() {
    if(!saveState().canSave||document.querySelector('dialog[open]'))return false;
    const binding={projectId:projectState.session.workspace.id,revisionId:projectState.revision};
    const current=()=>projectState.session?.workspace?.id===binding.projectId&&projectState.revision===binding.revisionId;
    const operation={...binding,pending:true,error:''};saveOperation=operation;ports.updateSessionChrome();
    let ownsBusy=false;
    try {
      await flushProjectEdits();
      if(!current())return false;
      projectState.projectBusy=true;ownsBusy=true;ports.updateSessionChrome();
      const session=window.vibeDesktop?.projectAction
        ?await window.vibeDesktop.projectAction('save',binding)
        :await request('/api/project/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(binding)});
      if(!current())return false;
      projectState.session=session;
      return true;
    } catch(error) {
      if(current()){
        operation.error=error.message;
        projectState.projectBusy=false;ownsBusy=false;
        await ports.pollSessionState();
      }
      return false;
    } finally {
      operation.pending=false;
      if(ownsBusy&&projectState.session?.workspace?.id===binding.projectId)projectState.projectBusy=false;
      ports.updateSessionChrome();releaseIdle();
    }
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
    ports.clearComparisonError();
    ports.updateSessionChrome();
    const optimisticDelete = action === "delete" && ports.beginOptimisticDeletion(extra);
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
      if(!["place", "delete"].includes(action))ports.showToast(action === "save" ? "已保存到当前文件" : action === "restore" ? "已恢复电路，对话和历史保留" : action === "undo" ? "已撤销上一步改动" : projectState.folder ? "已写入当前文件" : "改动已应用，尚未保存到文件");
      return true;
    } catch (error) {
      if (optimisticDelete) ports.rollbackOptimisticDeletion();
      const message = `${applied ? "操作已完成，但界面刷新失败" : "操作未完成"}：${error.message}`;
      if (!ports.comparisonActionError(message)) { ports.showToast(message); ports.setCanvasStatus(message, 'error'); }
      projectState.projectBusy = false;
      await ports.pollSessionState();
      return false;
    } finally {
      projectState.projectBusy = false;
      ports.updateSessionChrome();
      if (!deferredDisplay) releaseIdle();
    }
  }
  return Object.freeze({requestSave,saveState,dismissSaveError,performProjectAction,flushProjectEdits});
}
