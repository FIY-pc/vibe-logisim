'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ConversationStore} = require('./conversation-store.cjs');
const {ConversationDraftStore} = require('./conversation-drafts.cjs');
const {CodexBackend} = require('./codex-backend.cjs');
const {AgentModelError} = require('./model-errors.cjs');
const pluginManifest = require('../circuit-lens/studio/domain/circuit-plugin.json');
const makeRoot = t => {const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-conversations-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};

test('legacy thread and references survive migration, separate drafts, archive and restart', t => {
  const root=makeRoot(t),file=root+'/sessions.json',key='folder:one',projectId='folder-aaaaaaaaaaaaaaaa';
  const legacy={schema:'vibe-logisim.codex-sessions/v0',workspaces:{[key]:{threadId:'native-old',messageContexts:{question:{selectionId:'selection-kept'}},updatedAt:'2026-09-17T00:00:00Z'}}};
  fs.writeFileSync(file,JSON.stringify(legacy));
  const store=new ConversationStore(file),drafts=new ConversationDraftStore(root+'/drafts');
  const a=store.ensure(key),lease=drafts.open(projectId,1,a.id);
  drafts.save({...lease,sequence:1,draft:{text:'旧问题尚未发送',materials:[],moments:[],focus:null}},1);
  const b=store.change(key,'new').conversation;
  const second=drafts.open(projectId,1,b.id);
  drafts.save({...second,sequence:1,draft:{text:'新的思路',materials:[],moments:[],focus:null}},1);
  drafts.save({...lease,sequence:2,draft:{text:'旧问题最后一次输入',materials:[],moments:[],focus:null}},1);
  store.change(key,'rename',{id:b.id,title:'计数器'}); store.change(key,'archive',{id:a.id});
  assert.equal(store.active(key).id,b.id);
  store.change(key,'restore',{id:a.id});store.change(key,'select',{id:a.id});
  const reopened=new ConversationStore(file);
  assert.equal(reopened.active(key).threadId,'native-old');
  assert.equal(reopened.active(key).messageContexts.question.selectionId,'selection-kept');
  assert.equal(drafts.open(projectId,1,a.id).draft.text,'旧问题最后一次输入');
  assert.equal(drafts.open(projectId,1,b.id).draft.text,'新的思路');
  assert.deepEqual(JSON.parse(fs.readFileSync(file+'.v0-backup')),legacy);
  assert.throws(()=>store.change('folder:another','select',{id:b.id}),/不属于/);
});

test('damaged indexes are preserved instead of replaced by empty histories', t => {
  const file=makeRoot(t)+'/sessions.json';fs.writeFileSync(file,'broken-record');
  assert.throws(()=>new ConversationStore(file).ensure('folder:one'),/原文件仍保留/);
  assert.equal(fs.readFileSync(file,'utf8'),'broken-record');
});

test('selected conversations resume their own native threads; busy turns and missing threads cannot replace history', async t => {
  const root=makeRoot(t),key='folder:one';
  const backend=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json'});
  const requests=[];let serial=0,missing=false;
  // Explicit transport replay. Product thread selection and persistence are real;
  // no app-server process or paid model generation is used by this test.
  backend.start=async()=>{backend.status='ready';};backend.model='test-model';
  backend.child={stdin:{destroyed:false,write(line){
    const request=JSON.parse(line);requests.push(request);
    if(!request.id)return;
    const pending=backend.pending.get(String(request.id));clearTimeout(pending.timeout);backend.pending.delete(String(request.id));
    if(request.method==='thread/resume'&&missing){pending.reject(Object.assign(new Error('thread not found'),{code:-32600}));return;}
    const result=request.method==='thread/start'?{thread:{id:'thread-'+(++serial),turns:[]}}:
      request.method==='thread/resume'?{thread:{id:request.params.threadId,turns:[]}}:
      request.method==='turn/start'?{turn:{id:'turn-'+serial}}:{data:[]};
    pending.resolve(result);
  }}};
  const context={folder:{id:'folder-aaaaaaaaaaaaaaaa'},revisionId:'revision-one'};
  const a=backend.conversationState(key).activeId;
  await backend.ask({question:'全加器',context,workspaceKey:key});
  const inheritedThread=requests.find(request=>request.method==='thread/start');
  const inheritedTurn=requests.find(request=>request.method==='turn/start');
  assert.equal('model' in inheritedThread.params,false);
  assert.equal('model' in inheritedTurn.params,false);
  assert.equal('effort' in inheritedTurn.params,false);
  const liveHistory=backend.history;
  await backend.resumeWorkspace({workspaceKey:key,revisionId:context.revisionId});
  assert.equal(backend.history,liveHistory,'restoring a circuit must not replace live conversation state');
  await assert.rejects(()=>backend.changeConversation(key,'new',{}),/先停止/);
  await backend.invalidateRevision();
  const b=(await backend.changeConversation(key,'new',{})).activeId;
  await backend.ask({question:'计数器',context,workspaceKey:key});await backend.invalidateRevision();
  await backend.changeConversation(key,'select',{id:a});
  await backend.ask({question:'继续讲进位',context,workspaceKey:key});await backend.invalidateRevision();
  assert.equal(requests.filter(r=>r.method==='turn/start').at(-1).params.threadId,'thread-1');
  assert.equal(backend.conversations.get(key,b).threadId,'thread-2');
  assert.equal(backend.conversations.get(key,b).messages[0].text,'计数器');
  assert.equal(backend.conversations.get(key,a).messages[0].text,'全加器');
  assert.equal(backend.conversations.get(key,a).toolContract.mode, 'base');
  assert.match(backend.conversations.get(key,a).toolContract.developerInstructionsSha256, /^[a-f0-9]{64}$/);
  await backend.changeConversation(key,'select',{id:b});missing=true;
  await assert.rejects(()=>backend.ask({question:'再试',context,workspaceKey:key}),/原始会话暂时不可用/);
  assert.equal(requests.filter(r=>r.method==='thread/start').length,2);
  assert.equal(backend.conversations.get(key,b).threadId,'thread-2');
});

test('an explicit app model is sent as an override while inherited config stays native', async t => {
  const root=makeRoot(t),key='folder:model-override';
  const backend=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json'});
  const requests=[];let serial=0;
  backend.start=async()=>{backend.status='ready';};backend.model='local-model';backend.effort='high';
  backend.child={stdin:{destroyed:false,write(line){
    const request=JSON.parse(line);requests.push(request);
    if(!request.id)return;
    const pending=backend.pending.get(String(request.id));clearTimeout(pending.timeout);backend.pending.delete(String(request.id));
    const result=request.method==='thread/start'?{thread:{id:'thread-model-override',turns:[]}}:
      request.method==='turn/start'?{turn:{id:'turn-'+(++serial)}}:{};
    pending.resolve(result);
  }}};
  const context={folder:{id:'folder-aaaaaaaaaaaaaaaa'},revisionId:'revision-one'};
  await backend.ask({question:'沿用本机设置',context,workspaceKey:key});
  await backend.invalidateRevision();
  backend.modelSettings.save({model:'selected-model',effort:'high'});
  backend.model='selected-model';backend.effort='high';
  await backend.ask({question:'使用应用选择',context,workspaceKey:key});
  const turns=requests.filter(request=>request.method==='turn/start');
  assert.equal(turns.length,2);
  assert.deepEqual({model:turns[1].params.model,effort:turns[1].params.effort},{model:'selected-model',effort:'high'});
});

test('a changed circuit plugin contract starts a capable thread while retaining local conversation history', async t => {
  const root=makeRoot(t), key='folder:capability-upgrade';
  const backend=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json',
    circuitTool:async()=>({}), circuitManifest:async()=>pluginManifest});
  backend.start=async()=>{backend.status='ready';};
  const saved=backend.conversationState(key).conversation;
  backend.conversations.remember(key,{threadId:'thread-old',messages:[
    {type:'user',id:'u1',text:'保留这段上下文'},
    {type:'assistant',id:'a1',phase:'final_answer',text:'旧线程回答'},
  ],toolContract:{id:'vibe-logisim.circuit',version:'1.2.0',signature:'old-signature'}});
  const requests=[];
  backend.child={stdin:{destroyed:false,write(line){
    const request=JSON.parse(line);requests.push(request);if(!request.id)return;
    const pending=backend.pending.get(String(request.id));clearTimeout(pending.timeout);backend.pending.delete(String(request.id));
    if(request.method==='thread/resume'){pending.reject(new Error('resume must not be attempted for stale capabilities'));return;}
    const result=request.method==='thread/start'?{thread:{id:'thread-new',turns:[]}}:
      request.method==='mcpServerStatus/list'?{data:[]}:{};
    pending.resolve(result);
  }}};
  const events=[];backend.on('event',event=>events.push(event));
  await backend.resumeWorkspace({workspaceKey:key,revisionId:'revision-current'});
  const record=backend.conversations.get(key,saved.id);
  assert.equal(requests.some(request=>request.method==='thread/resume'),false);
  assert.equal(requests.find(request=>request.method==='thread/start').params.dynamicTools.length>0,true);
  assert.equal(record.threadId,'thread-new');
  assert.deepEqual(record.messages.map(message=>message.text),['保留这段上下文','旧线程回答']);
  assert.deepEqual(record.supersededThreadIds,['thread-old']);
  assert.equal(record.toolContract.signature,backend.circuitTools.registry.signature);
  assert.equal(record.toolContract.mode, 'circuit');
  assert.match(record.toolContract.developerInstructionsSha256, /^[a-f0-9]{64}$/);
  assert.equal(events.find(event=>event.type==='thread-started').capabilityReset,true);
});

test('changed developer instructions start a fresh native thread instead of resuming stale guidance', async t => {
  const root=makeRoot(t), key='folder:instruction-contract';
  const backend=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json',
    developerInstructions:'instructions-v1'});
  backend.start=async()=>{backend.status='ready';};
  const requests=[]; let serial=0;
  const childFor=owner=>({stdin:{destroyed:false,write(line){
    const request=JSON.parse(line); requests.push(request); if(!request.id)return;
    const pending=owner.pending.get(String(request.id)); clearTimeout(pending.timeout); owner.pending.delete(String(request.id));
    const result=request.method==='thread/start'?{thread:{id:'thread-'+(++serial),turns:[]}}:
      request.method==='thread/resume'?{thread:{id:request.params.threadId,turns:[]}}:
      request.method==='mcpServerStatus/list'?{data:[]}:
      request.method==='turn/start'?{turn:{id:'turn-'+serial}}:{};
    pending.resolve(result);
  }}});
  backend.child=childFor(backend); backend.model='test-model';
  const context={folder:{id:'folder-aaaaaaaaaaaaaaaa'},revisionId:'revision-one'};
  await backend.ask({question:'第一版指令',context,workspaceKey:key});
  const firstThread=backend.threadId;
  backend.child = null;
  backend.status = 'stopped';

  const changed=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json',
    developerInstructions:'instructions-v2'});
  changed.start=async()=>{changed.status='ready';};
  changed.child=childFor(changed); changed.model='test-model';
  await changed.resumeWorkspace({workspaceKey:key,revisionId:'revision-one'});
  assert.notEqual(changed.threadId, firstThread);
  assert.equal(changed.conversations.get(key,changed.conversationId).toolContract.developerInstructionsSha256,
    changed.developerInstructionsSha256);
  assert.equal(requests.some(request=>request.method==='thread/resume'), false);
  assert.equal(requests.filter(request=>request.method==='thread/fork').length, 0);
  assert.equal(requests.filter(request=>request.method==='thread/start').length, 2);
  changed.child = null;
});

test('an invalid inherited model is rejected before a turn can admit a native thread', async t => {
  const root=makeRoot(t), key='folder:invalid-inherited-model';
  const backend=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json'});
  backend.start=async()=>{backend.status='ready';};
  backend.child={stdin:{destroyed:false}};
  backend.modelConfigurationError=new AgentModelError('MODEL_UNAVAILABLE',
    '本机配置的模型「stale-model」不在当前连接的模型目录中，请打开模型列表并选择可用模型。',
    {phase:'config',model:'stale-model'});
  const context={folder:{id:'folder-aaaaaaaaaaaaaaaa'},revisionId:'revision-one'};
  await assert.rejects(()=>backend.ask({question:'开始构建',context,workspaceKey:key}),error=>{
    assert.equal(error.code,'MODEL_UNAVAILABLE');
    assert.equal(error.phase,'config');
    assert.match(error.message,/stale-model/);
    return true;
  });
  assert.equal(backend.threadId,null);
  assert.equal(backend.conversationId,null);
});

test('a provider model rejection invalidates the catalog and blocks a repeated native turn', async t => {
  const root=makeRoot(t), key='folder:provider-model-rejection';
  const backend=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json'});
  backend.start=async()=>{backend.status='ready';};
  backend.model='stale-model'; backend.effort='high';
  const requests=[];
  backend.child={stdin:{destroyed:false,writable:true,write(line){
    const request=JSON.parse(line); requests.push(request);
    if (!request.id) return;
    const pending=backend.pending.get(String(request.id));
    clearTimeout(pending.timeout); backend.pending.delete(String(request.id));
    if (request.method==='thread/start') {
      pending.resolve({thread:{id:'thread-provider-rejection',turns:[]}}); return;
    }
    if (request.method==='turn/start') {
      const error=new Error('unexpected status 404 Not Found: The model `stale-model` does not exist or you do not have access to it.');
      error.status=404; pending.reject(error); return;
    }
    pending.resolve({});
  }}};
  const context={folder:{id:'folder-aaaaaaaaaaaaaaaa'},revisionId:'revision-one'};
  await assert.rejects(()=>backend.ask({question:'第一次发送',context,workspaceKey:key}),error=>{
    assert.equal(error.code,'MODEL_UNAVAILABLE');
    assert.equal(error.phase,'turn');
    return true;
  });
  assert.equal(backend.modelConfigurationError.code,'MODEL_UNAVAILABLE');
  assert.equal(backend.modelSettings.state().status,'unknown');
  await assert.rejects(()=>backend.ask({question:'不应重复发送',context,workspaceKey:key}),error=>{
    assert.equal(error.code,'MODEL_UNAVAILABLE');
    return true;
  });
  assert.equal(requests.filter(request=>request.method==='thread/start').length,1);
  assert.equal(requests.filter(request=>request.method==='turn/start').length,1);
});

test('a turn admission failure releases a prepared direct workspace', async t => {
  const root=makeRoot(t), key='folder:direct-admission-failure';
  let aborted = 0;
  const agentWorkspace = {
    async prepare() { return {projectId:'project-1', revisionId:'revision-one', relative:'.', workspaceIndex:{}}; },
    async abort() { aborted += 1; },
  };
  const backend=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json',agentWorkspace});
  backend.start=async()=>{backend.status='ready';};
  backend.model='test-model';
  backend.child={stdin:{destroyed:false,writable:true,write(line){
    const request=JSON.parse(line);if(!request.id)return;
    const pending=backend.pending.get(String(request.id));clearTimeout(pending.timeout);backend.pending.delete(String(request.id));
    if(request.method==='thread/start'){pending.resolve({thread:{id:'thread-direct-failure',turns:[]}});return;}
    if(request.method==='turn/start'){pending.reject(new Error('turn admission failed'));return;}
    pending.resolve({});
  }}};
  const context={folder:{id:'folder-aaaaaaaaaaaaaaaa'},revisionId:'revision-one'};
  await assert.rejects(()=>backend.ask({question:'开始构建',context,workspaceKey:key}),/turn admission failed/);
  assert.equal(aborted,1);
  assert.equal(backend.pendingTurn,null);
});
