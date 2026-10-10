import {makeElement} from '../core/dom.js';
import {portName,bitRange,bitMapping,connectionIndex,connectedPorts,signalTrace} from '../core/connection-values.js';

export const modelDependencies=['project','canvas'];
export const dependencies=['selectionSnapshot','selectComponent','focusComponents','restoreDraftSelection','applyCamera','openReviewPanel','switchReviewTab','showToast'];

export function createController({models,ui,ports}) {
  const project=models.project,canvas=models.canvas;
  let circuit=null,index=null,scope=null,trace=null,selectionKey=null,internal=false;
  const history=[];
  const signature=()=>JSON.stringify(ports.selectionSnapshot());
  function refresh() {
    const key=JSON.stringify([project.session?.workspace?.id,project.revision,project.circuitName]);
    if(key!==scope||circuit!==project.circuit){scope=key;circuit=project.circuit;index=circuit?connectionIndex(circuit):null;trace=null;history.length=0;selectionKey=null;}
    return index&&!project.sourceChanged&&project.capabilityState==='exact';
  }
  function remember(previousTrace){history.push({scope,selection:ports.selectionSnapshot(),camera:{...canvas.camera},trace:previousTrace});if(history.length>40)history.shift();}
  function visit(peer,previousTrace=trace) {
    if(!refresh())return;
    remember(previousTrace);internal=true;
    try {
      ports.selectComponent(peer.component.componentId,false);ports.focusComponents([peer.component.componentId]);
      const b=peer.component.bounds,w=ui.circuitCanvas.clientWidth,h=ui.circuitCanvas.clientHeight;
      if(b&&w&&h){const unit=Math.max(Math.min(canvas.camera.width/w,1.3),(b.width+100)/w,(b.height+100)/h);
        canvas.camera={x:b.x+(b.width-w*unit)/2,y:b.y+(b.height-h*unit)/2,width:w*unit,height:h*unit};ports.applyCamera();}
    }
    finally {internal=false;selectionKey=signature();}
    renderConnections();
  }
  function signalBack() {
    if(!refresh())return false;
    const previous=history.pop();if(!previous||previous.scope!==scope)return false;
    internal=true;trace=previous.trace;
    try {ports.restoreDraftSelection(previous.selection);canvas.camera={...previous.camera};ports.applyCamera();}
    finally {internal=false;selectionKey=signature();}
    renderConnections();return true;
  }
  function peerButton(peer) {
    const button=makeElement('button','connection-peer');button.type='button';
    const name=peer.component.label||peer.component.factory;
    button.dataset.componentId=peer.component.componentId;
    button.append(makeElement('strong','',name),makeElement('span','',portName(peer.component,peer.end)));
    if(peer.end.width>1||peer.pairs.length>1||peer.pairs.some(p=>p.from!==0))button.append(makeElement('small','',bitMapping(peer.pairs)));
    button.title=`在画布定位 ${name} · ${portName(peer.component,peer.end)}`;
    button.addEventListener('click',()=>visit(peer));return button;
  }
  function button(text,action) {const b=makeElement('button','signal-action',text);b.type='button';b.addEventListener('click',action);return b;}
  function paint(bits,peers=[]) {
    const nets=new Set((bits||[]).map(b=>b.netId));
    const components=new Set(peers.map(p=>p.component.componentId));
    if(trace?.origin)components.add(trace.origin.componentId);
    for(const node of ui.wireLayer.querySelectorAll('.wire-group')) {
      const ids=JSON.parse(node.dataset.netIds||'[]');node.classList.toggle('is-signal-related',ids.some(id=>nets.has(id)));
    }
    for(const node of ui.componentLayer.querySelectorAll('.circuit-component'))node.classList.toggle('is-signal-related',components.has(node.dataset.objectId));
  }
  function start(bits,origin,label,jump=false) {
    if(!refresh()||!bits?.length){ports.showToast('未读取到此信号的连接信息');return;}
    const previousTrace=trace;
    trace={bits,origin,label};selectionKey=signature();
    ports.switchReviewTab('evidence');ports.openReviewPanel();
    const info=signalTrace(index,bits,origin);
    if(jump&&info.singleSource)visit(info.singleSource,previousTrace);
    else {renderConnections();if(jump)ports.showToast(info.sources.length?'此信号有多个或部分位来源，请在来源列表中选择':'没有已知输出驱动端，可查看位段与连接位置');}
  }
  function traceComponent(id,endIndex=null,jump=false) {
    if(!refresh())return;
    const c=index.components.get(id);if(!c)return;
    const end=endIndex===null?(c.ends?.length===1?c.ends[0]:null):c.ends?.find(e=>e.index===endIndex);
    if(!end){ports.selectComponent(id,false);ports.switchReviewTab('evidence');ports.openReviewPanel();ports.showToast('请选择要追踪的端口');return;}
    start(end.netBits,{componentId:id,endIndex:end.index},`${c.label||c.factory} · ${portName(c,end)}`,jump);
  }
  function group(title,bits,origin) {
    const section=makeElement('section','connection-port');section.append(makeElement('h3','',title));
    const peers=connectedPorts(index,bits,origin);
    if(bits?.length)section.append(button('追踪此信号',()=>start(bits,origin,title)));
    if(!bits?.length)section.append(makeElement('p','connection-empty','未读取到此端口的连接信息'));
    else if(!peers.length)section.append(makeElement('p','connection-empty','没有连接其他端口'));
    else for(const peer of peers)section.append(peerButton(peer));return section;
  }
  function renderTrace() {
    const info=signalTrace(index,trace.bits,trace.origin);
    ui.connectionsSummary.textContent=trace.label;
    const actions=makeElement('div','signal-actions');
    actions.append(button('定位来源',()=>{if(info.singleSource)visit(info.singleSource);else ports.showToast('请从下方来源列表选择');}),button('退出追踪',()=>{trace=null;renderConnections();}));
    ui.connectionList.append(actions,makeElement('p','connection-empty',`${new Set(trace.bits.map(b=>b.bit)).size} 位信号 · 来源与使用位置依据当前电路连接`));
    const names=[...new Set(info.aliases.map(p=>`${p.component.label||p.component.factory}[${bitRange(p.pairs.map(b=>b.to))}]`))];
    if(names.length)ui.connectionList.append(makeElement('p','signal-aliases',names.join(' · ')));
    if(info.peers.some(p=>p.end.width>p.pairs.length))ui.connectionList.append(makeElement('p','connection-empty','高亮的总线包含所选位；具体位段见下方映射。'));
    for(const [title,peers] of [['上游驱动端',info.sources],['使用位置',info.uses],['字段提取 / 合并位置',info.taps],['信号名称与引用',info.aliases],['方向未确定的连接',info.unknown]]) {
      if(!peers.length&&title!=='上游驱动端')continue;
      const section=makeElement('section','connection-port');section.append(makeElement('h3','',title));
      if(!peers.length)section.append(makeElement('p','connection-empty','未找到已知输出驱动端'));
      if(title==='上游驱动端'&&peers.length>1)section.append(makeElement('p','connection-empty','可能分属不同位或有多个驱动端；此处不判断当前激活者。'));
      for(const peer of peers)section.append(peerButton(peer));ui.connectionList.append(section);
    }
    paint(trace.bits,info.peers);
  }
  function renderConnections() {
    const valid=refresh();
    if(!internal&&selectionKey!==signature())trace=null;
    selectionKey=signature();
    ui.connectionList.replaceChildren();ui.evidenceTitle.textContent=trace?'信号追踪':'连接';paint([]);
    ui.evidenceTitle.hidden=!trace;
    ui.evidenceTitle.parentElement.hidden=false;
    if(history.length)ui.connectionList.append(button('← 返回上个位置 · Alt+←',signalBack));
    if(!circuit){ui.connectionsSummary.textContent='打开工程后，可在这里查看连接。';return;}
    if(!valid){trace=null;history.length=0;ui.connectionsSummary.textContent=project.sourceChanged?'工程版本已改变，重新载入后可查看连接。':'暂时无法读取连接，请在工程信息中检查运行环境。';return;}
    if(trace){renderTrace();return;}
    const selection=ports.selectionSnapshot();
    const components=selection.componentIds.map(id=>index.components.get(id)).filter(Boolean);
    if(!components.length&&!selection.wireIds.length&&!selection.netIds.length){ui.connectionsSummary.textContent='选中元件或导线查看连接；Ctrl+点击信号可定位来源。';return;}
    ui.connectionsSummary.textContent='';
    ui.evidenceTitle.parentElement.hidden=true;
    for(const c of components) {
      const card=makeElement('section','connection-component');card.append(makeElement('h2','',c.label||c.factory));
      if(!c.ends?.length)card.append(makeElement('p','connection-empty','此对象没有电气端口'));
      for(const end of c.ends||[])card.append(group(`${portName(c,end)} · ${end.width} 位`,end.netBits,{componentId:c.componentId,endIndex:end.index}));
      ui.connectionList.append(card);
      if(c.factory==='Tunnel'&&components.length===1){const bits=c.ends?.[0]?.netBits;paint(bits,connectedPorts(index,bits));}
    }
    const bundles=new Set(circuit.wires.filter(w=>selection.wireIds.includes(w.wireId)).map(w=>w.bundleId));
    for(const id of bundles){const b=index.bundles.get(id),bits=b?.valid===false?[]:b?.bitNets;ui.connectionList.append(group(`选中导线 · ${b?.width||'?'} 位`,bits));if(!components.length&&bundles.size===1)paint(bits,connectedPorts(index,bits));}
    if(!components.length&&!bundles.size&&selection.netIds.length)ui.connectionList.append(group('选中信号',selection.netIds.map((netId,bit)=>({bit,netId}))));
  }
  function mountConnections() {
    const target=event=>event.target.closest?.('.circuit-component,.wire-group');
    const gesture=event=>{
      if(!(event.ctrlKey||event.metaKey)||event.button!==0||canvas.heldSpace||!target(event))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(canvas.wireStart){ports.showToast("请先按 Esc 结束连线，再追踪信号");return;}
      const node=target(event),port=event.target.closest?.('[data-port-index]');
      if(node.dataset.objectId)traceComponent(node.dataset.objectId,port?Number(port.dataset.portIndex):null,true);
      else if(refresh()){const wire=circuit.wires.find(w=>w.wireId===node.dataset.wireId),b=index.bundles.get(wire?.bundleId);start(b?.valid===false?[]:b?.bitNets,null,'导线信号',true);}
    };
    // Capture before wiring/drag handlers so navigation never edits the file.
    ui.circuitCanvas.addEventListener('pointerdown',gesture,true);
    ui.circuitCanvas.addEventListener('click',e=>{if((e.ctrlKey||e.metaKey)&&target(e)){e.preventDefault();e.stopImmediatePropagation();}},true);
    document.addEventListener('keydown',e=>{
      if(e.target.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;
      if(e.altKey&&e.key==='ArrowLeft'&&history.length){e.preventDefault();signalBack();}
      if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&target(e)){e.preventDefault();e.stopImmediatePropagation();if(canvas.wireStart){ports.showToast('请先按 Esc 结束连线，再追踪信号');return;}const node=target(e);if(node.dataset.objectId)traceComponent(node.dataset.objectId,e.target.dataset.portIndex===undefined?null:Number(e.target.dataset.portIndex),true);}
    },true);
  }
  return {renderConnections,mountConnections,traceComponent,signalBack};
}
