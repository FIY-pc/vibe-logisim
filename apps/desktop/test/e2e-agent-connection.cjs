'use strict';
// Live model discovery/settings/reconnect; labelled error replay; no model turn.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {_electron}=require('playwright');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..');
const workspace=JSON.parse(fs.readFileSync(repo+'/experiments/004-course-collaboration/evidence/workspace.json'));
const output=repo+'/apps/desktop/docs/product/evidence/2026-09-15-agent-connection';

(async()=>{
 const env={...process.env,XDG_CONFIG_HOME:workspace.root+'/config',VIBE_LOGISIM_STATE_DIR:workspace.root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',workspace.source,'--no-sandbox'],env});
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const state=()=>page.evaluate(()=>window.vibeDesktop.agent.getState());
 const emit=event=>app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event',event),event);
 try{
  await page.setViewportSize({width:1500,height:960});
  await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});
  const before=await waitUntil(()=>state().then(s=>s.status==='ready'&&s.threadId&&s.messages.length&&s),{timeout:90000,label:'saved conversation'});
  const project=await page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  await page.locator('#questionInput').fill('我刚刚移动了输出引脚，请接着解释 IF_ID 的数据路径。');
  await page.locator('#agentModel').click();
  await waitUntil(()=>page.locator('#modelChoice [role=option]').count().then(n=>n>1),{timeout:60000,label:'actual model catalog'});
  const catalog=await page.evaluate(()=>window.vibeDesktop.agent.listModels());
  const alternate=catalog.models.find(m=>m.model!==before.model&&m.efforts.length);
  assert.ok(alternate,'at least one other catalog model for this connection');
  await page.locator('#modelChoice [role=option]').filter({hasText:alternate.name}).click();
  const effort=alternate.efforts.at(-1).value;await page.locator('#modelEffort button[data-effort="'+effort+'"]').click();
  await page.screenshot({path:output+'/01-model-choice.png'});
  await page.locator('#modelSave').click();await page.locator('#modelDialog').waitFor({state:'hidden'});
  const selected=await state();assert.equal(selected.model,alternate.model);assert.equal(selected.effort,effort);assert.equal(selected.threadId,before.threadId);
  const draft=await page.locator('#questionInput').inputValue();
  // Replay repeated transport failures through real IPC. No fake model response.
  for(let i=1;i<=12;i++)await emit({type:'status',...selected,status:'busy',busy:true,transmission:{phase:'retrying',turnId:'replay-only',attempts:i,message:'界面回放：连接暂时中断，正在重试'}});
  await page.locator('#agentNotice').waitFor({state:'visible'});
  assert.equal(await page.locator('#agentNotice').count(),1);
  assert.equal(await page.locator('#agentTimeline').getByText('界面回放：连接暂时中断，正在重试',{exact:true}).count(),0);
  assert.equal(await page.locator('#questionInput').isEnabled(),true);
  assert.equal(await page.locator('#interruptButton').isVisible(),true);
  await page.locator('#agentModel').click();assert.equal(await page.locator('#modelSave').isDisabled(),true);
  await page.locator('#modelClose').click();
  await page.screenshot({path:output+'/02-retry-state.png'});
  await page.locator('#agentReconnect').click();
  const restored=await waitUntil(()=>state().then(s=>s.status==='ready'&&!s.busy&&s.threadId===before.threadId&&s.messages.length&&s),{timeout:90000,label:'actual reconnect and conversation restore'});
  await page.locator('#agentNotice').waitFor({state:'hidden'});
  assert.equal(restored.model,alternate.model);assert.equal(restored.effort,effort);
  assert.equal(await page.locator('#questionInput').inputValue(),draft);
  assert.equal(restored.messages.length,before.messages.length);
  const after=await page.evaluate(()=>fetch('/api/session').then(r=>r.json()));assert.equal(after.revision.id,project.revision.id);assert.equal(after.workspace.id,project.workspace.id);
  // Restore the previous preference through the same visible control.
  await page.locator('#agentModel').click();await waitUntil(()=>page.locator('#modelChoice [role=option]:not([disabled])').count().then(n=>n>1));
  await page.locator('#modelChoice [role=option][data-model="'+(before.modelSelection?.model||'')+'"]').click();
  if(before.modelSelection)await page.locator('#modelEffort button[data-effort="'+before.modelSelection.effort+'"]').click();
  await page.locator('#modelSave').click();await page.locator('#modelDialog').waitFor({state:'hidden'});
  await page.screenshot({path:output+'/03-restored.png'});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(output+'/result.json',JSON.stringify({catalogModels:catalog.models.map(m=>m.model),selected:{model:alternate.model,effort},threadPreserved:true,projectPreserved:true,draftPreserved:true,restoredMessages:restored.messages.length,modelTurns:0,errorScenario:'labelled IPC replay',reconnect:'actual app-server stop, start and thread resume'},null,2));
  console.log('Actual model selection, persisted reconnect, conversation/project/draft preservation; replayed retry banner; no model turns');
 }catch(e){await page.screenshot({path:output+'/failure.png'}).catch(()=>{});throw e;}finally{await app.close();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
