'use strict';
// Real Electron interaction; all edits are confined to a temporary course copy.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright'),{waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),root=fs.mkdtempSync('/tmp/vibe-properties-');
const folder=root+'/course';fs.mkdirSync(folder);
const fixture=`<circuit name="编辑体验">
<comp lib="4" name="Register" loc="(300,200)"><a name="label" val="R0"/><a name="width" val="32"/></comp>
<comp lib="4" name="ROM" loc="(550,200)"><a name="label" val="程序"/><a name="addrWidth" val="8"/><a name="dataWidth" val="32"/><a name="contents">addr/data: 8 32
0</a></comp>
<comp lib="0" name="Pin" loc="(200,350)"><a name="label" val="A"/></comp>
</circuit>`;
const original=fs.readFileSync(repo+'/exports/interface-editing/stage6-if-id.circ','utf8');
const source=folder+'/course.circ';fs.writeFileSync(source,original.replace('</project>',fixture+'</project>'));
for(const file of ['cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/interface-editing/'+file,folder+'/'+file);
const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
const out=repo+'/apps/desktop/docs/product/evidence/2026-09-16-property-performance';fs.mkdirSync(out,{recursive:true});
const stage=process.argv.includes('--baseline')?'before':'after',timings={labels:[],romPages:[],interface:[]},errors=[];
let app,page,phase='launch';
const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
const scene=()=>page.evaluate(()=>fetch('/api/circuit?name='+encodeURIComponent('编辑体验')).then(r=>r.json()));
const idle=()=>page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false'&&document.querySelector('#canvasStatus').hidden);
async function launch(){
  app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});
  page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.stack));await page.setViewportSize({width:1500,height:960});
  await app.evaluate((_,repo)=>{const req=process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');req('./codex-backend.cjs').CodexBackend.prototype.ask=async()=>{throw new Error('No model turns in property acceptance');};},repo);
  await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^编辑体验$/})}).click();await idle();
}
(async()=>{try{
  await launch();phase='labels';
  await page.getByRole('button',{name:'R0，Register',exact:true}).click();
  for(const label of ['寄存器 A','寄存器 B']){
    const old=(await session()).revision.id;
    await page.locator('#objectInspector').getByRole('textbox',{name:'标签',exact:true}).fill(label);
    const t=Date.now();await page.locator('#objectInspector').getByRole('textbox',{name:'标签',exact:true}).press('Enter');
    await waitUntil(()=>session().then(s=>s.revision.id!==old));await idle();
    await page.locator('#objectInspector').getByRole('textbox',{name:'标签',exact:true}).waitFor();
    timings.labels.push(Date.now()-t);
    assert.ok((await scene()).circuit.components.some(c=>c.factory==='Register'&&c.label===label));
  }
  phase='ROM pages';await page.getByRole('button',{name:'程序，ROM',exact:true}).click();
  let t=Date.now();await page.getByRole('button',{name:/^存储内容/}).click();await page.locator('#memoryContent input[data-address="0"]').waitFor();timings.romPages.push(Date.now()-t);
  t=Date.now();await page.locator('#memoryNext').click();await page.locator('#memoryContent input[data-address="64"]').waitFor();timings.romPages.push(Date.now()-t);
  t=Date.now();await page.locator('#memoryPrev').click();await page.locator('#memoryContent input[data-address="0"]').waitFor();timings.romPages.push(Date.now()-t);
  phase='ROM write';const beforeRom=fs.readFileSync(source),revision=(await session()).revision.id;
  const cell=page.locator('#memoryContent input[data-address="0"]');await cell.fill('00000013');t=Date.now();await cell.press('Enter');
  await waitUntil(()=>session().then(s=>s.revision.id!==revision));await idle();
  await page.waitForFunction(()=>document.querySelector('#memoryContent input[data-address="0"]')?.value==='00000013');timings.romWrite=Date.now()-t;
  assert.equal((await session()).workspace.dirty,false);
  await page.locator('#memoryClose').click();await page.locator('#undoButton').click();
  await waitUntil(()=>session().then(s=>s.revision.id===revision));await idle();assert.ok(fs.readFileSync(source).equals(beforeRom));
  phase='interface';
  for(let i=0;i<2;i++){
    t=Date.now();await page.locator('#editInterface').click();
    await page.waitForFunction(()=>document.querySelector('#interfaceDialog').open&&!document.querySelector('#interfaceScope').textContent.includes('正在'));
    assert.equal(await page.locator('#interfaceError').isVisible(),false);
    assert.ok((await page.locator('#interfacePortList').innerText()).includes('A'));
    timings.interface.push(Date.now()-t);await page.locator('#interfaceClose').click();
  }
  phase='pin drag and definition switch';await page.locator('#fitButton').click();
  const priorMove=fs.readFileSync(source),priorRevision=(await session()).revision.id;
  const pin=(await scene()).circuit.components.find(c=>c.label==='A');
  const points=await page.locator('#circuitCanvas').evaluate((svg,b)=>{
    const matrix=svg.getScreenCTM(),a=new DOMPoint(b.x+b.width/2,b.y+b.height/2).matrixTransform(matrix),z=new DOMPoint(b.x+b.width/2+40,b.y+b.height/2).matrixTransform(matrix);
    return {a:{x:a.x,y:a.y},z:{x:z.x,y:z.y}};
  },pin.bounds);
  t=Date.now();await page.mouse.move(points.a.x,points.a.y);await page.mouse.down();await page.mouse.move(points.z.x,points.z.y,{steps:12});await page.mouse.up();
  await waitUntil(()=>session().then(s=>s.revision.id!==priorRevision));await idle();timings.pinDrag=Date.now()-t;
  assert.equal((await scene()).circuit.components.find(c=>c.label==='A').location.x,pin.location.x+40);
  await page.locator('#undoButton').click();await waitUntil(()=>session().then(s=>s.revision.id===priorRevision));await idle();assert.ok(fs.readFileSync(source).equals(priorMove));
  for(const name of ['IF_ID','编辑体验']){
    await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:new RegExp('^'+name+'$')})}).click();
    await page.waitForFunction(name=>document.querySelector('#currentCircuitName').textContent===name&&document.querySelector('#canvasStatus').hidden,name);
  }
  await page.getByRole('button',{name:'A，Pin',exact:true}).waitFor();
  phase='reopen';await app.close();app=null;await launch();
  assert.ok((await scene()).circuit.components.some(c=>c.label==='寄存器 B'));
  await page.getByRole('button',{name:'程序，ROM',exact:true}).click();await page.getByRole('button',{name:/^存储内容/}).click();
  await page.locator('#memoryContent input[data-address="0"]').waitFor();assert.equal(await page.locator('#memoryContent input[data-address="0"]').inputValue(),'00000000');
  assert.ok(fs.readFileSync(source,'utf8').startsWith(original.split('</project>')[0]));
  assert.deepEqual(errors,[]);await page.screenshot({path:out+'/'+stage+'.png'});
  const result={root,stage,success:true,modelTurns:0,timings,romUndoAndReopen:true,pinDragAndSwitch:true,otherModulesUnchanged:true};
  fs.writeFileSync(out+'/'+stage+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error({root,phase,timings},error);if(page)await page.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{if(app)await app.close();}})();
