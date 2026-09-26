'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
// Real Electron gestures and course runtime. No generated/replayed AI messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');
const repo = path.resolve(__dirname, '../../..');
const {requireSamples} = require('./support/samples.cjs');
requireSamples(repo, 'exports/if-id-collaboration/stage6-if-id.circ', 'exports/if-id-collaboration/cs3410.jar', 'exports/if-id-collaboration/riscv-probe.jar');
const output = path.join(repo, 'apps/desktop/docs/product/evidence/2026-09-15-branch-editing');
fs.mkdirSync(output, {recursive:true});

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-branch-editing-'));
  for (const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar']) fs.copyFileSync(path.join(repo,'exports/if-id-collaboration',name),path.join(root,name));
  const source = path.join(root,'stage6-if-id.circ'), original = fs.readFileSync(source);
  const env = {...process.env, XDG_CONFIG_HOME:path.join(root,'config'), VIBE_LOGISIM_STATE_DIR:path.join(root,'state')};
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({executablePath:require('electron'),args:[path.join(repo,'apps/desktop'),source,'--no-sandbox'],env});
  let app = await launch(), page = await app.firstWindow();
  const errors = [];
  const session = () => page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  const scene = () => page.evaluate(()=>fetch('/api/circuit?name=IF_ID').then(r=>r.json()).then(s=>s.circuit));
  const idle = () => page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false');
  const world = p => page.locator('#circuitCanvas').evaluate((n,p)=>{const q=new DOMPoint(p.x,p.y).matrixTransform(n.getScreenCTM());return {x:q.x,y:q.y};},p);
  async function open() {
    page.on('pageerror',e=>errors.push(e.message));
    await page.setViewportSize({width:1500,height:960});
    await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});
    await page.getByRole('button',{name:'ID.PC，Register',exact:true}).waitFor();
    await idle();
  }
  async function changed(before) {
    const result = await waitUntil(()=>session().then(s=>s.revision.id!==before&&s),{timeout:45000,label:'circuit edit'});
    await idle();return result;
  }
  async function move(labels,factory,dx,dy) {
    const before = await session(), camera = await page.locator('#circuitCanvas').getAttribute('viewBox');
    const objects = labels.map(label=>page.getByRole('button',{name:label+'，'+factory,exact:true}));
    for(let i=0;i<objects.length;i++)await objects[i].click(i?{modifiers:['Shift']}:{});
    assert.equal(await page.locator('.circuit-component.is-selected').count(),labels.length);
    const bounds = await objects[0].boundingBox(), scale = await page.locator('#circuitCanvas').evaluate(n=>n.getScreenCTM().a);
    const x = bounds.x+bounds.width/2, y = bounds.y+bounds.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx*scale,y+dy*scale,{steps:12});
    assert.equal(await page.locator('.move-preview image').count(),1);
    await page.mouse.up();
    const after = await changed(before.revision.id);
    assert.equal(await page.locator('.circuit-component.is-selected').count(),labels.length,'moved components remain selected');
    assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),camera,'local editing preserves the viewport');
    assert.deepEqual(fs.readFileSync(source),original,'editing does not save the original');
    return after;
  }
  async function clickWorld(p,options={}) { const q=await world(p);await page.mouse.click(q.x,q.y,options); }
  try {
    await open();
    // Start and finish on wire interiors, then undo this temporary loop.
    const junctionBase = await session();
    await page.keyboard.down('Alt');await clickWorld({x:880,y:180});await page.keyboard.up('Alt');
    await clickWorld({x:880,y:100});await clickWorld({x:940,y:100});
    assert.equal(await page.locator('.wire-preview').getAttribute('points'),'880,180 880,100 940,100');
    await clickWorld({x:940,y:180});await changed(junctionBase.revision.id);
    const branched = await scene();
    assert.ok(branched.wires.some(w=>w.from.y===100&&w.to.y===100));
    await page.screenshot({path:output+'/05-wire-junction.png'});
    const junctionRevision = (await session()).revision.id;
    await page.locator('#undoButton').click();await changed(junctionRevision);
    assert.equal((await session()).revision.id,junctionBase.revision.id);
    fs.writeFileSync(output+'/junctions.json',JSON.stringify({gesture:'Alt-click wire interior, two bends, finish on wire interior, undo',nativeAccepted:true,originalRestored:true,modelTurns:0},null,2));
    if(process.argv.includes('--junctions-only'))return;
    const initial = await session();
    await page.locator('#questionInput').fill('我正在调整控制线和寄存器位置，稍后继续讨论。');
    await page.screenshot({path:output+'/01-before.png'});
    // These inputs touch shared control branches, previously rejected.
    await move(['BRANCH','FETCH.EN','CLK','RST'],'Pin',0,-40);
    await page.locator('#zoomInButton').click();
    const moved = await move(['ID.PC','ID.IR'],'Register',100,0);
    let current = await scene();
    for(const label of ['ID.PC','ID.IR'])assert.equal(current.components.find(c=>c.factory==='Register'&&c.label===label).location.x,740);
    const beforeUndo = moved.revision.id;
    await page.locator('#undoButton').click();await changed(beforeUndo);
    current = await scene();assert.equal(current.components.find(c=>c.factory==='Register'&&c.label==='ID.PC').location.x,640);
    await move(['ID.PC','ID.IR'],'Register',100,0);
    await page.locator('#fitButton').click();
    await page.screenshot({path:output+'/02-branches-moved.png'});

    // Delete one actual output segment; native order must not select another wire.
    current = await scene();
    const wire = current.wires.find(w=>w.from.y===180&&w.to.y===180&&Math.min(w.from.x,w.to.x)===740&&Math.max(w.from.x,w.to.x)===1000);
    assert.ok(wire,'output path is still a direct physical wire');
    await clickWorld({x:900,y:180});
    assert.equal(await page.locator(`.wire-group[data-wire-id="${wire.wireId}"]`).evaluate(n=>n.classList.contains('is-selected-wire')),true);
    const beforeDelete = await session();
    await page.locator('#deleteSelectionButton').click();await changed(beforeDelete.revision.id);
    const disconnected = await scene();
    const pin = disconnected.components.find(c=>c.label==='ID.PC'&&c.factory==='Pin').ends[0];
    const register = disconnected.components.find(c=>c.label==='ID.PC'&&c.factory==='Register').ends[0];
    assert.notEqual(pin.netBits[0].netId,register.netBits[0].netId);

    // Explicit bends are kept, including the second and third clicked corners.
    await page.getByRole('button',{name:'ID.PC，Register',exact:true}).locator('[data-port-index="0"]').click();
    for(const p of [{x:880,y:180},{x:880,y:100},{x:1000,y:100}])await clickWorld(p);
    const preview = await page.locator('.wire-preview').getAttribute('points');
    assert.equal(preview,'740,180 880,180 880,100 1000,100');
    const beforeWire = await session();
    await page.getByRole('button',{name:'ID.PC，Pin',exact:true}).locator('[data-port-index="0"]').click();
    await changed(beforeWire.revision.id);
    current = await scene();
    for(const [a,b] of [[{x:880,y:180},{x:880,y:100}],[{x:880,y:100},{x:1000,y:100}]]) {
      assert.ok(current.wires.some(w=>JSON.stringify([w.from,w.to].sort((p,q)=>p.x-q.x||p.y-q.y))===JSON.stringify([a,b].sort((p,q)=>p.x-q.x||p.y-q.y))));
    }
    assert.equal(await page.locator('#agentTab').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#questionInput').inputValue(),'我正在调整控制线和寄存器位置，稍后继续讨论。');
    await page.locator('#fitButton').click();
    await page.screenshot({path:output+'/03-reconnected.png'});
    await page.locator('#saveButton').click();await page.locator('#confirmSave').click();await page.locator('#saveDialog').waitFor({state:'hidden'});
    const saved = await session();assert.notDeepEqual(fs.readFileSync(source),original);
    await app.close();app = await launch();page = await app.firstWindow();await open();
    assert.equal((await session()).workspace.id,initial.workspace.id);
    assert.equal((await session()).revision.id,saved.revision.id);
    // Operate the actual course registers after saving and reopening.
    const observation=()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json()));
    const value=(s,label)=>s.observation?.components.find(c=>c.label===label&&c.factory==='Pin')?.ports[0]?.value;
    await simulationMenu(page,'simulationStart');await waitUntil(()=>observation().then(s=>!!s.session));
    async function input(label,n) {
      await page.getByRole('button',{name:label+'，Pin',exact:true}).click();
      const field=page.getByRole('textbox',{name:'输入值',exact:true});await field.fill(String(n));await field.press('Enter');
      await waitUntil(()=>observation().then(s=>value(s,label)===n),{timeout:15000,label:label+' input'});
    }
    for(const [label,n] of [['CLK',0],['RST',1],['FETCH.EN',1],['BRANCH',0],['IF.PC',100],['IF.IR',111],['RST',0],['CLK',1]])await input(label,n);
    const captured = await observation();assert.equal(value(captured,'ID.PC'),100);assert.equal(value(captured,'ID.IR'),111);
    for(const [label,n] of [['CLK',0],['FETCH.EN',0],['BRANCH',1],['IF.PC',200],['CLK',1]])await input(label,n);
    const held=await observation();assert.equal(value(held,'ID.PC'),100);assert.equal(value(held,'ID.IR'),111);
    for(const [label,n] of [['CLK',0],['FETCH.EN',1],['CLK',1]])await input(label,n);
    const bubble=await observation();assert.equal(value(bubble,'ID.PC'),0);assert.equal(value(bubble,'ID.IR'),0);
    await page.screenshot({path:output+'/04-reopened-running.png'});
    await simulationMenu(page,'simulationStop');
    assert.equal((await session()).revision.id,saved.revision.id);
    assert.equal((await session()).workspace.dirty,false);
    assert.deepEqual(errors,[]);
    const deliver = path.join(repo,'exports/branch-editing');fs.mkdirSync(deliver,{recursive:true});
    for(const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar'])fs.copyFileSync(path.join(root,name),path.join(deliver,name));
    fs.writeFileSync(output+'/result.json',JSON.stringify({root,projectId:saved.workspace.id,revision:saved.revision.id,source,modelTurns:0,actions:['move shared control inputs','move two registers','undo and repeat move','delete exact output wire','reconnect with three explicit bends','save','reopen','native capture, stalled branch and enabled bubble'],viewportPreserved:true,draftPreservedDuringEdits:true,captured:[100,111],stalled:[100,111],bubble:[0,0]},null,2));
    console.log('Real branch editing, undo, multi-bend reconnect, save/reopen and native clock behavior complete',root);
  } catch(error) {
    console.error('Visible error:',await page.locator('#canvasStatus').textContent().catch(()=>''));
    await page.screenshot({path:output+'/failure.png'}).catch(()=>{});throw error;
  }
  finally { await app.close(); }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
