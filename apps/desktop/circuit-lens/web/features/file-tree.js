import {draggedEntry} from './file-drag.js';
import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';

export const parentPath=path=>path.split('/').slice(0,-1).join('/');
export function fileAppearance(entry,expanded=false) {
  if(entry.kind==='directory')return [expanded?'FolderOpen':'Folder','folder'];
  if(entry.kind==='link')return ['Link','link'];
  const ext=entry.name.split('.').pop().toLowerCase();
  if(ext==='circ')return ['CircuitBoard','circuit'];
  if(['png','jpg','jpeg','webp','svg','gif','bmp'].includes(ext))return ['FileImage','image'];
  if(['pdf','doc','docx','ppt','pptx'].includes(ext))return ['FileType','document'];
  if(['xls','xlsx','csv','tsv'].includes(ext))return ['FileSpreadsheet','sheet'];
  if(['zip','jar','7z','gz','tar'].includes(ext))return ['FileArchive','archive'];
  if(['js','ts','py','json','xml','v','sv','asm','s','c','h','yaml','yml'].includes(ext))return ['FileCode2','code'];
  return [['md','txt'].includes(ext)?'FileText':'File','text'];
}

// DOM/focus owner only. Loading, workspace identity and file operations stay
// in files.js; arrow navigation never opens documents as a side effect.
export function createFileTree({element,onOpen,onToggle,onContext,onSelect,onCreate,onRefresh,onCopy,onDelete,onDragStart}) {
  let entries=[],selected='',activeFile=null,dropTarget=null,expanded=new Set(),prefix='',typedAt=0;
  const rows=()=>[...element.querySelectorAll('.file-row')];
  const find=path=>rows().find(row=>row.dataset.path===path);
  function select(path,{focus=false,scroll=false}={}) {
    selected=path;
    for(const row of rows()) {
      const isSelected=row.dataset.path===path;
      row.setAttribute('aria-selected',String(isSelected));row.tabIndex=isSelected?0:-1;
    }
    const row=find(path);
    element.tabIndex=row?-1:0;
    if(focus)(row||element).focus({preventScroll:true});
    if(scroll)row?.scrollIntoView({block:'nearest'});
    onSelect(path);
  }
  function rowFor(entry) {
    const row=makeElement('button','file-row');row.type='button';row.dataset.path=entry.path;
    if(dropTarget===entry.path)row.classList.add('is-drop-target');
    row.style.setProperty('--depth',entry.depth);row.setAttribute('role','treeitem');
    row.setAttribute('aria-level',entry.depth+1);row.setAttribute('aria-posinset',entry.position);row.setAttribute('aria-setsize',entry.count);
    row.title=entry.path;row.setAttribute('aria-label',entry.name);
    if(entry.kind==='directory')row.setAttribute('aria-expanded',String(expanded.has(entry.path)));
    const chevron=makeElement('span','file-chevron');
    if(entry.kind==='directory')chevron.append(icon(expanded.has(entry.path)?'ChevronDown':'ChevronRight'));
    const [name,type]=fileAppearance(entry,expanded.has(entry.path));row.dataset.kind=type;
    row.append(chevron,icon(name),makeElement('span','file-name',entry.name));
    if(entry.path===activeFile) {
      row.setAttribute('aria-current','true');row.append(makeElement('span','file-current','当前'));
      row.title+=' · 当前电路';
    }
    row.draggable=true;row.addEventListener('dragstart',event=>onDragStart(event,entry));
    row.addEventListener('focus',()=>select(entry.path));
    row.addEventListener('click',()=>{select(entry.path);onOpen(entry);});
    row.addEventListener('contextmenu',event=>{event.preventDefault();select(entry.path,{focus:true});onContext(entry,row,event.clientX,event.clientY);});
    return row;
  }
  function render(items,options) {
    const focused=element.contains(document.activeElement),scroll=element.scrollTop;
    entries=items;expanded=options.expanded;activeFile=options.activeFile;
    dropTarget=element.querySelector('.is-drop-target')?.dataset.path;
    const fragment=document.createDocumentFragment();
    for(const entry of entries) {
      fragment.append(draggedEntry()?.path===entry.path?find(entry.path)?.cloneNode(true)||rowFor(entry):rowFor(entry));
      if(entry.kind==='directory'&&expanded.has(entry.path)&&entry.empty) {
        const empty=makeElement('div','file-empty-branch','空文件夹');empty.setAttribute('role','none');empty.dataset.path=entry.path;empty.style.setProperty('--depth',entry.depth+1);fragment.append(empty);
      }
      if(entry.error) {
        const error=makeElement('div','file-branch-error');error.setAttribute('role','none');error.style.setProperty('--depth',entry.depth+1);
        error.append(makeElement('span','',entry.error));const retry=makeElement('button','','重试');retry.type='button';retry.addEventListener('click',onRefresh);error.append(retry);fragment.append(error);
      }
    }
    const source=draggedEntry()?.path,live=source?find(source):null;
    if(live){
      const children=[...fragment.childNodes].map(child=>child.dataset?.path===source?live:child);
      let cursor=element.firstChild;
      for(const child of children){if(child===cursor)cursor=cursor.nextSibling;else element.insertBefore(child,cursor);}
      const retained=new Set(children);
      for(const child of [...element.childNodes])if(!retained.has(child))child.remove();
    }else element.replaceChildren(fragment);
    element.scrollTop=scroll;
    let path=options.selected;
    while(path&&!entries.some(entry=>entry.path===path))path=parentPath(path);
    select(path||entries.find(entry=>entry.path===activeFile)?.path||entries[0]?.path||'',{focus:focused});
  }
  element.addEventListener('contextmenu',event=>{
    if(event.target.closest('.file-row,.file-create'))return;
    event.preventDefault();onContext(null,element,event.clientX,event.clientY);
  });
  element.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    const input=event.target.closest('input');
    // Keep file operations from firing canvas shortcuts (Delete, undo, space,
    // letter tools). Global panel and simulation shortcuts still bubble.
    if(input){if(!event.ctrlKey&&!event.metaKey||event.key.toLowerCase()==='z')event.stopPropagation();return;}
    const entry=entries.find(item=>item.path===selected),index=entries.indexOf(entry);
    const move=i=>select(entries[Math.max(0,Math.min(entries.length-1,i))]?.path||'',{focus:true,scroll:true});
    let handled=true;
    if(event.key==='ArrowDown')move(index+1);
    else if(event.key==='ArrowUp')move(index-1);
    else if(event.key==='Home')move(0);
    else if(event.key==='End')move(entries.length-1);
    else if(event.key==='ArrowRight'&&entry?.kind==='directory') {
      if(!expanded.has(entry.path))onToggle(entry);else if(entries[index+1]?.depth>entry.depth)move(index+1);
    } else if(event.key==='ArrowLeft'&&entry) {
      if(entry.kind==='directory'&&expanded.has(entry.path))onToggle(entry);
      else if(parentPath(entry.path))select(parentPath(entry.path),{focus:true,scroll:true});
    } else if(event.key==='Enter'&&entry)onOpen(entry);
    else if(event.key===' '&&entry)select(entry.path,{focus:true});
    else if(event.shiftKey&&event.key==='F10'||event.key==='ContextMenu') {
      const row=find(selected)||element,r=row.getBoundingClientRect();onContext(entry,row,r.left+24,r.bottom);
    } else if(event.key==='F5')onRefresh();
    else if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='n')onCreate('directory');
    else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'&&entry)onCopy(entry.path);
    else if(['Delete','Backspace'].includes(event.key)&&entry){if(!event.repeat)onDelete(entry);}
    else if(['Escape'].includes(event.key)||(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z') { /* No canvas actions while browsing files. */ }
    else if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&event.key.length===1) {
      const now=Date.now(),character=event.key.toLocaleLowerCase();
      prefix=now-typedAt<800?prefix+character:character;typedAt=now;
      if([...prefix].every(c=>c===character))prefix=character;
      const ordered=[...entries.slice(index+1),...entries.slice(0,index+1)];
      const match=ordered.find(item=>item.name.toLocaleLowerCase().startsWith(prefix));
      if(match)select(match.path,{focus:true,scroll:true});
    } else handled=false;
    if(handled){event.preventDefault();event.stopPropagation();}
  });
  return {render,select,find};
}
