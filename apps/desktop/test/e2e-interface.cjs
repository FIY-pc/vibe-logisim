'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron}=require('playwright');const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),output=repo+'/apps/desktop/docs/product/evidence/2026-09-15-interface-editing';fs.mkdirSync(output,{recursive:true});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-interface-e2e-'));
  for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/layout-editing/'+name,root+'/'+name);
  const source=root+'/stage6-if-id.circ',original=fs.readFileSync(source);
  const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>_electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});
  let app=await launch(),page;const errors=[],commands=[];
  const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  const idle=()=>page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false');
  async function circuit(name){
    await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:new RegExp('^'+name+'$')})}).click({timeout:90000});
    await page.waitForFunction(name=>document.querySelector('#circuitList .is-active strong')?.textContent===name&&document.querySelector('#canvasStatus').hidden,name,{timeout:90000});await idle();
  }
  const scene=name=>page.evaluate(name=>fetch('/api/circuit?name='+encodeURIComponent(name)).then(r=>r.json()).then(d=>d.circuit),name);
  const changed=async id=>{const s=await waitUntil(()=>session().then(s=>s.revision.id!==id&&s),{timeout:60000,label:'interface commit'});await idle();return s;};
  const interfaceReady=()=>page.waitForFunction(()=>document.querySelector('#interfaceDialog').open&&!document.querySelector('#interfaceDialog').classList.contains('is-busy')&&document.querySelectorAll('.interface-port-row').length>0);
  async function field(label,value){const input=page.getByRole('textbox',{name:label,exact:true});await input.fill(String(value));await input.press('Enter');}
  try{
    page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});await circuit('IF_ID');
    await page.getByRole('button',{name:'ID.PC，Register',exact:true}).waitFor();
    const initial=await session();await page.locator('#questionInput').fill('把 IF_ID 的封装整理清楚，父图继续保持原有连接。');
    await page.locator('#editInterface').click();await interfaceReady();assert.equal(await page.locator('.interface-port-row').count(),8);
    await page.screenshot({path:output+'/01-editor.png'});
    // Adding, deleting and undoing inside this dialog only changes the draft.
    await page.locator('#interfaceAddPort').click();await field('SIGNAL 名称','READY');
    await page.getByRole('combobox',{name:'READY 方向',exact:true}).selectOption('output');await field('READY 位宽',8);
    await page.getByRole('button',{name:'删除端口 READY',exact:true}).click();assert.equal(await page.locator('.interface-port-row').count(),8);
    await page.locator('#interfaceUndo').click();assert.equal(await page.locator('.interface-port-row').count(),9);
    assert.equal(await page.getByRole('textbox',{name:'READY 位宽',exact:true}).inputValue(),'8');
    await page.locator('#interfaceClose').click();assert.equal((await session()).revision.id,initial.revision.id);
    await page.locator('#editInterface').click();await interfaceReady();assert.equal(await page.locator('.interface-port-row').count(),8);
    // A connected bus cannot silently become narrower.
    await field('ID.PC 位宽',16);await page.locator('#interfacePreview').click();
    await waitUntil(()=>page.locator('#interfaceError').isVisible(),{timeout:45000,label:'connected width conflict'});
    assert.equal((await session()).revision.id,initial.revision.id);await field('ID.PC 位宽',32);
    // Use the actual symbol canvas, not the project API, to move the output.
    const world=p=>page.locator('#interfaceCanvas').evaluate((n,p)=>{const q=new DOMPoint(p.x,p.y).matrixTransform(n.getScreenCTM());return{x:q.x,y:q.y};},p);
    const a=await world({x:410,y:130}),b=await world({x:410,y:110});
    await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:10});
    assert.equal((await session()).revision.id,initial.revision.id);await page.mouse.up();
    assert.equal(await page.getByRole('textbox',{name:'Y',exact:true}).inputValue(),'110');
    await field('ID.PC 名称','DECODE.PC');
    await page.locator('#interfaceArtwork').getByRole('button',{name:'文字 IF_ID',exact:true}).click();await field('文字内容','IF / ID');
    await page.locator('#interfaceArtwork').getByRole('button',{name:'封装图形',exact:true}).click({position:{x:30,y:20}});await field('宽度',340);
    await page.locator('#interfacePreview').click();await waitUntil(()=>page.locator('#interfaceImpact').textContent().then(s=>s.includes('其余已知端口连接保持')),{timeout:60000,label:'native parent routing'});
    assert.equal((await session()).revision.id,initial.revision.id);assert.deepEqual(fs.readFileSync(source),original);
    await page.screenshot({path:output+'/02-reviewed-draft.png'});
    await page.locator('#interfaceApply').click();await page.locator('#interfaceDialog').waitFor({state:'hidden',timeout:60000});const applied=await changed(initial.revision.id);
    assert.equal(applied.workspace.history.length,initial.workspace.history.length+1);
    assert.equal(await page.locator('#questionInput').inputValue(),'把 IF_ID 的封装整理清楚，父图继续保持原有连接。');
    assert.equal((await scene('IF_ID')).components.find(c=>c.factory==='Pin'&&c.label==='DECODE.PC').ends[0].width,32);
    await circuit('◇气泡流水线');await page.locator('#findObject').click();await page.locator('#finderInput').fill('IF_ID');
    await page.locator('#finderInput').press('Enter');await page.locator('#detailLayer image[data-circuit="◇气泡流水线"]').first().waitFor({timeout:60000});await page.screenshot({path:output+'/03-parent-reconnected.png'});
    await page.locator('#undoButton').click();await changed(applied.revision.id);assert.equal((await session()).revision.id,initial.revision.id);
    // Reapply by editing the child from its parent inspector, then save/reopen.
    await page.locator('#findObject').click();await page.locator('#finderInput').fill('IF_ID');await page.locator('#finderInput').press('Enter');
    await page.getByRole('button',{name:'编辑封装与接口',exact:true}).click();await interfaceReady();
    await page.getByRole('button',{name:'定位端口 ID.PC',exact:true}).click();await field('Y',110);await field('ID.PC 名称','DECODE.PC');
    await page.locator('#interfaceArtwork').getByRole('button',{name:'文字 IF_ID',exact:true}).click();await field('文字内容','IF / ID');
    await page.locator('#interfaceArtwork').getByRole('button',{name:'封装图形',exact:true}).click({position:{x:30,y:20}});await field('宽度',340);
    await page.locator('#interfaceApply').click();await page.locator('#interfaceDialog').waitFor({state:'hidden',timeout:60000});await changed(initial.revision.id);
    await page.locator('#saveButton').click();await page.locator('#confirmSave').click();await page.locator('#saveDialog').waitFor({state:'hidden'});const saved=await session();
    await app.close();app=await launch();page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});await circuit('IF_ID');
    page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/simulation'))commands.push(r.postDataJSON());});
    assert.equal((await session()).workspace.id,initial.workspace.id);assert.equal((await session()).revision.id,saved.revision.id);
    await page.locator('#editInterface').click();await interfaceReady();
    await page.locator('#interfaceArtwork').getByRole('button',{name:'文字 IF / ID',exact:true}).waitFor();
    await page.locator('#interfaceArtwork').getByRole('button',{name:'封装图形',exact:true}).click({position:{x:30,y:20}});assert.equal(await page.getByRole('textbox',{name:'宽度',exact:true}).inputValue(),'340');
    await page.screenshot({path:output+'/05-persisted-symbol.png'});await page.locator('#interfaceClose').click();
    const observation=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
    const value=(s,label)=>s.observation?.components.find(c=>c.factory==='Pin'&&c.label===label)?.ports[0]?.value;
    await simulationMenu(page,'simulationStart');await waitUntil(()=>observation().then(s=>!!s.session));
    for(const [label,n] of [['CLK',0],['RST',1],['FETCH.EN',1],['BRANCH',0],['IF.PC',100],['IF.IR',111],['RST',0],['CLK',1]]){
      await page.getByRole('button',{name:label+'，Pin',exact:true}).click();await field('输入值',n);await waitUntil(()=>observation().then(s=>value(s,label)===n),{label:`${label} = ${n}`});
    }
    const running=await observation();assert.equal(value(running,'DECODE.PC'),100);assert.equal(value(running,'ID.IR'),111);
    await page.screenshot({path:output+'/04-reopened-running.png'});await simulationMenu(page,'simulationStop');
    assert.equal((await session()).revision.id,saved.revision.id);assert.deepEqual(errors,[]);
    const deliver=repo+'/exports/interface-editing';fs.mkdirSync(deliver,{recursive:true});for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(root+'/'+name,deliver+'/'+name);
    fs.writeFileSync(output+'/result.json',JSON.stringify({root,revision:saved.revision.id,projectId:saved.workspace.id,modelTurns:0,
      actions:['draft add direction width delete undo and cancel','connected width conflict','symbol port drag','rename and artwork resize','native parent reconnection preview','apply','view parent','one undo','reapply from parent inspector','save and reopen with artwork','native register capture'],captured:[100,111],sourceProtectedUntilSave:true},null,2));console.log(root);
  }catch(e){console.error(errors);console.error(commands);console.error(await page.locator('#interfaceError').textContent().catch(()=>''));await page.screenshot({path:output+'/failure.png'}).catch(()=>{});throw e;}
  finally{await app.close();}
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
