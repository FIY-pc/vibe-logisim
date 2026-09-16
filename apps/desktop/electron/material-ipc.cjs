"use strict";
const {previewMaterial}=require('./material-preview.cjs');

// Renderer requests contain project/file identities, never filesystem paths.
function registerMaterialIpc({ipcMain,dialog,nativeImage,store,backend,codex,trusted,window,transitioning,generation}) {
  async function bind(event,request,mutation=false) {
    if(!trusted(event))throw new Error('Untrusted renderer.');
    const epoch=generation(),current=await backend.session();
    if(transitioning()||epoch!==generation()||!request?.projectId||current.workspace?.id!==request.projectId)throw new Error('工程已切换，请在当前工程重新打开资料');
    if(mutation&&codex().snapshot().busy)throw new Error('请在回答结束或停止后修改资料；现在仍可查看与引用');
    return {projectId:current.workspace.id,epoch};
  }
  ipcMain.handle('vibe-logisim:materials-list',async(event,request)=>{const b=await bind(event,request);return {projectId:b.projectId,items:store.list(b.projectId)};});
  ipcMain.handle('vibe-logisim:attach-materials',async(event,request)=>{
    const b=await bind(event,request,true);
    const selection=await dialog.showOpenDialog(window(),{title:'添加工程资料',properties:['openFile','multiSelections']});
    if(selection.canceled)return {projectId:b.projectId,canceled:true,names:[]};
    await bind(event,request,true);if(b.epoch!==generation())throw new Error('工程已切换，资料没有添加');
    return {projectId:b.projectId,...store.import(b.projectId,selection.filePaths)};
  });
  ipcMain.handle('vibe-logisim:materials-remove',async(event,request)=>{
    const b=await bind(event,request,true);store.setRemoved(b.projectId,request.id,request.removed!==false);
    return {projectId:b.projectId,items:store.list(b.projectId)};
  });
  let previewing=false;
  ipcMain.handle('vibe-logisim:materials-preview',async(event,request)=>{
    const b=await bind(event,request);
    if(previewing)throw new Error('上一份资料仍在加载，请稍后重试');
    previewing=true;
    try {
      const result=await previewMaterial(store,b.projectId,request.id,request.page??1,nativeImage);
      if(b.epoch!==generation()||transitioning())throw new Error('工程已切换');
      return {projectId:b.projectId,...result};
    }finally{previewing=false;}
  });
}
module.exports={registerMaterialIpc};
