import {changeTitle} from '../core/change-title.js';
import {makeElement,makeSvg} from '../core/dom.js';
import {categories,fields,factoryName,endpointText,rowTitle,rowObjects,objectBounds} from '../core/change-presentation.js';

export const modelDependencies=['project'];
export const dependencies=['performProjectAction','loadCircuit','selectComponent','selectWire','clearSelection','fitCircuit','focusComponents','showToast','showCandidateEvidence'];

export function createController({models,ui,client,ports}) {
  const {project}=models;
  let binding=null, summary=null, detail=null, selected=null, category='all', side='after', epoch=0, imageEpoch=0;
  let scale=1, bounds=null, busy=false, timer, imageAbort, detailUrl;
  const current=()=>binding && project.session?.workspace?.id===binding.projectId && project.revision===binding.revisionId;
  const query=extra=>new URLSearchParams({...binding,...extra});
  const row=()=>detail?.diff.rows.find(r=>r.id===selected);

  function clearComparisonError(){ui.comparisonError.hidden=true;}
  function comparisonActionError(message){
    if(!ui.comparisonDialog.open)return false;
    ui.comparisonError.textContent=message;ui.comparisonError.hidden=false;return true;
  }
  function closeComparison(){
    if(busy)return;
    epoch++;imageEpoch++;clearTimeout(timer);imageAbort?.abort();
    if(detailUrl)URL.revokeObjectURL(detailUrl);detailUrl=null;
    ui.comparisonDialog.close();
  }
  function invalidateComparison(){
    if(!ui.comparisonDialog.open)return;
    epoch++;imageEpoch++;imageAbort?.abort();
    ui.comparisonPrimary.disabled=ui.comparisonLocate.disabled=true;
    comparisonActionError('工程已更新，请重新打开这份对照。');
  }
  function resetComparison(){busy=false;closeComparison();binding=summary=detail=null;}
  async function openComparison(kind,id,mode='change'){
    binding={kind,id,mode,projectId:project.session.workspace.id,revisionId:project.revision};
    const token=++epoch;
    summary=detail=null;selected=null;category='all';side='after';
    clearComparisonError();ui.comparisonTitle.textContent='读取改动…';
    ui.comparisonScope.textContent='';ui.comparisonMode.hidden=true;
    ui.comparisonEvidence.hidden=ui.comparisonDownload.hidden=ui.comparisonNative.hidden=true;
    ui.comparisonModule.replaceChildren();ui.comparisonRows.replaceChildren();ui.comparisonDetails.replaceChildren();
    ui.comparisonFilters.replaceChildren();ui.comparisonSummary.textContent='';ui.comparisonScope.textContent='';
    ui.comparisonPrimary.disabled=ui.comparisonLocate.disabled=true;
    ui.comparisonSheet.hidden=true;ui.comparisonImageStatus.textContent='正在读取版本…';
    ui.comparisonSearch.value='';ui.comparisonDialog.showModal();
    try{
      const next=await client.request(`/api/comparison?${query()}`);
      if(token!==epoch||!current()||!ui.comparisonDialog.open)return;
      summary=next;
      ui.comparisonTitle.textContent=kind==='history'?changeTitle(project.session.workspace.history.find(entry=>entry.id===id)||summary):summary.title;
      ui.comparisonKind.textContent=kind==='candidate'?'候选与原版本':'工程历史';
      ui.comparisonMode.hidden=kind!=='history'||!summary.canCompareChange;ui.comparisonMode.value=mode;
      ui.comparisonBefore.textContent=summary.beforeLabel;ui.comparisonAfter.textContent=summary.afterLabel;
      ui.comparisonPrimary.textContent=kind==='candidate'?'应用改动':'恢复此版本';
      ui.comparisonPrimary.hidden=kind==='candidate'&&!summary.canApply;
      ui.comparisonPrimary.disabled=!(summary.canApply||summary.canRestore);
      ui.comparisonEvidence.hidden=!summary.candidateId;ui.comparisonDownload.hidden=kind!=='candidate';
      ui.comparisonNative.hidden=kind!=='candidate'||!summary.canApply||!window.vibeDesktop?.openCandidate;
      if(kind==='candidate')ui.comparisonDownload.href=`/api/candidate/download?id=${encodeURIComponent(id)}`;
      const circuits=summary.circuits.filter(c=>c.different);
      for(const c of circuits){const option=makeElement('option','',`${c.name}${c.status==='added'?' · 新增':c.status==='removed'?' · 删除':''}`);option.value=c.name;ui.comparisonModule.append(option);}
      if(!circuits.length){ui.comparisonImageStatus.textContent=summary.settingsChanged?'工程设置发生变化，没有电路定义改动':'电路内容相同';return;}
      ui.comparisonModule.value=circuits.find(c=>c.name===project.circuitName)?.name||circuits[0].name;
      await loadDefinition();
    }catch(error){if(token===epoch&&current())comparisonActionError(error.message);}
  }

  async function loadDefinition(){
    const token=++epoch;imageEpoch++;imageAbort?.abort();detail=null;selected=null;category='all';
    ui.comparisonRows.replaceChildren();ui.comparisonDetails.replaceChildren();ui.comparisonFilters.replaceChildren();
    ui.comparisonLocate.disabled=true;ui.comparisonSheet.hidden=true;ui.comparisonSummary.textContent='';
    ui.comparisonImageStatus.textContent='正在读取这两个版本的原生电路…';
    try{
      const next=await client.request(`/api/comparison?${query({circuit:ui.comparisonModule.value})}`);
      if(token!==epoch||!current()||!ui.comparisonDialog.open)return;
      detail=next;
      const state=detail.diff.connectivity.status;
      ui.comparisonSummary.textContent={unchanged:'已对应端口的连接关系未变',changed:'信号连接发生变化',partial:'部分端口连接未知',unavailable:'连接对照暂不可用'}[state];
      ui.comparisonSummary.dataset.state=state;
      const parents=detail.parents.after.length?detail.parents.after:detail.parents.before;
      ui.comparisonScope.textContent=parents.length?`引用此定义：${parents.map(p=>`${p.circuit}${p.count>1?`（${p.count} 处）`:''}`).join('、')}`:'独立电路定义';
      ui.comparisonScope.title='直接引用该共享定义的上层电路';
      if(detail.errors.length)comparisonActionError(detail.errors.join('；'));
      renderFilters();renderRows();renderDetails();await showSide(true);
    }catch(error){if(token===epoch&&current())comparisonActionError(error.message);}
  }
  function renderFilters(){
    ui.comparisonFilters.replaceChildren();
    for(const [key,label] of Object.entries({all:'全部',...categories})){
      const count=key==='all'?detail.diff.rows.length:detail.diff.counts[key]||0;
      if(!count&&key!=='all')continue;
      const button=makeElement('button','comparison-filter',`${label} ${count}`);button.type='button';
      button.dataset.category=key;button.setAttribute('aria-pressed',String(category===key));
      button.addEventListener('click',()=>{category=key;renderFilters();renderRows();});ui.comparisonFilters.append(button);
    }
  }
  function renderRows(){
    ui.comparisonRows.replaceChildren();
    const search=ui.comparisonSearch.value.trim().toLowerCase();
    const rows=(detail?.diff.rows||[]).filter(r=>(category==='all'||r.category===category)&&
      `${rowTitle(r)} ${r.fields||[]} ${r.before?.connections?.flat().map(endpointText)||''} ${r.after?.connections?.flat().map(endpointText)||''}`.toLowerCase().includes(search));
    let previous;
    for(const r of rows){
      if(previous!==r.category){ui.comparisonRows.append(makeElement('h3','comparison-group',categories[r.category]));previous=r.category;}
      const button=makeElement('button','comparison-row');button.type='button';button.dataset.rowId=r.id;
      button.setAttribute('aria-pressed',String(selected===r.id));
      button.append(makeElement('span','comparison-mark',({added:'＋',removed:'−',modified:'↔'})[r.change]),makeElement('strong','',rowTitle(r)));
      button.append(makeElement('small','',(r.fields||[]).map(f=>fields[f]||f).join('、') || (r.kind==='routing'?`${r.segmentsBefore} 段旧路径 → ${r.segmentsAfter} 段新路径`:({added:'新增',removed:'移除',modified:'修改'})[r.change])));
      button.addEventListener('click',()=>selectRow(r.id));ui.comparisonRows.append(button);
    }
    if(!rows.length)ui.comparisonRows.append(makeElement('p','comparison-empty','没有匹配的改动'));
  }
  function renderDetails(){
    const r=row();ui.comparisonDetails.replaceChildren();
    if(!r){ui.comparisonDetails.append(makeElement('p','','选择一项改动，查看前后内容'));return;}
    ui.comparisonDetails.append(makeElement('h3','',rowTitle(r)));
    const table=makeElement('table','comparison-values');
    const head=makeElement('tr');for(const label of ['内容',summary.beforeLabel,summary.afterLabel])head.append(makeElement('th','',label));
    table.append(head);
    function line(label,a,b){const tr=makeElement('tr');tr.append(makeElement('th','',label),makeElement('td','',String(a??'默认')),makeElement('td','',String(b??'默认')));table.append(tr);}
    if(r.kind==='connection'){
      const describe=s=>r[s].connections.map(group=>group.map(endpointText).join(' ↔ ')).join('\n\n')||'没有对应端口';
      line('端口关系',describe('before'),describe('after'));
    }else if(r.kind==='routing')line('物理线段',`${r.segmentsBefore} 段移除`,`${r.segmentsAfter} 段加入`);
    else {
      const a=r.before.components[0],b=r.after.components[0];
      if(r.kind==='component')line('元件',a?`${a.label||a.factory} · ${factoryName(a)}`:'不存在',b?`${b.label||b.factory} · ${factoryName(b)}`:'不存在');
      for(const field of r.fields||[]){
        const location=c=>c?`(${c.location.x}, ${c.location.y})`:'不存在';
        line(fields[field]||field,field==='位置'?location(a):r.before.attributes[field],field==='位置'?location(b):r.after.attributes[field]);
      }
      for(const d of r.details||[])line(d.name,d.before,d.after);
      if(r.kind==='definition'&&!r.fields?.length&&!r.details?.length)line('定义','原封装 / 引脚映射','已更新封装 / 引脚映射');
    }
    ui.comparisonDetails.append(table);
  }
  function selectRow(id){selected=id;renderRows();renderDetails();drawMarks();focusRow();updateLocate();}
  function updateLocate(){
    const available=current()&&detail&&row()&&['before','after'].some(s=>detail.sides[s].current&&objectBounds(rowObjects(row(),s)));
    ui.comparisonLocate.disabled=!available;ui.comparisonLocate.textContent='在当前工程中定位';
    ui.comparisonLocate.title=available?'关闭对照，选中这处改动对应的当前对象':'这项改动在当前工程中没有可定位对象';
  }

  async function showSide(fit=false){
    if(!detail)return;
    const boxes=Object.values(detail.render).map(r=>r.bounds);
    if(!boxes.length){ui.comparisonImageStatus.textContent='原生图暂不可用，仍可查看结构差异';return;}
    const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
    bounds={x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};
    const scroll={x:ui.comparisonStage.scrollLeft,y:ui.comparisonStage.scrollTop};
    ui.comparisonBefore.setAttribute('aria-pressed',String(side==='before'));ui.comparisonAfter.setAttribute('aria-pressed',String(side==='after'));
    const render=detail.render[side], token=++imageEpoch;
    imageAbort?.abort();ui.comparisonDetailImage.removeAttribute('href');
    ui.comparisonImage.hidden=true;ui.comparisonSheet.hidden=false;
    ui.comparisonImageStatus.textContent=render?'正在加载原生图…':`${side==='before'?summary.beforeLabel:summary.afterLabel}没有此定义`;
    if(fit)fitImage();else setScale(scale);
    ui.comparisonStage.scrollLeft=scroll.x;ui.comparisonStage.scrollTop=scroll.y;
    drawMarks();updateLocate();
    if(!render)return;
    try{
      const decoded=new Image();decoded.src=render.url;await decoded.decode();
      if(token!==imageEpoch||!current()||!ui.comparisonDialog.open)return;
      ui.comparisonImage.src=render.url;ui.comparisonImage.hidden=false;ui.comparisonImageStatus.textContent='';
      scheduleDetail();
    }catch(error){if(token===imageEpoch)ui.comparisonImageStatus.textContent='图像未加载，可点击“重载画面”重试';}
  }
  function setScale(value){
    if(!bounds)return;
    scale=Math.max(.025,Math.min(8,value));ui.comparisonZoom.textContent=`${Math.round(scale*100)}%`;
    ui.comparisonSheet.style.width=`${bounds.width*scale}px`;ui.comparisonSheet.style.height=`${bounds.height*scale}px`;
    ui.comparisonOverlay.setAttribute('viewBox',`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    const b=detail.render[side]?.bounds;
    if(b)Object.assign(ui.comparisonImage.style,{left:`${(b.x-bounds.x)*scale}px`,top:`${(b.y-bounds.y)*scale}px`,width:`${b.width*scale}px`,height:`${b.height*scale}px`});
    scheduleDetail();
  }
  function fitImage(){if(bounds)setScale(Math.min((ui.comparisonStage.clientWidth-48)/bounds.width,(ui.comparisonStage.clientHeight-48)/bounds.height));}
  function focusRow(){
    const b=objectBounds(rowObjects(row(),side))||objectBounds(rowObjects(row(),side==='before'?'after':'before'));
    if(!b||!bounds)return;
    setScale(Math.min(2.5,(ui.comparisonStage.clientWidth-100)/Math.max(250,b.width),(ui.comparisonStage.clientHeight-100)/Math.max(170,b.height)));
    ui.comparisonStage.scrollLeft=(b.x+b.width/2-bounds.x)*scale-ui.comparisonStage.clientWidth/2+24;
    ui.comparisonStage.scrollTop=(b.y+b.height/2-bounds.y)*scale-ui.comparisonStage.clientHeight/2+24;
  }
  function drawMarks(){
    ui.comparisonMarks.replaceChildren();
    for(const r of detail?.diff.rows||[]){
      if(selected!==null&&r.id!==selected)continue;
      const objects=rowObjects(r,side);
      for(const c of objects.components){
        const b=c.bounds;if(!b)continue;
        const rect=makeSvg('rect',{x:b.x-3,y:b.y-3,width:b.width+6,height:b.height+6,rx:3,tabindex:0,role:'button','aria-label':rowTitle(r)});
        rect.dataset.change=r.change;rect.addEventListener('click',()=>selectRow(r.id));rect.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();selectRow(r.id);}});ui.comparisonMarks.append(rect);
      }
      for(const w of objects.wires){const line=makeSvg('path',{d:`M${w.from.x} ${w.from.y}L${w.to.x} ${w.to.y}`});line.dataset.change=side==='before'?'removed':'added';ui.comparisonMarks.append(line);}
      for(const end of objects.connections?.flat()||[]){
        const dot=makeSvg('circle',{cx:end.location.x,cy:end.location.y,r:5});ui.comparisonMarks.append(dot);
      }
    }
  }
  function scheduleDetail(){clearTimeout(timer);timer=setTimeout(loadDetailImage,130);}
  async function loadDetailImage(){
    const render=detail?.render[side];
    if(!render||!current()||!ui.comparisonDialog.open||scale*(window.devicePixelRatio||1)<=render.scale)return;
    imageAbort?.abort();const controller=new AbortController();imageAbort=controller;
    const generation=imageEpoch, requestSide=side, stage=ui.comparisonStage;
    const region={x:Math.floor(bounds.x+Math.max(0,stage.scrollLeft-24)/scale),y:Math.floor(bounds.y+Math.max(0,stage.scrollTop-24)/scale),
      width:Math.ceil(stage.clientWidth/scale),height:Math.ceil(stage.clientHeight/scale)};
    const resolution=Math.min(scale*(window.devicePixelRatio||1),4095/region.width,4095/region.height,Math.sqrt(7900000/(region.width*region.height)),32);
    try{
      const response=await fetch(`${render.url}&${new URLSearchParams({...region,scale:resolution})}`,{signal:controller.signal});
      if(!response.ok)throw Error('局部图像未加载');
      const blob=await response.blob();const url=URL.createObjectURL(blob);const decoded=new Image();decoded.src=url;
      try{await decoded.decode();if(controller.signal.aborted||generation!==imageEpoch||requestSide!==side||!current()||!ui.comparisonDialog.open)return;
        if(detailUrl)URL.revokeObjectURL(detailUrl);detailUrl=url;ui.comparisonImageStatus.textContent='';
        for(const [key,value] of Object.entries({href:url,x:region.x,y:region.y,width:decoded.naturalWidth/resolution,height:decoded.naturalHeight/resolution}))ui.comparisonDetailImage.setAttribute(key,value);
      }finally{if(detailUrl!==url)URL.revokeObjectURL(url);}
    }catch(error){if(error.name!=='AbortError'&&generation===imageEpoch)ui.comparisonImageStatus.textContent='局部细节未加载，可重载画面';}
  }

  async function locate(objects, expected){
    if(project.session.workspace.id!==expected.projectId||project.session.revision?.artifactSha256!==expected.artifactSha256){ports.showToast('工程已改变，请重新选择改动');return;}
    // Keep the review visible until the destination is ready. Reloading the
    // already current definition could replace a user's next selection late.
    ui.comparisonLocate.disabled=true;
    if(project.circuitName!==expected.circuit)await ports.loadCircuit(expected.circuit);
    if(project.session.workspace.id!==expected.projectId||project.session.revision?.artifactSha256!==expected.artifactSha256)return;
    ports.clearSelection({notifyServer:false});const ids=[];
    for(const c of objects.components){const found=project.circuit.components.filter(n=>n.factory===c.factory&&n.location.x===c.location.x&&n.location.y===c.location.y);if(found.length===1)ids.push(found[0].componentId);}
    ids.forEach((id,i)=>ports.selectComponent(id,i>0,false));
    const key=w=>[w.from,w.to].map(p=>`${p.x},${p.y}`).sort().join(':');
    for(const w of objects.wires){const found=project.circuit.wires.find(n=>key(n)===key(w));if(found)ports.selectWire(found.wireId,true);}
    const b=objectBounds(objects);if(ids.length)ports.focusComponents(ids);else if(b)ports.fitCircuit(b);
    closeComparison();
  }
  function locateCurrent(){
    if(!current()||!row())return;
    const target=['before','after'].find(s=>detail.sides[s].current&&objectBounds(rowObjects(row(),s)));
    if(target)locate(rowObjects(row(),target),{projectId:binding.projectId,circuit:detail.circuit,...detail.sides[target]});
  }
  async function perform(){
    if(busy||!current()||!summary)return;
    const chosen=row(), target=summary.kind==='candidate'?'after':summary.restoreSide;
    const destination=detail&&{projectId:binding.projectId,circuit:detail.circuit,...detail.sides[target]};
    busy=true;ui.comparisonPrimary.disabled=ui.comparisonClose.disabled=true;
    try{
      const action=summary.kind==='candidate'?'apply':'restore';
      const args=summary.kind==='candidate'?{candidateId:binding.id}:{changeId:binding.id};
      const ok=await ports.performProjectAction(action,args,detail?.circuit||project.circuitName);
      busy=false;
      if(ok){closeComparison();if(chosen&&destination)await locate(rowObjects(chosen,target),destination);}
    }finally{busy=false;ui.comparisonClose.disabled=false;ui.comparisonPrimary.disabled=!current();}
  }
  function mountComparison(){
    ui.comparisonClose.addEventListener('click',closeComparison);
    ui.comparisonDialog.addEventListener('cancel',e=>{e.preventDefault();if(!busy)closeComparison();});
    ui.comparisonModule.addEventListener('change',loadDefinition);ui.comparisonSearch.addEventListener('input',renderRows);
    ui.comparisonBefore.addEventListener('click',()=>{side='before';showSide();});ui.comparisonAfter.addEventListener('click',()=>{side='after';showSide();});
    ui.comparisonFit.addEventListener('click',fitImage);ui.comparisonZoomIn.addEventListener('click',()=>setScale(scale*1.4));ui.comparisonZoomOut.addEventListener('click',()=>setScale(scale/1.4));
    ui.comparisonStage.addEventListener('scroll',scheduleDetail);new ResizeObserver(scheduleDetail).observe(ui.comparisonStage);
    ui.comparisonReload.addEventListener('click',()=>!summary?openComparison(binding.kind,binding.id,binding.mode):detail?showSide():loadDefinition());
    ui.comparisonMode.addEventListener('change',()=>openComparison(binding.kind,binding.id,ui.comparisonMode.value));
    ui.comparisonLocate.addEventListener('click',locateCurrent);ui.comparisonPrimary.addEventListener('click',perform);
    ui.comparisonEvidence.addEventListener('click',()=>{const id=summary?.candidateId;if(!id)return;const returnTo={...binding};closeComparison();ports.showCandidateEvidence({id,returnTo});});
    ui.comparisonNative.addEventListener('click',async()=>{
      if(!current()||!summary?.canApply)return;
      const token=epoch;ui.comparisonNative.disabled=true;
      try{await window.vibeDesktop.openCandidate({candidateId:binding.id,revisionId:binding.revisionId,projectId:binding.projectId});}
      catch(error){if(token===epoch)comparisonActionError(error.message);}
      finally{ui.comparisonNative.disabled=false;}
    });
  }
  return Object.freeze({openComparison,closeComparison,resetComparison,clearComparisonError,comparisonActionError,invalidateComparison,mountComparison});
}
