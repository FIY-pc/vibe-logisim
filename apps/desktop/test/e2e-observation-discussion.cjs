'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
// Default: real UI/runtime with a labelled response replay. --run-model sends
// one deliberate real question and one continuation, never a routine quota test.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),real=process.argv.includes('--run-model');
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-15-observation-discussion'+(real?'-real':'');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-observation-discussion-'));
 for(const n of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+n,root+'/'+n);
 const source=root+'/stage6-if-id.circ',original=fs.readFileSync(source);
 const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
 let app,page;const errors=[];
 async function launch(){
  app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1500,height:960});
  await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});
  await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='IF_ID'&&document.querySelector('#canvasStatus').hidden,{timeout:90000});
 }
 const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
 const sim=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
 async function find(query){await page.locator('#findObject').click();await page.locator('#finderInput').fill(query);await page.locator('#finderInput').press('Enter');}
 const pin=(s,label)=>s.observation.components.find(c=>c.factory==='Pin'&&c.label===label);
 async function input(label,value){await find(label+' Pin');const f=page.getByRole('textbox',{name:'输入值',exact:true});await f.fill(String(value));await f.press('Enter');await waitUntil(()=>sim().then(s=>pin(s,label)?.ports[0].value===value&&s.observation.commandSequence>=s.commandSequence));}
 async function live(){return waitUntil(async()=>{const s=await sim();return s.observation&&s.observation.commandSequence>=s.commandSequence&&await page.locator('#runtimeLayer').getAttribute('data-observation-id')===s.observation.id&&s;},{timeout:60000});}
 async function capture(title){
  await live();await simulationMenu(page,'momentCapture');
  await waitUntil(()=>page.locator('#momentCapture').isEnabled());
  await simulationMenu(page,'momentOpen');await page.locator('.moment-name').waitFor();
  await page.locator('.moment-name').fill(title);await page.locator('.moment-name').press('Enter');
  await page.locator('#momentList').getByRole('button',{name:title,exact:true}).waitFor();await page.locator('#momentClose').click();
 }
 async function events(){await page.evaluate(()=>{window.discussionEvents=[];window.vibeDesktop.agent.onEvent(e=>{if(['turn-started','turn-completed','assistant-completed','user-message','error'].includes(e.type))window.discussionEvents.push(e);});});}
 async function ask(question){
  const prior=await page.evaluate(()=>window.discussionEvents.length);
  await page.locator('#questionInput').fill(question);await page.locator('#askButton').click();
  const done=await waitUntil(()=>page.evaluate(prior=>window.discussionEvents.slice(prior).find(e=>e.type==='turn-completed'),prior),{timeout:240000,label:'one bounded answer'});
  assert.equal(done.status,'completed',JSON.stringify(done));return done;
 }
 try {
  await launch();const before=await session();
  await simulationMenu(page,'simulationStart');await live();
  await input('RST',1);await input('RST',0);await input('FETCH.EN',1);await input('IF.PC',256);await input('IF.IR',19);await input('CLK',1);
  assert.equal(pin(await live(),'DECODE.PC').ports[0].value,256);
  for(const label of ['IF.PC','DECODE.PC','FETCH.EN','CLK','BRANCH','RST']){await find(label+' Pin');await page.getByRole('button',{name:'观察端口 0',exact:true}).click();}
  await page.locator('#fitButton').click();await capture('写入后');
  await input('CLK',0);await input('FETCH.EN',0);await input('IF.PC',512);await input('CLK',1);
  assert.equal(pin(await live(),'DECODE.PC').ports[0].value,256);await page.locator('#fitButton').click();await capture('暂停写入后');
  const list=await page.evaluate(p=>fetch('/api/moments?projectId='+p).then(r=>r.json()),before.workspace.id);assert.equal(list.length,2);
  const first=list.find(m=>m.title==='写入后'),second=list.find(m=>m.title==='暂停写入后');
  assert.equal(first.signals.find(s=>s.label==='IF.PC').value,256);assert.equal(second.signals.find(s=>s.label==='IF.PC').value,512);
  await simulationMenu(page,'momentOpen');await page.getByRole('checkbox',{name:'选择观察 写入后',exact:true}).check();
  await page.waitForFunction(()=>document.querySelectorAll('.moment-picture').length===2);
  const table=page.locator('.moment-signals');assert.equal(await table.locator('tr[data-changed=true]').count(),2);
  await page.screenshot({path:out+'/01-compared-moments.png'});
  await page.locator('#momentAttach').click();assert.equal(await page.locator('.moment-chip').count(),2);
  await simulationMenu(page,'simulationStop');await waitUntil(()=>sim().then(s=>!s.session));
  await events();await waitUntil(()=>page.evaluate(()=>window.vibeDesktop.agent.getState()).then(s=>s.status==='ready'),{timeout:60000});
  if(real){
   await page.locator('#agentModel').click();await waitUntil(()=>page.locator('#modelChoice [role=option]:not([disabled])').count().then(n=>n>1));
   const state=await page.evaluate(()=>window.vibeDesktop.agent.getState());
   const catalog=await page.evaluate(()=>window.vibeDesktop.agent.listModels());const model=catalog.models.find(m=>m.model===state.model)||catalog.models.find(m=>m.model===state.inheritedModel);assert.ok(model);
   await page.locator('#modelChoice [role=option]').filter({hasText:model.name}).click();await page.locator('#modelEffort button[data-effort="'+(model.efforts.some(e=>e.value==='low')?'low':model.defaultEffort)+'"]').click();await page.locator('#modelSave').click();
   await page.locator('#modelDialog').waitFor({state:'hidden'});
  } else {
   await app.evaluate((_,repo)=>{
    const r=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
    r(repo+'/apps/desktop/electron/codex-backend.cjs').CodexBackend.prototype.ask=async function(request){
     global.__discussionAsk=request;const c=request.context,m=c.keptMoments[0],signal=m.signals.find(s=>s.label==='FETCH.EN');
     this.emit('event',{type:'user-message',id:'replay-user',text:request.question,context:{projectId:c.projectId,circuit:c.circuit,moments:c.keptMoments.map(m=>({id:m.id,title:m.title}))}});
     this.emit('event',{type:'assistant-completed',itemId:'replay-response',text:`界面回放（不是模型回答）：查看 [FETCH.EN](${signal.reference})。`});
     this.emit('event',{type:'turn-completed',status:'completed'});return {};
    };
   },repo);
  }
  if(real)await page.locator('#agentMode').selectOption('review');
  await ask('我保留了 IF_ID 写入前后的两个时刻：为什么 IF.PC 变了，DECODE.PC 没变？请结合这两份观察和当前电路解释，用可以点击的电路引用指出 FETCH.EN 和保存 PC 的寄存器。先解释，不修改文件。');
  const firstThread=(await page.evaluate(()=>window.vibeDesktop.agent.getState())).threadId;
  await page.locator('.circuit-reference').first().waitFor({timeout:10000});
  const link=page.locator('.circuit-reference').first();await link.click();await page.locator('.circuit-component.is-selected').waitFor();
  assert.equal(await page.locator('.moment-chip').count(),0,'sent attachments leave the draft');
  await page.screenshot({path:out+'/02-discussion-and-location.png'});
  await page.locator('.moment-message-link').first().click();await page.locator('.moment-picture').waitFor();await page.locator('#momentClose').click();
  if(!real){const got=await app.evaluate(()=>global.__discussionAsk.context);assert.equal(got.keptMoments.length,2);assert.equal(got.keptMoments[0].signals.length,6);assert.ok(!got.keptMoments[0].render);}
  await find('ID.PC Register');await page.getByRole('textbox',{name:'标签',exact:true}).fill('ID.PC 暂存');await page.getByRole('textbox',{name:'标签',exact:true}).press('Enter');
  await waitUntil(()=>session().then(s=>s.revision.id!==before.revision.id));await page.getByRole('button',{name:'ID.PC 暂存，Register',exact:true}).waitFor();
  assert.equal((await sim()).session,null);
  await link.click();await page.locator('#toast').getByText(/此前版本/).waitFor();
  await simulationMenu(page,'momentOpen');await page.locator('#momentList').getByRole('button',{name:'写入后',exact:true}).click();await page.locator('.moment-meta').getByText(/此前版本/).waitFor();
  await page.screenshot({path:out+'/03-observation-after-edit.png'});await page.locator('#momentClose').click();
  if(real){
   await ask('我已把 PC 寄存器手工改名为“ID.PC 暂存”。请读取当前版本，确认我修改的位置，并在 IF_ID 图下方加一条简短中文注释，说明 FETCH.EN=0 时保持寄存器内容。保留所有元件和连线的位置、逻辑、接口；生成候选让我查看。解释中请引用当前版本的寄存器。');
   assert.equal((await page.evaluate(()=>window.vibeDesktop.agent.getState())).threadId,firstThread);
   await page.locator('#proposalTab').click();await page.getByRole('button',{name:'查看改动',exact:true}).first().click({timeout:60000});
   const manualRevision=(await session()).revision.id;
   await page.locator('#comparisonPrimary').click({timeout:60000});
   await waitUntil(()=>session().then(s=>s.revision.id!==manualRevision));
   await waitUntil(()=>page.getByRole('button',{name:'ID.PC 暂存，Register',exact:true}).count().then(Boolean));
  }
  assert.deepEqual(fs.readFileSync(source),original,'source is only written by explicit Save');
  const after=await session(),logged=await page.evaluate(()=>window.discussionEvents);
  await app.close();app=null;await launch();await simulationMenu(page,'momentOpen');
  await page.locator('#momentList').getByRole('button',{name:'写入后',exact:true}).click();await page.locator('.moment-picture').waitFor();
  assert.equal(await page.locator('.moment-list-row').count(),2,'kept observations survive app restart');
  await page.screenshot({path:out+'/04-reopened-observation.png'});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(out+'/result.json',JSON.stringify({root,projectId:before.workspace.id,revisionBefore:before.revision.id,revisionAfter:after.revision.id,
    observations:list,sourceUnchanged:true,modelTurns:real?2:0,response:real?'actual embedded Codex':'labelled UI replay',events:logged},null,2));
  console.log('Observation discussion complete',root);
 }catch(error){console.error(errors);if(page)await page.screenshot({path:out+'/failure.png'}).catch(()=>{});throw error;}
 finally{if(app)await app.close();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
