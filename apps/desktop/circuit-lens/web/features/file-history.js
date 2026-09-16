import {makeElement} from '../core/dom.js';

// Owns file-change review; tree navigation does not invalidate history requests.
export function createFileHistory({api,models,ports,fail}) {
  const node=id=>document.getElementById(id);
  const request=extra=>({folderId:models.project.folder?.id,...extra});
  let detailEpoch=0;
  async function openFileChanges({show=true}={}) {
    if(!models.project.folder)return;
    const token=models.project.folder?.id;
    const entries=await api.history(request());if(token!==models.project.folder?.id)return;
    const list=node('fileChangeList');list.replaceChildren();node('fileDiff').replaceChildren();
    if(!entries.length)list.append(makeElement('p','list-empty','还没有文件改动'));
    for(const entry of entries) {
      const group=makeElement('section','file-change-group');
      const head=makeElement('header');head.append(makeElement('strong','',entry.title),makeElement('small','',new Date(entry.at).toLocaleString('zh-CN',{hour12:false})));
      const undo=makeElement('button','quiet-button','撤销这次改动');undo.type='button';undo.disabled=entry.files.some(f=>!f.undoable);
      undo.addEventListener('click',async()=>{undo.disabled=true;models.project.projectBusy=true;ports.updateComposerState();try{await api.undo(request({id:entry.id}));await ports.bootstrap();await openFileChanges({show:false});}catch(e){fail(e);undo.disabled=false;}finally{models.project.projectBusy=false;ports.updateComposerState();}});
      head.append(undo);group.append(head);
      for(const file of entry.files){const button=makeElement('button','file-change-row',({added:'新增',deleted:'删除',modified:'修改'}[file.kind])+'  '+file.path);button.type='button';button.addEventListener('click',async()=>{
        try{const detailToken=++detailEpoch;const detail=await api.diff(request({id:entry.id,path:file.path}));if(detailToken!==detailEpoch||token!==models.project.folder?.id)return;const diff=node('fileDiff');diff.replaceChildren(makeElement('h3','',file.path));
          if(detail.binary)diff.append(makeElement('p','list-empty','二进制文件，可通过撤销恢复之前的文件。'));
          else {const columns=makeElement('div','file-diff-columns');for(const [title,text] of [['修改前',detail.before],['修改后',detail.after]]){const side=makeElement('section');side.append(makeElement('h4','',title),makeElement('pre','',text||'（空文件或不存在）'));columns.append(side);}diff.append(columns);if(detail.limited)diff.append(makeElement('p','list-empty','内容较长，此处只显示开头部分。'));}
        }catch(e){fail(e);}
      });group.append(button);}
      list.append(group);
    }
    if(show&&!node('fileChanges').open)node('fileChanges').showModal();
  }
  node('fileChangesClose').addEventListener('click',()=>node('fileChanges').close());
  return {openFileChanges};
}
