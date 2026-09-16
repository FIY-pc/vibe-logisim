import {makeElement,makeSvg} from '../core/dom.js';
import {movePort,removePort,translateShape,resizeRect} from '../core/interface-geometry.js';

export const modelDependencies=['project'];
export const dependencies=['performProjectAction','showToast'];

export function createController({models,ui,client,ports}){
  const {project}=models;
  let ref=null,base=null,draft=null,selected=null,undo=[],preview=null,epoch=0,busy=false,applying=false,pointer=null;
  const active=()=>ref&&ref.projectId===project.session?.workspace?.id&&ref.revisionId===project.revision;
  const dirty=()=>draft&&JSON.stringify(draft)!==JSON.stringify(base);
  const svg=ui.interfaceCanvas,art=ui.interfaceArtwork;
  const error=message=>{ui.interfaceError.textContent=message||'';ui.interfaceError.hidden=!message;};
  function state(){
    const changed=dirty();ui.interfaceUndo.disabled=busy||!undo.length;
    ui.interfaceApply.disabled=busy||!changed||!active();ui.interfacePreview.disabled=busy||!changed||!active();
    ui.interfaceClose.disabled=applying;
    ui.interfaceDraftStatus.textContent=busy?'正在读取并调整真实电路…':changed?'草稿尚未应用':'尚未修改';
    ui.interfaceDialog.classList.toggle('is-busy',busy);
    for(const input of ui.interfaceDialog.querySelectorAll('.interface-workspace input,.interface-workspace select,.interface-workspace button'))input.disabled=busy;
    ui.interfaceUndo.disabled=busy||!undo.length;
  }
  function invalidate(){epoch++;preview=null;ui.interfaceImpact.replaceChildren();error('');state();}
  function edit(change,{rebuild=false}={}){
    if(busy||!draft)return;undo.push(structuredClone(draft));if(undo.length>60)undo.shift();change(draft);invalidate();draw();
    if(rebuild)renderPorts();else syncPorts();properties();
  }
  function choose(kind,id){selected={kind,id};draw();properties();syncPorts();}
  function field(label,value,change,options){
    const wrap=makeElement('label','',label),input=makeElement(options?'select':'input');
    input.setAttribute('aria-label',label);
    if(options)for(const [value,text] of options){const opt=makeElement('option','',text);opt.value=value;input.append(opt);}
    input.value=value??'';
    input.addEventListener('change',()=>change(input.value));
    input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();input.blur();}});
    wrap.append(input);return wrap;
  }
  function properties(){
    ui.interfaceProperties.replaceChildren();if(!selected||!draft)return;
    const item=(selected.kind==='port'?draft.ports:draft.shapes).find(p=>p.id===selected.id);if(!item)return;
    const row=makeElement('div','interface-property-fields');
    if(selected.kind==='port'){
      ui.interfaceProperties.append(makeElement('h3','',item.label||'未命名端口'));
      for(const k of ['x','y'])row.append(field(k.toUpperCase(),item[k],value=>edit(d=>movePort(d,item.id,{[k]:Number(value)}))));
      row.append(field('内外接线',item.disconnect?'detach':'keep',value=>edit(d=>movePort(d,item.id,{disconnect:value==='detach'})),[['keep','保持接线'],['detach','断开接线']]));
      if(item.id.startsWith('new-'))for(const [key,label] of [['internalX','内部 X'],['internalY','内部 Y']])row.append(field(label,item[key],v=>edit(d=>movePort(d,item.id,{[key]:Number(v)}))));
      ui.interfaceProperties.append(row,makeElement('p','','断开会移除内部及各父图中连到此端口的支线。新增端口需继续连接内部电路。'));
    }else{
      ui.interfaceProperties.append(makeElement('h3','',item.tag==='text'?'文字':'图形'));
      if(!item.editable){ui.interfaceProperties.append(makeElement('p','','此图形保留原样；可以继续编辑端口或添加图形。'));return;}
      for(const [key,label] of [['x','X'],['y','Y'],['width','宽度'],['height','高度'],['x1','起点 X'],['y1','起点 Y'],['x2','终点 X'],['y2','终点 Y'],['cx','中心 X'],['cy','中心 Y'],['rx','横半径'],['ry','纵半径'],['font-size','字号'],['fill','填充'],['stroke','线色']]){
        if(item.attrs[key]===undefined)continue;
        row.append(field(label,item.attrs[key],value=>edit(d=>{
          const s=d.shapes.find(s=>s.id===item.id);
          if(s.tag==='rect'&&['width','height'].includes(key))resizeRect(d,s.id,{[key]:Number(value)});
          else s.attrs[key]=value;
        })));
      }
      if(item.tag==='text')row.prepend(field('文字内容',item.text,value=>edit(d=>{d.shapes.find(s=>s.id===item.id).text=value;})));
      const remove=makeElement('button','quiet-button','删除图形');remove.addEventListener('click',()=>edit(d=>{d.shapes=d.shapes.filter(s=>s.id!==item.id);selected=null;}));
      ui.interfaceProperties.append(row,remove);
    }
  }
  function renderPorts(){
    ui.interfacePortList.replaceChildren();if(!draft)return;
    for(const p of draft.ports){
      const row=makeElement('div','interface-port-row');row.dataset.portId=p.id;
      const select=makeElement('button','interface-port-select',p.direction==='input'?'→':'←');
      select.setAttribute('aria-label',`定位端口 ${p.label}`);select.addEventListener('click',()=>choose('port',p.id));row.append(select);
      row.append(field(`${p.label} 名称`,p.label,v=>edit(d=>movePort(d,p.id,{label:v}))),
        field(`${p.label} 方向`,p.direction,v=>edit(d=>movePort(d,p.id,{direction:v})),[['input','输入'],['output','输出']]),
        field(`${p.label} 位宽`,p.width,v=>edit(d=>movePort(d,p.id,{width:Number(v)}))));
      const remove=makeElement('button','interface-port-remove','×');remove.setAttribute('aria-label',`删除端口 ${p.label}`);
      remove.addEventListener('click',()=>edit(d=>{removePort(d,p.id);if(selected?.id===p.id)selected=null;},{rebuild:true}));row.append(remove);
      ui.interfacePortList.append(row);
    }
    syncPorts();
  }
  function syncPorts(){
    if(!draft)return;
    for(const row of ui.interfacePortList.children){
      const p=draft.ports.find(p=>p.id===row.dataset.portId);if(!p)continue;
      row.classList.toggle('is-selected',selected?.kind==='port'&&selected.id===p.id);
      const fields=row.querySelectorAll('input,select');[p.label,p.direction,p.width].forEach((v,i)=>{if(document.activeElement!==fields[i])fields[i].value=v;});
      ['名称','方向','位宽'].forEach((label,i)=>fields[i].setAttribute('aria-label',`${p.label} ${label}`));
      row.querySelector('.interface-port-select').setAttribute('aria-label',`定位端口 ${p.label}`);
      row.querySelector('.interface-port-select').textContent=p.direction==='input'?'→':'←';
      row.querySelector('.interface-port-remove').setAttribute('aria-label',`删除端口 ${p.label}`);
    }
  }
  function draw(){
    art.replaceChildren();if(!draft)return;
    for(const s of draft.shapes){
      if(!['rect','ellipse','line','polyline','polygon','path','text'].includes(s.tag))continue;
      const attrs=Object.fromEntries(Object.entries(s.attrs).filter(([key,value])=>
        /^(x|y|width|height|r|rx|ry|cx|cy|x1|x2|y1|y2|points|d|fill|stroke|stroke-width|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline)$/.test(key)&&!String(value).includes('url(')));
      if(attrs['font-family']==='Dialog'||attrs['font-family']==='SansSerif')attrs['font-family']='sans-serif';
      if(attrs['font-family']==='Monospaced')attrs['font-family']='monospace';
      const shape=makeSvg(s.tag,attrs);if(s.tag==='text')shape.textContent=s.text;
      shape.dataset.shapeId=s.id;shape.setAttribute('role','button');shape.setAttribute('aria-label',s.tag==='text'?`文字 ${s.text}`:'封装图形');
      shape.classList.toggle('symbol-selected',selected?.kind==='shape'&&selected.id===s.id);art.append(shape);
    }
    for(const p of draft.ports){
      const group=makeSvg('g',{'data-port-id':p.id,role:'button','aria-label':`端口 ${p.label}`});
      group.append(makeSvg('circle',{cx:p.x,cy:p.y,r:11,fill:'transparent'}));
      group.append(makeSvg(p.direction==='input'?'circle':'rect',p.direction==='input'?{cx:p.x,cy:p.y,r:4}:{x:p.x-5,y:p.y-5,width:10,height:10}));
      group.classList.add('symbol-port');group.classList.toggle('symbol-selected',selected?.kind==='port'&&selected.id===p.id);art.append(group);
    }
  }
  function fit(){if(!draft)return;const b=art.getBBox();svg.setAttribute('viewBox',`${b.x-50} ${b.y-50} ${Math.max(160,b.width+100)} ${Math.max(140,b.height+100)}`);}
  async function openInterfaces(name=project.circuitName){
    if(!project.session||project.projectBusy)return;
    const token=++epoch;ref={projectId:project.session.workspace.id,revisionId:project.revision,circuit:name};
    base=draft=null;selected=null;undo=[];preview=null;busy=true;error('');art.replaceChildren();ui.interfacePortList.replaceChildren();ui.interfaceProperties.replaceChildren();ui.interfaceImpact.replaceChildren();
    ui.interfaceTitle.textContent=`${name} · 封装与接口`;ui.interfaceScope.textContent='正在读取真实封装与引用…';ui.interfaceDialog.showModal();state();
    try{
      const result=await client.request('/api/interface?'+new URLSearchParams(ref));
      if(token!==epoch||!ui.interfaceDialog.open)return;
      if(!active()){error("工程已更新，请关闭后重新打开编辑器。");return;}
      ref={...ref,newPinLocation:result.newPinLocation};base={shapes:result.shapes,ports:result.ports};draft=structuredClone(base);
      ui.interfaceScope.textContent=result.uses.length?`共享定义，应用后同步调整 ${result.uses.length} 处父图引用`:'此定义尚未放入其他电路';
      draw();renderPorts();fit();
    }catch(e){if(token===epoch)error(e.message);}
    finally{if(token===epoch){busy=false;state();}}
  }
  async function prepare(){
    if(busy||!active()||!dirty())return;
    busy=true;state();error('');const token=epoch;
    try{
      const result=await client.request('/api/interface/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...ref,draft})});
      if(token!==epoch)return;if(!active()){error("工程已更新，请关闭后重新打开编辑器。");return;}preview=result;ui.interfaceImpact.replaceChildren(makeElement('h3','','应用后的影响'));
      for(const i of result.impacts)ui.interfaceImpact.append(makeElement('p','',`${i.circuit}：调整 ${i.movedPorts} 个接点，断开 ${i.detachedPorts} 个端口`));
      ui.interfaceImpact.append(makeElement('p','',`新增 ${result.addedPorts} 个、删除 ${result.removedPorts} 个端口。其余已知端口连接保持。`));
    }catch(e){if(token===epoch)error(e.message);}
    finally{if(token===epoch){busy=false;state();}}
  }
  async function apply(){
    if(busy||!active()||!dirty())return;
    const token=epoch;
    if(!preview){await prepare();if(!preview||token!==epoch||!ui.interfaceDialog.open)return;}
    busy=applying=true;state();
    try{if(await ports.performProjectAction('interface',{...ref,draft,previewId:preview.previewId},project.circuitName))ui.interfaceDialog.close();
      else error('修改未应用。草稿已保留，请检查工程状态后重试。');}
    finally{busy=applying=false;state();}
  }
  const world=e=>new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  function cancelDrag(){if(!pointer)return;draft=pointer.before;pointer=null;draw();syncPorts();properties();state();}
  function mountInterfaces(){
    ui.editInterface.addEventListener('click',()=>openInterfaces());ui.interfacePreview.addEventListener('click',prepare);ui.interfaceApply.addEventListener('click',apply);
    ui.interfaceClose.addEventListener('click',()=>{epoch++;ui.interfaceDialog.close();});ui.interfaceDialog.addEventListener('cancel',e=>{if(pointer){e.preventDefault();cancelDrag();}else if(applying)e.preventDefault();});
    ui.interfaceDialog.addEventListener('close',()=>{epoch++;pointer=null;});ui.interfaceFit.addEventListener('click',fit);
    const undoDraft=()=>{if(undo.length&&!busy){draft=undo.pop();invalidate();draw();renderPorts();properties();}};
    ui.interfaceUndo.addEventListener('click',undoDraft);
    ui.interfaceDialog.addEventListener('keydown',e=>{
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!e.target.closest('input,select,textarea')){e.preventDefault();e.stopPropagation();if(!e.shiftKey)undoDraft();}
    });
    window.addEventListener('blur',cancelDrag);
    ui.interfaceAddPort.addEventListener('click',()=>edit(d=>{const id='new-'+crypto.randomUUID();d.ports.push({id,label:'SIGNAL',direction:'input',width:1,x:50,y:Math.max(50,...d.ports.map(p=>p.y))+20,internalX:ref.newPinLocation.x,internalY:ref.newPinLocation.y+d.ports.filter(p=>p.id.startsWith('new-')).length*30,disconnect:false});selected={kind:'port',id};},{rebuild:true}));
    ui.interfaceAddRect.addEventListener('click',()=>edit(d=>{const id='new-'+crypto.randomUUID();d.shapes.push({id,tag:'rect',attrs:{x:70,y:70,width:80,height:60,stroke:'#294963',fill:'none','stroke-width':2},text:'',editable:true});selected={kind:'shape',id};}));
    ui.interfaceAddText.addEventListener('click',()=>edit(d=>{const id='new-'+crypto.randomUUID();d.shapes.push({id,tag:'text',attrs:{x:100,y:100,'font-family':'Dialog','font-size':14,fill:'#24364b'},text:'文字',editable:true});selected={kind:'shape',id};}));
    svg.tabIndex=0;
    svg.addEventListener('pointerdown',e=>{
      if(busy||pointer||e.button!==0||!draft)return;
      const node=e.target.closest('[data-port-id],[data-shape-id]');if(!node)return;
      const kind=node.dataset.portId?'port':'shape',id=node.dataset.portId||node.dataset.shapeId;
      choose(kind,id);svg.focus();pointer={id,kind,pointerId:e.pointerId,start:world(e),before:structuredClone(draft),moved:false};svg.setPointerCapture(e.pointerId);e.preventDefault();
    });
    svg.addEventListener('pointermove',e=>{
      if(!pointer||pointer.pointerId!==e.pointerId)return;
      const p=world(e),dx=Math.round((p.x-pointer.start.x)/10)*10,dy=Math.round((p.y-pointer.start.y)/10)*10;
      draft=structuredClone(pointer.before);pointer.moved=!!(dx||dy);
      if(pointer.kind==='port'){const item=draft.ports.find(p=>p.id===pointer.id);movePort(draft,item.id,{x:item.x+dx,y:item.y+dy});}
      else{const item=draft.shapes.find(p=>p.id===pointer.id);if(item.editable&&item.tag!=='path')translateShape(item,dx,dy);}
      draw();
    });
    svg.addEventListener('pointerup',()=>{if(!pointer)return;if(pointer.moved){undo.push(pointer.before);invalidate();}pointer=null;syncPorts();properties();});
    svg.addEventListener('pointercancel',cancelDrag);svg.addEventListener('lostpointercapture',cancelDrag);
    svg.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&pointer){e.preventDefault();e.stopPropagation();cancelDrag();return;}
      const delta={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[e.key];if(!delta||!selected)return;e.preventDefault();
      edit(d=>{if(selected.kind==='port'){const p=d.ports.find(p=>p.id===selected.id);movePort(d,p.id,{x:p.x+delta[0],y:p.y+delta[1]});}else translateShape(d.shapes.find(s=>s.id===selected.id),...delta);});
    });
  }
  return Object.freeze({openInterfaces,mountInterfaces});
}
