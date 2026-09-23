'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CodexBackend}=require('./codex-backend.cjs');
const {forkThroughReply}=require('./conversation-fork.cjs');
const {POLICY_SIGNATURE}=require('./codex-capabilities.cjs');
const turns=[1,2,3].map(n=>({id:'turn-'+n,status:'completed',items:[
  {type:'userMessage',id:'native-user-'+n,clientId:'user-'+n,content:[{type:'text',text:'question '+n}]},
  {type:'agentMessage',id:'assistant-'+n,text:'answer '+n,phase:'final_answer'},
]}));
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-fork-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const backend=new CodexBackend({workDir:root,profileDir:root+'/profile',sessionStorePath:root+'/sessions.json'});
  const key='folder:one',sourceId=backend.conversationState(key).activeId;
  backend.conversations.remember(key,{threadId:'source',toolContract:{mode:'base',workspaceMode:null,signature:null,
    harnessSignature:POLICY_SIGNATURE,developerInstructionsSha256:backend.developerInstructionsSha256}});
  for(let n=1;n<=3;n++)backend.conversations.remember(key,{messageId:'user-'+n,context:{circuit:'main',materials:[{id:'material-'+n}]}});
  const requests=[],driver={ignoreCut:false,fail:false};
  backend.start=async()=>{backend.status='ready';};backend.model='test-model';
  backend.child={stdin:{destroyed:false,write(line){
    const r=JSON.parse(line);requests.push(r);if(!r.id)return;
    const p=backend.pending.get(String(r.id));clearTimeout(p.timeout);backend.pending.delete(String(r.id));
    if(driver.fail&&r.method==='thread/fork'){p.reject(new Error('分支连接中断'));return;}
    const id=r.params.threadId;
    const result=['thread/read','thread/resume'].includes(r.method)?{thread:{id,turns:id==='source'||driver.ignoreCut?turns:turns.slice(0,1)}}:
      r.method==='thread/fork'?{thread:{id:'child'}}:r.method==='turn/start'?{turn:{id:'turn-child'}}:{data:[]};
    p.resolve(structuredClone(result));
  }}};
  return {backend,key,sourceId,requests,driver};
}
test('fork inherits the selected native prefix and references; continuation targets the child',async t=>{
  const {backend,key,sourceId,requests}=setup(t);
  await backend.resumeWorkspace({workspaceKey:key,revisionId:'r1'});
  const original=backend.conversations.get(key,sourceId);
  const next=await backend.changeConversation(key,'fork',{messageId:'assistant-1'});
  assert.equal(requests.find(r=>r.method==='thread/fork').params.lastTurnId,'turn-1');
  assert.equal(next.conversation.threadId,'child');assert.notEqual(next.activeId,sourceId);
  assert.deepEqual(next.conversation.messages.map(m=>m.text),['question 1','answer 1']);
  assert.deepEqual(Object.keys(next.conversation.messageContexts),['user-1']);
  assert.deepEqual(next.conversation.messages[0].context.materials,[{id:'material-1'}]);
  assert.deepEqual(backend.conversations.get(key,sourceId),original);
  await backend.ask({question:'try a different layout',workspaceKey:key,context:{folder:{id:'folder-aaaaaaaaaaaaaaaa'},revisionId:'r1'}});
  assert.equal(requests.find(r=>r.method==='turn/start').params.threadId,'child');
  await backend.invalidateRevision();
});
test('failed or imprecise native forks never replace the original conversation',async t=>{
  const {backend,key,sourceId,requests,driver}=setup(t);
  await backend.resumeWorkspace({workspaceKey:key,revisionId:'r1'});
  const original=backend.conversationState(key);
  driver.fail=true;
  await assert.rejects(()=>backend.changeConversation(key,'fork',{messageId:'assistant-1'}),/连接中断/);
  assert.deepEqual(backend.conversationState(key),original);
  driver.fail=false;driver.ignoreCut=true;
  await assert.rejects(()=>backend.changeConversation(key,'fork',{messageId:'assistant-1'}),/准确保留/);
  assert.deepEqual(backend.conversationState(key),original);
  assert.equal(backend.threadId,'source');assert.equal(backend.conversationId,sourceId);
  assert.ok(requests.some(r=>r.method==='thread/unsubscribe'&&r.params.threadId==='child'));
  await assert.rejects(()=>backend.changeConversation(key,'fork',{messageId:'another-conversation-message'}),/不属于当前对话/);
});
test('a late fork response is detached when the workspace has changed',async()=>{
  let stale=false;const requests=[];
  const source={threadId:'source',messages:[{type:'assistant',id:'assistant-1'}]};
  await assert.rejects(()=>forkThroughReply({source,messageId:'assistant-1',options:{},assertCurrent(){if(stale)throw new Error('stale workspace');},
    async request(method,params){requests.push({method,params});if(method==='thread/read')return{thread:{id:'source',turns}};
      if(method==='thread/fork'){stale=true;return{thread:{id:'child'}};}return{};}}),/stale workspace/);
  assert.equal(requests.at(-1).method,'thread/unsubscribe');assert.equal(requests.at(-1).params.threadId,'child');
});
