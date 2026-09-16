'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
// Actual Electron + course runtime. No generated model response or cloud writes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-workspace-ux-'));
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-workspace-ux/after';fs.mkdirSync(out,{recursive:true});
for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,root+'/'+name);
const source=root+'/stage6-if-id.circ',original=fs.readFileSync(source),env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[],results={root,modelTurns:0};
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const simulation=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
const visible=id=>page.locator('#'+id).isVisible();
async function launch() {
  app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});
  page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:960});
  // Guard against accidentally running a model from any tested action.
  await app.evaluate((_,repo)=>{
    const r=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
    r('./codex-backend.cjs').CodexBackend.prototype.ask=async function(){throw new Error('This UX acceptance must not generate model turns');};
  },repo);
  await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});
  await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='IF_ID'&&document.querySelector('#canvasStatus').hidden);
  await waitUntil(()=>page.evaluate(()=>window.vibeDesktop.agent.getState()).then(s=>s.status==='ready'),{timeout:90000});
}
async function find(name) {
  await page.locator('#findObject').click();await page.locator('#finderInput').fill(name);
  await page.getByRole('option',{name:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'，')}).click();
}
async function screenshot(name){await page.screenshot({path:out+'/'+name+'.png'});}
(async()=>{
try {
  await launch();const before=await session();
  // A sidecar from an earlier revision must not freeze the current editor.
  let deliveredOldReview=false;
  await page.route('**/api/review',async route=>{deliveredOldReview=true;await route.fulfill({json:{revision:{id:'old-review-revision'},claims:[{kind:'fact',text:'界面验收回放：旧版本记录'}]}});});
  await waitUntil(()=>deliveredOldReview);
  await page.unroute('**/api/review');
  assert.equal(await visible('staleBanner'),false);assert.equal(await page.locator('#canvasStatus').isVisible(),false);
  await page.locator('#questionInput').fill('先保留设计想法，查看连线后再一起讨论。');
  const camera=await page.locator('#circuitCanvas').getAttribute('viewBox');
  const split=page.locator('#inspectorResize'),start=await split.boundingBox();
  await page.mouse.move(start.x+start.width/2,start.y+4);await page.mouse.down();await page.mouse.move(start.x+start.width/2,start.y+104,{steps:8});await page.mouse.up();
  const dragged=await page.locator('#circuitNavigator').boundingBox();assert.ok(dragged.height>start.y-54+80);
  await split.focus();await page.keyboard.press('ArrowUp');
  assert.ok((await page.locator('#circuitNavigator').boundingBox()).height<dragged.height);
  await page.locator('#collapseNavigator').click();assert.equal(await visible('circuitSearch'),false);
  assert.ok((await page.locator('#inspectorSection').boundingBox()).height>750);
  await page.locator('#collapseNavigator').click();
  await page.locator('#collapseInspector').click();assert.equal(await visible('objectInspector'),false);
  await page.locator('#collapseInspector').click();
  assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),camera,'Panel geometry must not reset the camera');
  await find('FETCH.EN');
  const foundCamera=await page.locator('#circuitCanvas').getAttribute('viewBox');
  assert.equal(foundCamera.split(' ')[2],camera.split(' ')[2],'Locating a visible pin must not change scale');
  await page.locator('#evidenceTab').click();assert.equal(await visible('selectionDock'),false);
  assert.match(await page.locator('#connectionList').innerText(),/ID.PC\s+使能\s+ID.IR\s+使能/);
  const sourceTitle=await page.locator('#objectInspector h2').textContent();assert.equal(sourceTitle,'FETCH.EN');
  await screenshot('04-connections');
  await page.locator('.connection-peer').filter({hasText:'ID.PC'}).click();
  assert.equal(await page.locator('#objectInspector h2').textContent(),'ID.PC');
  assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),foundCamera);
  const wirePoint=await page.locator('.wire-group[data-wire-id="w000"] .wire-hit').evaluate(node=>{
    const point=node.getPointAtLength(node.getTotalLength()/2),screen=new DOMPoint(point.x,point.y).matrixTransform(node.getScreenCTM());return {x:screen.x,y:screen.y};
  });
  await page.mouse.click(wirePoint.x,wirePoint.y);
  assert.match(await page.locator('#connectionList').innerText(),/选中导线 · 32 位/);
  assert.equal(await page.locator('#connectionList .connection-peer').count(),2,'A 32-bit bus must group ports rather than repeat 32 bit contacts');
  assert.match(await page.locator('#connectionList').innerText(),/\[31:0\] → \[31:0\]/);
  await find('FETCH.EN');
  await page.locator('#evidenceTab').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#proposalTab').getAttribute('aria-selected'),'true');
  assert.equal(await visible('selectionDock'),false);assert.equal(await visible('proposalCount'),false);
  await page.locator('#agentTab').click();assert.equal(await page.locator('#questionInput').inputValue(),'先保留设计想法，查看连线后再一起讨论。');
  await page.locator('#agentSettings').click();await page.locator('#connectionChooseModel').click();
  await page.locator('#modelChoice [role=option]').nth(1).waitFor({timeout:60000});await screenshot('05-model');await page.locator('#modelClose').click();
  assert.ok(await page.locator('#agentEffort').textContent());
  await page.locator('#projectInfo').click();assert.equal(await page.locator('#projectFileName').textContent(),'stage6-if-id.circ');
  assert.equal(await page.locator('#projectSource').textContent(),root);
  await app.evaluate(({session},root)=>session.defaultSession.once('will-download',(_,item)=>{
    item.setSavePath(root+'/export.zip');item.once('done',(_,state)=>{global.workspaceExportState=state;});
  }),root);
  await page.locator('#exportProject').click();
  assert.equal(await waitUntil(()=>app.evaluate(()=>global.workspaceExportState)),'completed');
  assert.ok(fs.statSync(root+'/export.zip').size>0);
  await screenshot('06-project-info');await page.locator('#projectInfoClose').click();
  await find('FETCH.EN');await page.locator('.appearance-properties summary').click();assert.equal(await page.getByRole('combobox',{name:'标签位置',exact:true}).isVisible(),true);
  await page.locator('.appearance-properties summary').click();
  await simulationMenu(page,'simulationStart');await waitUntil(()=>simulation().then(s=>!!s.observation));
  const dock=await page.locator('#simulationDock').boundingBox();
  const selectedBefore=await page.locator('.circuit-component.is-selected').getAttribute('data-object-id');
  await simulationMenu(page,'simulationSettings');assert.deepEqual(await page.locator('#simulationDock').boundingBox(),dock);
  await page.locator('#simulationFrequency').fill('4');await screenshot('07-running-settings');await page.locator('#simulationFrequency').press('Enter');
  await waitUntil(()=>simulation().then(s=>s.frequency===4));
  await page.waitForFunction(()=>!document.querySelector('#simulationOptions').open);assert.equal(await visible('simulationOptions'),false);
  assert.equal(await page.locator('.circuit-component.is-selected').getAttribute('data-object-id'),selectedBefore);
  const ticks=(await simulation()).observation.ticks;await simulationMenu(page,'simulationTick');await waitUntil(()=>simulation().then(s=>s.observation.ticks>ticks));
  await simulationMenu(page,'momentCapture');await page.locator('.moment-chip').waitFor();
  await simulationMenu(page,'simulationStop');await waitUntil(()=>simulation().then(s=>!s.session));
  assert.equal((await session()).revision.id,before.revision.id);assert.equal(await page.locator('#momentOpen').isEnabled(),true);
  await page.locator('#agentMaterials').click();await page.locator('.material-welcome #materialsAdd').waitFor();assert.equal(await page.locator('.materials-sidebar').isVisible(),false);await screenshot('08-materials-empty');
  const note=root+'/设计说明.md';fs.writeFileSync(note,'# 设计说明\n\n这是体验验收资料。使能控制写入。');
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},note);
  await page.locator('#materialsAdd').click();await page.locator('.material-text').waitFor();assert.equal(await page.locator('.materials-sidebar').isVisible(),true);
  await page.locator('#materialQuote').click();await page.locator('.material-chip').waitFor();
  await page.locator('#editInterface').click();await page.locator('#interfacePortList .interface-port-row').first().waitFor();
  assert.equal(await visible('interfaceProperties'),false);await screenshot('09-interface');await page.locator('#interfaceClose').click();
  await page.locator('#proposalTab').click();await page.locator('#projectHistoryButton').click();await page.locator('#projectHistory button').first().waitFor();await screenshot('10-history');
  await page.locator('#agentTab').click();await screenshot('11-conversation');
  // Tool feedback is an explicit replay, and must not hijack manual focus or
  // leave an unexplained Harness banner over the schematic.
  const selectedId=await page.locator('.circuit-component.is-selected').getAttribute('data-object-id');
  const target=await page.evaluate(()=>fetch('/api/circuit?name=IF_ID').then(r=>r.json()).then(r=>r.circuit.components.find(c=>c.label==='ID.IR').componentId));
  await app.evaluate(({BrowserWindow},data)=>BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event',{
    type:'harness-result',itemId:'ux-feedback-replay',session:{id:'ux-feedback-replay',circuit:'IF_ID',revisionId:data.revision},
    feedback:{status:'failed',targets:[{componentId:data.target}],firstFailure:{tick:1,inputs:{note:'界面验收回放'},outputs:{Q:0},expected:{Q:1}}}
  }),{target,revision:before.revision.id});
  await page.getByRole('button',{name:'定位异常',exact:true}).waitFor();
  assert.equal(await page.locator('.circuit-component.is-selected').getAttribute('data-object-id'),selectedId);
  assert.equal(await visible('canvasStatus'),false);
  await page.getByText('查看输入与输出',{exact:true}).click();await screenshot('14-feedback-replay');
  await page.getByRole('button',{name:'定位异常',exact:true}).click();assert.equal(await page.locator('#objectInspector h2').textContent(),'ID.IR');
  await page.setViewportSize({width:1024,height:700});await screenshot('12-compact');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:760,height:700});await page.locator('#toggleCircuits').click();await page.locator('#collapseNavigator').click();assert.equal(await page.locator('#inspectorResize').isVisible(),true);await screenshot('13-narrow');
  await page.locator('#collapseNavigator').click();await page.setViewportSize({width:1440,height:960});
  await waitUntil(()=>page.evaluate(()=>window.vibeDesktop.getLayout()).then(s=>s?.navigatorShare&&s));
  const saved=await page.evaluate(()=>window.vibeDesktop.getLayout());
  const draft=await page.locator('#questionInput').inputValue();
  assert.deepEqual(fs.readFileSync(source),original);assert.equal((await session()).revision.id,before.revision.id);
  await app.close();await launch();
  assert.equal(await page.locator('#inspectorResize').getAttribute('aria-valuenow'),String(Math.round(saved.navigatorShare*100)));
  assert.equal(await page.locator('#questionInput').inputValue(),draft);assert.equal(await page.locator('.material-chip').count(),1);assert.equal(await page.locator('.moment-chip').count(),1);
  assert.equal((await session()).workspace.id,before.workspace.id);assert.deepEqual(errors,[]);
  Object.assign(results,{layout:'drag-keyboard-collapse-restart',connections:'native IF_ID enable destinations, 32-bit wire ports and canvas locate',feedback:'explicit replay; no automatic selection, locate on click',oldReview:'explicit old-revision replay does not freeze editor',simulation:'frequency-tick-capture-stop',draft:'tabs-layout-restart preserve text and references',project:'metadata and export',materials:'empty-import-preview-quote',interface:'no empty property box; cancel',widths:[1440,1024,760],sourceUnchanged:true,errors});
  fs.writeFileSync(out+'/acceptance.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
} catch(error){if(page)await page.screenshot({path:out+'/failure.png'}).catch(()=>{});throw error;}
finally{await app?.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
