import {hasFileDrag,isEntryDrag,draggedEntry,readFileDrag} from './file-drag.js';

// Internal drags move an entry; native OS drags import a copy. A directory row
// targets that directory, a file row its parent, and the heading targets root.
export function createFileDrop({element,folder,api,onImported,fail,canMove=()=>true}) {
  let target=null,busy=false,hoverTimer,scrollFrame=0,scrollSpeed=0;
  const hint=document.createElement('div');
  hint.className='file-drop-hint';hint.hidden=true;hint.setAttribute('role','status');element.append(hint);
  const tree=element.querySelector('#fileTree');
  function scroll(){if(!scrollSpeed)return;tree.scrollTop+=scrollSpeed;scrollFrame=requestAnimationFrame(scroll);}
  function clear(){
    target=null;clearTimeout(hoverTimer);cancelAnimationFrame(scrollFrame);scrollFrame=0;scrollSpeed=0;
    element.classList.remove('is-file-drop');
    element.querySelectorAll('.is-drop-target').forEach(row=>row.classList.remove('is-drop-target'));
    if(!busy)hint.hidden=true;
  }
  function valid(entry,path){
    return folder()&&!busy&&(!entry||(entry.folderId===folder().id&&canMove()
      &&path!==entry.path&&!path.startsWith(entry.path+'/')
      &&path!==entry.path.split('/').slice(0,-1).join('/')));
  }
  function over(event){
    if(!hasFileDrag(event))return;
    event.preventDefault();event.stopPropagation();
    const row=event.target.closest('.file-row'),path=row?.dataset.kind==='folder'?row.dataset.path:(row?.dataset.path||'').split('/').slice(0,-1).join('/');
    const internal=isEntryDrag(event),entry=internal?draggedEntry():null;
    if(!valid(entry,path)||(internal&&!entry)) {event.dataTransfer.dropEffect='none';clear();return;}
    event.dataTransfer.dropEffect=internal?'move':'copy';
    if(path!==target){
      clearTimeout(hoverTimer);target=path;
      element.querySelectorAll('.is-drop-target').forEach(row=>row.classList.remove('is-drop-target'));
      const directory=[...element.querySelectorAll('.file-row')].find(row=>row.dataset.path===path&&row.dataset.kind==='folder');
      directory?.classList.add('is-drop-target');
      if(directory?.getAttribute('aria-expanded')==='false')hoverTimer=setTimeout(()=>directory.click(),650);
    }
    element.classList.add('is-file-drop');hint.hidden=false;
    hint.textContent=(internal?'移动到 ':'复制到 ')+(path?path.split('/').at(-1):folder().name);
    if(document.getElementById('filesTab').getAttribute('aria-selected')!=='true')document.getElementById('filesTab').click();
    const collapse=document.getElementById('collapseFiles');if(collapse.getAttribute('aria-expanded')==='false')collapse.click();
    const bounds=tree.getBoundingClientRect();scrollSpeed=event.clientY<bounds.top+24?-6:event.clientY>bounds.bottom-24?6:0;
    cancelAnimationFrame(scrollFrame);if(scrollSpeed)scrollFrame=requestAnimationFrame(scroll);
  }
  element.addEventListener('dragenter',over);element.addEventListener('dragover',over);
  element.addEventListener('dragleave',event=>{if(!element.contains(event.relatedTarget))clear();});
  element.addEventListener('drop',async event=>{
    if(!hasFileDrag(event))return;
    event.preventDefault();event.stopPropagation();
    const binding=folder(),destination=target,files=Array.from(event.dataTransfer.files),internal=isEntryDrag(event);
    clear();
    if(!binding||busy||destination===null)return;
    busy=true;hint.hidden=false;hint.textContent=internal?'正在移动…':'正在复制…';
    try {
      let result;
      if(internal){
        const entry=readFileDrag(event);
        if(entry.folderId!==binding.id)throw new Error('工作区已切换，请重新拖动');
        const to=[destination,entry.path.split('/').at(-1)].filter(Boolean).join('/');
        result=await api.move({folderId:binding.id,from:entry.path,to});
      }else if(files.length)result=await api.importFiles({folderId:binding.id,path:destination},files);
      if(result&&folder()?.id===binding.id)await onImported(result.items,destination);
    }catch(error){fail(error);}finally{busy=false;clear();}
  });
  document.addEventListener('dragend',clear);document.addEventListener('drop',clear);window.addEventListener('blur',clear);
  return {clear};
}
