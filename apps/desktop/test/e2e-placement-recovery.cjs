'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-placement-recovery-');
const source=root+'/main.circ';fs.copyFileSync(repo+'/apps/desktop/electron/templates/blank.circ',source);const original=fs.readFileSync(source);
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[];
(async()=>{try{
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});
 await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='main'&&document.querySelector('#canvasStatus').hidden);
 await app.evaluate((_,repo)=>{const req=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');req('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model turns');};const proto=req('./backend.cjs').LensBackend.prototype,original=proto.projectAction;let count=0;proto.projectAction=function(action,...args){if(action==='place'&&++count===2)throw new Error('测试：磁盘不可写');return original.call(this,action,...args);};},repo);
 await page.locator('#addComponentTool').click();await page.locator('#componentSearch').fill('AND Gate');await page.getByRole('button',{name:'与门',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#placementToolbar .placement-loading'));
 for(const x of [250,400,550]){const p=await page.locator('#circuitCanvas').evaluate((svg,x)=>{const q=new DOMPoint(x,300).matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y};},x);await page.mouse.click(p.x,p.y);}
 await page.waitForFunction(()=>document.querySelector('#canvasStatus').textContent.includes('后续 1 个未放置')&&!document.querySelector('#placementToolbar .placement-loading'));
 assert.equal(await page.locator('.circuit-component').count(),1);assert.equal(await page.locator('.placement-queued').count(),0);assert.match(await page.locator('#canvasStatus').innerText(),/磁盘不可写/);
 await page.keyboard.press('Escape');await page.locator('#circuitCanvas').focus();await page.keyboard.press('Control+z');await waitUntil(()=>fs.readFileSync(source).equals(original));
 assert.deepEqual(errors,[]);const result={root,success:true,firstClickPreserved:true,rejectedAndCancelledVisible:true,undoExact:true,modelTurns:0};fs.writeFileSync(repo+'/apps/desktop/docs/product/evidence/2026-09-16-editing-interactions/recovery.json',JSON.stringify(result,null,2));console.log(result);
}catch(e){console.error(root,e);if(page)console.error(await page.locator('#canvasStatus').innerText().catch(()=>''));process.exitCode=1;}finally{if(app)await app.close();}})();
