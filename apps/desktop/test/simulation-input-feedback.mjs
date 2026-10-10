import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createController} from '../circuit-lens/web/features/run.js';
import {createModels} from '../circuit-lens/web/core/models.js';
import {wirePath} from '../circuit-lens/web/core/wire-path.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function node(dataset={}) {
  const classes = new Set(), attributes = new Map();
  return {dataset, hidden:true, textContent:'', classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name),contains:name=>classes.has(name)},
    setAttribute:(key,value)=>attributes.set(key,value),getAttribute:key=>attributes.get(key),querySelector:()=>null,replaceChildren(){}};
}
function harness() {
  globalThis.window={};
  const models=createModels(), {project,run}=models;
  Object.assign(project,{session:{workspace:{id:'project'}},revision:'revision',circuitName:'main',circuit:{},capabilityState:'exact'});
  const component={componentId:'button',factory:'Button',bounds:{x:0,y:0,width:20,height:20}};
  const button=node({objectId:'button',inputControl:'pulse'});
  const ui=Object.fromEntries(['simulationError','simulationDock','simulationWatches','runtimeLayer'].map(key=>[key,node()]));
  ui.componentLayer={querySelectorAll:()=>[button]};
  globalThis.document={hidden:true,querySelectorAll:()=>[]}; // Do not run background polls in this controller test.
  const start=deferred(), requests=[];
  let sequence=0;
  const state = (commandSequence=sequence, observed=sequence) => ({session:{id:'session',projectId:'project',revisionId:'revision',circuit:'main'},
    view:{id:'view',circuit:'main'},commandSequence,observation:{id:`sample-${observed}`,sequence:observed+1,commandSequence:observed,circuit:'main',viewId:'view',
      components:[{componentId:'button',control:'pulse',ports:[{index:0,value:0,width:1}]}]}});
  const ports=new Proxy({staticCircuitRender:()=>null,startSimulation:async()=>{
    const ok=await start.promise;if(!ok)return false;
    run.simulation=state();run.displayedView=run.simulation.view;return true;
  }},{get:(target,key)=>target[key]||(()=>{})});
  const controller=createController({models,ui,ports,client:{request:async(_url,options)=>{
    const request={body:JSON.parse(options.body),result:deferred()}; requests.push(request); return request.result.promise;
  }}});
  async function acknowledge(index,{observe=false}={}) { sequence++;requests[index].result.resolve(state(sequence,observe?sequence:sequence-1)); await flush(); }
  return {models,controller,button,component,start,requests,ui,state,acknowledge};
}

test('cold press/release stays visible until native acknowledgement and observation, without latching',async()=>{
  const h=harness();h.controller.pressButton(h.component);
  assert.equal(h.button.getAttribute('aria-pressed'),'true');assert.equal(h.button.getAttribute('aria-busy'),'true');
  const released=h.controller.releaseButton();assert.equal(h.button.getAttribute('aria-pressed'),'false');
  assert.equal(h.button.getAttribute('aria-busy'),'true');assert.equal(h.requests.length,0);
  h.start.resolve(true);await flush();assert.equal(h.requests[0].body.value,'1');
  await h.acknowledge(0);assert.equal(h.requests[1].body.value,'0');
  await h.acknowledge(1);await released;
  assert.equal(h.button.getAttribute('aria-busy'),'true','an accepted command is not yet the displayed result');
  await h.controller.acceptSimulation(h.state(2,2),h.models.run.simulationEpoch);
  assert.equal(h.button.getAttribute('aria-busy'),'false');assert.equal(h.button.getAttribute('aria-pressed'),'false');
});

test('a failed command clears its pending feedback and leaves a visible error',async()=>{
  const h=harness();h.start.resolve(true);h.controller.pressButton(h.component);await flush();
  h.requests[0].result.reject(Error('native unavailable'));await flush();await h.controller.releaseButton();
  assert.equal(h.button.getAttribute('aria-busy'),'false');assert.equal(h.button.getAttribute('aria-pressed'),'false');
  assert.equal(h.ui.simulationError.hidden,false);assert.equal(h.ui.simulationError.textContent,'native unavailable');
});

test('navigation during startup drops the old input instead of poking the new circuit',async()=>{
  const h=harness();h.controller.pressButton(h.component);h.models.project.circuitRequestEpoch++;
  h.start.resolve(true);await flush();await h.controller.releaseButton();
  assert.equal(h.requests.length,0);assert.equal(h.button.getAttribute('aria-busy'),'false');
  assert.equal(h.button.getAttribute('aria-pressed'),'false');
});

test('pending feedback survives an older frame but clears when the session is invalidated',async()=>{
  const h=harness();h.start.resolve(true);h.controller.pressButton(h.component);await flush();await h.acknowledge(0);
  assert.equal(h.button.getAttribute('aria-busy'),'true');h.controller.invalidateSimulation();
  assert.equal(h.button.getAttribute('aria-busy'),'false');assert.equal(h.button.getAttribute('aria-pressed'),'false');
});

test('an input in a different circuit starts its own run even if another session exists',async()=>{
  const h=harness();
  h.models.run.simulation={session:{id:'other',projectId:'project',revisionId:'revision',circuit:'other'}};
  h.controller.pressButton(h.component);await flush();
  assert.equal(h.requests.length,0);assert.equal(h.button.getAttribute('aria-busy'),'true');
  h.start.resolve(true);await flush();
  assert.equal(h.requests[0].body.sessionId,'session');assert.equal(h.requests[0].body.circuit,'main');
  await h.acknowledge(0);const release=h.controller.releaseButton();await flush();await h.acknowledge(1);await release;
});

test('current runtime means a matching root or displayed instance, never just an existing session',()=>{
  const h=harness();h.models.run.simulation=h.state();
  assert.equal(h.controller.simulationStatus().current,true);
  h.models.project.circuitName='Child';assert.equal(h.controller.simulationStatus().current,false);
  h.models.run.simulation.view={id:'child',circuit:'Child'};h.models.run.displayedView=h.models.run.simulation.view;
  assert.equal(h.controller.simulationStatus().current,true);
  h.models.run.displayedView=null;assert.equal(h.controller.simulationStatus().current,false);
  h.models.project.circuitName='main';h.models.project.revision='edited';assert.equal(h.controller.simulationStatus().current,false);
});

test('restoring a root view does not deadlock behind the input waiting for that view',async()=>{
  const h=harness();h.models.run.simulation=h.state();
  const held={id:'button',session:null,pressed:deferred().promise,
    feedback:{scope:{project:'project',revision:'revision',circuit:'main',navigation:0}}};
  h.models.run.heldButton=held;
  const restored=h.controller.restoreCurrentSimulationView();await flush();
  assert.equal(h.requests[0].body.action,'view');assert.deepEqual(h.requests[0].body.instancePath,[]);
  await h.acknowledge(0,{observe:true});assert.equal(await restored,true);
  assert.equal(h.models.run.heldButton,held);assert.ok(h.controller.activeObservation());
});

test('a late start response cannot attach itself after leaving and returning to the same name',async()=>{
  const h=harness();const started=h.controller.simulationAction('start');await flush();
  h.models.project.circuitRequestEpoch+=2;
  await h.acknowledge(0,{observe:true});await started;
  assert.equal(h.controller.simulationStatus().current,true);
  assert.equal(h.controller.activeObservation(),null);
});

test('wire bend direction changes only the unfinished leg and all segments stay orthogonal',()=>{
  const start={x:100,y:100},first={x:200,y:150},end={x:300,y:250};
  const fixed=wirePath([start,first]);
  assert.deepEqual(fixed,[start,{x:200,y:100},first]);
  const path=wirePath([...fixed,end],true);
  assert.deepEqual(path,[...fixed,{x:200,y:250},end]);
  assert.ok(path.every((point,i)=>!i||point.x===path[i-1].x||point.y===path[i-1].y));
  assert.deepEqual(wirePath([start,start]),[start]);
});
