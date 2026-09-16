'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-interactions-'),folder=root+'/course';fs.mkdirSync(folder);
for(const file of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+file,folder+'/'+file);
const source=folder+'/stage6-if-id.circ',original=fs.readFileSync(source);
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-editing-interactions';fs.mkdirSync(out,{recursive:true});
const baseline=process.argv.includes('--baseline'),paced=process.argv.includes('--paced'),env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,phase='launch';const errors=[];
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const scene=()=>page.evaluate(()=>fetch('/api/circuit?name='+encodeURIComponent('◇气泡流水线')).then(r=>r.json()));
const idle=()=>page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false'&&!document.querySelector('#placementToolbar .placement-loading'));
async function world(x,y){return page.locator('#circuitCanvas').evaluate((svg,p)=>{const q=new DOMPoint(p.x,p.y).matrixTransform(svg.getScreenCTM());return{x:q.x,y:q.y};},{x,y});}
(async()=>{try{
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});page=await app.firstWindow();page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});
 await app.evaluate((_,repo)=>{const req=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');req('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model turns in interaction acceptance');};},repo);
 await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◇气泡流水线'&&document.querySelector('#canvasStatus').hidden);await idle();
 const initial=await scene(),count=initial.circuit.components.length,b=initial.circuit.bounds;
 const anchor={x:Math.ceil((b.x+b.width+300)/10)*10,y:Math.ceil((b.y+b.height/2)/10)*10};
 const screen=await world(anchor.x,anchor.y);await page.mouse.move(screen.x,screen.y);for(let i=0;i<30;i++)await page.mouse.wheel(0,-120);
 await page.locator('#addComponentTool').click();await page.locator('#componentSearch').fill('AND Gate');await page.getByRole('button',{name:'与门',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#objectInspector [data-attribute="inputs"]')&&!document.querySelector('#placementToolbar .placement-loading'));
 const inputs=page.locator('#objectInspector [data-attribute="inputs"]');await inputs.selectOption('2').catch(async()=>{await inputs.fill('2');await inputs.press('Enter');});await idle();
 const camera=await page.locator('#circuitCanvas').getAttribute('viewBox');
 const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start');
 phase='continuous large circuit';
 await page.evaluate(()=>{window.__frames=[];window.__tasks=[];window.__track=true;new PerformanceObserver(list=>{if(window.__track)window.__tasks.push(...list.getEntries().map(e=>e.duration));}).observe({type:'longtask',buffered:false});let last=performance.now();function frame(t){if(!window.__track)return;window.__frames.push(t-last);last=t;requestAnimationFrame(frame);}requestAnimationFrame(frame);});
 const started=Date.now();let first;
 for(let i=0;i<6;i++){const p=await world(anchor.x+(i%3)*60,anchor.y+Math.floor(i/3)*90);first??=p;await page.mouse.move(p.x,p.y);await page.mouse.click(p.x,p.y);if(paced)await page.waitForTimeout(150);}
 const clickMilliseconds=Date.now()-started;
 // Esc ends the tool, not the already accepted clicks.
 await page.keyboard.press('Escape');
 await waitUntil(()=>page.evaluate(count=>document.querySelectorAll('.circuit-component').length===count+6,count),{timeout:60000});await idle();
 const completeMilliseconds=Date.now()-started;
 const profile=await cdp.send('Profiler.stop');fs.writeFileSync(root+'/placement.cpuprofile',JSON.stringify(profile.profile));
 assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),camera);
 const timing=await page.evaluate(()=>{window.__track=false;return{maxFrameGap:Math.round(Math.max(...window.__frames)),longTasks:window.__tasks.map(Math.round),componentDom:document.querySelectorAll('.circuit-component').length};});
 await page.waitForFunction(()=>document.querySelector('#detailLayer image'));
 const firstId=await page.evaluate(async anchor=>(await(await fetch('/api/circuit?name='+encodeURIComponent('◇气泡流水线'))).json()).circuit.components.find(c=>c.location.x===anchor.x&&c.location.y===anchor.y).componentId,anchor);
 await page.locator('[data-object-id="'+firstId+'"] .component-hit').click();
 assert.equal(await page.locator('[data-object-id="'+firstId+'"]').evaluate(e=>e.classList.contains('is-selected')),true);
 const beforeDelete=(await session()).revision.id;await page.keyboard.press('Backspace');
 if(!baseline)await waitUntil(()=>session().then(s=>s.revision.id!==beforeDelete),{timeout:10000});await idle();
 const backspaceWorked=(await session()).revision.id!==beforeDelete;
 const selectedComponentDeleted=await page.evaluate(async anchor=>!(await(await fetch('/api/circuit?name='+encodeURIComponent('◇气泡流水线'))).json()).circuit.components.some(c=>c.location.x===anchor.x&&c.location.y===anchor.y),anchor);
 if(!baseline)assert.equal(selectedComponentDeleted,true);
 await page.screenshot({path:out+'/'+(baseline?'before':paced?'paced':'after')+'.png'});
 let undoRestored=false;
 if(!baseline){
   // Typing and explorer focus must not delete objects from the canvas.
   await page.mouse.click((await world(anchor.x+60,anchor.y)).x,(await world(anchor.x+60,anchor.y)).y);
   const revision=(await session()).revision.id;
   await page.locator('#questionInput').fill('测试');await page.locator('#questionInput').press('Backspace');assert.equal(await page.locator('#questionInput').inputValue(),'测');
   await page.locator('#filesTab').click();await page.locator('.file-row[data-path="stage6-if-id.circ"]').focus();await page.keyboard.press('Backspace');
   assert.equal((await session()).revision.id,revision);
   // Delete and all six accepted placements remain seven independent undo steps.
   for(let i=0;i<7;i++){const old=(await session()).revision.id;await page.locator('#circuitCanvas').focus();await page.keyboard.press('Control+z');await waitUntil(()=>session().then(s=>s.revision.id!==old));await idle();}
   undoRestored=fs.readFileSync(source).equals(original);assert.equal(undoRestored,true);
 }

 const result={root,initialComponents:count,success:true,paced,modelTurns:0,clickMilliseconds,completeMilliseconds,...timing,backspaceWorked,selectedComponentDeleted,undoRestored,sourceChanged:!fs.readFileSync(source).equals(original)};
 fs.writeFileSync(out+'/'+(baseline?'before':paced?'paced':'after')+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert.deepEqual(errors,[]);
}catch(error){console.error({root,phase},error);if(page)await page.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}finally{if(app)await app.close();}})();
