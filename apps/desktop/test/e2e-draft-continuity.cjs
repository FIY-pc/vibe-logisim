'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
// Real Electron projects and persistence. Model delivery is an explicit replay.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-drafts-'));
const before=process.argv.includes('--before');
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-15-draft-continuity/'+(before?'before':'after');fs.mkdirSync(out,{recursive:true});
for(const n of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+n,root+'/'+n);
const source=root+'/stage6-if-id.circ',second=root+'/another-design.circ';fs.copyFileSync(source,second);
const original=fs.readFileSync(source),note=root+'/模块设计说明.txt';fs.writeFileSync(note,'暂停写入时，寄存器应保留已有内容。');
const textA='我正在理解 IF_ID 的停顿控制。先保留现有结构，结合这份资料和留存观察讨论。';
const textB='这是另一份工程的问题，请讨论它自己的设计。';
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[];
async function launch(file=source){
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',file,'--no-sandbox'],env});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 // Electron itself handles a prevented unload; Chromium reports a dialog event
 // without a JS dialog. Do not let Playwright auto-dismiss that absent dialog.
 page.on('dialog',dialog=>{if(dialog.type()!=='beforeunload')dialog.dismiss().catch(e=>errors.push(e.message));});
 await page.setViewportSize({width:1500,height:960});await page.locator('#circuitList .circuit-item').first().waitFor({timeout:90000});
 await waitUntil(()=>page.evaluate(()=>window.vibeDesktop.agent.getState()).then(s=>s.status==='ready'),{timeout:90000});
}
const simulation=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
async function picker(files){await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},files);}
async function open(file){await picker([file]);await page.locator('#openButton').click();await waitUntil(()=>page.locator('#workspaceName').textContent().then(t=>t.includes(path.basename(file,'.circ'))),{timeout:60000});await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false'&&!document.querySelector('#questionInput').disabled&&document.querySelector('#canvasStatus').hidden);}
async function prepareDraft(){
 await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click();await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden);
 await picker([note]);await page.locator('#attachMaterials').click();await page.locator('.material-text').waitFor();await page.locator('#materialQuote').click();
 await simulationMenu(page,'simulationStart');await simulationMenu(page,'momentCapture');await page.locator('.moment-chip').waitFor();
 await simulationMenu(page,'simulationStop');await waitUntil(()=>simulation().then(s=>!s.session));
 await page.locator('#findObject').click();await page.locator('#finderInput').fill('FETCH.EN Pin');await page.locator('#finderInput').press('Enter');
 await page.locator('#questionInput').fill(textA);
}
(async()=>{try{
 await launch();await prepareDraft();const first=await session();await page.screenshot({path:out+'/01-project-a.png'});
 await open(second);const switchText=await page.locator('#questionInput').inputValue();await page.screenshot({path:out+'/02-project-b.png'});
 if(before){
   await app.close();app=null;await launch(source);const restartText=await page.locator('#questionInput').inputValue();await page.screenshot({path:out+'/03-reopened.png'});
   fs.writeFileSync(out+'/result.json',JSON.stringify({root,modelTurns:0,observed:{textCarriedIntoOtherProject:switchText===textA,reopenedText:restartText,restoredMaterials:await page.locator('.material-chip').count(),restoredMoments:await page.locator('.moment-chip').count()}},null,2));
 }else {
   assert.equal(switchText,'');assert.equal(await page.locator('.material-chip').count(),0);assert.equal(await page.locator('.moment-chip').count(),0);
   const bProject=(await session()).workspace.id;assert.notEqual(first.workspace.id,bProject);
   await page.locator('#questionInput').fill(textB);await open(source);
   const restored=async text=>{
     await waitUntil(()=>page.locator('#questionInput').inputValue().then(v=>v===text));
     assert.equal(await page.locator('.material-chip').count(),1);assert.equal(await page.locator('.moment-chip').count(),1);
     assert.equal(await page.locator('#currentCircuitName').textContent(),'IF_ID');
     await waitUntil(()=>page.locator('.circuit-component.is-selected').count().then(n=>n===1),{label:'restored selection visible'});
   };
   await restored(textA);await page.screenshot({path:out+'/03-returned-to-a.png'});
   await app.close();app=null;await launch();await restored(textA);
   assert.equal((await simulation()).session,null,'draft restore must not resume a simulation');
   await page.screenshot({path:out+'/04-reopened-with-context.png'});
   // Retained references still open their actual originals after a restart.
   await page.locator('.material-chip-label').click();await page.locator('.material-text').waitFor();await page.locator('#materialsClose').click();
   await page.locator('.moment-chip button').first().click();await page.locator('.moment-image img').waitFor();await page.locator('#momentClose').click();
   await page.getByRole('button',{name:'让 Codex 解释',exact:true}).click();assert.ok((await page.locator('#questionInput').inputValue()).startsWith(textA+'\n\n'));
   await page.locator('#questionInput').fill(textA);
   // The actual main-process request binding stays in place. Only Codex.ask is
   // replayed, so these tests consume no model generation quota.
   await app.evaluate((_,repo)=>{
     const r=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
     const C=r(repo+'/apps/desktop/electron/codex-backend.cjs').CodexBackend;
     global.__draftMode='fail';global.__draftAsks=0;
     C.prototype.ask=async function(request){
       global.__draftAsks++;global.__draftRequest=request;
       if(global.__draftMode==='fail')throw new Error('界面验收回放：连接尚未恢复');
       this.emit('event',{type:'user-message',id:'draft-replay',text:request.question,context:request.context});
       this.emit('event',{type:'turn-started',turnId:'draft-replay'});
       return new Promise(resolve=>{global.__draftComplete=()=>{this.emit('event',{type:'turn-completed',status:'completed'});resolve({});};});
     };
     const D=r(repo+'/apps/desktop/electron/conversation-drafts.cjs').ConversationDraftStore,save=D.prototype.save;
     D.prototype.save=function(...args){if(global.__draftSaveFail)throw new Error('界面验收回放：本机暂时无法写入');return save.apply(this,args);};
   },repo);
   await page.locator('#askButton').click();await waitUntil(()=>app.evaluate(()=>global.__draftAsks===1));
   await page.waitForFunction(()=>!document.querySelector('#askButton').disabled);await restored(textA);
   await app.evaluate(()=>{global.__draftMode='delayed';});await page.locator('#askButton').click();
   await waitUntil(()=>app.evaluate(()=>global.__draftAsks===2));
   const sent=await app.evaluate(()=>({question:global.__draftRequest.question,materials:global.__draftRequest.context.materials,moments:global.__draftRequest.context.keptMoments}));
   assert.equal(sent.question,textA);assert.equal(sent.materials.length,1);assert.equal(sent.moments.length,1);
   const next='上一条已提交。我还想理解暂停期间输入改变时，输出为什么保持。';
   await page.locator('#questionInput').fill(next);
   // Explicitly remove and re-add the same reference while the old send is pending.
   await page.locator('.material-chip [aria-label^="取消引用"]').click();
   await page.locator('#agentMaterials').click();await page.locator('.material-row').first().click();await page.locator('.material-text').waitFor();await page.locator('#materialQuote').click();
   await app.evaluate(()=>global.__draftComplete());
   await page.waitForFunction(()=>!document.querySelector('#askButton').hidden&&!document.querySelector('#askButton').disabled);
   assert.equal(await page.locator('#questionInput').inputValue(),next);assert.equal(await page.locator('.material-chip').count(),1);assert.equal(await page.locator('.moment-chip').count(),0,'only the already sent observation is cleared');
   await page.screenshot({path:out+'/05-next-draft.png'});
   // Local save failure is visible and recoverable without retyping.
   await app.evaluate(()=>{global.__draftSaveFail=true;});await page.locator('#questionInput').fill(next+'先记下这个问题。');
   await page.locator('#draftError').waitFor({state:'visible'});await page.screenshot({path:out+'/06-save-recovery.png'});
   await app.evaluate(({app,dialog})=>{dialog.showMessageBoxSync=()=>{global.__draftCloseWarning=true;return 0;};app.quit();});
   await waitUntil(()=>app.evaluate(()=>global.__draftCloseWarning===true));
   assert.equal((await session()).workspace.id,first.workspace.id,'cancelled quit keeps the backend available');
   assert.equal(await page.locator('#questionInput').inputValue(),next+'先记下这个问题。');
   await open(second);assert.equal(await page.locator('#questionInput').inputValue(),textB);
   assert.ok((await page.locator('#draftErrorText').textContent()).includes('stage6-if-id'),'failed save stays attributed to its original project');
   await app.evaluate(()=>{global.__draftSaveFail=false;});await page.locator('#draftRetry').click();await page.locator('#draftError').waitFor({state:'hidden'});
   await open(source);assert.equal(await page.locator('#questionInput').inputValue(),next+'先记下这个问题。');
   // Block ordinary asynchronous delivery to force the real beforeunload flush.
   await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('vibe-logisim:draft-save');ipcMain.handle('vibe-logisim:draft-save',()=>new Promise(()=>{}));});
   const finalDraft=next+'下次继续讨论，先不修改电路。';await page.locator('#questionInput').fill(finalDraft);
   await app.close();app=null;await launch();
   assert.equal(await page.locator('#questionInput').inputValue(),finalDraft);assert.equal(await page.locator('.material-chip').count(),1);
   await page.screenshot({path:out+'/07-final-reopened.png'});
   await open(second);assert.equal(await page.locator('#questionInput').inputValue(),textB);assert.equal(await page.locator('.material-chip').count(),0);
   await open(source);assert.equal(await page.locator('#questionInput').inputValue(),finalDraft);
   assert.equal((await session()).revision.id,first.revision.id);
   fs.writeFileSync(out+'/result.json',JSON.stringify({root,modelTurns:0,send:'labelled Codex.ask replay with actual host context binding',verified:['project isolation with identical circuit bytes','text and both reference kinds survive switch and restart','exact circuit and selection restored','original reference previews still open','clear and undo','explain appends without overwriting','failed send preserves draft','delayed receipt preserves new text and re-added reference','save failure, cancelled quit and retry from another project','beforeunload flush with asynchronous save deliberately blocked','source and structural revision unchanged','simulation remains stopped']},null,2));

 }
 assert.deepEqual(errors,[]);assert.deepEqual(fs.readFileSync(source),original);assert.deepEqual(fs.readFileSync(second),original);console.log(out);
}catch(e){await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});throw e;}finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
