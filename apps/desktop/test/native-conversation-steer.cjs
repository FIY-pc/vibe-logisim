'use strict';
// Production CodexBackend + real app-server + localhost Responses replay.
// No remote model, credentials, synthetic app-server notifications or source edits.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),{once}=require('node:events');
const {CodexBackend}=require('../electron/codex-backend.cjs');
const {resolveExecutable}=require('../electron/agent-process.cjs');
const {waitUntil}=require('./support/wait-until.cjs');
const manifest=require('../circuit-lens/studio/domain/circuit-plugin.json');
const {revertThroughMessage}=require('../electron/conversation-edit.cjs');
const root=fs.mkdtempSync(path.join(os.homedir(),'.local/share/vibe-logisim-dev/runs/native-steer-'));
const requests=[],events=[],wire=[];let backend,release,server;
const revision='a'.repeat(64),projectId='project-steer',workspaceKey='steer-workspace';
const context={revisionId:revision,projectId,circuit:'main',authority:'source-structure',folder:{id:'folder-steer',activeFile:'counter.circ'},materials:[],keptMoments:[]};
const snapshot={workspace:{id:projectId},revision:{id:revision}};
let gate=new Promise(resolve=>{release=resolve;});
let held=false;
const report={passed:false,modelCalls:0};
(async()=>{try{
 server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
  const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
  const id='local-steer-'+requests.length;
  const item=requests.length===1?{type:'custom_tool_call',call_id:'hold-inspect',name:'exec',input:'text(await tools.inspect_circuit({circuit:"main"}));'}
   :{type:'message',id:'steer-final',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'本地协议回放完成。'}]};
  const stream=[{type:'response.created',response:{id}},{type:'response.output_item.done',item},
   {type:'response.completed',response:{id,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}];
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end(stream.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const runtime=path.join(root,'runtime'),profile=path.join(root,'profile'),folder=path.join(root,'workspace');
 fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'untouched.txt'),'unchanged');
 // Exercise the existing packaged-runtime profile boundary with local binaries.
 for(const [relative,command] of [['codex/bin/codex','codex'],['codex/bin/codex-code-mode-host','codex-code-mode-host'],['python/bin/python3','python3']]){
  const target=path.join(runtime,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.symlinkSync(resolveExecutable(command),target);
 }
 fs.writeFileSync(path.join(profile,'provider.toml'),['model = "gpt-5.4"','model_provider = "local_steer"',
  '[model_providers.local_steer]','name = "Local steering protocol fixture"',`base_url = "http://127.0.0.1:${server.address().port}/v1"`,
  'wire_api = "responses"','requires_openai_auth = false','supports_websockets = false'].join('\n'));
 backend=new CodexBackend({workDir:folder,runtimeRoot:runtime,profileDir:profile,sessionStorePath:path.join(root,'conversations.json'),
  circuitManifest:async()=>manifest,agentWorkspace:{
   prepare:async()=>({relative:'.',projectId,revisionId:revision}),synchronize:async()=>snapshot,finish:async()=>null,
  },circuitTool:async request=>{assert.equal(request.tool,'inspect_circuit');held=true;await gate;return {circuit:'main',components:[],invocation:request};}});
 backend.on('event',e=>events.push(e));backend.on('log',()=>{});
 await backend.start();assert.equal(backend.sharedAuthPath,null);assert.equal(backend.status,'ready');
 const stdin=backend.child.stdin,write=stdin.write.bind(stdin);
 stdin.write=(chunk,...args)=>{try{wire.push(JSON.parse(String(chunk)));}catch{}return write(chunk,...args);};
 const first=await backend.ask({question:'先查看电路，等待我的补充。',context,workspaceKey});
 await waitUntil(()=>held&&backend.snapshot().canSteer,{timeout:30000});
 assert.equal(backend.snapshot().turnId,first.turnId);
 await assert.rejects(()=>backend.ask({question:'stale target',context,workspaceKey,expectedTurnId:'old-turn'}),/状态变化/);
 const secondContext={...context,displayedSimulation:{id:'live-1234567890123456'},selectionId:'sel-1234567890123456',selection:{componentIds:['c007'],intent:'focus'},
  materials:[{id:'reference',name:'要求.md',path:'要求.md',quote:'保留原布局',reference:'workspace://file/requirements'}]};
 const accepted=await backend.ask({question:'不要重画整图，只修反馈短接。',context:secondContext,workspaceKey,expectedTurnId:first.turnId});
 assert.equal(accepted.turnId,first.turnId);assert.equal(accepted.steered,true);
 assert.equal(backend.pendingTurn.observationId,secondContext.displayedSimulation.id);
 const acceptedAgain=await backend.ask({question:'复位必须同步。',context,workspaceKey,expectedTurnId:first.turnId});
 assert.equal(acceptedAgain.turnId,first.turnId);assert.equal(backend.pendingTurn.observationId,null);
 release();
 await waitUntil(()=>events.find(e=>e.type==='turn-completed'&&e.turnId===first.turnId),{timeout:30000});
 assert.equal(events.filter(e=>e.type==='turn-started').length,1);
 assert.equal(wire.filter(e=>e.method==='turn/start').length,1);
 assert.equal(wire.filter(e=>e.method==='turn/steer').length,2);
 assert.equal(events.filter(e=>e.type==='user-message').length,3);
 assert.equal(backend.history.filter(m=>m.type==='user').length,3);
 assert.equal(backend.history.filter(m=>m.context?.turnContinuation).length,2);
 const followup=requests.slice(1).map(r=>JSON.stringify(r.input)).join('\n');
 for(const text of ['不要重画整图，只修反馈短接。','复位必须同步。','保留原布局','c007'])assert.ok(followup.includes(text),'missing native model input '+text);
 await assert.rejects(()=>backend.ask({question:'late',context,workspaceKey,expectedTurnId:first.turnId}),/状态变化/);
 assert.equal(wire.filter(e=>e.method==='turn/start').length,1);
 const history=backend.history.filter(m=>m.type==='user').map(m=>m.text);
 const key=backend.workspaceKey;
 await backend.stop();await backend.start();await backend.resumeWorkspace({workspaceKey:key,revisionId:revision});
 // resumeWorkspace restores the real native history via thread/resume.
 assert.deepEqual(backend.history.filter(m=>m.type==='user').map(m=>m.text),history);
 assert.equal(backend.history.filter(m=>m.context?.turnContinuation).length,2);
 const steer=backend.history.find(m=>m.context?.turnContinuation);
 let reverted=false;
 await assert.rejects(()=>revertThroughMessage({source:{threadId:'native',messages:backend.history},messageId:steer.id,assertCurrent(){},
  request:async(method)=>{if(method==='thread/revert')reverted=true;return{thread:{turns:[{id:first.turnId,status:'completed',items:backend.history.filter(m=>m.type==='user').map(m=>({type:'userMessage',id:m.id}))}]}};}}),/同一回合/);
 assert.equal(reverted,false);assert.equal(fs.readFileSync(path.join(folder,'untouched.txt'),'utf8'),'unchanged');
 Object.assign(report,{passed:true,threadId:first.threadId,turnId:first.turnId,nativeRequests:requests.length,
  startCalls:1,steerCalls:2,userMessages:3,reopenedMessages:history,contextReachedModel:true,staleAndEndedTargetsRejected:true,sourceUnchanged:true});
 fs.writeFileSync(path.join(root,'requests.json'),JSON.stringify(requests,null,2));
 fs.writeFileSync(path.join(root,'events.json'),JSON.stringify(events,null,2));
 fs.writeFileSync(path.join(root,'protocol.json'),JSON.stringify(wire,null,2));
}catch(error){report.error=error.stack;process.exitCode=1;}finally{
 release?.();await backend?.stop();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,...report}));
}})();
