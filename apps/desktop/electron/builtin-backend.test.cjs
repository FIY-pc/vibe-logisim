'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {BuiltinBackend,recoverTranscript}=require('./builtin-backend.cjs');
const {BuiltinProvider}=require('./builtin-provider.cjs');
const {AgentRuntime}=require('./agent-runtime.cjs');
async function fixture(t,handler){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-builtin-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const requests=[];const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const data=body?JSON.parse(body):{};requests.push(data);handler(req,res,data,requests.length);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const options={workDir:root,profileDir:path.join(root,'profile'),sessionStorePath:path.join(root,'sessions.json'),workspaceHost:{mode:'direct',prepare:async()=>({revisionId:'r',projectId:'p'}),finish:async()=>null,abort:async()=>{},finishEvent:()=>null}};
  const b=new BuiltinBackend(options);t.after(()=>b.stop());
  b.provider.save({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'test-secret-key',model:'test',api:'openai-completions',effort:'none'});await b.start();
  return {root,b,requests,options};
}
function chunk(res,delta,finish=null){res.write('data: '+JSON.stringify({id:'chat-1',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');}
function reply(res,text){res.writeHead(200,{'content-type':'text/event-stream'});chunk(res,{role:'assistant',content:text});chunk(res,{},'stop');res.end('data: [DONE]\n\n');}
const request=(question='test')=>({question,workspaceKey:'workspace',context:{folder:{id:'f'},revisionId:'r',projectId:'p'}});
test('real Pi loop streams, executes one filesystem tool, continues, persists and reloads without replay',async t=>{
 const {b,root,requests,options}=await fixture(t,(_req,res,_body,n)=>{if(n===1){res.writeHead(200,{'content-type':'text/event-stream'});chunk(res,{role:'assistant',content:'正在写入。',tool_calls:[{index:0,id:'call-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'answer.txt',content:'42'})}}]});chunk(res,{},'tool_calls');res.end('data: [DONE]\n\n');}else reply(res,'完成');});
 const events=[];b.on('event',e=>events.push(e));await b.ask(request());await b.run;
 assert.equal(fs.readFileSync(path.join(root,'answer.txt'),'utf8'),'42');assert.equal(requests.length,2);
 assert.ok(requests[1].messages.some(m=>m.role==='tool'&&m.tool_call_id==='call-write'));
 assert.ok(events.some(e=>e.type==='assistant-delta'&&e.delta==='完成'));
 assert.equal(events.findLast(e=>e.type==='turn-completed').status,'completed');
 assert.ok(!JSON.stringify(b.snapshot()).includes('test-secret-key'));
 const reopened=new BuiltinBackend(options);await reopened.start();await reopened.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});
 const savedTool=reopened.history.find(m=>m.type==='activity');assert.equal(savedTool.status,'completed');assert.match(savedTool.detail,/answer.txt/);assert.match(savedTool.detail,/42/);
 assert.equal(reopened.history.find(m=>m.type==='turn').status,'completed');
 assert.equal(reopened.history.filter(m=>m.type==='assistant').length,2);await reopened.ask(request('继续'));await reopened.run;
 assert.equal(requests.length,3);assert.ok(requests[2].messages.some(m=>m.role==='tool'));await reopened.stop();
});
test('stream failure preserves user and earlier completed work; a new prompt can continue',async t=>{
 const {b,requests}=await fixture(t,(_req,res,_body,n)=>{if(n===1){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'bad key'}}));}else reply(res,'恢复');});
 await b.ask(request());await b.run;assert.equal(b.snapshot().transmission.phase,'failed');assert.equal(b.history[0].text,'test');
 await b.ask(request('重试'));await b.run;assert.equal(requests.length,2);assert.equal(b.history.at(-1).text,'恢复');
});
test('interrupt aborts a live HTTP stream and settles busy state',async t=>{
 let observed;const arrived=new Promise(r=>observed=r);
 const {b}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});chunk(res,{role:'assistant',content:'开始'});observed();});
 await b.ask(request());await arrived;await b.interrupt();assert.equal(b.snapshot().busy,false);assert.equal(b.snapshot().transmission.phase,'interrupted');
});
test('provider protocols persist independently and saved key is not reused for another URL',async t=>{
 const {b}=await fixture(t,(_req,res)=>reply(res,'OK'));const visible=b.provider.visible();
 assert.throws(()=>b.provider.save({...visible,baseUrl:'https://another.invalid',apiKey:''}),/密钥/);
 const added=b.provider.save({...visible,api:'anthropic-messages',apiKey:''});assert.equal(b.provider.read(added.id).api,'anthropic-messages');
 assert.equal(b.provider.read().id,visible.id);b.provider.clear(added.id);assert.equal(b.provider.read().id,visible.id);
 b.provider.clear();assert.equal(b.provider.read(),null);
});
test('crash recovery reports an unknown tool outcome and never manufactures success',()=>{
 const raw=[{role:'assistant',content:[{type:'toolCall',id:'c',name:'write_file',arguments:{}}]}];const restored=recoverTranscript(raw);
 assert.equal(restored[1].role,'toolResult');assert.equal(restored[1].isError,true);assert.match(restored[1].content[0].text,/结果未知/);
});
test('legacy thread remains Codex; selecting builtin creates a separate conversation',async t=>{
 const {options}=await fixture(t,(_req,res)=>reply(res,'OK'));const runtime=new AgentRuntime(options);
 const fake=runtime.backends.codex;fake.start=async()=>{fake.status='ready';};fake.stop=async()=>{};fake.resetWorkspace=async()=>{fake.threadId=null;};fake.resumeWorkspace=async()=>{};
 runtime.store.ensure('workspace');runtime.store.remember('workspace',{threadId:'native-old',messages:[{type:'user',id:'u',text:'old'}]});
 const original=runtime.store.active('workspace').id;
 await runtime.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});assert.equal(runtime.kind,'codex');
 await runtime.newRuntimeConversation('builtin');assert.equal(runtime.kind,'builtin');assert.notEqual(runtime.store.active('workspace').id,original);
 assert.equal(runtime.store.get('workspace',original).threadId,'native-old');assert.equal(runtime.store.get('workspace',original).runtime,'codex');
 await runtime.changeConversation('workspace','select',{id:original});assert.equal(runtime.kind,'codex');await runtime.stop();
});
test('Responses adapter uses the configured endpoint and streams a real response',async t=>{
 const {startFakeResponsesServer}=require('../test/support/fake-responses-server.cjs');
 const fake=await startFakeResponsesServer();t.after(()=>fake.close());
 const {b}=await fixture(t,(_req,res)=>reply(res,'unused'));
 b.provider.setDefault(b.provider.save({baseUrl:fake.baseUrl,apiKey:fake.apiKey,model:'probe-chat',api:'openai-responses',effort:'none'}).id);
 await b.ask(request());await b.run;assert.equal(b.history.at(-1).text,'OK');
 assert.equal(fake.requests[0].url,'/v1/responses');
});
test('Anthropic adapter uses Messages with API key authentication',async t=>{
 let auth,url;
 const {b}=await fixture(t,(req,res)=>{auth=req.headers['x-api-key'];url=req.url;res.writeHead(200,{'content-type':'text/event-stream'});
 const send=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
 send({type:'message_start',message:{id:'msg_1',type:'message',role:'assistant',content:[],model:'test',usage:{input_tokens:1,output_tokens:0}}});
 send({type:'content_block_start',index:0,content_block:{type:'text',text:''}});send({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'你好'}});send({type:'content_block_stop',index:0});send({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}});send({type:'message_stop'});res.end();});
 const c=b.provider.read();b.provider.setDefault(b.provider.save({...c,baseUrl:c.baseUrl.replace('/v1',''),api:'anthropic-messages'}).id);
 await b.ask(request());await b.run;assert.equal(b.history.at(-1).text,'你好');assert.equal(new URL(url,'http://test').pathname,'/v1/messages');assert.equal(auth,'test-secret-key');
});
test('circuit tool binding and image blocks reach the next model request',async t=>{
 const {b,requests}=await fixture(t,(_req,res,_body,n)=>{if(n===1){res.writeHead(200,{'content-type':'text/event-stream'});chunk(res,{role:'assistant',tool_calls:[{index:0,id:'circuit-call',type:'function',function:{name:'inspect_test',arguments:'{}'}}]});chunk(res,{},'tool_calls');res.end('data: [DONE]\n\n');}else reply(res,'已读取');});
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=';
 let call;
 b.toolHost={prepare:async()=>{},tools:[{name:'inspect_test',description:'test circuit tool',inputSchema:{type:'object',properties:{}}}],label:n=>n,errorPayload:e=>({message:e.message}),call:async(req,scope)=>{scope.assertCurrent();call=req;assert.equal(scope.pending.revisionId,'r');scope.updateBinding({workspace:{id:'p'},revision:{id:'r2'}});return {status:'observed',modelContentItems:[{type:'inputImage',mimeType:'image/png',imageData:png}]};}};
 b.provider.save({...b.provider.read(),vision:true});await b.ask(request());await b.run;
 assert.equal(call.tool,'inspect_test');assert.equal(b.revisionId,'r2');assert.ok(JSON.stringify(requests[1]).includes('data:image/png;base64,'));
});
test('cancellation while preparing waits for cleanup before a workspace switch',async t=>{
 const {b}=await fixture(t,(_req,res)=>reply(res,'should not send'));let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let aborted=false;
 b.workspaceHost.prepare=async()=>{entered();await gate;return {};};b.workspaceHost.abort=async()=>{aborted=true;};
 const ask=b.ask(request());await started;const stop=b.interrupt();release();await assert.rejects(ask,/已停止/);await stop;assert.equal(aborted,true);assert.equal(b.snapshot().busy,false);
});
test('file tools reject paths and symlinks outside the selected workspace',async t=>{
 const {resolveFile}=require('./builtin-tools.cjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-path-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 await assert.rejects(resolveFile(root,'../escape',true),/工作区/);fs.symlinkSync(os.tmpdir(),path.join(root,'outside'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(resolveFile(root,'outside/new.txt',true),/工作区/);
});
test('stop during a tool prevents subsequent queued tools and waits for the active tool',async t=>{
 let started,release;const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);const calls=[];
 const {b}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});chunk(res,{role:'assistant',tool_calls:[0,1].map(i=>({index:i,id:'call-'+i,type:'function',function:{name:'hold',arguments:'{}'}}))});chunk(res,{},'tool_calls');res.end('data: [DONE]\n\n');});
 b.toolHost={prepare:async()=>{},tools:[{name:'hold',description:'hold',inputSchema:{type:'object',properties:{}}}],label:n=>n,errorPayload:e=>({message:e.message}),call:async(req,scope)=>{scope.assertCurrent();calls.push(req.callId);started();await gate;scope.assertCurrent();return {};}};
 await b.ask(request());await entered;const stop=b.interrupt();assert.equal(b.snapshot().busy,true);release();await stop;assert.deepEqual(calls,['call-0']);assert.equal(b.snapshot().busy,false);
});
test('editing and branching use native transcript checkpoints without changing the source conversation',async t=>{
 const {b,requests}=await fixture(t,(_req,res)=>reply(res,'answer'));
 await b.ask(request('first'));await b.run;const firstUser=b.history[0].id;
 await b.ask(request('second'));await b.run;
 await b.ask({...request('replacement'),editMessageId:firstUser});await b.run;
 assert.equal(b.history.filter(m=>m.type==='user').length,1);assert.equal(b.history[0].text,'replacement');
 assert.ok(!JSON.stringify(requests.at(-1).messages.filter(m=>m.role==='user')).includes('second'));
 const source=b.conversationId,replyId=b.history.at(-1).id;
 await b.changeConversation('workspace','fork',{messageId:replyId});assert.notEqual(b.conversationId,source);assert.equal(b.history.at(-1).text,'answer');
 await b.ask(request('branch'));await b.run;assert.equal(b.conversations.get('workspace',source).messages.filter(m=>['user','assistant'].includes(m.type)).length,2);
});
test('steering queued before stop survives persistence and is not silently dropped',async t=>{
 let arrived;const entered=new Promise(r=>arrived=r);
 const {b,options}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});chunk(res,{role:'assistant',content:'work'});arrived();});
 await b.ask(request());await entered;await b.ask({...request('保留这条补充'),expectedTurnId:b.activeTurnId});await b.interrupt();
 assert.ok(b.history.some(m=>m.type==='user'&&m.text==='保留这条补充'));
 const reopened=new BuiltinBackend(options);await reopened.start();await reopened.resumeWorkspace({workspaceKey:'workspace'});
 assert.ok(reopened.raw.some(m=>m.role==='user'&&String(m.content).includes('保留这条补充')));await reopened.stop();
});

test('Anthropic model discovery uses the same API root and authentication as Messages',async t=>{
 let seen;
 const {b}=await fixture(t,(req,res)=>{seen={url:req.url,headers:req.headers};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'claude-test'}]}));});
 const c=b.provider.read();const result=await b.probeCustomProvider('discover',{...c,baseUrl:c.baseUrl.replace('/v1',''),api:'anthropic-messages'});
 assert.equal(result.ok,true);assert.deepEqual(result.models,['claude-test']);assert.equal(seen.url,'/v1/models');assert.equal(seen.headers['x-api-key'],'test-secret-key');assert.equal(seen.headers['anthropic-version'],'2023-06-01');assert.equal(seen.headers.authorization,undefined);
});
test('a missing Codex runtime still opens the selected local history and keeps every conversation visible',async t=>{
 const {options}=await fixture(t,(_req,res)=>reply(res,'unused'));const runtime=new AgentRuntime(options);
 await runtime.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});
 const builtinId=runtime.store.active('workspace').id;
 runtime.store.remember('workspace',{messages:[{type:'user',id:'new-u',text:'builtin history'}]});
 const old=runtime.store.change('workspace','new').activeId;
 runtime.store.runtimeData('workspace',{runtime:'codex'},old);
 runtime.store.remember('workspace',{threadId:'native-old',messages:[{type:'user',id:'old-u',text:'saved Codex history'}]});
 runtime.store.change('workspace','select',{id:builtinId});
 const events=[];runtime.on('event',e=>events.push(e));
 runtime.backends.codex.start=async()=>{runtime.backends.codex.status='unavailable';throw new Error('Codex executable missing');};
 await assert.rejects(runtime.changeConversation('workspace','select',{id:old}),/executable missing/);
 assert.equal(runtime.snapshot().conversationId,old);
 assert.equal(runtime.snapshot().messages[0].text,'saved Codex history');
 assert.ok(events.some(e=>e.type==='conversations-changed'&&e.activeId===old));
 assert.deepEqual(new Set(runtime.conversationState('workspace').conversations.map(c=>c.id)),new Set([builtinId,old]));
 assert.equal(runtime.store.get('workspace',old).threadId,'native-old');
 await runtime.changeConversation('workspace','select',{id:builtinId});
 assert.equal(runtime.snapshot().messages[0].text,'builtin history');await runtime.stop();
});
test('repeated restoration is idempotent and a new conversation gets no previous runtime transcript',async t=>{
 const {b,options}=await fixture(t,(_req,res)=>reply(res,'saved answer'));await b.ask(request('saved question'));await b.run;
 const before=b.conversations.active('workspace');
 for(let i=0;i<3;i++){
  const reopened=new AgentRuntime(options);await reopened.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});
  assert.equal(reopened.kind,'builtin');assert.equal(reopened.store.active('workspace').id,before.id);
  assert.deepEqual(reopened.snapshot().messages,before.messages);
  assert.deepEqual(reopened.store.active('workspace').runtimeMessages,before.runtimeMessages);
  await reopened.stop();
 }
 const runtime=new AgentRuntime(options);await runtime.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});
 await runtime.changeConversation('workspace','new',{});
 const fresh=runtime.store.active('workspace');assert.notEqual(fresh.id,before.id);
 assert.equal(fresh.threadId,null);assert.deepEqual(runtime.snapshot().messages,[]);assert.deepEqual(runtime.active.raw,[]);
 assert.deepEqual(runtime.store.get('workspace',before.id).runtimeMessages,before.runtimeMessages);
 await runtime.stop();
});
test('model choice belongs to its conversation, survives restart and fork, and uses a rotated credential',async t=>{
 const keys=[];const {b,requests,options}=await fixture(t,(req,res)=>{keys.push(req.headers.authorization);reply(res,'answer');});
 b.provider.save({...b.provider.read(),models:['test','other']});
 await b.ask(request('A'));await b.run;const first=b.conversationId;
 await b.selectModel({model:'other',effort:'none'});assert.equal(b.provider.read().model,'test');
 await b.changeConversation('workspace','new',{});await b.ask(request('B'));await b.run;const second=b.conversationId;
 assert.equal(requests.at(-1).model,'test');
 await b.changeConversation('workspace','select',{id:first});assert.equal(b.snapshot().model,'other');
 b.provider.save({...b.provider.read(),apiKey:'rotated-test-key'});
 const restored=new BuiltinBackend(options);await restored.start();await restored.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});
 await restored.ask(request('A again'));await restored.run;assert.equal(requests.at(-1).model,'other');assert.equal(keys.at(-1),'Bearer rotated-test-key');
 const source=restored.conversations.get('workspace',first);await restored.changeConversation('workspace','fork',{messageId:restored.history.findLast(m=>m.type==='assistant').id});
 assert.deepEqual(restored.selection,source.runtimeSelection);assert.equal(restored.conversations.get('workspace',second).runtimeSelection.model,'test');
 assert.ok(!JSON.stringify(restored.conversations.read()).includes('rotated-test-key'));await restored.stop();
});
test('adding a service and changing the default preserves the old destination across restart; explicit binding moves history',async t=>{
 const {b,requests,options}=await fixture(t,(_req,res)=>reply(res,'answer'));await b.ask(request('private history'));await b.run;
 const original=b.provider.read(),oldId=b.conversationId;
 const alternate=await fixture(t,(_req,res)=>reply(res,'other service'));
 await b.configureCustomProvider({...alternate.b.provider.read()});
 const other=b.provider.list().find(c=>c.id!==original.id);await b.defaultProvider({id:other.id});
 assert.equal(b.snapshot().customProvider.id,original.id);assert.equal(b.snapshot().modelConfigurationError,null);
 const restored=new BuiltinBackend(options);await restored.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});await restored.start();
 await restored.ask(request('continue'));await restored.run;assert.equal(requests.length,2);assert.equal(alternate.requests.length,0);
 await assert.rejects(restored.bindProvider({conversationId:'stale',...other}),/已变化/);
 await restored.bindProvider({conversationId:oldId,...other});await restored.ask(request('other'));await restored.run;
 assert.equal(alternate.requests.length,1);assert.ok(JSON.stringify(alternate.requests[0]).includes('private history'));
 await restored.clearCustomProvider({id:other.id});assert.equal(restored.snapshot().modelConfigurationError.code,'service-missing');
 await assert.rejects(restored.ask(request()),/原模型服务不可用/);assert.equal(requests.length,2);
 await restored.bindProvider({conversationId:oldId,...restored.provider.visible(original.id)});
 assert.equal(restored.snapshot().modelConfigurationError,null);await restored.stop();
});
test('old builtin histories without a service identity require an explicit choice',async t=>{
 const {b,requests}=await fixture(t,(_req,res)=>reply(res,'answer'));
 b.conversations.ensure('workspace');b.conversations.remember('workspace',{threadId:'builtin-old',messages:[{type:'user',id:'old',text:'history'}],runtimeData:{runtime:'builtin'}});
 await b.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});assert.equal(b.snapshot().modelConfigurationError.code,'unbound-history');
 await assert.rejects(b.ask(request()),/尚未记录模型服务/);assert.equal(requests.length,0);
 await b.bindProvider({conversationId:b.conversationId,...b.provider.visible()});assert.equal(b.snapshot().modelConfigurationError,null);
});
test('interrupted history restores tool outcomes and visible partial output without replay or repeated recovery notes',async t=>{
 const {b,options,requests}=await fixture(t,(_req,res)=>reply(res,'unused'));await b.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});
 b.selection=require('./builtin-session.cjs').selectionFor(b.provider.read());
 b.history=[{type:'user',id:'u',text:'task'},{type:'turn',id:'turn',status:'running',startedAt:1},
  {type:'reasoning',id:'thought',text:'visible reasoning'},
  {type:'activity',id:'done',turnId:'turn',label:'读取文件',status:'completed',detail:'actual output'},
  {type:'activity',id:'unknown',turnId:'turn',label:'写入文件',status:'running',detail:'actual arguments'},
  {type:'assistant',id:'partial',text:'partial response',phase:'commentary'}];b.persist();
 const restored=new BuiltinBackend(options);await restored.start();await restored.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});
 assert.equal(restored.history.find(m=>m.id==='done').status,'completed');assert.equal(restored.history.find(m=>m.id==='done').detail,'actual output');
 assert.equal(restored.history.find(m=>m.id==='unknown').status,'warning');assert.match(restored.history.find(m=>m.id==='unknown').detail,/结果未知/);
 assert.equal(restored.history.at(-1).text,'partial response');assert.equal(restored.snapshot().transmission.phase,'interrupted');
 const recovered=structuredClone(restored.history);await restored.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});assert.deepEqual(restored.history,recovered);assert.equal(requests.length,0);await restored.stop();
});
test('an explicitly changed service does not receive the previous service encrypted reasoning for a same-named model',async t=>{
 const {startFakeResponsesServer}=require('../test/support/fake-responses-server.cjs');
 const first=await startFakeResponsesServer(),second=await startFakeResponsesServer();t.after(()=>first.close());t.after(()=>second.close());
 const {b}=await fixture(t,(_req,res)=>reply(res,'unused'));
 b.provider.setDefault(b.provider.save({baseUrl:first.baseUrl,apiKey:first.apiKey,model:'probe-chat',api:'openai-responses',effort:'none'}).id);
 await b.ask(request('first service'));await b.run;
 b.raw.findLast(m=>m.role==='assistant').content.unshift({type:'thinking',thinking:'',thinkingSignature:JSON.stringify({type:'reasoning',id:'rs_old',encrypted_content:'old-service-encrypted-data',summary:[]})});b.persist();
 const next=b.provider.save({...b.provider.read(),baseUrl:second.baseUrl,apiKey:second.apiKey});
 await b.bindProvider({conversationId:b.conversationId,...next});await b.ask(request('second service'));await b.run;
 assert.equal(second.requests.length,1);assert.ok(!JSON.stringify(second.requests[0]).includes('old-service-encrypted-data'));
 assert.equal(b.history.findLast(m=>m.type==='assistant').text,'OK');
});

test('changing the default runtime leaves the active conversation and backend untouched',async t=>{
 const {options}=await fixture(t,(_req,res)=>reply(res,'OK'));const runtime=new AgentRuntime(options);
 await runtime.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});const before=runtime.store.active('workspace').id;
 runtime.store.remember('workspace',{messages:[{type:'user',id:'u',text:'keep'}]});
 let started=false;runtime.backends.codex.start=async()=>{started=true;};
 runtime.setDefaultRuntime('codex');assert.equal(runtime.kind,'builtin');assert.equal(runtime.store.active('workspace').id,before);assert.equal(started,false);
 assert.equal(runtime.snapshot().defaultRuntime,'codex');assert.equal(new AgentRuntime(options).defaultRuntime,'codex');
 runtime.backends.codex.resumeWorkspace=async()=>{};
 await runtime.newRuntimeConversation('builtin');assert.notEqual(runtime.store.active('workspace').id,before);
 assert.equal(runtime.defaultRuntime,'codex');assert.equal(runtime.store.get('workspace',before).messages[0].text,'keep');await runtime.stop();
});
test('legacy single-service storage and endpoint-bound conversations migrate without credentials in session state',async t=>{
 const {b,options}=await fixture(t,(_req,res)=>reply(res,'OK'));const old=b.provider.read();delete old.id;
 fs.writeFileSync(b.provider.file,JSON.stringify(old));const legacy=b.provider.read();assert.ok(legacy.id.startsWith('legacy-'));
 b.conversations.ensure('workspace');b.conversations.remember('workspace',{threadId:'builtin-old',messages:[{type:'user',id:'u',text:'saved'}],runtimeData:{runtime:'builtin',runtimeSelection:{baseUrl:old.baseUrl,api:old.api,model:old.model}}});
 await b.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});assert.equal(b.selection.serviceId,legacy.id);
 b.provider.save({...b.provider.visible(),apiKey:'rotated'});assert.equal(b.provider.registry().version,2);
 const reopened=new BuiltinBackend(options);await reopened.resumeWorkspace({workspaceKey:'workspace'});assert.equal(reopened.snapshot().customProvider.id,legacy.id);
 assert.ok(!JSON.stringify(reopened.snapshot()).includes('rotated'));assert.ok(!JSON.stringify(reopened.conversations.read()).includes('rotated'));await reopened.stop();
});

test('new on an empty conversation honors a changed default runtime without losing the empty record',async t=>{
 const {options}=await fixture(t,(_req,res)=>reply(res,'unused'));const r=new AgentRuntime(options);
 await r.resumeWorkspace({workspaceKey:'workspace',revisionId:'r'});r.setDefaultRuntime('codex');
 r.backends.codex.start=async()=>{r.backends.codex.status='ready';};r.backends.codex.resumeWorkspace=async()=>{};r.backends.codex.stop=async()=>{};
 await r.changeConversation('workspace','new',{});assert.equal(r.kind,'codex');assert.equal(r.store.active('workspace').runtime,'codex');await r.stop();
});
test('different accounts at the same endpoint keep separate credentials and service identities',async t=>{
 const keys=[];const {b,options}=await fixture(t,(req,res)=>{keys.push(req.headers.authorization);reply(res,'OK');});
 await b.ask(request('A'));await b.run;const original=b.provider.read();
 const second=b.provider.save({...original,id:undefined,apiKey:'account-b-key',name:'Account B'});
 assert.notEqual(second.id,original.id);await b.defaultProvider({id:second.id});
 await b.ask(request('still A'));await b.run;assert.equal(keys.at(-1),'Bearer test-secret-key');
 await b.bindProvider({conversationId:b.conversationId,...second});await b.ask(request('B'));await b.run;assert.equal(keys.at(-1),'Bearer account-b-key');
 const restored=new BuiltinBackend(options);await restored.resumeWorkspace({workspaceKey:'workspace'});assert.equal(restored.snapshot().customProvider.id,second.id);
 assert.notEqual(require('./builtin-provider.cjs').modelFor(original).provider,require('./builtin-provider.cjs').modelFor(restored.provider.read(second.id)).provider);await restored.stop();
});
