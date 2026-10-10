import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createController} from '../circuit-lens/web/features/changes.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
  globalThis.window={};globalThis.document={querySelector:()=>null};
  const project={session:{workspace:{id:'a',dirty:true,canSave:true}},revision:'r1',projectBusy:false,sourceChanged:false};
  const requests=[],states=[];
  const controller=createController({models:{project,review:{}},ui:{},client:{request:(url,options)=>new Promise((resolve,reject)=>requests.push({url,body:JSON.parse(options.body),resolve,reject}))},
    ports:{updateSessionChrome:()=>states.push(controller.saveState()),pollSessionState:async()=>{}}});
  return {project,controller,requests,states};
}

test('save is explicit, bound to the open revision and never duplicates while pending',async()=>{
  const h=harness(),saving=h.controller.requestSave();
  assert.equal(h.controller.saveState().pending,true);
  assert.equal(await h.controller.requestSave(),false);
  await flush();assert.equal(h.requests.length,1);
  assert.deepEqual(h.requests[0].body,{projectId:'a',revisionId:'r1'});
  assert.equal(h.project.session.workspace.dirty,true,'no success before acknowledgement');
  h.requests[0].resolve({workspace:{id:'a',dirty:false,canSave:true}});
  assert.equal(await saving,true);
  assert.deepEqual(h.controller.saveState(),{pending:false,error:'',canSave:false});
});

test('failed save leaves the document dirty, exposes the error and permits a retry',async()=>{
  const h=harness(),saving=h.controller.requestSave();await flush();
  h.requests[0].reject(Error('permission denied'));assert.equal(await saving,false);
  assert.equal(h.project.session.workspace.dirty,true);
  assert.deepEqual(h.controller.saveState(),{pending:false,error:'permission denied',canSave:true});
  const retry=h.controller.requestSave();await flush();
  h.requests[1].resolve({workspace:{id:'a',dirty:false,canSave:true}});await retry;
  assert.equal(h.controller.saveState().error,'');
});

test('a late save response never replaces a newly opened document',async()=>{
  const h=harness(),saving=h.controller.requestSave();await flush();
  h.project.session={workspace:{id:'b',dirty:true,canSave:true}};h.project.revision='r2';h.project.projectBusy=false;
  h.requests[0].resolve({workspace:{id:'a',dirty:false,canSave:true}});await saving;
  assert.equal(h.project.session.workspace.id,'b');assert.equal(h.project.session.workspace.dirty,true);
  assert.deepEqual(h.controller.saveState(),{pending:false,error:'',canSave:true});
});

test('external changes, uploaded files and modal edits cannot trigger a write',async()=>{
  const h=harness();
  h.project.sourceChanged=true;assert.equal(await h.controller.requestSave(),false);
  h.project.sourceChanged=false;h.project.session.workspace.canSave=false;assert.equal(await h.controller.requestSave(),false);
  h.project.session.workspace.canSave=true;globalThis.document.querySelector=()=>({});assert.equal(await h.controller.requestSave(),false);
  assert.equal(h.requests.length,0);
});

test('a newer revision arriving during save stays current and editing is unlocked',async()=>{
  const h=harness(),saving=h.controller.requestSave();await flush();
  h.project.revision='r2';
  h.requests[0].resolve({workspace:{id:'a',dirty:false,canSave:true}});await saving;
  assert.equal(h.project.revision,'r2');assert.equal(h.project.session.workspace.dirty,true);
  assert.equal(h.project.projectBusy,false);assert.equal(h.controller.saveState().canSave,true);
});
