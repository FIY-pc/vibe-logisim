import {makeElement} from '../core/dom.js';
import {momentPlace,momentRows,momentValue} from '../core/moment-values.js';

export const modelDependencies=['project'];
export const dependencies=['draftReferences','setDraftReferences','activeObservation','watchedSignals','selectionSnapshot','followCircuitReference','showToast','switchReviewTab','openReviewPanel'];

export function createController({models,ui,client,ports}) {
  const {project}=models;
  let readProjectId=null;
  let projectId=null,epoch=0,items=[],chosen=[],loaded=new Map();
  let captureQueue=Promise.resolve(),capturing=new Set();
  const attachment={
    get ids(){return ports.draftReferences('moments').map(m=>m.id);},
    set ids(ids){ports.setDraftReferences('moments',ids.map(id=>{
      const m=loaded.get(id)||items.find(m=>m.id===id)||ports.draftReferences('moments').find(m=>m.id===id);
      return {id,projectId:m?.projectId||projectId,title:m?.title||'留存观察',revisionId:m?.revisionId||project.revision};
    }));}
  };
  const current=()=>project.session?.workspace?.id;
  const post=body=>client.request('/api/moments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const get=id=>client.request('/api/moments?'+new URLSearchParams({projectId:id?(loaded.get(id)?.projectId||ports.draftReferences('moments').find(m=>m.id===id)?.projectId||readProjectId||projectId):projectId,...(id?{id}:{})}));
  function button(label,fn,className='quiet-button') {
    const b=makeElement('button',className,label);b.type='button';b.addEventListener('click',fn);return b;
  }
  function report(error){ports.showToast(error.message);}
  function updateMomentCapture() {
    ui.momentCapture.disabled=!ports.activeObservation();
    ui.momentCapture.setAttribute('aria-busy',String(capturing.size>0));
    ui.momentOpen.disabled=!items.length;
    ui.momentOpen.textContent=items.length?`留存观察 · ${items.length}`:'留存观察';
  }
  function renderAttachments() {
    ui.momentAttachments.replaceChildren();ui.momentAttachments.hidden=!attachment.ids.length;
    for(const id of attachment.ids) {
      const m=loaded.get(id)||items.find(m=>m.id===id)||ports.draftReferences('moments').find(m=>m.id===id);if(!m)continue;
      const chip=makeElement('span','moment-chip');
      const b=button(m.title+(m.revisionId!==project.revision?' · 此前版本':''),()=>openMoments([id]));b.title=`随问题发送 · ${m.instancePath?momentPlace(m):m.title}${m.revisionId!==project.revision?' · 此前版本':''}`;
      const remove=button('×',()=>{attachment.ids=attachment.ids.filter(v=>v!==id);renderAttachments();});remove.setAttribute('aria-label',`移除观察附件 ${m.title}`);
      chip.append(b,remove);ui.momentAttachments.append(chip);
    }
  }
  async function refresh() {
    const token=epoch;const result=await get();
    if(token!==epoch||projectId!==current())return;
    items=result;updateMomentCapture();renderAttachments();if(ui.momentDialog.open)renderList();
  }
  function momentsProjectChanged() {
    if(projectId===current()){renderAttachments();return;}
    projectId=current();readProjectId=null;epoch++;items=[];chosen=[];loaded.clear();capturing=new Set();captureQueue=Promise.resolve();
    ui.momentDialog.close();ui.momentViewer.replaceChildren();renderAttachments();updateMomentCapture();
    if(projectId)refresh().catch(report);
  }
  function captureMoment() {
    const sample=ports.activeObservation();if(!sample||capturing.has(sample.id))return Promise.resolve(false);
    const token=epoch,watched=ports.watchedSignals(),selection=ports.selectionSnapshot();
    const signals=watched.length?watched:sample.components.filter(c=>selection.componentIds.includes(c.componentId)).flatMap(c=>c.ports.map(p=>`${c.componentId}:${p.index}`)).slice(0,24);
    // Freeze the frame, observation and signal selection before any await/queue.
    const body={action:'capture',projectId,revisionId:sample.revisionId,observationId:sample.id,signals,render:structuredClone(sample.render)};
    capturing.add(sample.id);updateMomentCapture();
    ports.showToast('正在留存此刻…');
    const save=async()=>{
      if(token!==epoch)return false;
      try {
        const m=await post(body);
        if(token!==epoch)return false;
        loaded.set(m.id,m);chosen=[m.id];
        if(!attachment.ids.includes(m.id)&&attachment.ids.length<2)attachment.ids=[...attachment.ids,m.id];
        await refresh();
        if(token!==epoch)return false;
        ports.showToast(attachment.ids.includes(m.id)?'已留存此刻，并附到问题':'已留存此刻，可从观察列表选择要讨论的时刻');
        return true;
      }catch(error){if(token===epoch)report(error);return false;}
      finally{if(token===epoch){capturing.delete(sample.id);updateMomentCapture();}}
    };
    const pending=captureQueue.then(save,save);captureQueue=pending.catch(()=>false);return pending;
  }
  function renderList() {
    ui.momentList.replaceChildren();
    if(!items.length)ui.momentList.append(makeElement('p','moment-empty','运行电路时，可以留存想讨论的时刻。'));
    for(const m of items) {
      const row=makeElement('div','moment-list-row');row.dataset.id=m.id;
      const check=makeElement('input');check.type='checkbox';check.checked=chosen.includes(m.id);check.setAttribute('aria-label',`选择观察 ${m.title}`);
      check.addEventListener('change',()=>{
        if(check.checked&&chosen.length>=2){check.checked=false;ports.showToast('一次选择两个时刻比较');return;}
        chosen=check.checked?[...chosen,m.id]:chosen.filter(id=>id!==m.id);renderList();renderViewer().catch(report);
      });
      const name=button(m.title,()=>{chosen=[m.id];renderList();renderViewer().catch(report);},'moment-title');
      const subtitle=makeElement('small','',`${momentPlace(m)} · ${new Date(m.createdAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false})}`);
      const text=makeElement('div');text.append(name,subtitle);row.append(check,text);ui.momentList.append(row);
    }
    ui.momentAttach.disabled=!chosen.length;
  }
  async function read(id) {
    if(loaded.has(id))return loaded.get(id);
    const token=epoch,m=await get(id);if(token===epoch)loaded.set(id,m);return m;
  }
  async function locate(signal) {
    ui.momentDialog.close();await ports.followCircuitReference(signal.reference);
  }
  function table(moments) {
    const rows=momentRows(moments);if(!rows)return null;
    const t=makeElement('table','moment-signals'),head=makeElement('tr');
    head.append(makeElement('th','','信号'));
    for(const m of moments)head.append(makeElement('th','',`${m.title} · ${m.ticks} tick`));
    t.append(head);
    for(const row of rows) {
      const tr=makeElement('tr');tr.dataset.changed=String(row.changed);
      const name=makeElement('td'),link=button(`${row.signal.label}${row.signal.portIndex?' · '+row.signal.portIndex:''}`,()=>locate(row.signal),'moment-signal-link');
      link.disabled=moments[0].revisionId!==project.revision;link.title=link.disabled?'此前版本中的信号，原画面保留在上方':'定位当前工程中的这个信号';name.append(link);
      tr.append(name);
      for(const s of row.signals){const td=makeElement('td','',momentValue(s));td.title=s?`${s.bits} · ${s.width} bit`:'这一时刻没有留存这个信号';tr.append(td);}
      t.append(tr);
    }
    return t;
  }
  async function renderViewer() {
    const token=epoch,ids=[...chosen];ui.momentViewer.replaceChildren();ui.momentViewer.setAttribute('aria-busy','true');
    try {
      const moments=(await Promise.all(ids.map(read))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      if(token!==epoch||ids.join()!==chosen.join())return;
      ui.momentViewer.replaceChildren();
      if(!moments.length){ui.momentViewer.append(makeElement('p','moment-empty','选择一个时刻查看，或勾选两个时刻比较。'));return;}
      const pictures=makeElement('div','moment-pictures');
      for(const m of moments) {
        const card=makeElement('section','moment-picture');
        const title=makeElement('input','moment-name');title.value=m.title;title.maxLength=80;title.setAttribute('aria-label',`观察名称 ${m.ticks} tick`);
        title.addEventListener('keydown',e=>{if(e.key==='Enter')title.blur();});
        title.addEventListener('change',async()=>{
          try{const updated=await post({action:'rename',projectId:m.projectId,id:m.id,title:title.value});if(token!==epoch)return;
            Object.assign(m,updated);await refresh();}catch(error){title.value=m.title;report(error);}
        });
        card.append(title,makeElement('small','moment-place',momentPlace(m)),makeElement('small','moment-meta',`留存画面 · ${m.ticks} tick${m.pending?' · 传播尚未稳定':''}${m.oscillating?' · 振荡':''}${m.revisionId!==project.revision?' · 此前版本':''}`));
        const viewport=makeElement('div','moment-image'),img=makeElement('img');img.src=m.render.url;img.alt=`${m.title} 的留存画面`;img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',`放大留存画面 ${m.title}`);
        const zoom=()=>viewport.classList.toggle('is-expanded');img.addEventListener('click',zoom);img.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();zoom();}});
        viewport.append(img);card.append(viewport);
        card.append(button('从列表移除',async()=>{try{await post({action:'archive',projectId:m.projectId,id:m.id});if(token!==epoch)return;
          attachment.ids=attachment.ids.filter(id=>id!==m.id);chosen=chosen.filter(id=>id!==m.id);await refresh();await renderViewer();}catch(error){report(error);}}));
        pictures.append(card);
      }
      ui.momentViewer.append(pictures);
      const combined=table(moments);
      if(combined) {
        if(moments.length===2&&moments[0].sessionId!==moments[1].sessionId)ui.momentViewer.append(makeElement('p','moment-hint','这两个时刻来自两次运行，tick 分别从各自启动时计数。'));
        ui.momentViewer.append(combined);
      } else {
        ui.momentViewer.append(makeElement('p','moment-hint','两份观察来自不同版本或实例，分别显示信号。'));
        for(const m of moments)ui.momentViewer.append(makeElement('strong','',m.title),table([m]));
      }
    }finally{if(token===epoch)ui.momentViewer.removeAttribute('aria-busy');}
  }
  async function openMoments(ids=null,owner=null) {
    try {
      if(document.querySelector('dialog[open]')&&!ui.momentDialog.open)return;
      readProjectId=owner;
      if(ids)chosen=[...ids];
      ui.momentViewer.replaceChildren();
      if(!ui.momentDialog.open)ui.momentDialog.showModal();
      await refresh();renderList();await renderViewer();
    }catch(error){report(error);}
  }
  function momentAttachments(){return {projectId,ids:[...attachment.ids],refs:ports.draftReferences('moments').map(m=>({id:m.id,projectId:m.projectId||projectId}))};}
  function appendMomentReferences(node,context) {
    if(!context?.moments?.length)return;
    for(const m of context.moments)node.append(button(`查看观察 · ${m.title}`,()=>{
      if(context.projectId!==current()&&!project.folder?.documentIds?.includes(context.projectId)){ports.showToast('这份观察属于另一份工程');return;}
      openMoments([m.id],m.projectId||context.projectId);
    },'moment-message-link'));
  }
  function mountMoments() {
    ui.momentOpen.addEventListener('click',()=>openMoments());
    ui.momentClose.addEventListener('click',()=>ui.momentDialog.close());
    ui.momentAttach.addEventListener('click',()=>{
      attachment.ids=[...chosen].sort((a,b)=>(loaded.get(a)?.createdAt||'').localeCompare(loaded.get(b)?.createdAt||''));renderAttachments();ui.momentDialog.close();ports.switchReviewTab('agent');ports.openReviewPanel();ui.questionInput.focus();
    });
  }
  return Object.freeze({mountMoments,momentsProjectChanged,updateMomentCapture,captureMoment,momentAttachments,renderMomentAttachments:renderAttachments,appendMomentReferences});
}
