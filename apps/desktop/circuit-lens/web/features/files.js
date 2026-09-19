import {makeElement} from '../core/dom.js';
import {icon,action} from '../core/chat-dom.js';
import {createFileTree,parentPath,fileAppearance} from './file-tree.js';
import {createFileMenu} from './file-menu.js';
import {beginFileDrag} from './file-drag.js';
import {createFileDrop} from './file-drop.js';
import {createFileHistory} from './file-history.js';

export const modelDependencies=['project'];
export const dependencies=['updateComposerState','bootstrap','showToast','openWorkspaceFile','attachWorkspaceFiles','renderMaterialAttachments'];

export function createController({models,ports}) {
  const api=window.vibeDesktop?.folder;
  const node=id=>document.getElementById(id),element=node('fileTree');
  let folder=null,epoch=0,selected='',entries=[],showHidden=false,editor=null,viewTimer=null,lastActive=null;
  const expanded=new Set();
  const request=extra=>({folderId:folder?.id,...extra});
  const message=e=>String(e.message||e).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');
  const fail=e=>ports.showToast(message(e));
  const menu=createFileMenu(node('fileMenu'),fail);
  const history=createFileHistory({api,models,ports,fail});
  const guarded=operation=>(...args)=>Promise.resolve().then(()=>operation(...args)).catch(fail);
  const persist=()=>{
    clearTimeout(viewTimer);
    const value=request({expanded:[...expanded],selected,showHidden});
    viewTimer=setTimeout(()=>api.view(value).catch(()=>{}),150);
  };
  let drop;
  const tree=createFileTree({element,onOpen:guarded(openEntry),onToggle:guarded(toggle),onContext:openContext,
    onSelect:path=>{if(selected!==path){selected=path;persist();}},onCreate:guarded(startCreate),onRefresh:guarded(refreshFiles),onCopy:guarded(path=>window.vibeDesktop.copyText(path)),onDelete:guarded(deleteEntry),onDragStart:(event,entry)=>beginFileDrag(event,entry,folder)});
  function expandParents(path) {
    for(let parent=parentPath(path);parent;parent=parentPath(parent))expanded.add(parent);
    if(path.split('/').some(part=>part.startsWith('.')))showHidden=true;
  }
  function workspaceFolderChanged(value) {
    const changed=folder?.id!==value?.id;
    if(changed) {
      drop?.clear();clearTimeout(viewTimer);editor=null;epoch++;entries=[];expanded.clear();menu.close({restore:false});node('fileChanges').close();
      const view=value?.explorer||{};for(const path of view.expanded||[])expanded.add(path);
      selected=view.selected||value?.activeFile||'';showHidden=!!view.showHidden;lastActive=value?.activeFile;
      if(lastActive&&!value.explorer)expandParents(lastActive);
      node('folderError').hidden=true;node('folderError').textContent='';
    }
    folder=value;models.project.folder=value;
    if(value?.activeFile!==lastActive) {lastActive=value?.activeFile;if(lastActive){expandParents(lastActive);selected=lastActive;}}
    node('folderName').textContent=value?.name||'文件';node('collapseFiles').title=value?.root||'文件';
    node('fileActions').hidden=!folder;node('locateCurrentFile').disabled=!folder?.activeFile;
    refreshFiles().catch(fail);
  }
  async function refreshFiles() {
    if(editor)return; // Watch events must not replace an in-progress filename.
    const token=++epoch,binding=request(),items=[];
    if(!folder){element.replaceChildren(emptyState(false));element.tabIndex=0;return;}
    async function walk(directory,depth) {
      const response=await api.list({...binding,path:directory,hidden:showHidden});
      if(token!==epoch)return;
      for(const [index,entry] of response.items.entries()) {
        const item={...entry,depth,position:index+1,count:response.items.length};items.push(item);
        if(entry.kind==='directory'&&expanded.has(entry.path)) {
          try {const count=items.length;await walk(entry.path,depth+1);item.empty=items.length===count;}
          catch(e){item.error=message(e);}
        }
      }
    }
    try {await walk('',0);} catch(e) {
      if(token!==epoch)return;
      const box=makeElement('div','file-empty');box.append(makeElement('p','',message(e)),action('重新读取文件','RefreshCw',guarded(refreshFiles),'quiet-button'));
      element.replaceChildren(box);return;
    }
    if(token!==epoch||editor)return;
    entries=items;tree.render(items,{selected,activeFile:folder.activeFile,expanded});
    if(!items.length)element.append(emptyState(true));
  }
  function emptyState(open) {
    const box=makeElement('div','file-empty');box.append(icon(open?'FolderOpen':'Folder'));
    box.append(makeElement('p','',open?'还没有文件':'打开项目所在的文件夹'));
    const button=makeElement('button','quiet-button',open?'新建电路':'打开文件夹');button.type='button';
    button.addEventListener('click',guarded(()=>open?startCreate('circuit',''):node('openButton').click()));box.append(button);return box;
  }
  async function toggle(entry) {
    expanded.has(entry.path)?expanded.delete(entry.path):expanded.add(entry.path);persist();await refreshFiles();
  }
  async function openEntry(entry,{folderId=folder?.id,page=1,pathVersion=(folder?.moves||[]).length}={}) {
    if(folderId!==folder?.id)throw new Error('文件属于另一工作区');
    if(entry.kind==='directory')return toggle(entry);
    if(/\.circ$/i.test(entry.name)) {
      if(folder.activeFile===entry.path)return;
      await api.select({folderId,path:entry.path});if(folder?.id===folderId)await ports.bootstrap();
    } else await ports.openWorkspaceFile(entry.path,page,pathVersion,folderId);
  }
  async function openWorkspaceReference({folderId,path,page=1,pathVersion}) {
    if(folderId!==folder?.id)throw new Error('文件属于另一工作区');
    // The existing file service owns move mapping and realpath/symlink checks.
    const {items}=await api.reference({folderId,refs:[{id:path,pathVersion}]});
    if(folderId!==folder?.id)throw new Error('文件属于另一工作区');
    const item=items[0];
    await openEntry({...item,kind:'file'},{folderId,page,pathVersion:item.pathVersion});
  }
  async function locateCurrent() {
    if(!folder?.activeFile)return;
    if(node('collapseFiles').getAttribute('aria-expanded')==='false')node('collapseFiles').click();
    expandParents(folder.activeFile);selected=folder.activeFile;await refreshFiles();tree.select(selected,{focus:true,scroll:true});persist();
  }
  const creationItems=parent=>[
    {label:'新建电路',icon:'CircuitBoard',run:()=>startCreate('circuit',parent)},
    {label:'新建文件',icon:'FilePlus2',run:()=>startCreate('file',parent)},
    {label:'新建文件夹',icon:'FolderPlus',shortcut:'Ctrl+Shift+N',run:()=>startCreate('directory',parent)},
  ];
  function contextParent(entry) {return entry?.kind==='directory'?entry.path:parentPath(entry?.path||'');}
  async function deleteEntry(entry,binding=request()) {
    if(models.project.projectBusy)throw new Error('正在保存画布编辑，请稍后再试');
    await api.trash({...binding,path:entry.path});
  }
  function openContext(entry,anchor,x,y) {
    const binding=request(),path=entry?.path||'',pathVersion=(folder.moves||[]).length;
    const reveal={label:'在文件管理器中显示',icon:'FolderOpen',run:()=>api.reveal({...binding,path})};
    const items=[];
    if(entry)items.push({label:entry.kind==='directory'?(expanded.has(path)?'收起文件夹':'展开文件夹'):'打开',icon:entry.kind==='directory'?'FolderOpen':'ExternalLink',shortcut:'Enter',run:()=>openEntry(entry)});
    if(!entry||entry.kind==='directory')items.push(...creationItems(path),null);
    if(entry?.kind!=='directory'&&entry)items.push({label:'用系统应用打开',icon:'ExternalLink',run:async()=>{const result=await api['open-system']({...binding,path});if(result)throw new Error(result);}},null);
    items.push(reveal,{label:'复制相对路径',icon:'Copy',shortcut:'Ctrl+C',run:()=>window.vibeDesktop.copyText(path||'.')},
      {label:'复制完整路径',icon:'Copy',run:()=>window.vibeDesktop.copyText(folder.root+(path?'/'+path:''))});
    if(entry?.kind==='file')items.push(null,{label:'添加到对话',icon:'MessageSquarePlus',run:()=>ports.attachWorkspaceFiles([{id:path,pathVersion}],binding.folderId)});
    if(entry)items.push(null,{label:'删除（移到回收站）',icon:'Trash2',shortcut:'Delete',run:()=>deleteEntry(entry,binding)});
    menu.open(items,anchor,{x,y,title:entry?.name||folder?.name});
  }
  function showOptions() {
    menu.open([
      {id:'showFileChanges',label:'文件改动',icon:'History',run:()=>history.openFileChanges()},
      {id:'refreshFiles',label:'刷新文件',icon:'RefreshCw',shortcut:'F5',run:refreshFiles},
      {label:'折叠所有文件夹',icon:'ChevronsDownUp',run:async()=>{expanded.clear();persist();await refreshFiles();}},
      {label:'显示隐藏文件',icon:'Eye',checked:showHidden,run:async()=>{showHidden=!showHidden;persist();await refreshFiles();}},null,
      {id:'revealFolder',label:'在文件管理器中打开',icon:'FolderOpen',run:()=>api.reveal(request())},
      {label:'复制文件夹路径',icon:'Copy',run:()=>window.vibeDesktop.copyText(folder.root)},
    ],node('fileOptions'));
  }
  async function startCreate(kind,parent) {
    if(!folder)return;
    if(editor){editor.input.focus();return;}
    const id=folder.id;
    parent??=contextParent(entries.find(entry=>entry.path===selected));
    if(node('collapseFiles').getAttribute('aria-expanded')==='false')node('collapseFiles').click();
    if(parent){expanded.add(parent);expandParents(parent);}await refreshFiles();if(folder?.id!==id)return;
    const form=makeElement('form','file-create'),line=makeElement('div','file-create-line'),input=makeElement('input'),error=makeElement('p','file-create-error');
    form.style.setProperty('--depth',parent?parent.split('/').length:0);form.setAttribute('role','none');
    const name=kind==='directory'?'文件夹名称':'文件名称';input.type='text';input.autocomplete='off';input.spellcheck=false;input.setAttribute('aria-label',name);
    input.value=kind==='circuit'?'新电路.circ':kind==='directory'?'新文件夹':'新文件.txt';error.hidden=true;error.id='fileCreateError';error.setAttribute('role','alert');input.setAttribute('aria-describedby',error.id);
    const [image]=fileAppearance({name:input.value,kind:kind==='directory'?'directory':'file'});
    const cancel=action('取消新建','X',guarded(()=>finish()),'file-create-action');
    const save=action('确认新建','Check',()=>form.requestSubmit(),'file-create-action');
    line.append(icon(image),input,save,cancel);form.append(line,error);editor={input,form,parent,busy:false};
    async function finish(path=parent) {
      editor=null;form.remove();selected=path;
      await refreshFiles();if(folder?.id===id)tree.select(path,{focus:true,scroll:true});
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(editor?.busy)return;
      let name=input.value.trim();
      if(!name||['.','..'].includes(name)||/[\/\\\0]/.test(name)){error.textContent='名称不能为空，也不能包含 / 或 \\';error.hidden=false;input.setAttribute('aria-invalid','true');input.focus();return;}
      if(kind==='circuit'&&!/\.circ$/i.test(name))name+='.circ';
      const file=parent?parent+'/'+name:name;editor.busy=true;input.disabled=save.disabled=cancel.disabled=true;error.hidden=true;
      try {
        await api.create({folderId:id,path:file,directory:kind==='directory'});
        if(folder?.id!==id)return;
        if(name.startsWith('.'))showHidden=true;
        await finish(file);persist();
        if(/\.circ$/i.test(name)&&kind!=='directory')await openEntry({path:file,name,kind:'file'});
      } catch(e) {
        if(folder?.id!==id)return;
        if(!editor){fail(e);return;}
        editor.busy=false;input.disabled=save.disabled=cancel.disabled=false;error.textContent=message(e);error.hidden=false;input.setAttribute('aria-invalid','true');input.focus();
      }
    });
    input.addEventListener('input',()=>{error.hidden=true;input.removeAttribute('aria-invalid');});
    form.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'&&!editor?.busy){event.preventDefault();finish().catch(fail);}});
    element.querySelector('.file-empty')?.remove();
    const row=parent?tree.find(parent):null;if(row){row.nextElementSibling?.classList.contains('file-empty-branch')&&row.nextElementSibling.remove();row.after(form);}else element.prepend(form);
    input.focus();input.setSelectionRange(0,kind==='directory'?input.value.length:input.value.lastIndexOf('.'));form.scrollIntoView({block:'nearest'});
  }
  function mountFiles() {
    if(!api)return;
    drop=createFileDrop({element:node('fileExplorer'),folder:()=>folder,api,fail,canMove:()=>!models.project.projectBusy,
      onImported:async(items,parent)=>{
        if(parent)expanded.add(parent);
        for(const item of items)expandParents(item.path);
        selected=items[0]?.path||parent;
        await refreshFiles();tree.select(selected,{focus:true,scroll:true});persist();
      }});
    for(const [id,name,handler] of [['locateCurrentFile','LocateFixed',locateCurrent],['newFileMenu','Plus',()=>menu.open(creationItems(),node('newFileMenu'))],['fileOptions','Ellipsis',showOptions]]) {
      node(id).replaceChildren(icon(name));node(id).addEventListener('click',guarded(handler));
    }
    api.onEvent(event=>{
      if(event.folder?.id!==folder?.id)return;
      if(event.move){
        const {from,to}=event.move,remap=p=>p===from||p.startsWith(from+'/')?to+p.slice(from.length):p;
        selected=remap(selected);const next=[...expanded].map(remap);expanded.clear();next.forEach(p=>expanded.add(p));
        clearTimeout(viewTimer);
      }
      folder=event.folder;models.project.folder=folder;
      ports.renderMaterialAttachments();
      node('folderError').textContent=event.error||'';node('folderError').hidden=!event.error;
      if(event.error&&folder?.activeFile){models.project.sourceChanged=true;ports.updateComposerState();}
      node('locateCurrentFile').disabled=!folder?.activeFile;
      refreshFiles().catch(fail);
      if(event.documentChanged)ports.bootstrap();
    });
  }
  return {mountFiles,workspaceFolderChanged,refreshFiles,openWorkspaceReference,openFileChanges:history.openFileChanges};
}
