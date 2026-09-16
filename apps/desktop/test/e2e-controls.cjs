'use strict';
// Actual Electron and host preferences. A labelled IPC failure is injected;
// no model generation, user workspace changes, or browser-only acceptance.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');
const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-controls-'));
const out = repo + '/apps/desktop/docs/product/evidence/2026-09-16-controls';
fs.mkdirSync(out, {recursive:true});
for (const name of ['stage6-if-id.circ','cs3410.jar','riscv-probe.jar']) {
  fs.copyFileSync(repo + '/exports/interface-editing/' + name, root + '/' + name);
}
const source = root + '/stage6-if-id.circ', original = fs.readFileSync(source);
const env = {...process.env, XDG_CONFIG_HOME:root+'/config', VIBE_LOGISIM_STATE_DIR:root+'/state'};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [], result = {root, modelTurns:0};
const state = () => page.evaluate(() => window.vibeDesktop.agent.getState());
const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
const shot = name => page.screenshot({path:out+'/'+name+'.png'});
const camera = () => page.locator('#circuitCanvas').getAttribute('viewBox');
const selected = () => page.locator('.circuit-component.is-selected').getAttribute('data-object-id');
async function upward(panel, trigger) {
  const menu = await page.locator(panel).boundingBox(), button = await page.locator(trigger).boundingBox();
  assert.ok(menu && menu.y + menu.height <= button.y, 'Picker should open above its composer trigger');
  assert.ok(menu.x >= 0 && menu.x + menu.width <= (await page.viewportSize()).width);
}
async function openModel() {
  await page.locator('#agentModel').click();
  await page.waitForFunction(() => document.querySelector('#modelLoading').hidden && document.querySelectorAll('#modelChoice [role=option]').length > 1);
}

(async () => {
  try {
    app = await _electron.launch({executablePath:require('electron'), args:[repo+'/apps/desktop',source,'--no-sandbox'], env});
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width:1500,height:960});
    await app.evaluate((_, repo) => {
      const require = process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
      require('./codex-backend.cjs').CodexBackend.prototype.ask = async () => { throw new Error('Model generation is disabled in control acceptance'); };
    }, repo);
    await page.locator('#circuitList button').filter({has:page.locator('strong',{hasText:/^IF_ID$/})}).click({timeout:90000});
    await page.waitForFunction(() => document.querySelector('#canvasStatus').hidden);
    const initial = await waitUntil(() => state().then(s => s.status === 'ready' && s), {timeout:90000});
    const project = await session();
    await page.locator('#questionInput').fill('先讨论控制线的整理方式，不改变现有的数据路径。');
    await page.locator('#findObject').click(); await page.locator('#finderInput').fill('ID.PC'); await page.locator('#finderInput').press('Enter');
    for (let i=0; i<2; i++) await page.locator('#zoomInButton').click();
    const chosen = await selected(), zoomed = await camera();
    // Each panel has one persistent control at its own edge; no implicit fit.
    assert.equal(await page.locator('#expandConversation,#hideCircuits,#closeReview,select#agentMode').count(), 0);
    assert.ok((await page.locator('#toggleCircuits').boundingBox()).x < 60);
    assert.ok((await page.locator('#toggleReview').boundingBox()).x > 1400);
    await page.locator('#toggleCircuits').click(); await page.locator('#circuitRail').waitFor({state:'hidden'});
    assert.equal(await page.locator('#toggleCircuits').getAttribute('aria-label'), '展开电路目录');
    assert.equal(await camera(), zoomed); await page.locator('#toggleCircuits').click(); await page.locator('#circuitRail').waitFor();
    await page.locator('#toggleReview').focus(); await page.keyboard.press('Control+Alt+b'); await page.locator('#reviewPanel').waitFor({state:'hidden'});
    await page.keyboard.press('Control+Alt+b'); await page.locator('#reviewPanel').waitFor();
    assert.equal(await selected(), chosen); assert.equal(await camera(), zoomed);
    await page.locator('#questionInput').focus(); await page.keyboard.press('Control+b');
    assert.equal(await page.locator('#circuitRail').isVisible(), true, 'Text editing must not hide the workspace');
    // Policy is a real host setting, with one explanation per choice.
    await page.locator('#agentMode').click(); await upward('#modeMenu','#agentMode'); await shot('01-application-mode');
    await page.locator('#modeOptions [data-mode=auto]').click();
    await waitUntil(() => state().then(s => s.policy === 'auto'));
    await page.waitForFunction(() => document.activeElement.id === 'agentMode');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    await waitUntil(() => state().then(s => s.policy === 'review'));
    assert.equal(await page.locator('#agentMode').innerText(), '先看改动');
    // Real catalog + immediate model choice; thread and compatible effort survive.
    await openModel(); await upward('#modelDialog','#agentModel'); await shot('02-model-choice');
    const catalog = await page.evaluate(() => window.vibeDesktop.agent.listModels());
    const alternative = catalog.models.find(m => m.model !== initial.model && m.efforts.length);
    await page.locator('#modelSearch').fill(alternative.name);
    await page.locator('#modelSearch').press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#modelDialog').open);
    assert.equal((await state()).model, alternative.model); assert.equal((await state()).threadId, initial.threadId);
    assert.equal(await page.locator('#modelSave,#modelEffort').count(), 0);
    await page.locator('#agentEffort').click();
    await page.locator('#effortOptions [data-effort]').first().waitFor();
    await upward('#effortMenu','#agentEffort'); await shot('03-thinking-depth');
    const depth = alternative.efforts.at(-1).value;
    await page.locator('#effortOptions [data-effort="'+depth+'"]').click();
    await waitUntil(() => state().then(s => s.effort === depth));
    assert.equal((await state()).model, alternative.model);
    // Failure must keep the previous real preference; retry the same visible choice.
    await app.evaluate((_,repo) => {
      const require = process.getBuiltinModule('node:module').createRequire(repo+'/apps/desktop/electron/main.cjs');
      const proto = require('./codex-backend.cjs').CodexBackend.prototype, original = proto.selectModel;
      proto.selectModel = async function(selection) { proto.selectModel = original; throw new Error('验收注入：偏好保存暂时失败'); };
    }, repo);
    await openModel(); await page.locator('#modelChoice [data-model="'+initial.model+'"]').click();
    await page.locator('#modelError').waitFor(); assert.match(await page.locator('#modelError').innerText(), /验收注入/);
    assert.equal((await state()).model, alternative.model);
    await page.locator('#modelChoice [data-model="'+initial.model+'"]').click();
    await page.waitForFunction(() => !document.querySelector('#modelDialog').open);
    assert.equal((await state()).model, initial.model);
    // One resize mechanism, including keyboard and double-click reset.
    const handle = await page.locator('#reviewResize').boundingBox();
    await page.mouse.move(handle.x+4,handle.y+80); await page.mouse.down(); await page.mouse.move(handle.x-330,handle.y+80,{steps:10}); await page.mouse.up();
    assert.ok((await page.locator('#reviewPanel').boundingBox()).width > 640);
    await shot('04-wide-conversation');
    await page.locator('#reviewResize').focus(); await page.keyboard.press('Home');
    await waitUntil(() => page.locator('#reviewPanel').boundingBox().then(b => Math.abs(b.width-400)<2));
    assert.equal(await camera(), zoomed); assert.equal(await selected(), chosen);
    // Narrow drawer, resizing while a picker is open, outside dismissal and focus.
    await page.setViewportSize({width:800,height:740}); await page.locator('#toggleReview').click(); await page.locator('#reviewPanel').waitFor();
    await page.locator('#agentMode').click(); await upward('#modeMenu','#agentMode'); await shot('05-compact-menu');
    await page.setViewportSize({width:900,height:740}); await upward('#modeMenu','#agentMode');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#modeMenu').matches(':popover-open'));
    await page.locator('#agentEffort').click(); await page.locator('#effortOptions [data-effort]').first().waitFor();
    await page.locator('#currentCircuitName').click(); await page.waitForFunction(() => !document.querySelector('#effortMenu').matches(':popover-open'));
    assert.equal(await page.locator('#questionInput').inputValue(), '先讨论控制线的整理方式，不改变现有的数据路径。');
    await page.setViewportSize({width:1500,height:960});
    await openModel(); await page.locator('#modelChoice [data-model=""]').click();
    await page.waitForFunction(() => !document.querySelector('#modelDialog').open);
    assert.equal((await state()).modelSelection, null);
    await shot('06-workspace');
    assert.equal((await session()).revision.id, project.revision.id);
    assert.deepEqual(fs.readFileSync(source), original); assert.deepEqual(errors, []);
    // The single width preference survives a real desktop restart, including widths above the old 640 limit.
    const resize = await page.locator('#reviewResize').boundingBox();
    await page.mouse.move(resize.x+4,resize.y+80); await page.mouse.down(); await page.mouse.move(resize.x-330,resize.y+80,{steps:10}); await page.mouse.up();
    const wide = (await page.locator('#reviewPanel').boundingBox()).width;
    assert.ok(wide>640);
    await app.close(); app=null;
    app=await _electron.launch({executablePath:require('electron'),args:[repo+'/apps/desktop',source,'--no-sandbox'],env});
    page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1500,height:960});
    await page.waitForFunction(()=>document.querySelector('#canvasStatus').hidden&&document.querySelector('#workspaceName').textContent.includes('stage6'),{},{timeout:90000});
    await waitUntil(()=>page.locator('#reviewPanel').boundingBox().then(b=>Math.abs(b.width-wide)<2));
    await waitUntil(()=>page.locator('#questionInput').inputValue().then(v=>v==='先讨论控制线的整理方式，不改变现有的数据路径。'));
    assert.equal((await session()).workspace.id,project.workspace.id);assert.deepEqual(errors,[]);
    result.restart='panel width above 640 and draft restored in the same project';
    Object.assign(result, {menus:'upward, keyboard, outside-dismiss, resize, current choices and real host persistence',
      panels:'one toggle per edge, keyboard, no implicit fit, one resizer, narrow drawers',
      recovery:'injected preference write failure retains old selection; real retry succeeds',
      preserved:'draft, selection, camera, thread, project revision and source', errors});
    fs.writeFileSync(out+'/acceptance.json', JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
  } catch (error) {
    await page?.screenshot({path:out+'/failure.png'}).catch(()=>{}); console.error('UI errors:', errors); throw error;
  } finally { await app?.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
