'use strict';
const {migrateDraft}=require('./folder-migration.cjs');
function registerDraftIpc({ipcMain,store,backend,trusted,transitioning,generation,dialog,window}) {
  ipcMain.handle('vibe-logisim:draft-open',async(event,request)=>{
    if(!trusted(event))throw new Error('Untrusted renderer.');
    const epoch=generation(),session=await backend.session();
    if(transitioning()||epoch!==generation()||!request?.projectId||request.projectId!==(session.folder?.id || session.workspace?.id))throw new Error('工程已切换，未读取其他工程的草稿');
    migrateDraft(store,session.folder);
    return store.open(request.projectId,event.sender.id);
  });
  function save(event,request){
    if(!trusted(event))throw new Error('Untrusted renderer.');
    // A leased previous project may still flush its last edit after a switch.
    // The payload is always bound to that lease, never to the current project.
    return store.save(request,event.sender.id);
  }
  ipcMain.handle('vibe-logisim:draft-save',save);
  ipcMain.on('vibe-logisim:draft-flush',(event,requests)=>{
    let projectId=null;
    try {
      if(!Array.isArray(requests)||requests.length>100)throw new Error('草稿数量无效');
      event.returnValue={ok:true,results:requests.map(request=>{projectId=request?.projectId;return save(event,request);})};
    }catch(error){
      const discard=trusted(event)&&dialog.showMessageBoxSync(window(),{
        type:'warning',title:'草稿尚未保留',message:'最新草稿未能存到本机',
        detail:'返回窗口后可以重试或复制草稿。直接关闭会丢失尚未保留的内容。',
        buttons:['返回继续编辑','放弃未保留内容并关闭'],defaultId:0,cancelId:0,noLink:true,
      })===1;
      event.returnValue={ok:false,discard,projectId,error:error.message};
    }
  });
}
module.exports={registerDraftIpc};
