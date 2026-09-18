'use strict';
// Real Electron + course runtime, no model calls. Transport faults are labelled injections.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs'),{simulationMenu}=require('./support/simulation-menu.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-adaptive-render-'));
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-adaptive-render';fs.mkdirSync(out,{recursive:true});
for(const n of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+n,root+'/'+n);
const source=root+'/stage6-if-id.circ',original=fs.readFileSync(source),env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[],requests=[],result={root,modelTurns:0};
const sim=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
async function menu(id){await simulationMenu(page,id);}
async function key(k){await page.locator('#simulationMenuButton').focus();await page.keyboard.press('Control+'+k);}
async function find(q){await page.locator('#findObject').click();await page.locator('#finderInput').fill(q);await page.locator('#finderInput').press('Enter');}
async function circuit(name){await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:new RegExp('^'+name+'$')})}).click();await page.waitForFunction(name=>document.querySelector('#currentCircuitName').textContent===name&&document.querySelector('#canvasStatus').hidden,name);}
const geometry=()=>page.evaluate(()=>{
 const svg=document.querySelector('#circuitCanvas'),matrix=svg.getScreenCTM(),rect=svg.getBoundingClientRect();
 const a=new DOMPoint(rect.left,rect.top).matrixTransform(matrix.inverse()),b=new DOMPoint(rect.right,rect.bottom).matrixTransform(matrix.inverse());
 const layer=document.querySelector('#runtimeLayer'),im=layer.querySelector('image'),bounds=Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(im.getAttribute(k))]));
 return {hidden:document.hidden,visibility:document.visibilityState,bounds,view:{x:a.x,y:a.y,right:b.x,bottom:b.y},scale:Number(layer.dataset.scale),pixelWidth:Number(layer.dataset.pixelWidth),pixelHeight:Number(layer.dataset.pixelHeight),density:matrix.a*devicePixelRatio,dpr:devicePixelRatio,id:layer.dataset.observationId,camera:svg.getAttribute('viewBox')};
});
async function sharp(){return waitUntil(async()=>{
 const g=await geometry();return g.id&&g.scale>=g.density*.98&&g.bounds.x<=g.view.x&&g.bounds.y<=g.view.y&&g.bounds.x+g.bounds.width>=g.view.right&&g.bounds.y+g.bounds.height>=g.view.bottom&&g;
},{timeout:45000,label:'native frame covers current view at screen resolution'});}
async function shot(name){await page.screenshot({path:out+'/'+name+'.png'});}
(async()=>{try{
 app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});page=await app.firstWindow();await page.setViewportSize({width:1500,height:960});page.on('pageerror',e=>errors.push(e.message));
 await app.evaluate((_,repo)=>{const r=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');r('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No generation in viewport acceptance');};},repo);
 page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/simulation')requests.push(r.postDataJSON());});
 await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^◇气泡流水线$/})}).waitFor({timeout:90000});await circuit('◇气泡流水线');const initial=await session();
 const scene=await page.evaluate(()=>fetch('/api/circuit?name='+encodeURIComponent('◇气泡流水线')).then(r=>r.json()));assert.ok(scene.circuit.bounds.height>19000);
 await page.locator('#questionInput').fill('看清数码管和流水线控制信号，再一起讨论。');
 for(let i=0;i<20;i++)await page.locator('#zoomInButton').click();await find('Hex Digit Display');
 await page.locator('#detailLayer image').first().waitFor();await shot('01-static-detail');
 await key('e');await sharp();const paused=await sim(),pausedGeometry=await geometry();const owner=paused.session.id;
 assert.equal(paused.running,false);assert.equal(paused.observation.ticks,0);assert.equal(await page.locator('#detailLayer image').count(),0);
 result.coursePaused=pausedGeometry;await shot('02-live-paused');
 // Pan in live mode without changing circuit values, then zoom beyond the old fit-relative limit.
 const ticks=paused.observation.ticks;await page.locator('#panTool').click();const canvas=await page.locator('#circuitCanvas').boundingBox();
 await page.mouse.move(canvas.x+canvas.width*.55,canvas.y+canvas.height*.5);await page.mouse.down();await page.mouse.move(canvas.x+canvas.width*.55-150,canvas.y+canvas.height*.5+80,{steps:8});await page.mouse.up();
 await sharp();assert.equal((await sim()).observation.ticks,ticks);assert.equal((await sim()).session.id,owner);
 for(let i=0;i<5;i++)await page.locator('#zoomInButton').click();await find('Hex Digit Display');await sharp();assert.ok(Number.parseInt(await page.locator('#zoomReadout').innerText(),10)>2000);
 await page.locator('#selectTool').click();await menu('simulationSettings');await page.locator('#simulationFrequency').fill('16');await page.locator('#simulationFrequency').press('Enter');await page.waitForFunction(()=>!document.querySelector('#simulationOptions').open);await key('k');
 await waitUntil(()=>sim().then(s=>s.running&&s.observation?.ticks>8));await sharp();assert.equal((await sim()).session.id,owner);
 await find('Hex Digit Display');const selected=await page.locator('.circuit-component.is-selected').getAttribute('data-object-id');
 // Change the Chromium display to 2x without changing CSS dimensions.
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1500,height:960,deviceScaleFactor:2,mobile:false});await page.waitForFunction(()=>Math.abs(devicePixelRatio-2)<.001);const hidpi=await sharp();
 assert.ok(hidpi.pixelWidth<=4096&&hidpi.pixelHeight<=4096&&hidpi.pixelWidth*hidpi.pixelHeight<=8_000_000);result.hidpi=hidpi;await shot('03-running-hidpi');
 assert.equal(await page.locator('.circuit-component.is-selected').getAttribute('data-object-id'),selected);assert.equal(await page.locator('#questionInput').inputValue(),'看清数码管和流水线控制信号，再一起讨论。');
 // F6 retains exactly the newly rendered native viewport while the clock continues.
 await page.evaluate(()=>{window.frameAtCapture=null;window.addEventListener('keydown',e=>{if(e.key==='F6')window.frameAtCapture={id:document.querySelector('#runtimeLayer').dataset.observationId,url:document.querySelector('#runtimeLayer image').getAttribute('href')};},true);});
 await page.keyboard.press('F6');const captured=await page.evaluate(()=>window.frameAtCapture);await waitUntil(()=>page.evaluate(ref=>fetch('/api/moments?'+new URLSearchParams(ref)).then(r=>r.json()),{projectId:initial.workspace.id,id:captured.id}).then(m=>m.render?.url===captured.url));assert.equal((await sim()).running,true);
 await key('k');await waitUntil(()=>sim().then(s=>!s.running));
 // Real viewport failure: retain the previous live frame, then retry at the current camera.
 const oldFrame=(await geometry()).id;await page.route('**/api/simulation',async route=>{
   if(route.request().method()==='POST'&&route.request().postDataJSON().action==='viewport')await route.fulfill({status:503,json:{error:{message:'验收注入：局部绘图暂不可用'}}});else await route.continue();
 });
 await page.locator('#zoomOutButton').click();await page.getByRole('button',{name:'细节未加载 · 重试',exact:true}).waitFor();assert.ok((await geometry()).id);assert.equal((await sim()).session.id,owner);
 await page.unroute('**/api/simulation');await page.locator('#renderStatus').click();await sharp();assert.equal(await page.locator('#simulationError').isVisible(),false);
 // An old live viewport cannot overwrite a newly selected running instance.
 let release,held=false;const gate=new Promise(resolve=>release=resolve);
 await page.route('**/api/simulation',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='viewport'&&!held){held=true;const response=await route.fetch();await gate;await route.fulfill({response});}else await route.continue();});
 await page.locator('#zoomOutButton').click();await waitUntil(()=>held);await circuit('IF_ID');release();await page.unrouteAll({behavior:'wait'});
 await menu('simulationStop');await waitUntil(()=>sim().then(s=>!s.session));await key('e');await sharp();assert.equal((await sim()).observation.circuit,'IF_ID');
 // Pixel bounds remain valid through fit, rapid zoom/pan and narrow viewport resize.
 for(let i=0;i<5;i++)await page.locator('#zoomInButton').click();await cdp.send('Emulation.clearDeviceMetricsOverride');await page.setViewportSize({width:1100,height:760});await sharp();await page.locator('#fitButton').click();const fit=await sharp();result.fit=fit;
 assert.equal((await sim()).observation.ticks,0);assert.equal((await session()).revision.id,initial.revision.id);assert.deepEqual(fs.readFileSync(source),original);assert.deepEqual(errors,[]);
 Object.assign(result,{sourceUnchanged:true,courseHeight:scene.circuit.bounds.height,automatic:'paused/live, pan/zoom/resize/DPR, bounded native pixels',ownership:'same root run while changing viewport; old response cannot cover another circuit',snapshots:'F6 saved exact native viewport bytes while running',recovery:'injected viewport failure then real retry',errors});fs.writeFileSync(out+'/acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});console.error('UI errors:',errors);console.error('Commands:',requests);console.error('Geometry:',await geometry().catch(()=>null));console.error('Runtime:',await sim().then(s=>({running:s.running,frequency:s.frequency,ticks:s.observation?.ticks,error:s.error})).catch(()=>null));throw error;}finally{await app?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
