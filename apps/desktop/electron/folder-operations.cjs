'use strict';
const fs=require('node:fs'),path=require('node:path');
const {remapPath}=require('./folder-workspace.cjs');

// Called under DesktopWorkspace's queue and the desktop transition boundary.
// The engine moves the file and document records together; folder identity and
// conversation identity never change when an entry is moved.
async function moveEntry(workspace,request) {
  const {folder,backend,history}=workspace,current=folder.assert(request.folderId);
  const from=request.from,to=request.to;
  const source=folder.resolve(from,{exists:false}),target=folder.resolve(to,{exists:false});
  if(source===current.root||target===current.root)throw new Error('不能移动工作区根目录');
  if(from===to)return {items:[{path:to}],...workspace.snapshot()};
  if(to.startsWith(from+'/'))throw new Error('不能将文件夹移动到自身或它的子文件夹');
  if(fs.existsSync(target)||fs.lstatSync(target,{throwIfNoEntry:false}))throw new Error('目标文件夹内已有同名文件，请选择其他位置');
  const stat=fs.lstatSync(source);
  history.checkpoint('文件改动');
  const result=await backend.movePath(current.id,from,to);
  try{folder.moved(from,to);}catch(error){await backend.movePath(current.id,to,from);throw error;}
  await backend.setFolder(folder.snapshot());
  history.checkpoint(request.title||'移动 '+path.basename(from),{operation:{kind:'move',from,to}});
  workspace.error='';
  const response={...workspace.snapshot(),documentChanged:result.documentChanged,move:{from,to},items:[{path:to,kind:stat.isDirectory()?'directory':'file'}]};
  workspace.emit('changed',response);
  return response;
}

async function trashEntry(workspace,request,shell) {
  const {folder,backend,history}=workspace,current=folder.assert(request.folderId);
  const file=folder.resolve(request.path,{exists:false});
  if(file===current.root)throw new Error('不能删除工作区根目录');
  const affected=current.activeFile&&remapPath(current.activeFile,request.path,'')!==current.activeFile;
  if(affected&&(await backend.session()).workspace?.dirty)throw new Error('当前电路还有未保存编辑，请先保存，再移到回收站');
  history.checkpoint('文件改动');
  // No permanent-delete fallback: a failed trash operation leaves the file here.
  try{await shell.trashItem(file);}catch(error){throw new Error('无法移到系统回收站，请检查文件权限及所在磁盘是否支持回收站',{cause:error});}
  return workspace.refresh({title:'移到回收站：'+path.basename(file)});
}

async function undoEntry(workspace,request) {
  workspace.folder.assert(request.folderId);
  const entry=workspace.history.entry(request.id),op=entry.operation;
  if(op?.kind==='move')return moveEntry(workspace,{...request,from:op.to,to:op.from,title:'撤销：'+entry.title});
  const session=await workspace.backend.session();
  if(session.workspace?.dirty)throw new Error('请先保存画布中的编辑，再撤销文件改动');
  workspace.history.undo(request.id);
  return workspace.refresh();
}
module.exports={moveEntry,trashEntry,undoEntry};
