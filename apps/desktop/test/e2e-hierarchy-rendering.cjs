'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');
const repo = path.resolve(__dirname, '../../..');
const output = path.join(repo, 'apps/desktop/docs/product/evidence/2026-09-15-hierarchy-rendering');
fs.mkdirSync(output, {recursive:true});

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hierarchy-'));
  for (const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar']) fs.copyFileSync(path.join(repo,'exports/branch-editing',name),path.join(root,name));
  const source = path.join(root,'stage6-if-id.circ'), original = fs.readFileSync(source);
  const env = {...process.env, XDG_CONFIG_HOME:path.join(root,'config'), VIBE_LOGISIM_STATE_DIR:path.join(root,'state')};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({executablePath:require('electron'),args:[path.join(repo,'apps/desktop'),source,'--no-sandbox'],env});
  const page = await app.firstWindow(), errors = [];
  const renders = [];
  page.on('response', response => {
    if (response.url().includes('/api/render/viewport')) renders.push({url:response.url(), status:response.status()});
  });
  page.on('pageerror', e => errors.push(e.message));
  const session = () => page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  const idle = () => page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy')==='false');
  try {
    await page.setViewportSize({width:1500,height:960});
    await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^◇气泡流水线$/})}).click({timeout:90000});
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◇气泡流水线');
    await page.locator('#findObject').click();await page.locator('#finderInput').fill('IF_ID');await page.locator('#finderInput').press('Enter');
    await page.locator('.circuit-component.is-selected').waitFor();
    const parent = await page.locator('#circuitCanvas').getAttribute('viewBox');
    if(process.argv.includes('--baseline')) {
      await page.screenshot({path:output+'/01-before.png'});
      console.log('Baseline captured', root, parent);
      return;
    }
    const detail = page.locator('#detailLayer image');
    await detail.waitFor({timeout:60000});
    assert.equal(await detail.getAttribute('data-circuit'),'◇气泡流水线');
    const sharp = await detail.evaluate(n=>Object.fromEntries([...n.attributes].map(a=>[a.name,a.value]).filter(([name])=>name!=='href')));
    assert.ok(Number(sharp['data-pixel-width'])>=page.viewportSize().width/2);
    await page.screenshot({path:output+'/02-native-detail.png'});
    await page.locator('.circuit-component.is-selected').dblclick();
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='IF_ID');
    await page.getByRole('button',{name:'ID.PC，Register',exact:true}).waitFor();
    await idle();
    assert.equal(await page.locator('.breadcrumb-parent').textContent(),'◇气泡流水线');
    assert.match(await page.locator('#definitionContext').textContent(),/共享定义.*引用/);
    await page.locator('#questionInput').fill('我在看 IF 到 ID 的边界，先整理内部命名，再回上层。');
    const initial = await session();
    await page.getByRole('button',{name:'ID.PC，Register',exact:true}).click();
    await page.getByRole('textbox',{name:'标签',exact:true}).fill('ID.PC 暂存');
    await page.getByRole('textbox',{name:'标签',exact:true}).press('Enter');
    await waitUntil(()=>session().then(s=>s.revision.id!==initial.revision.id),{timeout:45000,label:'edit inside shared circuit'});await idle();
    await page.getByRole('button',{name:'ID.PC 暂存，Register',exact:true}).waitFor();
    assert.equal(await page.locator('#circuitBack').isEnabled(),true,'editing retains the parent route');
    await page.screenshot({path:output+'/03-child-edit.png'});
    await page.locator('#undoButton').click();
    await waitUntil(()=>session().then(s=>s.revision.id===initial.revision.id),{timeout:45000,label:'undo'});await idle();
    await page.locator('#findObject').click();await page.locator('#finderInput').fill('ID.PC Register');await page.locator('#finderInput').press('Enter');
    await page.locator('#zoomInButton').click();
    await detail.waitFor({timeout:30000});
    const register=page.getByRole('button',{name:'ID.PC，Register',exact:true});
    const box=await register.boundingBox(), scale=await page.locator('#circuitCanvas').evaluate(n=>n.getScreenCTM().a);
    const pointer={x:box.x+box.width/2,y:box.y+box.height/2};
    await page.mouse.move(pointer.x,pointer.y);await page.mouse.down();
    await page.mouse.move(pointer.x+20*scale,pointer.y,{steps:8});
    assert.equal(await page.locator('.move-preview image').count(),2,'drag preview includes sharp native detail');
    await page.mouse.up();
    await waitUntil(()=>session().then(s=>s.revision.id!==initial.revision.id),{timeout:45000,label:'zoomed component move'});await idle();
    assert.equal(await page.locator('#nativeArtwork').evaluate(n=>n.style.opacity),'');
    // On this desktop captureScreenshot can emit lostpointercapture. Capture
    // after release so collecting evidence cannot cancel the user's gesture.
    await detail.waitFor({timeout:30000});
    await page.screenshot({path:output+'/06-zoomed-drag.png'});
    await page.locator('#undoButton').click();
    await waitUntil(()=>session().then(s=>s.revision.id===initial.revision.id),{timeout:45000,label:'undo zoomed move'});await idle();
    await page.locator('.breadcrumb-parent').click();
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◇气泡流水线');
    await page.locator('.circuit-component.is-selected').waitFor();
    assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),parent,'return restores the parent camera after edits');
    assert.match(await page.locator('.circuit-component.is-selected').getAttribute('aria-label'),/IF_ID/);
    assert.equal(await page.locator('#questionInput').inputValue(),'我在看 IF 到 ID 的边界，先整理内部命名，再回上层。');
    await detail.waitFor({timeout:30000});
    await page.screenshot({path:output+'/04-return-to-parent.png'});

    // Delay an actual native response, then leave the circuit while it is in flight.
    let release, intercepted=false, delivered=false;
    const gate=new Promise(resolve=>release=resolve);
    await page.route('**/api/render/viewport?**',async route=>{
      const response=await route.fetch(); intercepted=true;
      await gate;
      try {await route.fulfill({response});} catch (_) { /* navigation may abort the request */ }
      delivered=true;
    },{times:1});
    await page.locator('#zoomInButton').click();
    await waitUntil(()=>intercepted,{timeout:30000,label:'native viewport response'});
    await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click();
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='IF_ID');
    release(); await waitUntil(()=>delivered);
    assert.equal(await page.locator('.breadcrumb-parent').count(),0,'sidebar opens a definition directly');
    assert.equal(await page.locator('#circuitBack').isDisabled(),true);
    assert.equal(await page.locator('#detailLayer image[data-circuit="◇气泡流水线"]').count(),0,'late parent image never covers the child');

    // Rapid zoom and resizing resolve to the last visible region.
    for(let i=0;i<9;i++)await page.locator('#zoomInButton').click();
    await page.setViewportSize({width:1400,height:900});
    await waitUntil(()=>detail.evaluateAll(nodes=>{
      if(!nodes.length)return false;
      const image=nodes[0], svg=document.querySelector('#circuitCanvas');
      const rect=svg.getBoundingClientRect(), inverse=svg.getScreenCTM().inverse();
      const a=new DOMPoint(rect.left,rect.top).matrixTransform(inverse), b=new DOMPoint(rect.right,rect.bottom).matrixTransform(inverse);
      return image.dataset.circuit==='IF_ID' && Number(image.getAttribute('x'))<=a.x && Number(image.getAttribute('y'))<=a.y &&
        Number(image.getAttribute('x'))+Number(image.getAttribute('width'))>=b.x && Number(image.getAttribute('y'))+Number(image.getAttribute('height'))>=b.y;
    }),{timeout:30000,label:'latest resized viewport'});
    await simulationMenu(page,'simulationStart');
    await page.waitForFunction(()=>document.querySelector('#documentKind').textContent==='运行实例');
    assert.equal(await detail.count(),0,'static detail does not cover live values');
    await page.locator('#zoomInButton').click();
    assert.equal(await detail.count(),0);
    await simulationMenu(page,'simulationStop');
    await page.waitForFunction(()=>document.querySelector('#documentKind').textContent==='电路定义');
    await detail.waitFor({timeout:30000});
    await page.route('**/api/render/viewport?**', route=>route.fulfill({status:503,body:'injected drawing failure'}),{times:1});
    await page.locator('#zoomInButton').click();
    await page.getByRole('button',{name:'细节未加载 · 重试',exact:true}).waitFor();
    assert.equal(await page.locator('#runtimeLayer image').count(),1,'base circuit stays visible when detail drawing fails');
    await page.locator('#renderStatus').click();
    await page.locator('#renderStatus').waitFor({state:'hidden',timeout:30000});
    assert.equal(await detail.count(),1);
    await page.locator('#fitButton').click();

    // Traverse the actual three-level course circuit, including keyboard entry
    // and an ancestor jump. This is not a generated hierarchy fixture.
    await page.locator('#circuitList .circuit-item').filter({has:page.locator('strong',{hasText:/^◆封装正确性测试$/})}).click();
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◆封装正确性测试');
    async function locate(query) {
      await page.locator('#findObject').click();await page.locator('#finderInput').fill(query);await page.locator('#finderInput').press('Enter');
      await page.locator('.circuit-component.is-selected').waitFor();
    }
    await locate('◇气泡流水线');
    const wrapperCamera=await page.locator('#circuitCanvas').getAttribute('viewBox');
    await page.keyboard.press('Alt+Enter');
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◇气泡流水线');
    await locate('IF_ID');
    const nestedCamera=await page.locator('#circuitCanvas').getAttribute('viewBox');
    await page.keyboard.press('Alt+Enter');
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='IF_ID');
    assert.deepEqual(await page.locator('.breadcrumb-parent').allTextContents(),['◆封装正确性测试','◇气泡流水线']);
    await page.screenshot({path:output+'/05-three-level-route.png'});
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◇气泡流水线');
    await page.locator('.circuit-component.is-selected').waitFor();
    assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),nestedCamera);
    await page.locator('.circuit-component.is-selected').dblclick();
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='IF_ID');
    await page.locator('.breadcrumb-parent').first().click();
    await page.waitForFunction(()=>document.querySelector('#currentCircuitName').textContent==='◆封装正确性测试');
    await page.locator('.circuit-component.is-selected').waitFor();
    assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'),wrapperCamera);
    assert.match(await page.locator('.circuit-component.is-selected').getAttribute('aria-label'),/◇气泡流水线/);
    const final = await session();
    assert.equal(final.revision.id,initial.revision.id,'navigation, rendering and simulation do not revise the circuit');
    assert.deepEqual(fs.readFileSync(source),original);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(output+'/result.json',JSON.stringify({root,projectId:initial.workspace.id,revision:initial.revision.id,
      modelTurns:0,parentCamera:parent,sharp,sourceUnchanged:true,revisionRestored:true,lateImageDiscarded:true,
      liveImageUncovered:true,drawingFailureRecovered:true,threeLevelNavigation:true,sharpDragPreview:true,
      actions:['locate IF_ID in course CPU','native viewport drawing','enter shared definition','edit label','undo','return to parent camera and instance','switch definition while native drawing pending','rapid zoom and resize','start and stop native simulation','recover failed detail drawing','three-level keyboard entry, return and ancestor jump'],renders},null,2));
    console.log('Hierarchy, native viewport drawing and live-state isolation complete',root);
  } catch(error) {
    console.error(await page.locator('#canvasStatus').textContent().catch(()=>''));
    await page.screenshot({path:output+'/failure.png'}).catch(()=>{});throw error;
  } finally { await app.close(); }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
