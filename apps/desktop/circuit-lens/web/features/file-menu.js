import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';

export function createFileMenu(element,fail) {
  let returnFocus=null,positionHint={};
  function position() {
    if(!element.matches(':popover-open')||!returnFocus?.isConnected)return;
    const {x,y}=positionHint,r=returnFocus.getBoundingClientRect(),m=element.getBoundingClientRect();
    const left=x??r.right-m.width,top=y??(r.bottom+m.height<innerHeight-8?r.bottom+4:r.top-m.height-4);
    element.style.left=Math.max(8,Math.min(left,innerWidth-m.width-8))+'px';
    element.style.top=Math.max(8,Math.min(top,innerHeight-m.height-8))+'px';
  }
  function close({restore=true}={}) {
    if(!element.matches(':popover-open'))return;
    element.hidePopover();returnFocus?.setAttribute('aria-expanded','false');
    if(restore&&returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
  }
  function open(items,anchor,{x,y,title}={}) {
    if(element.matches(':popover-open')&&returnFocus===anchor&&x===undefined){close();return;}
    close({restore:false});returnFocus=anchor;positionHint={x,y};element.replaceChildren();
    if(title)element.append(makeElement('div','file-menu-title',title));
    for(const item of items) {
      if(!item){const line=makeElement('hr');line.setAttribute('role','separator');element.append(line);continue;}
      const row=makeElement('button','file-menu-item');row.type='button';row.disabled=!!item.disabled;
      row.setAttribute('aria-label',item.label);
      row.setAttribute('role',item.checked===undefined?'menuitem':'menuitemcheckbox');
      if(item.checked!==undefined)row.setAttribute('aria-checked',String(item.checked));
      if(item.id)row.id=item.id;
      row.append(icon(item.checked?'Check':item.icon||'File'),makeElement('span','',item.label));
      if(item.shortcut)row.append(makeElement('kbd','',item.shortcut));
      row.addEventListener('click',()=>{close();Promise.resolve().then(item.run).catch(fail);});element.append(row);
    }
    element.showPopover();if(anchor?.hasAttribute('aria-haspopup'))anchor.setAttribute('aria-expanded','true');
    position();
    element.querySelector('button:not(:disabled)')?.focus();
  }
  element.addEventListener('keydown',event=>{
    const items=[...element.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault();items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();
    } else if(event.key==='Escape'){event.preventDefault();close();}
    else if(event.key==='Tab')close();
    // Menus must not trigger global canvas shortcuts either.
    event.stopPropagation();
  });
  document.addEventListener('pointerdown',event=>{if(!element.contains(event.target)&&!returnFocus?.contains(event.target))close({restore:false});});
  window.addEventListener('resize',position);
  return {open,close};
}
