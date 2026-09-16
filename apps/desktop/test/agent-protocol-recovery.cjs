'use strict';
// Start the real local app-server, then replay protocol notifications at its
// reader boundary. No turn/start is sent and no model inference is requested.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CodexBackend}=require('../electron/codex-backend.cjs');
const {waitUntil}=require('./support/wait-until.cjs');

(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-protocol-recovery-'));
 const backend=new CodexBackend({workDir:root+'/workspace',profileDir:root+'/profile',sessionStorePath:root+'/sessions.json'});
 const events=[];backend.on('event',e=>events.push(e));
 try{
  await backend.start();
  const generation=backend.childEpoch;
  function begin(id){
   backend.threadId='protocol-replay';
   backend.pendingTurn={epoch:backend.workspaceEpoch,childEpoch:backend.childEpoch,threadId:backend.threadId,turnId:null};
   notify('turn/started',{turn:{id}});
  }
  function notify(method,params){backend.stdoutLines.emit('line',JSON.stringify({method,params:{threadId:'protocol-replay',...params}}));}
  begin('turn-replay-1');
  const setting=backend.modelSettings.selection;
  await assert.rejects(()=>backend.selectModel(null),/先停止/);
  await assert.rejects(()=>backend.reconnect(),/先停止/);
  assert.equal(backend.childEpoch,generation);
  for(let i=0;i<12;i++)notify('error',{turnId:'turn-replay-1',willRetry:true,error:{message:'Reconnecting… waiting for network'}});
  assert.equal(backend.snapshot().transmission.phase,'retrying');assert.equal(backend.snapshot().busy,true);
  assert.equal(backend.snapshot().transmission.attempts,12);
  assert.equal(events.filter(e=>e.type==='error').length,0);
  assert.equal(events.filter(e=>e.type==='turn-completed').length,0);
  notify('error',{turnId:'old-turn',willRetry:false,error:{message:'stale failure'}});
  assert.equal(backend.snapshot().transmission.phase,'retrying');
  notify('item/agentMessage/delta',{turnId:'turn-replay-1',itemId:'message-replay',delta:'恢复输出'});
  assert.equal(backend.snapshot().transmission,null);
  notify('error',{turnId:'turn-replay-1',willRetry:false,error:{message:'terminal failure'}});
  notify('turn/completed',{turn:{id:'turn-replay-1',status:'failed',error:{message:'terminal failure'}}});
  await waitUntil(()=>events.find(e=>e.type==='turn-completed'&&e.turnId==='turn-replay-1'));
  assert.equal(backend.snapshot().busy,false);assert.equal(backend.snapshot().transmission.phase,'failed');
  begin('turn-replay-2');assert.equal(backend.snapshot().transmission,null);
  notify('error',{turnId:'turn-replay-1',willRetry:true,error:{message:'late retry'}});
  assert.equal(backend.snapshot().transmission,null);
  notify('error',{turnId:'turn-replay-2',willRetry:true,error:{message:'retry again'}});
  await backend.reconnect();
  assert.ok(backend.childEpoch>generation);assert.equal(backend.snapshot().transmission,null);assert.equal(backend.snapshot().busy,false);
  assert.deepEqual(backend.modelSettings.selection,setting);
  begin('turn-replay-3');
  backend.child.stdin.emit('error',new Error('Simulated broken process pipe'));
  assert.equal(backend.snapshot().status,'unavailable');assert.equal(backend.snapshot().canReconnect,true);
  await backend.reconnect();assert.equal(backend.snapshot().busy,false);
  console.log('Actual reader accepted retry/recovery/failure notifications, rejected stale turns and busy model changes; real reconnect; model turns: 0');
 }finally{await backend.stop();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
