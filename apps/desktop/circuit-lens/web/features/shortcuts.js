import {makeElement} from '../core/dom.js';
import {icon} from '../core/chat-dom.js';
import {shortcutCommands,defaultBindings,eventBinding,bindingLabel,bindingProblem,resolveBindings,bindingOverrides} from '../core/shortcuts.js';

export const modelDependencies=['project'];
export const dependencies=['setMode','openComponents','openFinder','fitCircuit','requestSave','performProjectAction','runSimulationCommand','showToast'];

export function createController({models:{project},ui,ports}) {
  const mac=/Mac/.test(navigator.platform), api=window.vibeDesktop?.shortcutPreferences;
  let bindings={...defaultBindings},recording=null,error='',saving=false,loading=true,returnFocus=null;
  const nodes=new Map();
  const label=id=>bindingLabel(bindings[id],mac);
  const matchesShortcut=(event,id)=>bindings[id]!=null&&eventBinding(event,mac)===bindings[id];
  const tool=mode=>{ports.setMode(mode);ui.circuitCanvas.focus({preventScroll:true});};
  const actions={
    select:()=>tool('select'),wire:()=>tool('wire'),poke:()=>tool('poke'),pan:()=>tool('pan'),
    components:()=>{if(project.circuit&&!project.sourceChanged&&!project.projectBusy)ports.openComponents();},
    save:()=>ports.requestSave(),undo:()=>{if(!ui.undoButton.disabled)ports.performProjectAction('undo');},
    find:()=>ports.openFinder(),circuitSearch:()=>ui.circuitSearch.focus(),fit:()=>ports.fitCircuit(),
    grid:()=>ui.gridToggle.click(),rail:()=>ui.toggleCircuits.click(),review:()=>ui.toggleReview.click(),
    ...Object.fromEntries([['clock','toggle-clock'],['tick','tick'],['propagation','toggle-propagation'],['step','step'],['reset','reset'],['capture','capture']]
      .map(([id,action])=>[id,()=>ports.runSimulationCommand(action)])),
  };

  function refreshShortcutHints() {
    for(const command of shortcutCommands)for(const id of command.targets||[]){
      const button=document.getElementById(id);if(!button)continue;
      const binding=bindings[command.id];
      button.title=`${command.label}${binding?`（${label(command.id)}）`:''}${command.hint?`；${command.hint}`:''}`;
      button.setAttribute('aria-keyshortcuts',binding?binding.replace('Mod',mac?'Meta':'Control').replace('Ctrl','Control'):'');
      const kbd=button.querySelector('kbd');if(kbd){kbd.textContent=binding?label(command.id):'';kbd.hidden=!binding;}
    }
    const circuitKey=ui.circuitSearch.parentElement.querySelector('kbd');
    if(circuitKey)circuitKey.textContent=bindings.circuitSearch?label('circuitSearch'):'';
    document.dispatchEvent(new CustomEvent('vibe-shortcuts-changed'));
  }

  function renderRows() {
    nodes.clear();ui.shortcutList.replaceChildren();
    const query=ui.shortcutSearch.value.trim().toLowerCase();
    let group=null,section=null;
    for(const command of shortcutCommands){
      if(query&&!`${command.label} ${command.group} ${label(command.id)}`.toLowerCase().includes(query))continue;
      if(group!==command.group){group=command.group;section=makeElement('section','shortcut-group');section.append(makeElement('h3','',group));ui.shortcutList.append(section);}
      const row=makeElement('div','shortcut-row');row.dataset.command=command.id;
      row.append(makeElement('span','shortcut-name',command.label));
      const controls=makeElement('div','shortcut-binding');
      const key=makeElement('button','shortcut-key');key.type='button';
      key.setAttribute('aria-label',`更改${command.label}快捷键`);
      key.setAttribute('aria-description',recording===command.id?'正在录入，Esc 取消':`当前：${label(command.id)}`);
      key.textContent=recording===command.id?'按下新快捷键…':label(command.id);
      key.setAttribute('aria-pressed',String(recording===command.id));key.disabled=saving||loading;
      key.addEventListener('click',()=>{recording=command.id;error='';renderRows();nodes.get(command.id)?.focus();});
      controls.append(key);nodes.set(command.id,key);
      if(recording===command.id){
        for(const [text,action] of [['清除',()=>change(command.id,null)],['取消',()=>{recording=null;error='';renderRows();nodes.get(command.id)?.focus();}]]){
          const b=makeElement('button','quiet-button',text);b.type='button';b.disabled=saving;b.addEventListener('click',action);controls.append(b);
        }
      }else if(bindings[command.id]!==command.key){
        const reset=makeElement('button','shortcut-reset');reset.type='button';reset.title=`恢复${command.label}默认键：${bindingLabel(command.key,mac)}`;
        reset.setAttribute('aria-label',reset.title);reset.append(icon('RotateCcw'));reset.disabled=saving||loading;
        reset.addEventListener('click',()=>change(command.id,command.key));controls.append(reset);
      }
      row.append(controls);section.append(row);
    }
    if(!ui.shortcutList.childElementCount)ui.shortcutList.append(makeElement('p','shortcut-empty','没有找到这个操作'));
    ui.shortcutError.textContent=error;ui.shortcutError.hidden=!error;
    ui.shortcutStatus.textContent=loading?'正在读取快捷键…':saving?'正在保存…':'';
    ui.shortcutResetAll.disabled=saving||loading||!Object.keys(bindingOverrides(bindings)).length;
    ui.shortcutClose.disabled=saving;ui.shortcutSearch.disabled=saving;
  }

  async function persist(next,focusId) {
    saving=true;error='';renderRows();
    try{
      const value=bindingOverrides(next);
      if(api)await api.write(value);else localStorage.setItem('vibe.shortcuts',JSON.stringify(value));
      bindings=next;recording=null;refreshShortcutHints();
    }catch(e){error=`未能保存：${e.message}`;}
    finally{saving=false;renderRows();if(focusId)nodes.get(focusId)?.focus();}
  }
  function change(id,binding) {
    error=bindingProblem(id,binding,bindings)||'';
    if(error){renderRows();nodes.get(id)?.focus();return;}
    void persist({...bindings,[id]:binding},id);
  }
  function openShortcutSettings() {
    if(document.querySelector('dialog[open]'))return;
    for(const popup of document.querySelectorAll(':popover-open'))popup.hidePopover();
    ui.appMenuButton.setAttribute('aria-expanded','false');
    returnFocus=document.activeElement;recording=null;ui.shortcutSearch.value='';renderRows();
    ui.shortcutDialog.showModal();ui.shortcutSearch.focus();
  }

  function mountShortcuts() {
    ui.shortcutClose.replaceChildren(icon('X'));
    ui.shortcutClose.addEventListener('click',()=>ui.shortcutDialog.close());
    ui.shortcutDialog.addEventListener('close',()=>{recording=null;returnFocus?.focus?.({preventScroll:true});});
    ui.shortcutDialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
    ui.shortcutSearch.addEventListener('input',()=>{recording=null;renderRows();});
    ui.shortcutSearch.addEventListener('focus',()=>{if(recording){recording=null;error='';renderRows();}});
    ui.shortcutResetAll.addEventListener('click',()=>{recording=null;void persist({...defaultBindings});});
    ui.shortcutDialog.addEventListener('keydown',event=>{
      if(!recording||saving||event.isComposing||event.keyCode===229)return;
      if(event.key==='Tab')return;
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();const id=recording;recording=null;error='';renderRows();nodes.get(id)?.focus();return;}
      if(event.target!==nodes.get(recording))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(event.repeat)return;
      const binding=eventBinding(event,mac);if(binding)change(recording,binding);
    },true);
    document.addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.isComposing||event.keyCode===229)return;
      const binding=eventBinding(event,mac);if(!binding)return;
      const dialog=document.querySelector('dialog[open]');
      if(binding==='Mod+,'&&!dialog){event.preventDefault();if(!event.repeat)openShortcutSettings();return;}
      const command=shortcutCommands.find(c=>bindings[c.id]===binding);if(!command||!actions[command.id])return;
      if(dialog&&!(command.id==='find'&&dialog===ui.finderDialog))return;
      if(document.querySelector(':popover-open')&&!(command.group==='仿真'&&ui.simulationMenu.matches(':popover-open')))return;
      const inField=event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
      if(inField&&(!['save','find'].includes(command.id)||(!event.ctrlKey&&!event.metaKey)))return;
      event.preventDefault();if(!event.repeat||command.id==='undo')void actions[command.id]();
    });
    refreshShortcutHints();
    Promise.resolve().then(()=>api?api.read():JSON.parse(localStorage.getItem('vibe.shortcuts')||'{}')).then(value=>{
      bindings=resolveBindings(value);refreshShortcutHints();
    }).catch(e=>{error=`未能读取快捷键，暂用默认键位：${e.message}`;ports.showToast(error);})
      .finally(()=>{loading=false;if(ui.shortcutDialog.open)renderRows();});
  }
  return {mountShortcuts,openShortcutSettings,matchesShortcut,shortcutLabel:label,
    shortcutHint:id=>bindings[id]?`（${label(id)}）`:'',refreshShortcutHints};
}
