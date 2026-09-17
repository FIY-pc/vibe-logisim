import {hasFileDrag,isEntryDrag,draggedEntry,readFileDrag} from './file-drag.js';

export function createReferenceDrop({element,target,folder,ready,receipt,count,api,attach,fail}) {
  let busy=false;
  // The pane accepts drops; the composer shows where the reference will go.
  function clear(){target.classList.remove('is-reference-drop');}
  function over(event){
    if(!hasFileDrag(event))return;
    event.preventDefault();event.stopPropagation();
    const entry=isEntryDrag(event)?draggedEntry():null;
    const accepted=folder()&&ready()&&!busy&&(!isEntryDrag(event)||entry?.folderId===folder().id&&entry.kind!=='directory');
    event.dataTransfer.dropEffect=accepted?'copy':'none';
    target.classList.toggle('is-reference-drop',Boolean(accepted));
    return accepted;
  }
  element.addEventListener('dragenter',over);element.addEventListener('dragover',over);
  element.addEventListener('dragleave',event=>{if(!element.contains(event.relatedTarget))clear();});
  element.addEventListener('drop',async event=>{
    if(!hasFileDrag(event))return;
    const accepted=over(event),binding=folder(),draft=receipt(),internal=isEntryDrag(event),files=Array.from(event.dataTransfer.files);
    clear();if(!accepted)return;
    busy=true;
    try {
      let references;
      if(internal){const entry=readFileDrag(event);if(entry.folderId!==binding.id||entry.kind==='directory')throw new Error('请拖入当前工作区中的文件');references=[{id:entry.path,pathVersion:entry.pathVersion}];}
      else {
        if(!files.length)return;
        if(count()+files.length>8)throw new Error('每条问题最多引用 8 处文件');
        const result=await api.importFiles({folderId:binding.id,path:'',filesOnly:true},files);
        references=result.items.map(item=>({id:item.path,pathVersion:result.pathVersion}));
      }
      await attach(references,binding.id,draft);
    }catch(error){fail(error);}finally{busy=false;clear();}
  });
  document.addEventListener('dragend',clear);document.addEventListener('drop',clear);window.addEventListener('blur',clear);
  return {clear};
}
