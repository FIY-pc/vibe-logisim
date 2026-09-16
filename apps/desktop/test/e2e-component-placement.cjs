'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-placement-'),folder=root+'/从零构建';fs.mkdirSync(folder);
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-component-placement';fs.mkdirSync(out,{recursive:true});
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,phase='launch';const errors=[],times=[];
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const scene=()=>page.evaluate(()=>fetch('/api/circuit?name=main').then(r=>r.json()));
async function idle(){await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')!=='true'&&document.querySelector('#canvasStatus').hidden&&!document.querySelector('#placementToolbar .placement-loading'),{timeout:30000});}
async function world(x,y){return page.locator('#circuitCanvas').evaluate((e,p)=>{const n=new DOMPoint(p.x,p.y).matrixTransform(e.getScreenCTM());return {x:n.x,y:n.y};},{x,y});}
async function choose(search,label){await page.locator('#addComponentTool').click();await page.locator('#componentSearch').fill(search);await page.locator('#componentLibrary').getByRole('button',{name:label,exact:true}).click();await page.waitForFunction(()=>document.querySelector('#objectInspector [data-attribute]')&&!document.querySelector('#placementToolbar .placement-loading'));}
async function attribute(name,value){const field=page.locator('#objectInspector [data-attribute="'+name+'"]');if(await field.evaluate(e=>e.tagName)==='SELECT')await field.selectOption(value);else {await field.fill(value);await field.press('Enter');}await page.waitForFunction(()=>!document.querySelector('#placementToolbar .placement-loading'));await page.locator('#circuitCanvas').focus();}
async function place(x,y){const old=(await session()).revision.id,p=await world(x,y),t=Date.now();await page.mouse.move(p.x,p.y);await page.locator('.placement-ghost').waitFor();await page.mouse.click(p.x,p.y);await waitUntil(()=>session().then(s=>s.revision.id!==old&&s),{timeout:30000});await idle();times.push(Date.now()-t);}
async function launch(){app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop','--no-sandbox'],env});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.stack));await page.setViewportSize({width:1500,height:960});await app.evaluate((_,repo)=>{const require=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');require('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model generation in placement acceptance');};},repo);}
(async()=>{try {
 await launch();phase='create circuit';await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},folder);await page.locator('#openButton').click();await page.getByRole('button',{name:'新建电路',exact:true}).click();await page.getByRole('textbox',{name:'文件名称',exact:true}).fill('与门验证.circ');await page.getByRole('textbox',{name:'文件名称',exact:true}).press('Enter');await waitUntil(()=>session().then(s=>s.folder?.activeFile==='与门验证.circ'&&s));await idle();
 phase='catalog and preview';await page.locator('#circuitCanvas').focus();await page.keyboard.press('a');await page.locator('#componentSearch').fill('AND Gate');await page.getByRole('button',{name:'与门',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#objectInspector [data-attribute="inputs"]')&&!document.querySelector('#placementToolbar .placement-loading'));
 await attribute('inputs','2');await attribute('label','AND');
 const p=await world(500,300);await page.mouse.move(p.x,p.y);await page.locator('.placement-ghost').waitFor();
 phase='rotation';await page.keyboard.press('r');await page.waitForFunction(()=>document.querySelector('#objectInspector [data-attribute="facing"]')?.value==='south');for(let i=0;i<3;i++){await page.locator('#circuitCanvas').focus();await page.keyboard.press('r');await page.waitForFunction(()=>!document.querySelector('#placementToolbar .placement-loading'));}
 await page.screenshot({path:out+'/01-placement-preview.png'});
 phase='continuous placement';await place(500,300);
 const unchanged=(await session()).revision.id;const duplicate=await world(500,300);await page.mouse.click(duplicate.x,duplicate.y);await page.getByText('此位置已有相同元件',{exact:true}).waitFor();assert.equal((await session()).revision.id,unchanged);
 for(const point of [[500,450],[650,450]]){const p=await world(...point);await page.mouse.click(p.x,p.y);}
 await waitUntil(()=>scene().then(s=>s.circuit.components.length===3));await idle();await page.keyboard.press('Escape');await page.keyboard.press('Control+z');await waitUntil(()=>scene().then(s=>s.circuit.components.length===2));await idle();await page.keyboard.press('Control+z');await waitUntil(()=>scene().then(s=>s.circuit.components.length===1));await idle();
 phase='input pins';await choose('输入引脚','输入引脚');await attribute('tristate','false');await attribute('label','A');await place(250,220);await attribute('label','B');await place(250,380);await page.keyboard.press('Escape');
 phase='output pin';await choose('输出引脚','输出引脚');await attribute('label','Y');await place(680,300);await page.keyboard.press('Escape');
 phase='wire from ports';
 for(const [a,b] of [[[250,220],[470,290]],[[250,380],[470,310]],[[500,300],[680,300]]]) {
   const before=(await session()).revision.id;
   await page.locator(`.wire-port-hit[cx="${a[0]}"][cy="${a[1]}"]`).click();await page.locator(`.wire-port-hit[cx="${b[0]}"][cy="${b[1]}"]`).click();
   await waitUntil(()=>session().then(s=>s.revision.id!==before&&s));await idle();
 }
 const constructed=await scene();assert.equal(constructed.circuit.components.length,4);assert.equal(constructed.circuit.wires.length,5);assert.equal((await session()).workspace.dirty,false);
 await page.locator('#componentSearch').fill('');await page.locator('#fitButton').click();await page.screenshot({path:out+'/02-built-circuit.png'});
 phase='native truth table';await page.locator('#simulationMenuButton').focus();await page.keyboard.press('Control+t');
 const observation=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));await waitUntil(()=>observation().then(s=>s.observation?.components?.length===4));
 await page.locator('#pokeTool').click();
 async function bits(){const s=await observation();return Object.fromEntries(s.observation.components.filter(c=>['A','B','Y'].includes(c.label)).map(c=>[c.label,c.ports[0].bits]));}
 async function poke(label){const c=constructed.circuit.components.find(c=>c.label===label),b=c.bounds,p=await world(b.x+b.width/2,b.y+b.height/2);const before=(await bits())[label];await page.mouse.click(p.x,p.y);await waitUntil(async()=>{const b=await bits();return b[label]!==before&&b;});}
 for(const label of ['A','B']) {
   await page.locator('#selectTool').click();const c=constructed.circuit.components.find(c=>c.label===label),b=c.bounds,p=await world(b.x+b.width/2,b.y+b.height/2);await page.mouse.click(p.x,p.y);
   const input=page.getByRole('textbox',{name:'输入值',exact:true});await input.fill('0');await input.press('Enter');await waitUntil(async()=>(await bits())[label]==='0');
 }
 await page.locator('#pokeTool').click();
 const truth=[];let v=await bits();assert.equal(v.Y,'0');truth.push(v);await poke('A');v=await bits();assert.equal(v.Y,'0');truth.push(v);await poke('B');v=await bits();assert.equal(v.Y,'1');truth.push(v);await poke('A');v=await bits();assert.equal(v.Y,'0');truth.push(v);
 await page.screenshot({path:out+'/03-native-simulation.png'});
 phase='restart persisted circuit';await app.close();app=null;await launch();await waitUntil(()=>session().then(s=>s.folder?.activeFile==='与门验证.circ'&&s));await idle();assert.equal((await scene()).circuit.components.length,4);assert.deepEqual(errors,[]);
 phase='course libraries';
 for(const name of ['cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+name,folder+'/'+name);
 const course=fs.readFileSync(repo+'/exports/interface-editing/stage6-if-id.circ','utf8').replace('</project>','<circuit name="手动搭建"/></project>');fs.writeFileSync(folder+'/课程样例.circ',course);
 await page.locator('#filesTab').click();await page.locator('.file-row').filter({hasText:'课程样例.circ'}).click();await waitUntil(()=>session().then(s=>s.folder?.activeFile==='课程样例.circ'&&s));
 await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^手动搭建$/})}).click();await idle();
 await page.locator('#addComponentTool').click();await page.locator('#componentSearch').fill('RegisterFile');await page.locator('.component-tool[data-factory="RegisterFile"]').click();await page.waitForFunction(()=>document.querySelector('#objectInspector [data-attribute]')&&!document.querySelector('#placementToolbar .placement-loading'));await place(650,300);await page.keyboard.press('Escape');
 await choose('IF_ID','IF_ID');await place(450,300);await page.keyboard.press('Escape');
 const libraryScene=await page.evaluate(()=>fetch('/api/circuit?name='+encodeURIComponent('手动搭建')).then(r=>r.json()));assert.deepEqual(libraryScene.circuit.components.map(c=>c.factory).sort(),['IF_ID','RegisterFile']);
 await page.locator('#fitButton').click();await page.screenshot({path:out+'/04-course-libraries.png'});
 phase='cycle and preview ownership';await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click();await idle();await page.locator('#componentSearch').fill('手动搭建');assert.equal(await page.locator('#componentLibrary').getByRole('button',{name:'手动搭建',exact:true}).isDisabled(),true);
 await choose('非门','非门');const beforePreview=fs.readFileSync(folder+'/课程样例.circ');await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^手动搭建$/})}).click();await idle();assert.equal(await page.locator('#placementToolbar').isVisible(),false);assert.ok(fs.readFileSync(folder+'/课程样例.circ').equals(beforePreview));
 assert.deepEqual(errors,[]);
 fs.copyFileSync(folder+'/与门验证.circ',out+'/and-built-through-ui.circ');
 const result={root,success:true,modelTurns:0,truthTable:truth,placementMilliseconds:times,components:4,wires:5,rapidClicksRetained:true,customLibrary:'RegisterFile',subcircuit:'IF_ID',recursivePlacementBlocked:true};fs.writeFileSync(out+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error('FAILED',phase,root,error);if(page){await page.screenshot({path:out+'/failure.png'}).catch(()=>{});console.error(await page.locator('#canvasStatus').innerText().catch(()=>''));console.error(await page.locator('#objectInspector').innerText().catch(()=>''));console.error(errors,times);}process.exitCode=1;}finally{if(app)await app.close();}})();
