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
