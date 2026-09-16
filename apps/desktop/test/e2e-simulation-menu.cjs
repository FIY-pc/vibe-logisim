'use strict';
// Desktop keyboard/mouse -> application -> actual HUST Logisim runtime.
// Only delayed/failed transport responses below are injected; observations are native.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-simulation-menu-e2e-'));
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-simulation-menu';fs.mkdirSync(out,{recursive:true});
for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,root+'/'+name);
const source=root+'/stage6-if-id.circ',courseSource=fs.readFileSync(source);
// Actual Clock (IF_ID's CLK is an input pin, so ticks alone cannot prove clock propagation).
const clockFixture=`<circuit name="Clock acceptance"><comp lib="0" name="Clock" loc="(100,100)"><a name="facing" val="east"/><a name="highDuration" val="1"/><a name="lowDuration" val="1"/><a name="label" val="CLOCK"/></comp><comp lib="0" name="Pin" loc="(300,100)"><a name="facing" val="west"/><a name="output" val="true"/><a name="width" val="1"/><a name="label" val="Q"/></comp><wire from="(100,100)" to="(300,100)"/></circuit>`;
fs.writeFileSync(source,courseSource.toString().replace('</project>',clockFixture+'</project>'));const original=fs.readFileSync(source);
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
const errors=[],actions=[],results={root,modelTurns:0};let app,page;
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const sim=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
const visible=id=>page.locator('#'+id).isVisible();
async function live(){return waitUntil(async()=>{const s=await sim();return s.observation&&s.observation.commandSequence>=s.commandSequence&&await page.locator('#runtimeLayer').getAttribute('data-observation-id')===s.observation.id&&s;},{timeout:60000,label:'native observation displayed'});}
async function circuit(name){await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:new RegExp('^'+name+'$')})}).click();await page.waitForFunction(name=>document.querySelector('#currentCircuitName').textContent===name&&document.querySelector('#canvasStatus').hidden,name);}
async function menu(id){if(!await visible('simulationMenu'))await page.locator('#simulationMenuButton').click();await page.locator('#'+id).click();}
async function key(k){await page.locator('#simulationMenuButton').focus();await page.keyboard.press('Control+'+k);}
async function find(label){await page.locator('#findObject').click();await page.locator('#finderInput').fill(label+' Pin');await page.locator('#finderInput').press('Enter');}
const pin=(s,label)=>s.observation.components.find(c=>c.factory==='Pin'&&c.label===label)?.ports[0]?.value;
async function input(label,value){await find(label);const f=page.getByRole('textbox',{name:'输入值',exact:true});await f.fill(String(value));await f.press('Enter');await waitUntil(()=>sim().then(s=>pin(s,label)===value));await live();}
async function shot(name){await page.screenshot({path:out+'/'+name+'.png'});}
(async()=>{try{
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
 await app.evaluate((_,repo)=>{const r=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');r('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model generation in simulation acceptance');};},repo);
 page.on('request',req=>{if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/simulation')actions.push(req.postDataJSON());});
 await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).waitFor({timeout:90000});await circuit('IF_ID');const before=await session();
 assert.equal(await visible('simulationDock'),false);const canvas=await page.locator('#circuitCanvas').boundingBox();
 await shot('01-idle');
 // Editing a question, native dialog and IME must not issue simulation actions.
 await page.locator('#questionInput').fill('先看 IF_ID 的写入行为，再一起讨论。');await page.keyboard.press('Control+k');assert.equal((await sim()).session,null);
 await page.locator('#projectInfo').click();await page.keyboard.press('Control+k');assert.equal((await sim()).session,null);await page.locator('#projectInfoClose').click();
 await page.locator('#simulationMenuButton').focus();await page.dispatchEvent('#simulationMenuButton','keydown',{key:'k',ctrlKey:true,isComposing:true,bubbles:true});assert.equal((await sim()).session,null);
 // Menu navigation is available without a mouse; settings are available before start.
 await page.keyboard.press('ArrowUp');await page.waitForFunction(()=>document.activeElement?.id==='simulationSettings');await page.keyboard.press('Escape');
 await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.activeElement?.id==='simulationStart');await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'simulationSettings');await page.keyboard.press('Enter');
 assert.equal(await visible('simulationOptions'),true);await page.locator('#simulationFrequency').fill('0');await page.locator('#simulationSettingsApply').click();assert.equal(await visible('simulationOptions'),true);assert.equal((await sim()).session,null);
 await page.locator('#simulationFrequency').fill('8');await page.locator('#simulationFrequency').press('Enter');await page.waitForFunction(()=>!document.querySelector('#simulationOptions').open);
 assert.deepEqual(await page.locator('#circuitCanvas').boundingBox(),canvas);
 // Cold K + K, with start still in flight: exactly start/configure/play/pause.
 let releaseStart,delayed=false;const held=new Promise(resolve=>releaseStart=resolve);
 await page.route('**/api/simulation',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='start'&&!delayed){delayed=true;await held;}await route.continue();});
 const offset=actions.length;await key('k');await waitUntil(()=>delayed);await key('k');releaseStart();
 await waitUntil(()=>sim().then(s=>s.session&&!s.running&&s.commandSequence>=4));await live();await page.unroute('**/api/simulation');
 assert.deepEqual(actions.slice(offset).filter(a=>a.action!=='viewport').map(a=>a.action),['start','configure','play','pause']);assert.equal((await sim()).frequency,8);
 assert.equal(await visible('simulationDock'),false);assert.deepEqual(await page.locator('#circuitCanvas').boundingBox(),canvas);
 await input('RST',1);await input('RST',0);await input('FETCH.EN',1);await input('IF.PC',256);await input('IF.IR',19);await input('CLK',1);assert.equal(pin(await live(),'DECODE.PC'),256);
 const instance=(await sim()).session.id;await key('k');await waitUntil(()=>sim().then(s=>s.running));await key('k');await waitUntil(()=>sim().then(s=>!s.running));assert.equal((await sim()).session.id,instance);assert.equal(pin(await live(),'DECODE.PC'),256);
 await page.locator('#simulationMenuButton').click();await shot('02-menu-paused');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'simulationMenuButton');
 const ticks=(await live()).observation.ticks;await key('t');await waitUntil(()=>sim().then(s=>s.observation?.ticks===ticks+1));
 await key('e');await waitUntil(()=>sim().then(s=>!s.automatic));await page.locator('#simulationMenuButton').click();assert.equal(await page.locator('#simulationAutomatic').getAttribute('aria-checked'),'false');await page.keyboard.press('Escape');
 const seq=(await sim()).commandSequence;await key('i');await waitUntil(()=>sim().then(s=>s.commandSequence>seq));assert.equal((await sim()).automatic,false);await key('e');await waitUntil(()=>sim().then(s=>s.automatic));
 const url=page.url();await key('r');await waitUntil(()=>sim().then(s=>s.observation?.ticks===0));assert.equal(page.url(),url);assert.equal(pin(await live(),'IF.PC'),0);assert.equal((await sim()).session.id,instance);
 // Keep only explicitly watched signals in the canvas tray; captures remain reachable after stop.
 await find('FETCH.EN');await page.getByRole('button',{name:'观察端口 0',exact:true}).click();assert.equal(await visible('simulationDock'),true);await live();await menu('momentCapture');await page.locator('.moment-chip').waitFor();
 await menu('simulationSettings');await page.locator('#simulationFrequency').fill('16');await page.keyboard.press('Escape');assert.equal((await sim()).frequency,8);await menu('simulationSettings');assert.equal(await page.locator('#simulationFrequency').inputValue(),'8');await shot('03-settings');await page.locator('#simulationSettingsCancel').click();
 await menu('simulationStop');await waitUntil(()=>sim().then(s=>!s.session));await page.waitForFunction(()=>document.querySelector('#simulationDock').hidden);assert.equal((await session()).revision.id,before.revision.id);
 await menu('momentOpen');await page.locator('.moment-picture').waitFor();await page.locator('#momentClose').click();assert.equal(await page.locator('#questionInput').inputValue(),'先看 IF_ID 的写入行为，再一起讨论。');
 // Independent native Clock proves a tick changes propagated output, not just a counter.
 await circuit('Clock acceptance');await key('t');await waitUntil(()=>sim().then(s=>s.observation?.ticks===1));const clock1=await live();assert.equal(clock1.observation.ticks,1);const q1=pin(clock1,'Q');assert.ok(q1===0||q1===1);
 await key('t');await waitUntil(()=>sim().then(s=>s.observation?.ticks===2));const clock2=await live();assert.equal(pin(clock2,'Q'),1-q1);assert.equal(clock2.frequency,8);
 // Key auto-repeat is suppressed, but a normal key remains effective.
 const repeatTicks=(await sim()).observation.ticks;await page.dispatchEvent('#simulationMenuButton','keydown',{key:'t',ctrlKey:true,repeat:true,bubbles:true});assert.equal((await sim()).observation.ticks,repeatTicks);
 // Freeze exactly the displayed image on F6, even while persistence is delayed.
 await find('Q');await page.getByRole('button',{name:'观察端口 0',exact:true}).click();
 await page.evaluate(()=>{window.capturePresses=[];window.addEventListener('keydown',e=>{
   if(e.key==='F6'&&!e.repeat)window.capturePresses.push({id:document.querySelector('#runtimeLayer').dataset.observationId,
     image:document.querySelector('#runtimeLayer image').getAttribute('href'),value:document.querySelector('.signal-watch strong')?.textContent});
 },true);});
 let releaseCapture;const captureHeld=new Promise(resolve=>releaseCapture=resolve),captureRequests=[];
 await page.route('**/api/moments',async route=>{
   const req=route.request();if(req.method()==='POST'&&req.postDataJSON().action==='capture'){
     captureRequests.push(req.postDataJSON());if(captureRequests.length===1)await captureHeld;
   }await route.continue();
 });
 await key('k');await waitUntil(()=>sim().then(s=>s.running&&s.observation?.ticks>3));
 const captureStart=await sim();await page.locator('#questionInput').focus();const draft=await page.locator('#questionInput').inputValue();
 await page.keyboard.press('F6');await waitUntil(()=>captureRequests.length===1);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'questionInput');assert.equal(await page.locator('#questionInput').inputValue(),draft);
 assert.equal(captureRequests[0].observationId,(await page.evaluate(()=>window.capturePresses))[0].id);
 assert.equal(captureRequests[0].render.url,(await page.evaluate(()=>window.capturePresses))[0].image);
 await page.dispatchEvent('#questionInput','keydown',{key:'F6',repeat:true,bubbles:true});
 // More than eight native frames pass, evicting the original bitmap cache entry.
 await waitUntil(()=>sim().then(s=>s.running&&s.observation?.sequence>captureStart.observation.sequence+12));
 await page.keyboard.press('F6');const presses=await page.evaluate(()=>window.capturePresses);assert.equal(presses.length,2);assert.notEqual(presses[0].id,presses[1].id);
 await menu('simulationStop');await waitUntil(()=>sim().then(s=>!s.session));releaseCapture();
 await waitUntil(()=>page.evaluate(project=>fetch('/api/moments?projectId='+project).then(r=>r.json()),before.workspace.id).then(items=>presses.every(p=>items.some(m=>m.id===p.id))));
 await page.unroute('**/api/moments');assert.equal(captureRequests.length,2);
 for(let i=0;i<2;i++){
   const kept=await page.evaluate(ref=>fetch('/api/moments?'+new URLSearchParams(ref)).then(r=>r.json()),{projectId:before.workspace.id,id:presses[i].id});
   assert.equal(captureRequests[i].observationId,presses[i].id);assert.equal(kept.render.url,presses[i].image);
   assert.equal(kept.signals.find(s=>s.label==='Q').value,Number(BigInt(presses[i].value)));
 }
 await menu('momentOpen');await page.locator('.moment-picture').waitFor();await shot('06-shortcut-capture');await page.locator('#momentClose').click();
 await page.locator('#simulationMenuButton').click();assert.equal(await page.locator('#momentCapture').getAttribute('aria-keyshortcuts'),'F6');await shot('07-capture-shortcut-menu');await page.keyboard.press('Escape');
 // Disabled F6 never creates a run; a dialog does not acquire a new capture.
await page.locator('#projectInfo').click();await page.keyboard.press('F6');await page.locator('#projectInfoClose').click();assert.equal((await sim()).session,null);
 // Restore a Clock run for the independent navigation assertions below.
 await key('t');await waitUntil(()=>sim().then(s=>s.observation?.ticks===1));await live();
 // Browsing another definition must not silently replace the root run.
 const clockSession=(await sim()).session.id;await circuit('IF_ID');await key('t');await waitUntil(()=>sim().then(s=>s.session.id===clockSession&&!s.running));await page.locator('#simulationMenuButton').click();assert.equal(await page.locator('#simulationOwner').textContent(),'Clock acceptance');assert.equal(await visible('simulationReturn'),true);await page.locator('#simulationReturn').click();await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='Clock acceptance');await live();
 await menu('simulationStop');await waitUntil(()=>sim().then(s=>!s.session));await circuit('IF_ID');
 // Ctrl+E from idle enables propagation; a second press pauses it in the same run.
 await key('e');await live();assert.equal((await sim()).automatic,true);assert.equal((await sim()).running,false);
 await page.locator('#simulationMenuButton').click();assert.equal(await page.locator('#simulationAutomatic').getAttribute('aria-checked'),'true');await page.keyboard.press('Escape');
 await key('e');await waitUntil(()=>sim().then(s=>!s.automatic));await menu('simulationStop');await waitUntil(()=>sim().then(s=>!s.session));
 // An unavailable runtime reports a visible, retryable error, with no empty phantom run.
 let fail=true;await page.route('**/api/simulation',async route=>{if(fail&&route.request().method()==='POST'&&route.request().postDataJSON().action==='start'){fail=false;await route.fulfill({status:503,json:{error:{message:'验收注入：运行服务暂不可用'}}});}else await route.continue();});
 await key('k');await page.locator('#simulationError').waitFor();assert.match(await page.locator('#simulationError').innerText(),/运行服务暂不可用/);assert.equal((await sim()).session,null);await shot('04-error-retry');await page.unroute('**/api/simulation');await key('t');await live();assert.equal(await visible('simulationError'),false);assert.equal(await visible('simulationDock'),false);
 await menu('simulationStop');await waitUntil(()=>sim().then(s=>!s.session));
 await page.setViewportSize({width:1024,height:700});await page.locator('#simulationMenuButton').click();await shot('05-compact-menu');const menuBox=await page.locator('#simulationMenu').boundingBox();assert.ok(menuBox.x>=0&&menuBox.y>=0&&menuBox.x+menuBox.width<=1024&&menuBox.y+menuBox.height<=700);await page.keyboard.press('Escape');
 // A queued start belongs to its original project, even if the file picker switches away before it reaches the runtime.
 const second=root+'/other-project.circ';fs.writeFileSync(second,original);let releaseOld,oldReceived=false;
 const oldHeld=new Promise(resolve=>releaseOld=resolve);
 await page.route('**/api/simulation',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='start'&&!oldReceived){oldReceived=true;await oldHeld;}await route.continue();});
 await key('k');await waitUntil(()=>oldReceived);await key('k');
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},second);
 await page.locator('#openButton').click();await waitUntil(()=>session().then(s=>s.workspace.id!==before.workspace.id));
 await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false'&&document.querySelector('#canvasStatus').hidden);
 const oldResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/simulation');releaseOld();await oldResponse;
 await page.unroute('**/api/simulation');assert.equal((await sim()).session,null);
 await key('t');await waitUntil(()=>sim().then(s=>s.observation?.ticks===1));assert.equal((await sim()).session.projectId,(await session()).workspace.id);
 await menu('simulationStop');await waitUntil(()=>sim().then(s=>!s.session));
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},source);await page.locator('#openButton').click();await waitUntil(()=>session().then(s=>s.workspace.id===before.workspace.id));
 assert.deepEqual(fs.readFileSync(second),original);
 assert.deepEqual(fs.readFileSync(source),original);assert.deepEqual(fs.readFileSync(repo+'/exports/interface-editing/stage6-if-id.circ'),courseSource);assert.equal((await session()).revision.id,before.revision.id);assert.deepEqual(errors,[]);
 Object.assign(results,{course:'IF_ID reset, write 256, pause preserves output, reset clears inputs',clock:'Actual Clock changes Q on consecutive ticks; automatic clock runs and pauses',shortcuts:'K T E I R from UI; cold start; ordered rapid K K; ignore repeats and IME',context:'chat and dialogs do not simulate; existing root preserved across circuit navigation; queued old-project keys do not start the newly opened project',settings:'before-start, invalid, apply, cancel, retained through stop/start',canvas:'no height change on start, pause, menu or settings; tray only with watches/errors',recovery:'injected start failure visible; T retries successfully',moments:'F6 and menu share capture; key-time image/signals persist after 12+ frames and stop; consecutive presses survive delayed save; repeats ignored; input focus/draft preserved',sourceUnchanged:true,errors});fs.writeFileSync(out+'/acceptance.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}catch(error){console.error('Runtime:',await sim().then(s=>({session:s.session?.id,view:s.view?.id,running:s.running,command:s.commandSequence,observation:s.observation&&{id:s.observation.id,view:s.observation.viewId,seq:s.observation.sequence,command:s.observation.commandSequence,ticks:s.observation.ticks}})));console.error('DOM:',await page.evaluate(()=>({id:document.querySelector('#runtimeLayer').dataset.observationId,kind:document.querySelector('#documentKind').textContent})));await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});throw error;}finally{await app?.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
