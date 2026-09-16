import {icon} from '../core/chat-dom.js';
// Owns workspace geometry only. Circuit coordinates and conversation state do
// not change when a panel is resized, collapsed, or revealed.
export const modelDependencies = [];
export const dependencies = [];

const defaults = { rail: 260, review: 400, navigatorShare: .30, fileShare:.32, filesCollapsed:false, navigatorCollapsed: false, inspectorCollapsed: false };
const limits = { rail: [224, 420], review: [320, 820] };
const clamp = (n, min, max) => Math.max(min, Math.min(n, max));

export function createController({ui}) {
  let desired = {...defaults};
  let widths = {...defaults};
  let mounted = false;
  let drag = null;
  let edited = false;
  const scrollPositions={navigatorCollapsed:0,inspectorCollapsed:0};
  const handles = {rail: ui.railResize, review: ui.reviewResize};

  function applyLayout() {
    const desktop = window.innerWidth > 820;
    const available = ui.workbench.clientWidth;
    const railVisible = !ui.appShell.classList.contains('rail-hidden');
    const reviewVisible = !ui.appShell.classList.contains('review-hidden');
    widths = {...desired};
    if (desktop) {
      const extra = Math.max(0, available - 440 - (railVisible ? limits.rail[0] : 0) - (reviewVisible ? limits.review[0] : 0));
      const requested = (railVisible ? desired.rail - limits.rail[0] : 0) + (reviewVisible ? desired.review - limits.review[0] : 0);
      const ratio = requested > extra ? extra / requested : 1;
      for (const side of ['rail','review']) widths[side] = Math.round(limits[side][0] + (desired[side] - limits[side][0]) * ratio);
    }
    for (const side of ['rail', 'review']) {
      ui.appShell.style.setProperty(`--${side}-width`, `${widths[side]}px`);
      handles[side].setAttribute('aria-valuemin', limits[side][0]);
      handles[side].setAttribute('aria-valuemax', limits[side][1]);
      handles[side].setAttribute('aria-valuenow', widths[side]);
      handles[side].setAttribute('aria-valuetext', `${widths[side]} 像素，方向键调整，Home 恢复默认`);
    }
    applySplit();
    renderPanelToggles();
  }

  const fileSection=document.getElementById('fileExplorer');
  const fileHandle=document.getElementById('filesResize');
  const fileToggle=document.getElementById('collapseFiles');
  const sections=[fileSection,ui.circuitNavigator,ui.inspectorSection];
  const collapsed=['filesCollapsed','navigatorCollapsed','inspectorCollapsed'];
  function applySplit() {
    const total=ui.circuitRail.clientHeight-16;
    if(total<126)return;
    const weights=[desired.fileShare,desired.navigatorShare,Math.max(.1,1-desired.fileShare-desired.navigatorShare)];
    const open=collapsed.map((key,i)=>desired[key]?null:i).filter(i=>i!==null);
    const available=total-(3-open.length)*42;
    const sum=open.reduce((s,i)=>s+weights[i],0);
    sections.forEach((section,i)=>{
      const height=desired[collapsed[i]]?42:available*weights[i]/sum;
      section.style.flex=`0 0 ${height}px`;
      section.classList.toggle('is-collapsed',desired[collapsed[i]]);
      [fileToggle,ui.collapseNavigator,ui.collapseInspector][i].setAttribute('aria-expanded',String(!desired[collapsed[i]]));
    });
    [fileHandle,ui.inspectorResize].forEach((handle,i)=>{
      const enabled=!desired[collapsed[i]]&&!desired[collapsed[i+1]];
      handle.setAttribute('aria-disabled',String(!enabled));handle.tabIndex=enabled?0:-1;
      handle.setAttribute('aria-valuemin','10');handle.setAttribute('aria-valuemax','80');
      handle.setAttribute('aria-valuenow',String(Math.round(weights[i]*100)));
      handle.setAttribute('aria-valuetext','上下方向键调整高度，Home 恢复默认');
    });
  }
  function mountSplit() {
    [fileToggle,ui.collapseNavigator,ui.collapseInspector].forEach((toggle,i)=>toggle.addEventListener('click',()=>{
      desired[collapsed[i]]=!desired[collapsed[i]];
      if(collapsed.every(key=>desired[key]))desired[collapsed[(i+1)%3]]=false;
      edited=true;applySplit();void saveLayout();
    }));
    [fileHandle,ui.inspectorResize].forEach((handle,index)=>{
      const adjust=delta=>{
        const total=ui.circuitRail.clientHeight-16;
        const heights=sections.map(section=>section.offsetHeight);
        delta=clamp(delta,Math.min(90,heights[index])-heights[index],heights[index+1]-Math.min(90,heights[index+1]));
        heights[index]+=delta;heights[index+1]-=delta;
        desired.fileShare=heights[0]/total;desired.navigatorShare=heights[1]/total;edited=true;applySplit();
      };
      handle.addEventListener('pointerdown',event=>{
        if(event.button!==0||handle.getAttribute('aria-disabled')==='true')return;
        event.preventDefault();handle.focus();drag={side:'split'+index,pointerId:event.pointerId,start:event.clientY};handle.setPointerCapture(event.pointerId);ui.appShell.classList.add('resizing-row');
      });
      handle.addEventListener('pointermove',event=>{if(drag?.side!=='split'+index||drag.pointerId!==event.pointerId)return;adjust(event.clientY-drag.start);drag.start=event.clientY;});
      const finish=event=>{if(drag?.side!=='split'+index||drag.pointerId!==event.pointerId)return;drag=null;if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);ui.appShell.classList.remove('resizing-row');void saveLayout();};
      for(const name of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(name,finish);
      handle.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','Home'].includes(event.key)||handle.getAttribute('aria-disabled')==='true')return;event.preventDefault();if(event.key==='Home'){desired.fileShare=defaults.fileShare;desired.navigatorShare=defaults.navigatorShare;applySplit();}else adjust((event.key==='ArrowDown'?1:-1)*(event.shiftKey?40:16));edited=true;void saveLayout();});
    });
  }

  async function saveLayout() {
    try {
      if (window.vibeDesktop?.setLayout) await window.vibeDesktop.setLayout(desired);
      else localStorage.setItem('vibe.workspace.layout', JSON.stringify(desired));
    } catch { /* A layout preference never blocks circuit work. */ }
  }

  function changeWidth(side, value) {
    const other = side === 'rail' ? 'review' : 'rail';
    const otherVisible = !ui.appShell.classList.contains(`${other}-hidden`);
    const max = Math.min(limits[side][1], ui.workbench.clientWidth - 440 - (otherVisible ? widths[other] : 0));
    desired[side] = clamp(Math.round(value), limits[side][0], max);
    edited = true;
    applyLayout();
  }

  function renderPanelToggles() {
    for(const [side, button, panel, name, shortcut] of [
      ['rail', ui.toggleCircuits, ui.circuitRail, '项目栏', 'Ctrl+B'],
      ['review', ui.toggleReview, ui.reviewPanel, '工作栏', 'Ctrl+Alt+B'],
    ]) {
      const open=innerWidth>820 ? !ui.appShell.classList.contains(`${side}-hidden`) : panel.classList.contains('is-open');
      button.setAttribute('aria-expanded',String(open));
      button.setAttribute('aria-label',`${open?'收起':'展开'}${name}`);
      button.title=`${open?'收起':'展开'}${name}（${shortcut}）`;
      const nameOfIcon=(side==='rail'?'PanelLeft':'PanelRight')+(open?'Close':'Open');
      if(button.dataset.icon!==nameOfIcon){button.replaceChildren(icon(nameOfIcon));button.dataset.icon=nameOfIcon;}
    }
  }

  function closeWorkspaceDrawers() {
    ui.circuitRail.classList.remove('is-open');ui.reviewPanel.classList.remove('is-open');renderPanelToggles();
  }

  function setWorkspacePanel(side, open) {
    const panel=side==='rail'?ui.circuitRail:ui.reviewPanel;
    if(innerWidth>820)ui.appShell.classList.toggle(`${side}-hidden`,!open);
    else {closeWorkspaceDrawers();ui.appShell.classList.remove(`${side}-hidden`);panel.classList.toggle('is-open',open);}
    applyLayout();
  }

  function togglePanel(side) {
    const button=side==='rail'?ui.toggleCircuits:ui.toggleReview;
    setWorkspacePanel(side,button.getAttribute('aria-expanded')!=='true');
  }

  function revealInspector() {
    if(desired.inspectorCollapsed){desired.inspectorCollapsed=false;edited=true;void saveLayout();}
    setWorkspacePanel('rail',true);
  }

  function mountLayout() {
    if (mounted) return;
    mounted = true;
    mountSplit();
    ui.toggleCircuits.addEventListener('click',()=>togglePanel('rail'));
    ui.toggleReview.addEventListener('click',()=>togglePanel('review'));
    ui.toggleCircuits.setAttribute('aria-keyshortcuts','Control+B Meta+B');
    ui.toggleReview.setAttribute('aria-keyshortcuts','Control+Alt+B Meta+Alt+B');
    document.addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.isComposing||event.repeat||event.shiftKey||!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='b')return;
      if(event.target.closest?.('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open],:popover-open'))return;
      event.preventDefault();togglePanel(event.altKey?'review':'rail');
    });
    window.addEventListener('resize',applyLayout);
    for (const [side, handle] of Object.entries(handles)) {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || window.innerWidth <= 820) return;
        event.preventDefault();
        drag = {side, pointerId: event.pointerId, start: event.clientX, width: widths[side]};
        handle.setPointerCapture(event.pointerId);
        ui.appShell.classList.add('resizing-panel');
      });
      handle.addEventListener('pointermove', event => {
        if (!drag || drag.side !== side || drag.pointerId !== event.pointerId) return;
        changeWidth(side, drag.width + (event.clientX - drag.start) * (side === 'rail' ? 1 : -1));
      });
      const finish = event => {
        if (!drag || drag.side !== side || drag.pointerId !== event.pointerId) return;
        drag = null;
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        ui.appShell.classList.remove('resizing-panel');
        void saveLayout();
      };
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
      handle.addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight','Home'].includes(event.key)) return;
        event.preventDefault();
        const delta = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'rail' ? 1 : -1) * (event.shiftKey ? 40 : 16);
        changeWidth(side, event.key === 'Home' ? defaults[side] : widths[side] + delta);
        void saveLayout();
      });
      handle.addEventListener('dblclick', () => { changeWidth(side, defaults[side]); void saveLayout(); });
    }
    const observer=new ResizeObserver(applyLayout);
    observer.observe(ui.workbench);observer.observe(ui.circuitRail);
    new MutationObserver(applyLayout).observe(ui.appShell, {attributes: true, attributeFilter: ['class']});
    const load = window.vibeDesktop?.getLayout
      ? window.vibeDesktop.getLayout()
      : Promise.resolve().then(() => JSON.parse(localStorage.getItem('vibe.workspace.layout') || 'null'));
    load.then(saved => {
      if (edited || !saved) return;
      for (const side of ['rail','review']) if (Number.isFinite(saved[side])) desired[side] = clamp(saved[side], ...limits[side]);
      if(Number.isFinite(saved.fileShare))desired.fileShare=clamp(saved.fileShare,.1,.8);
      desired.filesCollapsed=saved.filesCollapsed===true;
      if(Number.isFinite(saved.navigatorShare))desired.navigatorShare=clamp(saved.navigatorShare,.12,.85);
      desired.navigatorCollapsed=saved.navigatorCollapsed===true;
      desired.inspectorCollapsed=!desired.navigatorCollapsed&&saved.inspectorCollapsed===true;
      applyLayout();
    }).catch(() => {});
    applyLayout();
  }
  return Object.freeze({mountLayout, revealInspector, setWorkspacePanel, closeWorkspaceDrawers});
}
