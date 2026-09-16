import {makeElement,makeSvg} from '../core/dom.js';
import {action} from '../core/chat-dom.js';
import {propertyLabels,optionLabels} from '../core/component-labels.js';

export const modelDependencies=['project','canvas'];
export const dependencies=['flushProjectEdits','setMode','revealInspector','renderInspector','clearSelection','performProjectAction','clientToWorld','setCanvasStatus','selectComponent','selectPaletteTool','appendOptimisticComponent','removeOptimisticComponent'];

export function createController({models,ui,client,ports}) {
  const {project,canvas}=models,node=id=>document.getElementById(id);
  let active=null,generation=0,placing=false,repeat=true,lastClient=null,ownsError=false;
  const queue=[],unpainted=[];
  let ghost=null,ghostTemplate=null;
  let optimisticSequence=0;
  const preferences=new Map();
  const same=state=>state&&state.projectId===project.session?.workspace?.id&&state.circuit===project.circuitName;
  const ready=()=>active?.template&&!active.loading&&!active.invalid&&same(active)&&!project.sourceChanged&&!project.projectBusy&&!placing;
  function cancelPlacement() {
    if(!active)return;
    active=null;generation++;node('placementLayer').replaceChildren();node('placementToolbar').hidden=true;
    ui.circuitCanvas.classList.remove('is-placing','placement-pending');ports.selectPaletteTool(null);
    if(canvas.mode==='place')ports.setMode('select');
    draw();
    if(ownsError){ports.setCanvasStatus('');ownsError=false;}
    ports.renderInspector();
  }
  async function startPlacement(tool) {
    if(!project.circuit||project.sourceChanged||project.projectBusy)return;
    cancelPlacement();ports.clearSelection({notifyServer:false});ports.setMode('place');
    canvas.wireStart=null;canvas.wirePoints=[];ui.interactionLayer.querySelector('.wire-preview')?.remove();
    const key=project.session.workspace.id+':'+tool.key;
    active={projectId:project.session.workspace.id,revision:project.revision,circuit:project.circuitName,tool,preferenceKey:key,
      values:{...tool.preset,...(preferences.get(key)||{})},template:null,loading:false,invalid:false,point:null,visible:false};
    const state=active;ui.circuitCanvas.classList.add('is-placing');ports.selectPaletteTool(tool.key);ports.revealInspector();renderToolbar();ports.renderInspector();
    try {await updateTemplate(state,state.values);if(active===state)ui.circuitCanvas.focus({preventScroll:true});}
    catch(error){if(active===state){state.error=error.message;ports.renderInspector();}}
  }
  async function updateTemplate(state,values) {
    const token=++generation;state.loading=true;draw();renderToolbar();
    try {
      const result=await client.request('/api/components/template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:state.projectId,revisionId:project.revision,circuit:state.circuit,library:state.tool.library,tool:state.tool.name,attributes:values})});
      if(active!==state||token!==generation||!same(state)||result.revisionId!==project.revision)return false;
      state.template=result;state.values={...values};state.invalid=false;state.error=null;state.loading=false;
      preferences.set(state.preferenceKey,{...values});ports.renderInspector();draw();renderToolbar();return true;
    } catch(error) {if(active===state&&token===generation){state.invalid=true;throw error;}return false;}
    finally {if(active===state&&token===generation){state.loading=false;draw();renderToolbar();}}
  }
  function placementContextChanged() {
    if(queue.length&&!same(queue[0].state)){queue.length=0;unpainted.length=0;}
    if(active&&(!same(active)||project.sourceChanged||(!placing&&active.revision!==project.revision)))cancelPlacement();
    if(active&&placing)active.revision=project.revision;
    draw();renderToolbar();
  }
  function errorAt(point) {
    const state=active,t=state?.template;if(!t||!point)return '';
    if(point.x+t.bounds.x<0||point.y+t.bounds.y<0)return '请把整个元件放在坐标原点的右下方';
    const duplicate=project.circuit.components.some(c=>c.factory===t.factory&&c.location.x===point.x&&c.location.y===point.y);
    if(duplicate||unpainted.some(item=>item.point.x===point.x&&item.point.y===point.y&&item.template.factory===t.factory))return '此位置已有相同元件';
    return '';
  }
  function draw() {
    const layer=node('placementLayer');
    // Keep decoded images and DOM nodes while the pointer moves. Only their
    // position changes; pending native commits never stop pointer feedback.
    ui.circuitCanvas.classList.toggle('placement-pending',!!active&&active.loading);
    // Accepted clicks already live in the circuit model and component layer.
    // The placement layer is reserved for the movable ghost and conflict hint.
    if(!active?.template||!same(active)||!active.visible||canvas.heldSpace||!active.point){ghost?.remove();return;}
    const {point,template}=active,bad=!!errorAt(point);
    if(template!==ghostTemplate||!ghost){
      ghost?.remove();ghostTemplate=template;
      const image=template.image;
      ghost=makeSvg('g',{'data-factory':template.factory});
      ghost.append(makeSvg('image',{href:image.url,x:image.x,y:image.y,width:image.width,height:image.height}));
      ghost.append(makeSvg('rect',{...template.bounds,class:'placement-conflict'}));
      for(const port of template.ports)ghost.append(makeSvg('circle',{cx:port.x,cy:port.y,r:2.5,class:'placement-port'}));
      ghost.append(makeSvg('path',{d:'M-4 0H4M0-4V4',class:'placement-anchor'}));
    }
    ghost.setAttribute('class','placement-ghost'+(bad?' is-invalid':''));
    ghost.querySelector('.placement-conflict').style.display=bad?'':'none';
    ghost.setAttribute('transform',`translate(${point.x} ${point.y})`);
    ghost.dataset.x=point.x;ghost.dataset.y=point.y;
    if(ghost.parentNode!==layer)layer.append(ghost);
  }
  function optimisticComponent(state,template,point) {
    const attributes=Object.fromEntries(template.attributes.map(attribute=>[attribute.name,attribute.value]));
    const attributeDetails=template.attributes.map(attribute=>({...attribute,standard:attribute.value}));
    return {
      componentId:`pending:${Date.now().toString(36)}:${(++optimisticSequence).toString(36)}`,
      factory:template.factory,
      factoryName:template.factory,
      label:attributes.label || null,
      location:{...point},
      bounds:{x:point.x+template.bounds.x,y:point.y+template.bounds.y,width:template.bounds.width,height:template.bounds.height},
      attributes,
      attributeDetails,
      previewImage:{...template.image},
      ends:template.ports.map((port,index)=>({...port,index,location:{x:point.x+port.x,y:point.y+port.y}})),
      optimistic:true,
    };
  }
  function move(event) {
    if(!active)return;lastClient={x:event.clientX,y:event.clientY};
    const p=ports.clientToWorld(event.clientX,event.clientY),point={x:Math.round(p.x/10)*10,y:Math.round(p.y/10)*10};
    if(ownsError&&(point.x!==active.point?.x||point.y!==active.point?.y)){ports.setCanvasStatus('');ownsError=false;}
    active.point=point;active.visible=true;draw();
  }
  function place(event) {
    if(!active?.template||active.loading||active.invalid||!same(active)||project.sourceChanged||(project.projectBusy&&!placing))return;
    move(event);const state=active,point={...state.point},error=errorAt(point);
    if(error){ports.setCanvasStatus(error,'error');ownsError=true;return;}
    if(queue.some(item=>item.point.x===point.x&&item.point.y===point.y&&item.template.factory===state.template.factory))return;
    const item={state,point,template:state.template,values:{...state.values}};
    item.optimisticComponent=optimisticComponent(state,item.template,point);
    queue.push(item);
    ports.appendOptimisticComponent(item.optimisticComponent);
    if(!repeat)cancelPlacement();
    draw();void drain();
  }
  async function drain() {
    if(placing)return;
    placing=true;renderToolbar();ports.renderInspector();draw();
    let failure='';
    try {
      while(queue.length) {
        const item=queue[0],{state,point,template}=item;
        if(!same(state)){queue.length=0;break;}
        let deferred=false;
        const ok=await ports.performProjectAction('place',{projectId:state.projectId,circuit:state.circuit,library:state.tool.library,tool:state.tool.name,attributes:item.values,...point},state.circuit,{allowDeferred:true,deferDisplay:()=>deferred=queue.length>1});
        if(queue[0]===item)queue.shift();
        if(!same(state)){queue.length=0;break;}
        if(active)active.revision=project.revision;
        if(!ok){
          failure=ui.canvasStatus.textContent+(queue.length?'；后续 '+queue.length+' 个未放置':'');
          ports.removeOptimisticComponent(item.optimisticComponent.componentId);
          for(const pending of queue)ports.removeOptimisticComponent(pending.optimisticComponent?.componentId);
          queue.length=0;ownsError=true;break;
        }
        if(deferred){unpainted.push(item);draw();continue;}
        unpainted.length=0;
        const placed=project.circuit.components.find(c=>c.factory===template.factory&&c.location.x===point.x&&c.location.y===point.y);
        if(placed)ports.selectComponent(placed.componentId,false,false);
        draw();renderToolbar();
      }
    } finally {
      await ports.flushProjectEdits();unpainted.length=0;
      placing=false;ports.renderInspector();draw();renderToolbar();
      if(failure)ports.setCanvasStatus(failure,'error');
    }
  }
  async function rotate() {
    if(!ready())return;
    const state=active,name=state.template.facingAttribute;
    if(!name)return;
    const directions=['east','south','west','north'],value=state.template.attributes.find(a=>a.name===name)?.value;
    try {await updateTemplate(state,{...state.values,[name]:directions[(directions.indexOf(value)+1)%4]});}
    catch(error){ports.setCanvasStatus(error.message,'error');ownsError=true;}
  }
  function renderToolbar() {
    const bar=node('placementToolbar');bar.hidden=!active;if(!active){bar.replaceChildren();return;}
    bar.replaceChildren(makeElement('strong','',active.tool.label));
    if(active.loading||placing)bar.append(makeElement('span','placement-loading',placing?(queue.length>1?'待放置 '+queue.length+' 个':'放置中…'):'读取中…'));
    const rotation=action('旋转 90°（R）',null,rotate,'placement-rotate');rotation.textContent='↻';rotation.disabled=!ready()||!active.template?.facingAttribute;bar.append(rotation);
    const label=makeElement('label','placement-repeat'),check=makeElement('input');check.type='checkbox';check.checked=repeat;check.addEventListener('change',()=>repeat=check.checked);label.append(check,document.createTextNode('连续放置'));bar.append(label);
    const done=makeElement('button','placement-done','完成');done.title='结束放置（Esc / 右键）';done.append(makeElement('kbd','','Esc'));done.addEventListener('click',()=>{cancelPlacement();ui.circuitCanvas.focus();});bar.append(done);
  }
  function renderPlacementInspector() {
    if(!active)return false;
    const state=active,container=ui.objectInspector;
    const focused=container.contains(document.activeElement)?document.activeElement?.dataset.attribute:null;
    container.replaceChildren(makeElement('h2','',state.tool.label),makeElement('p','placement-inspector-caption','新元件属性'));
    if(!state.template) {
      container.append(makeElement('p','',state.error||'正在读取默认属性…'));
      if(state.error){const retry=makeElement('button','quiet-button','重新读取');retry.addEventListener('click',()=>startPlacement(state.tool));container.append(retry);}return true;
    }
    const appearance=makeElement('details','appearance-properties');appearance.append(makeElement('summary','','外观'));
    for(const attr of state.template.attributes.filter(a=>a.editable)) {
      const form=makeElement('form','property-editor'),label=makeElement('label','',propertyLabels[attr.name]||attr.label),input=makeElement(attr.options.length?'select':'input');
      input.disabled=placing||state.loading;input.dataset.attribute=attr.name;input.setAttribute('aria-label',propertyLabels[attr.name]||attr.label);input.autocomplete='off';input.spellcheck=false;
      for(const value of attr.options){const option=makeElement('option','',optionLabels[value.label]||value.label);option.value=value.value;input.append(option);}
      input.value=attr.value;const error=makeElement('span','property-error');error.setAttribute('role','status');label.append(input);form.append(label,error);
      const submit=async event=>{
        event.preventDefault();if(active!==state||input.value===attr.value)return;
        input.disabled=true;error.textContent='';
        try {await updateTemplate(state,{...state.values,[attr.name]:input.value});}
        catch(e){error.textContent=e.message;input.setAttribute('aria-invalid','true');}
        finally {input.disabled=false;}
      };
      form.addEventListener('submit',submit);if(attr.options.length)input.addEventListener('change',submit);
      input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();input.value=attr.value;error.textContent='';input.removeAttribute('aria-invalid');state.invalid=false;input.blur();renderToolbar();}});
      (/^(labelfont|labelcolor|labelloc|color|font|labelvisible|appearance)$/.test(attr.name)?appearance:container).append(form);
    }
    if(appearance.childElementCount>1)container.append(appearance);
    if(focused)container.querySelector(`[data-attribute="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
    return true;
  }
  function placementViewportChanged() {
    if(active&&lastClient&&active.visible)move({clientX:lastClient.x,clientY:lastClient.y});
  }
  function mountPlacement() {
    ui.circuitCanvas.addEventListener('pointermove',move);
    ui.circuitCanvas.addEventListener('pointerleave',()=>{if(active){active.visible=false;draw();}});
    ui.circuitCanvas.addEventListener('pointerdown',event=>{
      if(!active||canvas.heldSpace||event.button===1)return;
      event.preventDefault();event.stopImmediatePropagation();ui.circuitCanvas.focus({preventScroll:true});
      if(event.button===0)void place(event);
    },true);
    ui.circuitCanvas.addEventListener('click',event=>{if(active&&!canvas.heldSpace){event.preventDefault();event.stopImmediatePropagation();}},true);
    ui.circuitCanvas.addEventListener('contextmenu',event=>{if(active){event.preventDefault();event.stopPropagation();cancelPlacement();}});
    document.addEventListener('keydown',event=>{
      if(!active||event.isComposing||event.target.closest('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open],:popover-open'))return;
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();cancelPlacement();}
      else if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&event.key.toLowerCase()==='r'){event.preventDefault();event.stopImmediatePropagation();void rotate();}
      else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){
        if(placing){event.preventDefault();event.stopImmediatePropagation();ports.setCanvasStatus('正在放置，完成后可以撤销','loading');ownsError=true;}else cancelPlacement();
      }
    },true);
  }
  return {placementViewportChanged,mountPlacement,startPlacement,cancelPlacement,placementContextChanged,renderPlacementInspector};
}
