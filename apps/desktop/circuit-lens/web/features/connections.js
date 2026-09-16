import {makeElement} from '../core/dom.js';
import {portName,bitRange,connectionIndex,connectedPorts} from '../core/connection-values.js';

export const modelDependencies=['project'];
export const dependencies=['selectionSnapshot','selectComponent','focusComponents'];

export function createController({models,ui,ports}) {
  const project=models.project;
  let circuit=null,index=null;
  function peerButton(peer) {
    const button=makeElement('button','connection-peer');button.type='button';
    const name=peer.component.label||peer.component.factory;
    button.append(makeElement('strong','',name),makeElement('span','',portName(peer.component,peer.end)));
    if(peer.end.width>1||peer.pairs.length>1||peer.pairs.some(p=>p.from!==0))button.append(makeElement('small','',`[${bitRange(peer.pairs.map(p=>p.from))}] → [${bitRange(peer.pairs.map(p=>p.to))}]`));
    button.title=`在画布定位 ${name} · ${portName(peer.component,peer.end)}`;
    button.addEventListener('click',()=>{ports.selectComponent(peer.component.componentId,false);ports.focusComponents([peer.component.componentId]);});
    return button;
  }
  function group(title,bits,origin) {
    const section=makeElement('section','connection-port');section.append(makeElement('h3','',title));
    const peers=connectedPorts(index,bits,origin);
    if(!bits?.length)section.append(makeElement('p','connection-empty','未读取到此端口的连接信息'));
    else if(!peers.length)section.append(makeElement('p','connection-empty','没有连接其他端口'));
    else for(const peer of peers)section.append(peerButton(peer));
    return section;
  }
  function renderConnections() {
    if(project.circuit!==circuit){circuit=project.circuit;index=circuit?connectionIndex(circuit):null;}
    ui.connectionList.replaceChildren();ui.evidenceTitle.textContent='连接';
    const selection=ports.selectionSnapshot();
    if(!circuit){ui.connectionsSummary.textContent='打开工程后，可在这里查看连接。';return;}
    if(project.sourceChanged||project.capabilityState!=='exact') {
      ui.connectionsSummary.textContent=project.sourceChanged?'工程版本已改变，重新载入后可查看连接。':'暂时无法读取连接，请在工程信息中检查运行环境。';return;
    }
    const components=selection.componentIds.map(id=>index.components.get(id)).filter(Boolean);
    if(!components.length&&!selection.wireIds.length&&!selection.netIds.length) {
      ui.connectionsSummary.textContent='选中元件或导线，查看连接到哪里。';return;
    }
    ui.connectionsSummary.textContent=project.circuitName;
    for(const c of components) {
      const card=makeElement('section','connection-component');card.append(makeElement('h2','',c.label||c.factory));
      if(!c.ends?.length)card.append(makeElement('p','connection-empty','此对象没有电气端口'));
      for(const end of c.ends||[])card.append(group(`${portName(c,end)} · ${end.width} 位`,end.netBits,{componentId:c.componentId,endIndex:end.index}));
      ui.connectionList.append(card);
    }
    const bundles=new Set(circuit.wires.filter(w=>selection.wireIds.includes(w.wireId)).map(w=>w.bundleId));
    for(const id of bundles) {
      const bundle=index.bundles.get(id);
      ui.connectionList.append(group(`选中导线 · ${bundle?.width||'?'} 位`,bundle?.valid===false?[]:bundle?.bitNets));
    }
    if(!components.length&&!bundles.size&&selection.netIds.length)ui.connectionList.append(group('选中信号',selection.netIds.map((netId,bit)=>({bit,netId}))));
  }
  return {renderConnections};
}
