'use strict';
// Actual Electron clicks and actual local Codex fork/resume. Only the historical
// content is a fixture; no turn/start, model output or circuit edits are requested.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {_electron}=require('playwright');
const {ConversationStore}=require('../electron/conversation-store.cjs');
const {seedNativeConversation}=require('./support/native-conversation-fixture.cjs');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-fork-e2e-'),folder=root+'/电路工作区';
fs.mkdirSync(folder);
const xml='<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(100,100)"/></circuit></project>';
fs.writeFileSync(folder+'/adder.circ',xml);
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,store,source,branch,fixture,userData,key,phase='initialize';const errors=[];
const draft=()=>page.locator('#questionInput');
async function launch(){
  app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',folder+'/adder.circ'],chromiumSandbox:true,env});
  page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1500,height:960});
  await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden&&document.querySelector('#questionInput').dataset.conversationId&&!document.querySelector('#questionInput').disabled);
  await waitUntil(()=>page.evaluate(()=>window.vibeDesktop.agent.getState()).then(s=>s.status==='ready'),{timeout:30000});
  userData=await app.evaluate(({app})=>app.getPath('userData'));
  // Hard guard against accidental model use in this acceptance script.
  await app.evaluate((_,repo)=>{
    const req=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
    req('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model turns allowed in fork acceptance');};
  },repo);
}
async function choose(title){
  await page.locator('#conversationPicker').click();await page.getByRole('button',{name:'打开对话：'+title,exact:true}).click();
  await waitUntil(()=>draft().isEnabled());
}
(async()=>{try{
  await launch();key=(await page.evaluate(()=>fetch('/api/session').then(r=>r.json()))).folder.conversationKey;
  await app.close();app=null;
  fixture=seedNativeConversation(userData+'/circuit-agent/codex-home', '/tmp/workspace', process.argv.includes('--legacy')?'legacy':'paginated');
  store=new ConversationStore(userData+'/circuit-agent/sessions.json');store.remember(key,{threadId:fixture.threadId});
  await launch();await page.getByText('验收历史 3：最后讨论流水线。',{exact:true}).waitFor();
  source=store.active(key);
  await draft().fill('原对话里写到一半的问题');
  const first=page.locator('.agent-message[data-role="assistant"]').filter({hasText:'验收历史 1：讲解全加器进位。'});
  assert.equal(await first.getByRole('button',{name:'引用到问题',exact:true}).count(),0);
  const originalRollout=fs.readFileSync(fixture.file);

  phase='fork through first reply using real native context';
  await first.getByRole('button',{name:'分支到新聊天',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#conversationTitle').textContent.endsWith(' · 分支')&&!document.querySelector('#questionInput').disabled);
  branch=store.active(key);
  assert.notEqual(branch.threadId,source.threadId);
  assert.equal(branch.forkedFrom.turnId,fixture.turnIds[0]);
  assert.equal(await page.locator('.agent-message').count(),2);
  assert.equal(await draft().inputValue(),'');
  assert.equal(await page.getByText('验收历史 2：再讨论计数器。',{exact:true}).count(),0);
  assert.deepEqual(fs.readFileSync(fixture.file),originalRollout);
  assert.deepEqual(store.get(key,source.id),source);
  const rollouts=fs.readdirSync(path.dirname(fixture.file));
  const branchFile=rollouts.find(f=>f.endsWith(branch.threadId+'.jsonl'));
  const nativeChild=fs.readFileSync(path.join(path.dirname(fixture.file),branchFile),'utf8');
  const meta=JSON.parse(nativeChild.split('\n')[0]).payload;
  // Paginated native forks persist a parent-prefix reference rather than
  // duplicating rollout bytes; legacy forks materialize the prefix itself.
  let inherited=nativeChild;
  if(Number.isInteger(meta.forked_from_ordinal_exclusive)) {
    assert.equal(meta.forked_from_id,fixture.threadId);
    inherited=originalRollout.toString().trim().split('\n').filter(line=>JSON.parse(line).ordinal<meta.forked_from_ordinal_exclusive).join('\n');
  }
  assert.ok(inherited.includes('LOCAL_TOOL_EVIDENCE_1'),'native tool result must survive the fork');
  assert.ok(!inherited.includes('LOCAL_TOOL_EVIDENCE_2'),'later native context must be excluded');
  await draft().fill('我们在这个分支里换一种接法');
  await page.screenshot({path:root+'/branched-conversation.png'});

  phase='original draft and history stay intact';
  await choose(source.title);assert.equal(await draft().inputValue(),'原对话里写到一半的问题');
  assert.equal(await page.locator('.agent-message').count(),6);
  await choose(branch.title);assert.equal(await draft().inputValue(),'我们在这个分支里换一种接法');

  phase='restart resumes the native child';
  await app.close();app=null;await launch();
  await waitUntil(()=>page.evaluate(()=>window.vibeDesktop.agent.getState()).then(s=>s.threadId===branch.threadId));
  assert.equal(await page.locator('#conversationTitle').innerText(),branch.title);
  assert.equal(await page.locator('.agent-message').count(),2);
  assert.equal(await draft().inputValue(),'我们在这个分支里换一种接法');
  assert.equal(fs.readFileSync(folder+'/adder.circ','utf8'),xml);assert.deepEqual(errors,[]);
  const result={root,success:true,nativeFork:true,nativeResume:true,modelTurns:0,history:'explicit fixture',
    inheritedToolContext:true,laterTurnsExcluded:true,originalDraftPreserved:true,sourceUnchanged:true};
  fs.writeFileSync(root+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page?.screenshot({path:root+'/failure.png'}).catch(()=>{});console.error({root,phase,error,errors});process.exitCode=1;}
finally{await app?.close();}})();
