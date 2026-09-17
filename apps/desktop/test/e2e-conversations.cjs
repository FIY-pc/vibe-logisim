'use strict';
// Mouse/keyboard acceptance of the real Electron workspace, IPC and local stores.
// Historical messages below are explicitly seeded fixtures, not model output.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {_electron}=require('playwright');
const {ConversationStore}=require('../electron/conversation-store.cjs');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-conversations-e2e-'),folder=root+'/电路工作区',otherFolder=root+'/另一个工作区';
fs.mkdirSync(folder);fs.mkdirSync(otherFolder);
const xml='<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(100,100)"/></circuit></project>';
for(const file of ['adder.circ','counter.circ'])fs.writeFileSync(folder+'/'+file,xml);
fs.writeFileSync(folder+'/任务说明.md','请说明进位如何产生，再设计一个计数器。');
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state',VIBE_LOGISIM_CODEX:root+'/no-agent'};
delete env.ELECTRON_RUN_AS_NODE;
let app,page,phase='launch',key,userData;
const errors=[];
async function launch(){
  app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',folder+'/adder.circ'],chromiumSandbox:true,env});
  page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1500,height:960});
  await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden&&!document.querySelector('#questionInput').disabled&&document.querySelector('#questionInput').dataset.conversationId&&document.querySelector('#currentCircuitName').textContent==='main');
  userData=await app.evaluate(({app})=>app.getPath('userData'));
}
const current=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const draft=()=>page.locator('#questionInput');
async function menu(){await page.locator('#conversationPicker').click();await page.locator('#conversationSearch').waitFor();}
async function choose(title){await menu();await page.getByRole('button',{name:'打开对话：'+title,exact:true}).click();await waitUntil(()=>draft().isEnabled());}
async function openFolder(target){
  await app.evaluate(({dialog},target)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]});},target);
  await page.locator('#openButton').click();
  await waitUntil(async()=>(await current()).folder?.root===target);
  const id=(await current()).folder.id;
  await page.waitForFunction(id=>document.querySelector('#questionInput').dataset.workspaceId===id&&!document.querySelector('#questionInput').disabled,id);
}

(async()=>{try{
  await launch();key=(await current()).folder.conversationKey;
  await app.close();app=null;
  const store=new ConversationStore(userData+'/circuit-agent/sessions.json');
  store.remember(key,{threadId:'fixture-existing-thread',messages:[
    {type:'user',id:'history-user',text:'讲解全加器进位'},
    {type:'assistant',id:'history-assistant',text:'历史消息验收夹具：进位为至少两个输入同时为 1。'},
  ]});
  await launch();
  await page.getByText('历史消息验收夹具：进位为至少两个输入同时为 1。',{exact:true}).waitFor();
  assert.equal(await page.locator('#conversationTitle').innerText(),'讲解全加器进位');

  phase='draft and reference survive a new conversation';
  await draft().fill('还想问 A 和 B 同时为 1 的情况');
  await page.locator('.file-row').filter({hasText:'任务说明.md'}).click();
  await page.locator('.material-text').waitFor();await page.locator('#materialQuote').click();
  await page.locator('.material-chip').waitFor();
  await page.locator('#conversationNew').click();
  await page.waitForFunction(()=>document.querySelector('#conversationTitle').textContent==='新对话'&&!document.querySelector('#questionInput').disabled);
  assert.equal(await draft().inputValue(),'');assert.equal(await page.locator('.material-chip').count(),0);
  assert.equal(await page.locator('.agent-message').count(),0);
  await draft().fill('希望计数器能复位');

  phase='rename and find';
  await menu();await page.getByRole('button',{name:'重命名对话：新对话',exact:true}).click();
  await page.getByRole('textbox',{name:'对话名称',exact:true}).fill('四位计数器');
  await page.getByRole('textbox',{name:'对话名称',exact:true}).press('Enter');
  await page.waitForFunction(()=>document.querySelector('#conversationTitle').textContent==='四位计数器');
  await page.locator('#conversationSearch').fill('全加器');
  assert.equal(await page.locator('.conversation-row').count(),1);
  await page.getByRole('button',{name:'打开对话：讲解全加器进位',exact:true}).click();
  await waitUntil(async()=>await draft().inputValue()==='还想问 A 和 B 同时为 1 的情况');
  assert.equal(await page.locator('.material-chip').count(),1);
  assert.equal(await page.locator('.agent-message').count(),2);

  phase='circuit switch keeps the conversation';
  await page.locator('.file-row').filter({hasText:'counter.circ'}).click();
  await waitUntil(async()=>(await current()).folder.activeFile==='counter.circ');
  await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
  assert.equal(await page.locator('#conversationTitle').innerText(),'讲解全加器进位');
  assert.equal(await draft().inputValue(),'还想问 A 和 B 同时为 1 的情况');

  phase='archive, restore and switch';
  await menu();await page.locator('#conversationSearch').fill('');
  await page.getByRole('button',{name:'归档对话：四位计数器',exact:true}).click();
  await page.getByRole('button',{name:'打开对话：四位计数器',exact:true}).waitFor({state:'detached'});
  await page.locator('#conversationArchive').click();
  await page.getByRole('button',{name:'恢复对话：四位计数器',exact:true}).click();
  await page.getByText('没有已归档的对话',{exact:true}).waitFor();
  await page.locator('#conversationArchive').click();
  await page.getByRole('button',{name:'打开对话：四位计数器',exact:true}).click();
  await waitUntil(async()=>await draft().inputValue()==='希望计数器能复位');
  assert.equal(await page.locator('.material-chip').count(),0);
  await menu();await page.screenshot({path:root+'/conversation-history.png'});await page.keyboard.press('Escape');

  phase='restart into the last conversation and its unsent text';
  await app.close();app=null;await launch();
  assert.equal(await page.locator('#conversationTitle').innerText(),'四位计数器');
  assert.equal(await draft().inputValue(),'希望计数器能复位');
  await choose('讲解全加器进位');
  await waitUntil(async()=>await draft().inputValue()==='还想问 A 和 B 同时为 1 的情况');
  assert.equal(await page.locator('.material-chip').count(),1);
  await page.getByText('历史消息验收夹具：进位为至少两个输入同时为 1。',{exact:true}).waitFor();

  phase='folder ownership';
  await openFolder(otherFolder);
  assert.equal(await page.locator('#conversationTitle').innerText(),'新对话');
  assert.equal(await draft().inputValue(),'');assert.equal(await page.locator('.material-chip').count(),0);
  await draft().fill('另一个工作区的问题');
  await menu();assert.equal(await page.locator('.conversation-row').count(),1);await page.keyboard.press('Escape');
  await openFolder(folder);
  assert.equal(await page.locator('#conversationTitle').innerText(),'讲解全加器进位');
  assert.equal(await draft().inputValue(),'还想问 A 和 B 同时为 1 的情况');
  assert.equal(await page.locator('.material-chip').count(),1);
  await page.getByText('历史消息验收夹具：进位为至少两个输入同时为 1。',{exact:true}).waitFor();

  phase='busy guard and keyboard new conversation';
  await menu();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event',{type:'status',status:'busy',busy:true}));
  assert.equal(await page.locator('#conversationNew').isEnabled(),false);
  assert.equal(await page.getByRole('button',{name:'打开对话：四位计数器',exact:true}).isEnabled(),false);
  await page.keyboard.press('Escape');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event',{type:'status',status:'unavailable',busy:false}));
  await draft().focus();await page.keyboard.press('Control+Shift+O');
  await page.waitForFunction(()=>document.querySelector('#conversationTitle').textContent==='新对话'&&!document.querySelector('#questionInput').disabled);
  const before=store.state(key).conversations.length;
  await page.locator('#conversationNew').dblclick();
  await page.waitForFunction(()=>!document.querySelector('#questionInput').disabled);
  assert.equal(store.state(key).conversations.length,before);

  phase='archiving the active conversation preserves its draft';
  await draft().fill('归档后仍能找回这段话');
  await menu();await page.getByRole('button',{name:'归档对话：新对话',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#conversationTitle').textContent!=='新对话'&&!document.querySelector('#questionInput').disabled);
  await page.locator('#conversationArchive').click();
  await page.getByRole('button',{name:'恢复对话：新对话',exact:true}).click();
  await page.getByText('没有已归档的对话',{exact:true}).waitFor();
  await page.locator('#conversationArchive').click();
  await page.getByRole('button',{name:'打开对话：新对话',exact:true}).click();
  await waitUntil(async()=>await draft().inputValue()==='归档后仍能找回这段话');
  assert.equal(fs.readFileSync(folder+'/adder.circ','utf8'),xml);
  assert.equal(fs.readFileSync(folder+'/counter.circ','utf8'),xml);assert.deepEqual(errors,[]);
  const result={root,success:true,modelTurns:0,historicalMessages:'explicit local fixture',draftsAndReferencesIsolated:true,
    renameSearchArchiveRestore:true,circuitSwitchKeepsConversation:true,folderIsolation:true,restartRestoresLastConversation:true,sourceUnchanged:true};
  fs.writeFileSync(root+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page?.screenshot({path:root+'/failure.png'}).catch(()=>{});console.error({root,phase,error,errors});process.exitCode=1;}
finally{await app?.close();}})();
