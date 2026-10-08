const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const modulePromise=import('data:text/javascript;base64,'+fs.readFileSync(path.join(__dirname,'../circuit-lens/web/core/connection-values.js')).toString('base64'));

// Electrical contacts deliberately disagree with names and include a
// permuted slice, passive splitter, and another disconnected "rs1" label.
function fixture() {
  const component=(id,factory,direction,bits,label)=>({componentId:id,factory,label,ends:[{index:0,direction,width:bits.length,netBits:bits.map((netId,bit)=>({bit,netId}))}]});
  const components=[component('rom','ROM','output',['x','b','a','y']),
    component('tap','Splitter','inout',['b','a']),component('rs','Tunnel','inout',['a','b'],'rs1'),
    component('use','Multiplexer','input',['a','b']),component('other','Tunnel','inout',['z'],'rs1')];
  const nets=new Map();
  for(const c of components)for(const bit of c.ends[0].netBits){
    if(!nets.has(bit.netId))nets.set(bit.netId,{netId:bit.netId,contacts:[]});
    nets.get(bit.netId).contacts.push({componentId:c.componentId,endIndex:0,bit:bit.bit});
  }
  return {components,nets:[...nets.values()]};
}

test('native bit contacts determine sources and uses, including permuted bus slices',async()=>{
  const {connectionIndex,signalTrace,bitMapping}=await modulePromise;
  const c=fixture(),index=connectionIndex(c),bits=c.components[2].ends[0].netBits;
  const trace=signalTrace(index,bits,{componentId:'rs',endIndex:0});
  assert.equal(trace.singleSource.component.componentId,'rom');
  assert.deepEqual(trace.singleSource.pairs,[{from:0,to:2},{from:1,to:1}]);
  assert.equal(bitMapping(trace.singleSource.pairs),'逐位映射 0→2, 1→1');
  assert.deepEqual(trace.uses.map(p=>p.component.componentId),['use']);
  assert.deepEqual(trace.taps.map(p=>p.component.componentId),['tap']);
  assert.ok(!trace.peers.some(p=>p.component.componentId==='other'));
  assert.equal(bitMapping([{from:0,to:15},{from:1,to:16}]),'所选 [1:0] → 此端口 [16:15]');
});

test('never guess a unique source for multiple drivers, partial coverage, or unknown directions',async()=>{
  const {connectionIndex,signalTrace}=await modulePromise;
  const c=fixture(),bits=c.components[2].ends[0].netBits;
  c.components[3].ends[0].direction='output';
  let t=signalTrace(connectionIndex(c),bits);assert.equal(t.sources.length,2);assert.equal(t.singleSource,null);
  c.components[3].ends[0].direction='input';
  t=signalTrace(connectionIndex(c),[...bits,{bit:2,netId:'z'}]);assert.equal(t.singleSource,null);
  c.components[0].ends[0].direction='inout';
  t=signalTrace(connectionIndex(c),bits);assert.equal(t.sources.length,0);assert.equal(t.unknown.length,1);
});

test('tracing the driving port retains that port as the source',async()=>{
  const {connectionIndex,signalTrace}=await modulePromise;
  const c=fixture(),rom=c.components[0];
  const t=signalTrace(connectionIndex(c),rom.ends[0].netBits,{componentId:'rom',endIndex:0});
  assert.equal(t.singleSource.component.componentId,'rom');
  assert.equal(t.singleSource.pairs.length,4);
});
