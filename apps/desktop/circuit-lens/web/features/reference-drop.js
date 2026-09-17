import {hasFileDrag,isEntryDrag,draggedEntry,readFileDrag} from './file-drag.js';

export function createReferenceDrop({element,folder,ready,receipt,count,api,attach,fail}) {
  let busy=false;
  const hint=document.createElement('div');hint.className='reference-drop-hint';hint.hidden=true;hint.setAttribute('role','status');element.append(hint);
  function clear(){element.classList.remove('is-reference-drop');if(!busy)hint.hidden=true;}
  function over(event){
    if(!hasFileDrag(event))return;
    event.preventDefault();event.stopPropagation();
    const entry=isEntryDrag(event)?draggedEntry():null;
    const accepted=folder()&&ready()&&!busy&&(!isEntryDrag(event)||entry?.folderId===folder().id&&entry.kind!=='directory');
    event.dataTransfer.dropEffect=accepted?'copy':'none';
    element.classList.toggle('is-reference-drop',Boolean(accepted));hint.hidden=false;
    hint.textContent=entry?.kind==='directory'?'请拖入要引用的文件':!folder()?'先打开工作区文件夹':!ready()?'对话正在加载，请稍后再拖入':busy?'正在添加文件…':entry?'引用 '+entry.path.split('/').at(-1):'复制到工作区并引用';
    return accepted;
  }
  element.addEventListener('dragenter',over);element.addEventListener('dragover',over);
  element.addEventListener('dragleave',event=>{if(!element.contains(event.relatedTarget))clear();});
  element.addEventListener('drop',async event=>{
    if(!hasFileDrag(event))return;
    const accepted=over(event),binding=folder(),draft=receipt(),internal=isEntryDrag(event),files=Array.from(event.dataTransfer.files);
    clear();if(!accepted)return;
    busy=true;hint.hidden=false;hint.textContent='正在添加文件…';
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
