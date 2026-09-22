'use strict';
// UI acceptance on a disposable course workspace. Existing conversation is
// restored by the real host; progress/error events are explicitly labelled replay.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require('playwright');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..');
const workspaceIndex=process.argv.indexOf('--workspace');
const existing=workspaceIndex!==-1;
if(existing&&!process.argv[workspaceIndex+1])throw new Error('--workspace needs a disposable course workspace directory');
const root=existing?path.resolve(process.argv[workspaceIndex+1]):fs.mkdtempSync(path.join(os.tmpdir(),'vibe-ai-panel-'));
if(!existing)for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,root+'/'+name);
const historyFixture=[
 {type:'user',id:'fixture-question',text:'界面验收回放：我想理解 IF_ID 中复位、使能和时钟的关系。'},
 {type:'assistant',id:'fixture-progress',phase:'commentary',text:'界面验收回放：先读控制端，再查看寄存器的数据路径。'},
 {type:'assistant',id:'fixture-answer',phase:'final_answer',text:'**界面验收回放，并非新的模型回答。**\n\n### 这三个控制各自做什么\n\n1. 复位清除寄存器保存的值。\n2. 使能决定是否接受新的输入。\n3. 在有效时钟边沿采样。\n\n> 观察输入和输出时，也要一起看控制端。\n\n可以先保留现有结构，再讨论控制线的表达。'},
];
const before=process.argv.includes('--before');
const out=path.join(repo,'apps/desktop/docs/product/evidence/2026-09-15-ai-panel',before?'before':existing?'after':'replay');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const original=fs.readFileSync(root+'/stage6-if-id.circ');
 const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',root+'/stage6-if-id.circ','--no-sandbox'],env});
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const state=()=>page.evaluate(()=>window.vibeDesktop.agent.getState());
 const emit=event=>app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event',event),event);
 try{
  await page.setViewportSize({width:1500,height:960});
  await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});
  const projectBefore=await page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  const initial=await waitUntil(()=>state().then(s=>s.status==='ready'&&(!existing||s.messages.length)&&s),{timeout:90000});
  if(!existing)await emit({type:'history',messages:historyFixture});
  await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
  await page.locator('#fitButton').click();
  await page.screenshot({path:out+'/01-conversation.png'});
  await page.locator('#questionInput').fill('先保留现在的数据路径。\n我想把复位和使能两条控制线整理得更清楚，你先给出建议，我再决定怎么改。');
  await page.screenshot({path:out+'/02-composer.png'});
  await page.locator('#agentModel').click();
  await waitUntil(()=>page.locator(before?'#modelChoice option':'#modelChoice [role=option]').count().then(n=>n>1),{timeout:60000});
  await page.screenshot({path:out+'/03-model.png'});
  await page.locator('#modelClose').click();
  let preference=initial;
  if(!before) {
    const catalog=await page.evaluate(()=>window.vibeDesktop.agent.listModels());
    const alternative=catalog.models.find(m=>m.model!==initial.model&&m.efforts.length);
    await page.locator('#agentModel').click();await page.locator('#modelSearch').fill(alternative.name);
    await waitUntil(()=>page.locator('#modelChoice [role=option]').count().then(n=>n===1));
    await page.locator('#modelSearch').press('ArrowDown');await page.keyboard.press('Enter');
    const depth=alternative.efforts.at(-1).value;
    await page.waitForFunction(()=>!document.querySelector('#modelDialog').open);await page.locator('#agentEffort').click();await page.locator('#effortOptions button[data-effort="'+depth+'"]').click();await waitUntil(()=>state().then(s=>s.effort===depth));
    preference=await state();assert.equal(preference.model,alternative.model);assert.equal(preference.effort,depth);assert.equal(preference.threadId,initial.threadId);
    await page.locator('#agentSettings').click();await page.locator('#connectionModel').getByText(alternative.model,{exact:false}).waitFor();
    await page.screenshot({path:out+'/05-settings.png'});await page.locator('#connectionClose').click();
    await page.locator('#reviewResize').focus();for(let i=0;i<8;i++)await page.keyboard.press('Shift+ArrowLeft');
    assert.ok((await page.locator('#reviewPanel').boundingBox()).width>600);
    await page.screenshot({path:out+'/06-expanded.png'});await page.locator('#reviewResize').focus();await page.keyboard.press('Home');
  }
  const draft=await page.locator('#questionInput').inputValue();
  await emit({type:'status',...preference,status:'busy',busy:true,transmission:{phase:'retrying',message:'界面验收回放：连接暂时中断'}});
  await page.locator('#agentNotice').waitFor({state:'visible'});
  await page.screenshot({path:out+'/04-recovery.png'});
  if(!before) {
    await page.locator('#agentReconnect').click();
    const restored=await waitUntil(()=>state().then(s=>s.status==='ready'&&!s.busy&&s.threadId===initial.threadId&&s),{timeout:90000});
    if(!existing)await emit({type:'history',messages:historyFixture});
    assert.equal(restored.model,preference.model);assert.equal(await page.locator('#questionInput').inputValue(),draft);
    // Restore original local model preference, never change provider/login.
    await page.locator('#agentModel').click();
    await page.locator('#modelChoice [data-model="'+(initial.modelSelection?.model||'')+'"]').click();
    await page.waitForFunction(()=>!document.querySelector('#modelDialog').open);
    if(initial.modelSelection){await page.locator('#agentEffort').click();await page.locator('#effortOptions [data-effort="'+initial.modelSelection.effort+'"]').click();}
    await app.evaluate((_,repo)=>{
      const r=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
      const C=r(repo+'/apps/desktop/electron/codex-backend.cjs').CodexBackend;
      C.prototype.ask=async function(request){
        global.__panelRequest=request;global.__panelAsks=(global.__panelAsks||0)+1;
        this.emit('event',{type:'user-message',id:'panel-replay-user',text:request.question,context:request.context});
        this.emit('event',{type:'turn-started',turnId:'panel-replay-turn'});return {};
      };
      C.prototype.interrupt=async function(){global.__panelInterrupted=true;this.emit('event',{type:'turn-completed',status:'interrupted'});return {interrupted:true};};
      r('electron').shell.openExternal=async url=>{global.__openedPanelURL=url;};
    },repo);
    await page.locator('#questionInput').fill('界面验收回放：讨论复位和使能');
    await page.locator('#questionInput').press('Shift+Enter');
    assert.ok((await page.locator('#questionInput').inputValue()).includes('\n'));
    await page.locator('#questionInput').dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});
    assert.equal(await app.evaluate(()=>global.__panelAsks||0),0,'IME confirmation must not send');
    await page.locator('#questionInput').press('Enter');
    await waitUntil(()=>app.evaluate(()=>global.__panelAsks===1));
    await page.locator('#questionInput').fill('这是写到一半的下一条问题');
    await emit({type:'assistant-started',itemId:'panel-progress',phase:'commentary',text:''});
    await emit({type:'assistant-completed',itemId:'panel-progress',phase:'commentary',text:'界面回放：先读取寄存器的控制端，再检查实际连接。'});
    await emit({type:'activity',itemId:'panel-tool',kind:'tool',activityKey:'circuit:inspect_circuit',status:'running',label:'查看电路'});
    await emit({type:'activity',itemId:'panel-tool',kind:'tool',activityKey:'circuit:inspect_circuit',status:'failed',label:'查看电路',detail:'找不到输入引脚 IR1；请先读取当前接口。'});
    await emit({type:'activity',itemId:'panel-tool-retry',kind:'tool',activityKey:'circuit:inspect_circuit',status:'running',label:'查看电路'});
    await emit({type:'activity',itemId:'panel-tool-retry',kind:'tool',activityKey:'circuit:inspect_circuit',status:'completed',label:'查看电路'});
    assert.equal(await page.locator('.agent-work').last().getAttribute('open'),'');
    await page.locator('.agent-work').last().locator('.agent-tool-batch > summary').click();
    await page.locator('.agent-activity[data-status="failed"] .agent-activity-status').filter({hasText:'调用失败'}).waitFor();
    assert.equal(await page.locator('.agent-activity[data-recovered="true"]').count(),0);
    assert.equal(await page.locator('.agent-activity-detail').textContent(),'找不到输入引脚 IR1；请先读取当前接口。');
    const markdown='**界面验收回放，不是模型新回答。**\n\n### 先看控制关系\n\n1. `RST=1` 时清零。\n2. `FETCH.EN=0` 时保持原值。\n\n> 输入改变不等于寄存器已经写入。\n\n| 信号 | 写入后 | 暂停后 |\n| --- | --- | --- |\n| IF.PC | 0x100 | 0x200 |\n| DECODE.PC | 0x100 | 0x100 |\n\n```text\nRST=0\nFETCH.EN=0\n```\n\n[参考说明](https://cburch.com/logisim/docs/2.7/en/html/libs/mem/register.html)\n\n<img src="https://invalid.example/never-request" onerror="window.panelInjected=true"><a href="javascript:alert(1)">危险链接</a>';
    await emit({type:'assistant-started',itemId:'panel-answer',phase:'final_answer',text:''});
    await emit({type:'assistant-delta',itemId:'panel-answer',phase:'final_answer',delta:markdown});
    const answer=page.locator('[data-item-id="panel-answer"]');
    await answer.locator('table').waitFor();assert.equal(await answer.locator('ol li').count(),2);assert.equal(await answer.locator('img').count(),0);
    assert.equal(await page.evaluate(()=>window.panelInjected),undefined);
    await page.screenshot({path:out+'/07-streaming.png'});
    await page.locator('#agentTimeline').hover();await page.mouse.wheel(0,-900);
    await page.locator('#conversationLatest').waitFor({state:'visible'});
    const top=await page.locator('#agentTimeline').evaluate(n=>n.scrollTop);
    await emit({type:'assistant-delta',itemId:'panel-answer',phase:'final_answer',delta:'\n\n继续观察下一次上升沿。'});
    await page.waitForFunction(()=>document.querySelector('[data-item-id="panel-answer"]').textContent.includes('继续观察'));
    assert.ok(Math.abs(await page.locator('#agentTimeline').evaluate(n=>n.scrollTop)-top)<3,'reading position survives new output');
    await page.locator('#interruptButton').click();assert.equal(await app.evaluate(()=>global.__panelInterrupted),true);
    assert.equal(await page.locator('#questionInput').inputValue(),'这是写到一半的下一条问题');
    await page.locator('#conversationLatest').click();
    assert.equal(await answer.getByRole('button',{name:'引用到问题',exact:true}).count(),0);
    await answer.getByRole('button',{name:'分支到新聊天',exact:true}).waitFor();
    // Native branching and original-draft preservation are exercised by
    // e2e-conversation-fork.cjs; these replayed messages have no native thread.
    assert.equal(await page.locator('#questionInput').inputValue(),'这是写到一半的下一条问题');
    const copied=await app.evaluate(({clipboard})=>clipboard.readText());
    try{await answer.getByRole('button',{name:'复制代码',exact:true}).click();await answer.locator('.chat-code [data-copied=true]').waitFor();assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'RST=0\nFETCH.EN=0\n');}
    finally{await app.evaluate(({clipboard},value)=>clipboard.writeText(value),copied);}
    await answer.getByRole('link',{name:'参考说明'}).click();assert.equal(await app.evaluate(()=>global.__openedPanelURL),'https://cburch.com/logisim/docs/2.7/en/html/libs/mem/register.html');
    assert.equal(await page.evaluate(()=>window.vibeDesktop.openWebLink('file:///etc/passwd').then(()=>false,()=>true)),true);

    // A second protocol turn must get an independent work projection. The
    // final answer remains the primary content even when a tool step failed.
    await emit({type:'turn-started',turnId:'panel-replay-second-turn'});
    await emit({type:'assistant-started',itemId:'panel-second-answer',phase:'final_answer',text:''});
    await emit({type:'assistant-completed',itemId:'panel-second-answer',phase:'final_answer',text:'第二轮回放回答：当前结构仍然可继续讨论。'});
    await emit({type:'activity',itemId:'panel-tool',kind:'tool',activityKey:'circuit:simulate_circuit',status:'failed',label:'检查输入输出',detail:'输入标签不完整，请先读取当前接口。'});
    await emit({type:'turn-completed',turnId:'panel-replay-second-turn',status:'completed'});
    const workSteps=page.locator('.agent-work');
    await waitUntil(()=>workSteps.count().then(n=>n>=2));
    const interruptedWork=page.locator('.agent-work[data-status="interrupted"]');
    const completedWorks=page.locator('.agent-work[data-status="completed"]');
    await waitUntil(()=>interruptedWork.count().then(n=>n===1)&&completedWorks.count().then(n=>n>=2));
    const completedWork=completedWorks.last();
    assert.match(await interruptedWork.locator(':scope > summary span').textContent(),/用时/);
    assert.match(await completedWork.locator(':scope > summary span').textContent(),/用时/);
    assert.equal(await completedWork.locator('.agent-activity[data-status="failed"]').count(),1);
    assert.equal(await page.locator('[data-item-id="panel-second-answer"]').textContent().then(text=>text.includes('第二轮回放回答')),true);

    await page.locator('#questionInput').fill('保留现在的结构，我想再讨论一下控制线的布局。');
    await page.setViewportSize({width:1100,height:760});
    await page.screenshot({path:out+'/08-compact.png'});
    const geometry=await page.locator('#selectionDock').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));assert.ok(geometry.scroll<=geometry.width+1);
    await page.locator('#agentModel').click();await page.locator('#modelChoice [role=option]').first().waitFor();
    const picker=await page.locator('#modelDialog').boundingBox();assert.ok(picker.y>=0&&picker.y+picker.height<=760);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#agentModel').evaluate(n=>n===document.activeElement),true);
  }else await emit({type:'status',...initial,transmission:null});
  assert.deepEqual(errors,[]);
  assert.deepEqual(fs.readFileSync(root+'/stage6-if-id.circ'),original);
  assert.equal((await page.evaluate(()=>fetch('/api/session').then(r=>r.json()))).revision.id,projectBefore.revision.id);
  fs.writeFileSync(out+'/result.json',JSON.stringify({workspace:root,historySource:existing?'actual saved conversation':'labelled UI fixture',restoredMessages:initial.messages.length,threadId:initial.threadId,modelTurns:0,recoveryState:'labelled IPC replay',reconnect:before?'not exercised':'actual thread restore',modelSelection:!before,streaming:before?'not exercised':'labelled IPC replay with actual host request binding',sourceUnchanged:true},null,2));
  console.log(out);
 }catch(error){await page.screenshot({path:out+'/failure.png'}).catch(()=>{});throw error;}finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
