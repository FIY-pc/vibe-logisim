'use strict';
const {randomUUID} = require('node:crypto');

const binding = session => ({folderId:session.folder?.id ?? null,
  projectId:session.workspace?.id ?? null, revisionId:session.revision?.id ?? null});
const matches = (left, right) => ['folderId','projectId','revisionId'].every(key => left?.[key] === right?.[key]);

// The renderer owns the displayed definition. File/selection state cannot prove
// which circuit is on screen. This bridge is transient and never edits a file.
class CanvasNavigation {
  constructor(send) { this.send=send; this.ready=false; this.view=null; this.version=0; this.pending=new Map(); }
  report(view) { this.view=view; ++this.version; }
  snapshot(session) {
    return this.ready && matches(this.view,binding(session))
      ? {...this.view} : {status:this.ready?'unknown':'unavailable', ...binding(session), circuit:null};
  }
  complete(id, result) {
    const pending=this.pending.get(id);
    if(!pending)return;
    if(!matches(result,pending.binding))return pending.finish({...pending.binding,status:'superseded',circuit:null});
    pending.finish(result);
  }
  reset() {
    this.ready=false;this.view=null;++this.version;
    for(const pending of this.pending.values())pending.finish({...pending.binding,status:'unavailable',circuit:null});
  }
  open(session, circuit, expectedVersion=this.version) {
    if(expectedVersion!==this.version)return Promise.resolve({...binding(session),status:'superseded',circuit:null});
    if(!this.ready)return Promise.resolve(this.snapshot(session));
    const id=randomUUID(),target=binding(session);
    return new Promise(resolve=>{
      const finish=result=>{clearTimeout(timer);this.pending.delete(id);resolve(result);};
      const timer=setTimeout(()=>finish({...target,status:'unknown',circuit:null,error:'画布打开尚未确认'}),30000);
      this.pending.set(id,{binding:target,finish});
      try { this.send({id,...target,circuit:circuit??null}); }
      catch(error){finish({...target,status:'unavailable',circuit:null,error:error.message});}
    });
  }
}

function registerCanvasIpc({ipcMain,trusted,canvas}) {
  ipcMain.handle('vibe-logisim:canvas', (event,request={})=>{
    if(!trusted(event))throw new Error('Untrusted renderer.');
    if(request.action==='ready'){canvas.ready=true;return;}
    const view=request.view;
    if(!view || !['shown','loading','superseded','failed'].includes(view.status) ||
      !['folderId','projectId','revisionId','circuit'].every(key=>view[key]===null||typeof view[key]==='string'))throw new Error('Invalid canvas state.');
    if(request.action==='report')canvas.report(view);
    else if(request.action==='complete')canvas.complete(request.id,view);
    else throw new Error('Invalid canvas action.');
  });
}
module.exports={CanvasNavigation,registerCanvasIpc};
