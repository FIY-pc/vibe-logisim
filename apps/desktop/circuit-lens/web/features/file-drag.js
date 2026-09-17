// The private MIME keeps moving workspace entries distinct from importing OS
// files. Browsers hide payloads during dragover, so retain only this gesture's
// source for local target feedback; validate the actual payload again on drop.
export const entryType='application/x-vibe-workspace-entry';
let active=null;
export const isEntryDrag=event=>Array.from(event.dataTransfer?.types||[]).includes(entryType);
export const hasFileDrag=event=>isEntryDrag(event)||Array.from(event.dataTransfer?.types||[]).includes('Files');
export const draggedEntry=()=>active;
export function beginFileDrag(event,entry,folder) {
  if(!folder){event.preventDefault();return;}
  active={folderId:folder.id,path:entry.path,kind:entry.kind,pathVersion:(folder.moves||[]).length};
  event.dataTransfer.effectAllowed='copyMove';
  event.dataTransfer.setData(entryType,JSON.stringify(active));
  event.dataTransfer.setData('text/plain',entry.path);
  // A whole-row drag image hides the destination. Carry just the file's icon
  // and name, below the pointer so the receiving row stays visible.
  const preview=document.createElement('div');preview.className='file-drag-preview';preview.setAttribute('aria-hidden','true');
  const glyph=event.currentTarget.querySelector(':scope > svg')?.cloneNode(true);
  if(glyph)preview.append(glyph);
  const name=document.createElement('span');name.textContent=entry.name;preview.append(name);document.body.append(preview);
  event.dataTransfer.setDragImage(preview,-14,-18);
  requestAnimationFrame(()=>preview.remove());
}
export function readFileDrag(event) {
  try {
    const value=JSON.parse(event.dataTransfer.getData(entryType));
    if(typeof value.path==='string'&&typeof value.folderId==='string'&&['file','directory','link'].includes(value.kind))return value;
  }catch{}
  throw new Error('拖动已失效，请重新拖动文件');
}
document.addEventListener('dragend',()=>{active=null;});
document.addEventListener('drop',()=>{active=null;});
window.addEventListener('blur',()=>{active=null;});
