// Runs the shipped application outside the checkout. No model turns or private course fixtures.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const executable=path.resolve(process.argv[2]||'missing-packaged-executable');
assert.ok(fs.existsSync(executable),'Pass the packaged vibe-logisim executable as the first argument');
const root=fs.mkdtempSync('/tmp/vibe-packaged-'),folder=root+'/我的电路 workspace',out=root;fs.mkdirSync(folder);
const guards=root+'/host-guards';fs.mkdirSync(guards);
for(const name of ['python3','java','javac','codex','codex-code-mode-host','pdfinfo','pdftotext','pdftoppm']) {
 fs.writeFileSync(guards+'/'+name,`#!/bin/sh\nprintf '%s\\n' '${name}' >> '${root}/host-tools-called'\nexit 91\n`,{mode:0o755});
}
const env={...process.env,PATH:guards+':/usr/bin:/bin',XDG_CONFIG_HOME:root+'/config'};
delete env.ELECTRON_RUN_AS_NODE;
delete env.VIBE_LOGISIM_STATE_DIR;
// A tiny independent two-page PDF fixture, built without another application.
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',...['AND circuit','Truth table: 00=0 01=0 10=0 11=1'].map(text=>{const data=`BT /F1 12 Tf 20 140 Td (${text}) Tj ET`;return `<< /Length ${data.length} >>\nstream\n${data}\nendstream`})];
let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 8\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(folder+'/任务说明.pdf',pdf);
let app,page,phase='launch';const errors=[],times=[];
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const scene=()=>page.evaluate(()=>fetch('/api/circuit?name=main').then(r=>r.json()));
async function idle(){await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')!=='true'&&document.querySelector('#canvasStatus').hidden&&!document.querySelector('#placementToolbar .placement-loading'),{timeout:30000});}
async function world(x,y){return page.locator('#circuitCanvas').evaluate((e,p)=>{const n=new DOMPoint(p.x,p.y).matrixTransform(e.getScreenCTM());return {x:n.x,y:n.y};},{x,y});}
async function choose(search,label){await page.locator('#circuitCanvas').press('a');await page.locator('#componentSearch').fill(search);await page.locator('#componentLibrary').getByRole('button',{name:label,exact:true}).click();await page.waitForFunction(()=>document.querySelector('#objectInspector [data-attribute]')&&!document.querySelector('#placementToolbar .placement-loading'));}
async function attribute(name,value){const field=page.locator('#objectInspector [data-attribute="'+name+'"]');if(await field.evaluate(e=>e.tagName)==='SELECT')await field.selectOption(value);else {await field.fill(value);await field.press('Enter');}await page.waitForFunction(()=>!document.querySelector('#placementToolbar .placement-loading'));await page.locator('#circuitCanvas').focus();}
async function place(x,y){const old=(await session()).revision.id,p=await world(x,y),t=Date.now();await page.mouse.move(p.x,p.y);await page.locator('.placement-ghost').waitFor();await page.mouse.click(p.x,p.y);await waitUntil(()=>session().then(s=>s.revision.id!==old&&s),{timeout:30000});await idle();times.push(Date.now()-t);}
async function launch(){
 app=await _electron.launch({executablePath:executable,args:[],chromiumSandbox:true,cwd:root,env,timeout:60000});
 page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.stack));await page.setViewportSize({width:1500,height:960});
 app.process().stderr.on('data',data=>fs.appendFileSync(root+'/app.log',data));
 const packaged=await app.evaluate(({app})=>app.isPackaged);assert.equal(packaged,true);
 assert.equal(await app.evaluate(({app})=>app.getPath("userData")),root+"/config/vibe-logisim");
 assert.equal(await app.evaluate(({app})=>app.commandLine.hasSwitch("no-sandbox")),false);
 await page.waitForFunction(async()=>window.vibeDesktop&&(await window.vibeDesktop.agent.getState()).status==='auth-required');
}

(async()=>{try {
 await launch();phase='create circuit';await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},folder);await page.locator('#openButton').click();await page.locator('#newFileMenu').click();await page.getByRole('menuitem',{name:'新建电路',exact:true}).click();await page.getByRole('textbox',{name:'文件名称',exact:true}).fill('与门验证.circ');await page.getByRole('textbox',{name:'文件名称',exact:true}).press('Enter');await waitUntil(()=>session().then(s=>s.folder?.activeFile==='与门验证.circ'&&s));await idle();
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
 phase='PDF preview without Poppler';
 await page.locator('#filesTab').click();
 await page.locator('.file-row').filter({hasText:'任务说明.pdf'}).dblclick();
 await page.locator('.material-image').waitFor({timeout:30000});
 assert.equal(await page.locator('#materialPage').innerText(),'1 / 2');
 await page.locator('#materialNext').click();
 await page.waitForFunction(()=>document.querySelector('#materialPage').textContent==='2 / 2');
 await page.screenshot({path:out+'/pdf-preview.png'});
 await page.locator('#materialTextMode').click();
 assert.match(await page.locator('.material-text').innerText(),/Truth table/);
 await page.locator('#materialsClose').click();
 phase='bundled AI login and cancel (browser launch intercepted; no credentials)';
 await page.waitForFunction(async()=>(await window.vibeDesktop.agent.getState()).status==='auth-required');
 await app.evaluate(({shell})=>{globalThis.openedLoginUrl=null;shell.openExternal=async url=>{globalThis.openedLoginUrl=url;};});
 await page.locator('#agentReconnect').click();
 await page.waitForFunction(()=>document.querySelector('#agentReconnect').textContent==='取消登录');
 const login=await app.evaluate(()=>globalThis.openedLoginUrl);
 assert.equal(new URL(login).hostname,'auth.openai.com');
 await page.locator('#agentReconnect').click();
 await page.waitForFunction(()=>document.querySelector('#agentReconnect').textContent==='登录 ChatGPT');
 await page.screenshot({path:out+'/packaged-workspace.png'});
 assert.equal(fs.existsSync(root+'/host-tools-called'),false,'No host Python/Java/Codex/Poppler');
 assert.deepEqual(errors,[]);
 const result={root,executable,success:true,modelTurns:0,truthTable:truth,components:4,wires:5,reopened:true,pdf:'two pages, rendered image and extracted text',ai:'real bundled app-server; login URL and cancellation; browser opening intercepted',hostToolsUsed:false};
 fs.writeFileSync(out+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error('FAILED',phase,root,error);if(page){await page.screenshot({path:out+'/failure.png'}).catch(()=>{});console.error(await page.locator('#canvasStatus').innerText().catch(()=>''));console.error(await page.locator('#objectInspector').innerText().catch(()=>''));console.error(errors,times);}process.exitCode=1;}finally{if(app)await app.close();}})();
