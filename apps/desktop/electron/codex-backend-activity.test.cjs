'use strict';
const assert=require('node:assert/strict');
const {itemActivity}=require('./codex-backend.cjs');
const {EpisodeLedger}=require('./episode-ledger.cjs');

// A host that knows the circuit tools, like AgentToolHost over the plugin registry.
const host={
  get(name){return ['inspect_circuit','render_circuit','trace_circuit','run_verification'].includes(name)?{name}:null;},
  label(name){return name==='render_circuit'?'渲染电路':null;},
};

const known=itemActivity({type:'dynamicToolCall',tool:'render_circuit'},host);
assert.equal(known.kind,'tool');
assert.equal(known.activityKey,'circuit:render_circuit');
assert.equal(known.label,'渲染电路');

const unknown=itemActivity({type:'dynamicToolCall',tool:'some_other_tool'},host);
assert.equal(unknown.activityKey,'tool:some_other_tool');
assert.equal(unknown.label,'使用动态工具');

assert.equal(itemActivity({type:'dynamicToolCall',tool:'inspect_circuit'},null).activityKey,'tool:inspect_circuit');

// The ledger's circuit-tool metrics must see the domain calls the backend records.
const ledger=new EpisodeLedger({taskId:'t',condition:'full',initialArtifactSha256:'0'});
ledger.record('event',{type:'turn-started',turnId:'turn-1'});
let n=0;
for(const tool of ['inspect_circuit','render_circuit','trace_circuit','run_verification','some_other_tool']){
  const activity=itemActivity({type:'dynamicToolCall',tool},host);
  ledger.record('event',{type:'activity',itemId:`tool-${++n}`,...activity,status:'completed'},n*10);
}
ledger.record('event',{type:'turn-completed',turnId:'turn-1',status:'completed'});
const metrics=ledger.metrics();
assert.equal(metrics.toolCalls,5);
assert.equal(metrics.circuitToolCalls,4);
assert.equal(metrics.visualObservationCalls,1);
assert.equal(metrics.nativeRunCalls,1);
assert.equal(metrics.verificationToolCalls,1);
console.log('codex backend activity checks passed');
