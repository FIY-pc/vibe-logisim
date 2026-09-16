import {componentId, displayName} from '../core/values.js';
import {makeElement} from '../core/dom.js';

export const modelDependencies = ['project'];
export const dependencies = ['displayedSimulationView','activateSimulationView','captureViewport', 'restoreViewport', 'loadCircuit', 'selectComponent'];

// Spatial breadcrumbs and live instance identity remain separate. Native IDs
// locate an instance only within the unchanged revision of its running session.
export function createController({models, ui, ports}) {
  const {project} = models;
  let projectId = null, parents = [], current = null, mounted = false;
  let navigating = false, signature = '';
  const definition = name => project.circuits.find(c => displayName(c) === name);
  const sameEntry = (instance, entry) => instance.target === entry.target &&
    instance.location?.x === entry.location.x && instance.location?.y === entry.location.y;

  function resetNavigation() {
    projectId = null; parents = []; current = null; signature='';
    renderNavigation();
  }

  function runtimeNavigationStarted() {
    parents=[];current=project.circuitName;signature='';renderNavigation();
  }

  function renderNavigation() {
    const live=ports.displayedSimulationView();
    const next=JSON.stringify([project.revision,current,parents,live,navigating]);
    if(next===signature)return;signature=next;
    ui.circuitBreadcrumbs.replaceChildren();
    parents.forEach((frame, index) => {
      const instance=live?.instancePath[index-1];
      const label=instance?.label&&instance.label!==frame.name?`${instance.label} · ${frame.name}`:frame.name;
      const button = makeElement('button', 'breadcrumb-parent', label);
      button.type = 'button'; button.title = `返回 ${frame.name}`;
      button.addEventListener('click', () => returnToCircuit(index));
      const separator = makeElement('span', 'breadcrumb-separator', '›');
      separator.setAttribute('aria-hidden', 'true');
      ui.circuitBreadcrumbs.append(button, separator);
    });
    ui.currentCircuitName.textContent = current || '电路工作区';
    ui.currentCircuitName.setAttribute('aria-current', 'page');
    ui.circuitBreadcrumbs.append(ui.currentCircuitName);
    ui.currentCircuitName.scrollIntoView({block:'nearest', inline:'nearest'});
    ui.circuitBack.disabled = !parents.length||navigating;
    ui.circuitBack.title = parents.length ? `返回 ${parents.at(-1).name}（Alt + ←）` : '已经在入口电路';
    const count = project.circuits.reduce((n, c) => n + (c.instances || []).filter(i => i.target === current).length, 0);
    ui.definitionContext.hidden = !count&&!live;
    ui.definitionContext.textContent = live ? `运行实例 · ${live.instancePath.at(-1)?.label||live.rootCircuit}` : `${count} 处使用`;
    const entry = parents.at(-1)?.entry;
    ui.definitionContext.title = live ? [live.rootCircuit,...live.instancePath.map(p=>`${p.label}（${p.location.x}, ${p.location.y}）`)].join(' › ')+'：显示同一次运行中的实例；结构修改仍作用于共享定义。' : `${entry ? `从 ${parents.at(-1).name} 的 ${entry.label || entry.target}（${entry.location.x}, ${entry.location.y}）进入。` : ''}修改会用于所有引用此定义的模块。这里不是父电路中某个实例的运行状态。`;
  }

  function didNavigateCircuit(name, navigation = {kind:'definition'}) {
    if (projectId !== project.session?.workspace?.id) {parents = []; current = null;}
    projectId = project.session?.workspace?.id;
    // Only retain spatial entry context if the current project still has that
    // unique reference. Never remap a deleted/moved instance by an old ID.
    if (parents.some(frame => !definition(frame.name) ||
      (definition(frame.name).instances || []).filter(i => sameEntry(i, frame.entry)).length !== 1)) parents = [];
    let returned;
    if(navigation.kind==='runtime-return')parents=navigation.runtimeView.instancePath.map((entry,index)=>({name:entry.parentCircuit,
      entry:{target:entry.circuit,label:entry.label,location:entry.location},runtimePath:navigation.runtimeView.instancePath.slice(0,index)}));
    else if (navigation.kind === 'enter' && navigation.parent.name === current) parents.push(navigation.parent);
    else if (navigation.kind === 'back' && parents[navigation.index]?.name === name) {
      returned = parents[navigation.index]; parents = parents.slice(0, navigation.index);
    } else if (navigation.kind !== 'refresh' || current !== name) parents = [];
    current = name;
    renderNavigation();
    if (returned?.viewport) ports.restoreViewport(returned.viewport);
    return returned?.entry || null;
  }

  function restoreEntrySelection(entry) {
    if (!entry) return;
    const matches = project.circuit.components.filter(c => sameEntry({target:c.subcircuit || c.factory, location:c.location}, entry));
    if (matches.length === 1) ports.selectComponent(componentId(matches[0]));
  }

  async function enterCircuit(component) {
    const target = component.subcircuit || component.factory;
    if (!definition(target) || project.projectBusy || project.sourceChanged || navigating) return;
    const live=ports.displayedSimulationView(),epoch=project.circuitRequestEpoch,revision=project.revision;
    const parent={name:project.circuitName,viewport:ports.captureViewport(),runtimePath:live?.instancePath,
      entry:{target,label:component.label,location:{...component.location}}};
    navigating=true;renderNavigation();
    try{
      const view=live?await ports.activateSimulationView([...live.instancePath,{componentId:componentId(component)}]):null;
      if(live&&!view||epoch!==project.circuitRequestEpoch||revision!==project.revision)return;
      await ports.loadCircuit(target,{navigation:{kind:'enter',parent,runtimeView:view}});
    }finally{navigating=false;renderNavigation();}
  }

  async function returnToCircuit(index = parents.length - 1) {
    if (!parents[index] || project.projectBusy || navigating) return;
    const parent=parents[index],live=ports.displayedSimulationView(),epoch=project.circuitRequestEpoch,revision=project.revision;
    navigating=true;renderNavigation();
    try{
      const view=live?await ports.activateSimulationView(parent.runtimePath||[]):null;
      if(live&&!view||epoch!==project.circuitRequestEpoch||revision!==project.revision)return;
      await ports.loadCircuit(parent.name,{navigation:{kind:'back',index,runtimeView:view}});
    }finally{navigating=false;renderNavigation();}
  }

  function mountNavigation() {
    if (mounted) return; mounted = true;
    ui.circuitBack.addEventListener('click', () => returnToCircuit());
    window.addEventListener('keydown', event => {
      if (event.altKey && event.key === 'ArrowLeft' && !document.querySelector('dialog[open]')) {
        event.preventDefault(); returnToCircuit();
      }
    });
  }
  return Object.freeze({runtimeNavigationStarted,renderNavigation,resetNavigation, didNavigateCircuit, restoreEntrySelection, enterCircuit, returnToCircuit, mountNavigation});
}
