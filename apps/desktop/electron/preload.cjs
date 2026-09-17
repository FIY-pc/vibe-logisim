"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const pendingDrafts=new Map();
const draftErrors=new Set();
function saveDraft(request) {
  pendingDrafts.set(request.projectId,request);
  return ipcRenderer.invoke('vibe-logisim:draft-save',request).then(result=>{
    if(pendingDrafts.get(request.projectId)?.sequence<=result.sequence)pendingDrafts.delete(request.projectId);
    return result;
  });
}
window.addEventListener('beforeunload',event=>{
  if(!pendingDrafts.size)return;
  const result=ipcRenderer.sendSync('vibe-logisim:draft-flush',[...pendingDrafts.values()]);
  if(result.ok)pendingDrafts.clear();
  else if(!result.discard) {
    event.preventDefault();event.returnValue=false;
    for(const listener of draftErrors)listener({projectId:result.projectId,message:result.error});
  }
});

contextBridge.exposeInMainWorld(
  "vibeDesktop",
  Object.freeze({
    folder:Object.freeze({
      open:()=>ipcRenderer.invoke('vibe-logisim:folder-open'),
      state:()=>ipcRenderer.invoke('vibe-logisim:folder-state'),
      importFiles:(request, files)=>ipcRenderer.invoke('vibe-logisim:folder-import', {...request, sources:files.map(file=>webUtils.getPathForFile(file))}),
      ...Object.fromEntries(['list','view','select','preview','reveal','open-system','create','history','diff','undo'].map(name=>[name,request=>ipcRenderer.invoke('vibe-logisim:folder-'+name,request)])),
      onEvent:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('vibe-logisim:folder-event',listener);return()=>ipcRenderer.removeListener('vibe-logisim:folder-event',listener);},
    }),
    openCircuit: () => ipcRenderer.invoke("vibe-logisim:open-circuit"),
    importCircuit: (request) => ipcRenderer.invoke("vibe-logisim:import-circuit", request),
    reloadCircuit: () => ipcRenderer.invoke("vibe-logisim:reload-circuit"),
    openCandidate: (request) => ipcRenderer.invoke("vibe-logisim:open-candidate", request),
    projectAction: (action, request) => ipcRenderer.invoke("vibe-logisim:project-action", action, request),
    getLayout: () => ipcRenderer.invoke("vibe-logisim:layout-read"),
    setLayout: value => ipcRenderer.invoke("vibe-logisim:layout-write", value),
    getAppInfo: () => ipcRenderer.invoke("vibe-logisim:app-info"),
    copyText: value => ipcRenderer.invoke("vibe-logisim:copy-text", value),
    openWebLink: value => ipcRenderer.invoke("vibe-logisim:open-web-link", value),
    attachMaterials: request => ipcRenderer.invoke("vibe-logisim:attach-materials",request),
    drafts:Object.freeze({
      open:request=>ipcRenderer.invoke('vibe-logisim:draft-open',request),
      save:saveDraft,
      onError:callback=>{draftErrors.add(callback);return()=>draftErrors.delete(callback);},
    }),
    materials: Object.freeze({
      list: request => ipcRenderer.invoke('vibe-logisim:materials-list',request),
      preview: request => ipcRenderer.invoke('vibe-logisim:materials-preview',request),
      remove: request => ipcRenderer.invoke('vibe-logisim:materials-remove',request),
    }),
    agent: Object.freeze({
      getState: () => ipcRenderer.invoke("vibe-logisim:agent-state"),
      listModels: refresh => ipcRenderer.invoke("vibe-logisim:agent-models", refresh),
      selectModel: selection => ipcRenderer.invoke("vibe-logisim:agent-model-select", selection),
      reconnect: () => ipcRenderer.invoke("vibe-logisim:agent-reconnect"),
      account: action => ipcRenderer.invoke('vibe-logisim:agent-account', action),
      getRecoveries: () => ipcRenderer.invoke("vibe-logisim:agent-recoveries"),
      reviewRecovery: request => ipcRenderer.invoke("vibe-logisim:review-recovery", request),
      ask: (request) => ipcRenderer.invoke("vibe-logisim:agent-ask", request),
      interrupt: () => ipcRenderer.invoke("vibe-logisim:agent-interrupt"),
      setMode: mode => ipcRenderer.invoke("vibe-logisim:agent-mode", mode),
      answer: (requestId, answers) => ipcRenderer.invoke("vibe-logisim:agent-answer", requestId, answers),
      onEvent: (callback) => {
        if (typeof callback !== "function") throw new TypeError("Agent event callback must be a function.");
        const listener = (_event, value) => callback(value);
        ipcRenderer.on("vibe-logisim:agent-event", listener);
        return () => ipcRenderer.removeListener("vibe-logisim:agent-event", listener);
      },
    }),
  }),
);
