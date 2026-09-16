'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-single-placement-'),folder=root+'/course';fs.mkdirSync(folder);
for(const file of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+file,folder+'/'+file);
const source=folder+'/stage6-if-id.circ',original=fs.readFileSync(source),env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-editing-interactions';fs.mkdirSync(out,{recursive:true});
let app,page;const errors=[];const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
async function world(x,y){return page.locator('#circuitCanvas').evaluate((svg,p)=>{const q=new DOMPoint(p.x,p.y).matrixTransform(svg.getScreenCTM());return{x:q.x,y:q.y};},{x,y});}
(async()=>{try{
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});page=await app.firstWindow();page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});
 await app.evaluate((_,repo)=>{const req=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');req('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model turns in single placement acceptance');};const proto=req('./backend.cjs').LensBackend.prototype,original=proto.projectAction;let delayed=false;proto.projectAction=async function(action,...args){if(action==='place'&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,3000));}return original.call(this,action,...args);};},repo);
 await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◇气泡流水线'&&document.querySelector('#canvasStatus').hidden);await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false');
 const scene=await page.evaluate(()=>fetch('/api/circuit?name='+encodeURIComponent('◇气泡流水线')).then(r=>r.json())),count=scene.circuit.components.length,b=scene.circuit.bounds;
 const anchor={x:Math.ceil((b.x+b.width+300)/10)*10,y:Math.ceil((b.y+b.height/2)/10)*10};const screen=await world(anchor.x,anchor.y);
 for(let i=0;i<30;i++)await page.mouse.wheel(0,-120);
 await page.locator('#addComponentTool').click();await page.locator('#componentSearch').fill('AND Gate');await page.getByRole('button',{name:'与门',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#objectInspector [data-attribute="inputs"]')&&!document.querySelector('#placementToolbar .placement-loading'));await page.locator('#objectInspector [data-attribute="inputs"]').selectOption('2');await page.waitForFunction(()=>!document.querySelector('#placementToolbar .placement-loading'));
 const before=(await session()).revision.id;const started=await page.evaluate(()=>performance.now());await page.mouse.move(screen.x,screen.y);await page.mouse.click(screen.x,screen.y);
 await page.locator('.circuit-component[data-optimistic="true"]').waitFor({timeout:1000});const visibleMilliseconds=await page.evaluate(start=>performance.now()-start,started);
 assert.ok(visibleMilliseconds<50,`optimistic component took ${visibleMilliseconds}ms`);assert.equal(await page.locator('.circuit-component').count(),count+1);
 const optimistic=page.locator('.circuit-component[data-optimistic="true"]');
 await page.keyboard.press('Escape');await optimistic.click();
 assert.equal(await optimistic.getAttribute('class').then(value=>value.includes('is-selected')),true);
 const port=optimistic.locator('.wire-port-hit').first();assert.equal(await port.count(),1,await optimistic.evaluate(node=>node.outerHTML));await port.click();await page.waitForTimeout(30);assert.equal(await optimistic.locator('.wire-port-hit.is-wire-start').count(),1,JSON.stringify({class:await port.getAttribute('class'),all:await page.locator('.wire-port-hit.is-wire-start').count(),status:await page.locator('#canvasStatus').innerText(),mode:await page.locator('#circuitCanvas').getAttribute('data-mode'),placing:await page.locator('#circuitCanvas').getAttribute('class')}));
 await waitUntil(()=>session().then(s=>s.revision.id!==before),{timeout:30000});await page.waitForFunction(count=>document.querySelectorAll('.circuit-component').length===count+1,count);
 assert.equal(fs.readFileSync(source).equals(original),false);assert.deepEqual(errors,[]);
 const result={root,success:true,initialComponents:count,visibleMilliseconds:Math.round(visibleMilliseconds),feedbackBudgetMs:50,inMemoryComponentBeforeCommit:true,selectableBeforeCommit:true,wirePortAvailableBeforeCommit:true,commitAfterFeedback:true,sourceChanged:true,modelTurns:0};fs.writeFileSync(out+'/single-placement.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error({root},error);if(page)await page.screenshot({path:out+'/single-placement-failure.png'}).catch(()=>{});process.exitCode=1;}finally{if(app)await app.close();}})();
