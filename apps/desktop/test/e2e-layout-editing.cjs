'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron}=require('playwright');
const {waitUntil}=require('./support/wait-until.cjs');
const repo=path.resolve(__dirname,'../../..'),output=repo+'/apps/desktop/docs/product/evidence/2026-09-16-editor-performance/layout';
fs.mkdirSync(output,{recursive:true});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-layout-editing-'));
  for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(repo+'/exports/branch-editing/'+name,root+'/'+name);
  const source=root+'/stage6-if-id.circ',original=fs.readFileSync(source);
  const env={...process.env,XDG_CONFIG_HOME:root+'/config',VIBE_LOGISIM_STATE_DIR:root+'/state'};delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>_electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});
  let app=await launch(),page;const errors=[];
  const session=()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  const scene=()=>page.evaluate(()=>fetch('/api/circuit?name=IF_ID').then(r=>r.json()).then(d=>d.circuit));
  const idle=()=>page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false');
  const world=p=>page.locator('#circuitCanvas').evaluate((n,p)=>{const q=new DOMPoint(p.x,p.y).matrixTransform(n.getScreenCTM());return{x:q.x,y:q.y};},p);
  const changed=async revision=>{const s=await waitUntil(()=>session().then(s=>s.revision.id!==revision&&s),{timeout:45000,label:'layout edit'});await idle();return s;};
  const selected=()=>page.locator('.wire-group.is-selected-wire').evaluateAll(nodes=>nodes.map(n=>n.dataset.wireId));
  const topWire=scene=>scene.wires.find(w=>w.from.y===w.to.y&&w.from.y<100&&Math.max(w.from.x,w.to.x)>=1000);
  const outputNets=scene=>{
    const bits=factory=>scene.components.find(c=>c.label==='ID.PC'&&c.factory===factory).ends[0].netBits.map(b=>b.netId);
    assert.equal(bits('Register').length,32);assert.deepEqual(bits('Register'),bits('Pin'));
  };
  async function drag(a,dx,dy){
    const p=await world(a),q=await world({x:a.x+dx,y:a.y+dy});
    await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(q.x,q.y,{steps:12});
    await page.mouse.up();
  }
  try{
    page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1500,height:960});
    await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});await idle();
    if(process.argv.includes('--baseline')){
      const before=await session();await drag({x:940,y:100},0,-40);
      assert.equal((await session()).revision.id,before.revision.id);
      await page.getByRole('button',{name:'ID.PC，Register',exact:true}).click({modifiers:['Shift']});
      await page.screenshot({path:output+'/01-before.png'});console.log(root);return;
    }
    await page.getByRole('button',{name:'ID.PC，Register',exact:true}).waitFor();
    const initial=await session();
    const draft='把这段输出线向上挪，保留我选中的寄存器和连线，稍后一起讨论。';
    await page.locator('#questionInput').fill(draft);
    // Preview a real wire slide without releasing the mouse. It must not edit.
    const p=await world({x:940,y:100}),q=await world({x:940,y:60});
    await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(q.x,q.y,{steps:12});
    await page.locator('.layout-preview:not(.is-pending)').waitFor({timeout:30000});
    assert.equal((await session()).revision.id,initial.revision.id);
    assert.deepEqual(fs.readFileSync(source),original);
    await page.screenshot({path:output+'/02-wire-preview.png'});
    await page.mouse.up();await changed(initial.revision.id);
    let current=await scene();outputNets(current);assert.ok(topWire(current));assert.equal((await selected()).length,1);
    const moved=await session();
    // Another drag is canceled. The async geometry response must not resurrect it.
    let releasePreview,previewFetched=false;
    const heldPreview=new Promise(resolve=>{releasePreview=resolve;});
    const intercept=async route=>{
      const response=await route.fetch();previewFetched=true;await heldPreview;
      await route.fulfill({response}).catch(()=>{});
    };
    await page.route('**/api/layout/preview',intercept);
    const r=await world({x:940,y:60}),s=await world({x:940,y:40});
    await page.mouse.move(r.x,r.y);await page.mouse.down();await page.mouse.move(s.x,s.y,{steps:8});
    await waitUntil(()=>previewFetched,{label:'held native geometry response'});
    await page.keyboard.press('Escape');await page.mouse.up();releasePreview();
    await page.unrouteAll({behavior:'wait'});
    assert.equal(await page.locator('.layout-preview').count(),0);
    assert.equal((await session()).revision.id,moved.revision.id);
    // Left-to-right includes only enclosed objects; right-to-left includes
    // touched segments. Neither gesture turns a segment into its entire bus.
    await drag({x:930,y:40},20,40);assert.equal((await selected()).length,0);
    await drag({x:950,y:80},-20,-40);assert.equal((await selected()).length,1);
    assert.equal(await page.locator('.circuit-component.is-selected').count(),0);
    const wirePoint=await world({x:940,y:60});await page.mouse.click(wirePoint.x,wirePoint.y);
    // The exact segment and component form one selection and one edit.
    await page.getByRole('button',{name:'ID.PC，Register',exact:true}).click({modifiers:['Shift']});
    assert.equal(await page.locator('.circuit-component.is-selected').count(),1);assert.equal((await selected()).length,1);
    // Exercise the real composer through its IPC boundary without spending a
    // model turn. A deliberate error keeps the draft; this is context delivery,
    // not evidence that a model understood or acted on the selection.
    await app.evaluate(({ipcMain})=>{
      ipcMain.removeHandler('vibe-logisim:agent-ask');
      ipcMain.handle('vibe-logisim:agent-ask',(_,request)=>{global.__layoutAsk=request;throw new Error('本次检查停在发送边界，未调用模型');});
    });
    await page.locator('#askButton').click();
    const selection=await waitUntil(()=>page.evaluate(()=>fetch('/api/selection').then(r=>r.json())).then(s=>s.wireIds?.length===1&&s.componentIds?.length===1&&s));
    assert.deepEqual(selection.wireIds,await selected());assert.equal(selection.wires.length,1);
    assert.equal((await app.evaluate(()=>global.__layoutAsk)).kind,'overview');
    assert.deepEqual(selection.intent.netIds,[]);assert.equal(await page.locator('.circuit-component.is-selected').count(),1);
    // The deliberately rejected send is not a product failure screenshot.
    await page.screenshot({path:output+'/03-context-boundary.png'});
    await drag({x:940,y:60},40,0);await changed(moved.revision.id);
    current=await scene();outputNets(current);
    assert.equal(current.components.find(c=>c.label==='ID.PC'&&c.factory==='Register').location.x,780);
    assert.equal(await page.locator('.circuit-component.is-selected').count(),1);assert.equal((await selected()).length,1);
    await page.screenshot({path:output+'/03-mixed-selection.png'});
    const mixed=await session();
    const mixedBytes=fs.readFileSync(source);
    assert.equal(mixed.workspace.dirty,false);
    assert.notDeepEqual(mixedBytes,original);
    await page.locator('#deleteSelectionButton').click();await changed(mixed.revision.id);
    current=await scene();assert.ok(!current.components.some(c=>c.factory==='Register'&&c.label==='ID.PC'));
    assert.ok(!current.wires.some(w=>w.from.y===60&&w.to.y===60));
    const deleted=await session();assert.equal(deleted.workspace.history.length,mixed.workspace.history.length+1);
    await page.locator('#undoButton').click();await changed(deleted.revision.id);
    assert.equal((await session()).revision.id,mixed.revision.id);outputNets(await scene());
    assert.equal(await page.locator('#questionInput').inputValue(),draft);
    await page.locator('#fitButton').click();await page.screenshot({path:output+'/04-layout.png'});
    // Folder workspaces write accepted edits directly, including undo. A
    // transient drag preview still leaves the file untouched (checked above).
    assert.deepEqual(fs.readFileSync(source),mixedBytes);
    const saved=await session();assert.notDeepEqual(fs.readFileSync(source),original);
    await app.close();app=await launch();page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await page.setViewportSize({width:1500,height:960});
    await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});
    await page.getByRole('button',{name:'ID.PC，Register',exact:true}).waitFor();await idle();
    assert.equal((await session()).workspace.id,initial.workspace.id);
    assert.equal((await session()).revision.id,saved.revision.id);outputNets(await scene());
    const observation=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
    const value=(s,label)=>s.observation?.components.find(c=>c.label===label&&c.factory==='Pin')?.ports[0]?.value;
    await simulationMenu(page,'simulationStart');await waitUntil(()=>observation().then(s=>!!s.session));
    async function input(label,n){
      await page.getByRole('button',{name:label+'，Pin',exact:true}).click();
      const field=page.getByRole('textbox',{name:'输入值',exact:true});await field.fill(String(n));await field.press('Enter');
      await waitUntil(()=>observation().then(s=>value(s,label)===n),{timeout:15000,label:label+' input'});
    }
    for(const [label,n] of [['CLK',0],['RST',1],['FETCH.EN',1],['BRANCH',0],['IF.PC',100],['IF.IR',111],['RST',0],['CLK',1]])await input(label,n);
    const captured=await observation();assert.equal(value(captured,'ID.PC'),100);assert.equal(value(captured,'ID.IR'),111);
    for(const [label,n] of [['CLK',0],['FETCH.EN',0],['BRANCH',1],['IF.PC',200],['CLK',1]])await input(label,n);
    const held=await observation();assert.equal(value(held,'ID.PC'),100);assert.equal(value(held,'ID.IR'),111);
    for(const [label,n] of [['CLK',0],['FETCH.EN',1],['CLK',1]])await input(label,n);
    const bubble=await observation();assert.equal(value(bubble,'ID.PC'),0);assert.equal(value(bubble,'ID.IR'),0);
    await page.screenshot({path:output+'/05-reopened-running.png'});await simulationMenu(page,'simulationStop');
    assert.equal((await session()).revision.id,saved.revision.id);assert.equal((await session()).workspace.dirty,false);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(output+'/result.json',JSON.stringify({root,projectId:saved.workspace.id,revision:saved.revision.id,source,modelTurns:0,
      interaction:['wire slide and read-only preview','Escape cancels; delayed native response discarded','enclosed/crossing marquee','mixed component and wire selection','composer freezes exact selected objects; model boundary deliberately rejected','mixed drag','atomic delete and undo','write through and reopen','native capture, stalled branch, enabled bubble'],
      selection:selection.intent,captured:[100,111],stalled:[100,111],bubble:[0,0],previewLeavesSourceUntouched:true,writeThrough:true,undoRestoresExactBytes:true},null,2));
    console.log(root);
  }catch(error){console.error(errors);if(page){console.error(await page.locator('#canvasStatus').textContent());await page.screenshot({path:output+'/failure.png'}).catch(()=>{});}throw error;}
  finally{await app.close();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
