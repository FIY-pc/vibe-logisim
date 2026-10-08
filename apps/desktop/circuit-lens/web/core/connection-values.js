// Names come from native port metadata. Unknown library ports retain their name.
export function portName(component, end, index = end.index) {
  const role={circuitInput:'输入引脚',circuitOutput:'输出引脚'}[end.semanticRole];
  if(role)return role;
  const native=String(end.runtimeTooltip||'').split(':')[0].trim();
  const register={Output:'当前值 Q',Data:'写入值 D'};
  const names={Output:'输出',Input:'输入',Data:'数据',Address:'地址',Clock:'时钟',Clear:'清零',Enable:'使能','Chip select':'片选',Preset:'置位',Select:'选择',Store:'写入',Load:'读取',Carry:'进位'};
  return (component.factory==='Register'&&register[native])||names[native]||native||`端口 ${index}`;
}

export function bitRange(bits) {
  const sorted=[...new Set(bits)].sort((a,b)=>a-b),ranges=[];
  for(let i=0;i<sorted.length;i++) {
    const first=sorted[i];let last=first;
    while(sorted[i+1]===last+1)last=sorted[++i];
    ranges.push(first===last?String(first):`${last}:${first}`);
  }
  return ranges.join(', ');
}

export function bitMapping(pairs) {
  const sorted=[...pairs].sort((a,b)=>a.from-b.from||a.to-b.to);
  if(!sorted.length)return '';
  if(sorted.every(p=>p.to-p.from===sorted[0].to-sorted[0].from))
    return `所选 [${bitRange(sorted.map(p=>p.from))}] → 此端口 [${bitRange(sorted.map(p=>p.to))}]`;
  return `逐位映射 ${sorted.map(p=>`${p.from}→${p.to}`).join(', ')}`;
}

// Build once per loaded circuit, using native net contacts (including tunnels
// and splitters), never visual intersections. Keep source/destination bit pairs.
export function connectionIndex(circuit) {
  return {components:new Map((circuit.components||[]).map(c=>[c.componentId,c])),
    nets:new Map((circuit.nets||[]).map(n=>[n.netId,n])),
    bundles:new Map((circuit.bundles||[]).map(b=>[b.bundleId,b]))};
}

export function connectedPorts(index, bits, origin = null) {
  const peers=new Map();
  for(const bit of bits||[]) for(const contact of index.nets.get(bit.netId)?.contacts||[]) {
    if(contact.componentId===origin?.componentId&&contact.endIndex===origin?.endIndex)continue;
    const component=index.components.get(contact.componentId),end=component?.ends?.find(e=>e.index===contact.endIndex);
    if(!component||!end)continue;
    const key=`${contact.componentId}:${contact.endIndex}`;
    if(!peers.has(key))peers.set(key,{component,end,pairs:[]});
    const peer=peers.get(key);
    if(!peer.pairs.some(p=>p.from===bit.bit&&p.to===contact.bit))peer.pairs.push({from:bit.bit,to:contact.bit});
  }
  return [...peers.values()];
}

// A read view of one observed signal, including bus slices and aliases. A
// Splitter is passive connectivity; it is never invented as a driving source.
export function signalTrace(index, bits, origin = null) {
  const peers=connectedPorts(index,bits,origin);
  const self=index.components.get(origin?.componentId),end=self?.ends?.find(e=>e.index===origin?.endIndex);
  if(end?.direction==='output'&&!['Tunnel','Splitter'].includes(self.factory)) {
    const pairs=(bits||[]).flatMap(b=>(end.netBits||[]).filter(e=>e.netId===b.netId).map(e=>({from:b.bit,to:e.bit})));
    if(pairs.length)peers.unshift({component:self,end,pairs});
  }
  const passive=p=>['Tunnel','Splitter'].includes(p.component.factory);
  const sources=peers.filter(p=>!passive(p)&&p.end.direction==='output');
  const uses=peers.filter(p=>!passive(p)&&p.end.direction==='input');
  const unknown=peers.filter(p=>!passive(p)&&!['input','output'].includes(p.end.direction));
  const aliases=peers.filter(p=>p.component.factory==='Tunnel');
  const taps=peers.filter(p=>p.component.factory==='Splitter');
  const selected=new Set((bits||[]).map(b=>b.bit));
  const singleSource=sources.length===1&&new Set(sources[0].pairs.map(p=>p.from)).size===selected.size?sources[0]:null;
  return {peers,sources,uses,unknown,aliases,taps,singleSource};
}
