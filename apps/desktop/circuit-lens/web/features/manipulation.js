import {makeSvg} from '../core/dom.js';
import {showMovePreview,clearMovePreview} from '../core/move-preview.js';

export const modelDependencies=['project','canvas'];
export const dependencies=['selectionSnapshot','selectComponent','selectWire','clientToWorld','performProjectAction','setCanvasStatus'];

export function createController({models,ui,client,ports}){
  const {project,canvas}=models;
  let pointer=null,timer=null,request=null,generation=0;
  const current=p=>p&&p.projectId===project.session?.workspace?.id&&p.revisionId===project.revision&&p.circuit===project.circuitName;
  function clearPreview(){
    clearMovePreview(ui);ui.interactionLayer.querySelector('.layout-preview')?.remove();
    ui.circuitCanvas.classList.remove('is-layout-dragging');
  }
  function stopRequests(abort=true){generation++;clearTimeout(timer);if(abort)request?.abort();}
  function resetManipulation(){
    const active=pointer;pointer=null;stopRequests();clearPreview();
    if(active?.node.hasPointerCapture(active.pointerId))active.node.releasePointerCapture(active.pointerId);
    if(active?.dragging)ports.setCanvasStatus('');
  }
  function drawPaths(segments,pending=false){
    ui.interactionLayer.querySelector('.layout-preview')?.remove();
    const group=makeSvg('g',{class:`layout-preview${pending?' is-pending':''}`,'pointer-events':'none'});
    group.append(makeSvg('path',{d:segments.map(w=>`M${w.from.x} ${w.from.y}L${w.to.x} ${w.to.y}`).join(' ')}));
    ui.interactionLayer.append(group);
  }
  function drawLocal(p){
    ui.nativeArtwork.style.opacity='0.4';ui.circuitCanvas.classList.add('is-layout-dragging');
    if(p.componentIds.length)showMovePreview(ui,project.circuit,p.componentIds,p.delta.x,p.delta.y);
    for(const id of p.componentIds){const n=ui.componentLayer.querySelector(`[data-object-id="${id}"]`);if(n)n.style.transform=`translate(${p.delta.x}px,${p.delta.y}px)`;}
    const translated=project.circuit.wires.filter(w=>p.wireIds.includes(w.wireId)).map(w=>Object.fromEntries(['from','to'].map(k=>[k,{x:w[k].x+p.delta.x,y:w[k].y+p.delta.y}])));
    drawPaths(translated,true);
  }
  function payload(p){return {projectId:p.projectId,revisionId:p.revisionId,circuit:p.circuit,componentIds:p.componentIds,wireIds:p.wireIds,delta:{...p.delta}};}
  async function preview(p){
    if(pointer!==p||!current(p)||request)return;
    const token=++generation,body=payload(p),abort=new AbortController();request=abort;
    try{
      const result=await client.request('/api/layout/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:abort.signal});
      if(pointer!==p||token!==generation||!current(p))return;
      const key=w=>[w.from,w.to].map(p=>`${p.x},${p.y}`).sort().join(':');
      const unchanged=new Set(project.circuit.wires.map(key));
      drawPaths(result.segments.filter(w=>!unchanged.has(key(w))));ports.setCanvasStatus('释放移动 · Esc 取消','loading');
    }catch(error){
      if(error.name!=='AbortError'&&pointer===p&&token===generation&&current(p))ports.setCanvasStatus(error.message,'error');
    }finally{
      if(request===abort)request=null;
      // Coalesce pointer updates while a plan is running. Aborting fetch would
      // not cancel backend routing and could otherwise pile up obsolete work.
      if(pointer?.dragging&&current(pointer)&&token!==generation)timer=setTimeout(()=>preview(pointer),100);
    }
  }
  function move(event){
    const p=pointer;if(!p||event.pointerId!==p.pointerId)return;
    if(!current(p)){resetManipulation();return;}
    const now=ports.clientToWorld(event.clientX,event.clientY),scale=ui.circuitCanvas.getScreenCTM().a;
    if(!p.dragging&&Math.hypot(now.x-p.start.x,now.y-p.start.y)*scale<3)return;
    const delta={x:Math.round((now.x-p.start.x)/10)*10,y:Math.round((now.y-p.start.y)/10)*10};
    if(p.axis)delta[p.axis]=0;
    if(p.dragging&&delta.x===p.delta.x&&delta.y===p.delta.y)return;
    p.dragging=true;p.delta=delta;stopRequests(false);drawLocal(p);
    ports.setCanvasStatus('正在调整连线… · Esc 取消','loading');timer=setTimeout(()=>preview(p),100);
  }
  async function finish(event){
    const p=pointer;if(!p||event.pointerId!==p.pointerId)return;
    move(event);if(pointer!==p)return;
    pointer=null;stopRequests();
    if(p.node.hasPointerCapture(event.pointerId))p.node.releasePointerCapture(event.pointerId);
    if(!current(p)||(!p.delta.x&&!p.delta.y)){clearPreview();return;}
    try{if(await ports.performProjectAction('move',payload(p),p.circuit))ports.setCanvasStatus('');}
    finally{clearPreview();}
  }
  function bindSelectionDrag(node,target){
    let pointerClick=false;
    function select(additive){if(target.componentId)ports.selectComponent(target.componentId,additive);else ports.selectWire(target.wireId,additive);}
    node.addEventListener('pointerdown',event=>{
      if(canvas.mode!=='select'||canvas.heldSpace||event.button!==0||canvas.wireStart||event.altKey||event.target.closest('.wire-port-hit'))return;
      event.preventDefault();event.stopPropagation();pointerClick=true;
      const selection=ports.selectionSnapshot(),isSelected=target.componentId?selection.componentIds.includes(target.componentId):selection.wireIds.includes(target.wireId);
      if(event.shiftKey||!isSelected)select(event.shiftKey);
      node.focus({preventScroll:true});
      if((event.shiftKey&&isSelected)||project.projectBusy||project.sourceChanged)return;
      resetManipulation();const chosen=ports.selectionSnapshot();
      const wire=target.wireId&&project.circuit.wires.find(w=>w.wireId===target.wireId);
      pointer={...chosen,node,pointerId:event.pointerId,start:ports.clientToWorld(event.clientX,event.clientY),delta:{x:0,y:0},dragging:false,
        axis:!chosen.componentIds.length&&chosen.wireIds.length===1&&wire?(wire.from.y===wire.to.y?'x':'y'):null};
      node.setPointerCapture(event.pointerId);
    });
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',finish);
    const cancel=event=>{if(pointer?.pointerId===event.pointerId)resetManipulation();};
    node.addEventListener('pointercancel',cancel);node.addEventListener('lostpointercapture',cancel);
    node.addEventListener('click',event=>{
      if(canvas.mode!=='select'||canvas.heldSpace||canvas.wireStart||event.altKey||event.target.closest('.wire-port-hit'))return;
      event.stopImmediatePropagation();if(!pointerClick)select(event.shiftKey);pointerClick=false;
    });
  }
  function mountManipulation(){
    document.addEventListener('keydown',event=>{
      if(event.key!=='Escape'||!pointer)return;
      event.preventDefault();event.stopImmediatePropagation();resetManipulation();ports.setCanvasStatus('已取消移动','idle');
    },true);
    window.addEventListener('blur',()=>{if(pointer)resetManipulation();});
  }
  return Object.freeze({bindSelectionDrag,resetManipulation,mountManipulation});
}
