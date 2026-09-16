'use strict';
const {simulationMenu}=require('./support/simulation-menu.cjs');
const assert = require('node:assert/strict');
const {waitUntil} = require('./support/wait-until.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron: electron} = require('playwright');
const repo = path.resolve(__dirname, '../../..');

// Exercises the actual Electron preload, filesystem preferences, native
// circuit editing and UI. Message events are a labelled deterministic replay;
// this script never asks a model or measures its circuit-building ability.
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-collaboration-e2e-'));
  const source = path.join(root, 'half-adder.circ');
  fs.copyFileSync(path.join(repo, 'archive/tooling/tmp/half_adder.circ'), source);
  const original = fs.readFileSync(source);
  const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR: path.join(root, 'state')};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({executablePath: require('electron'), args: [path.join(repo, 'apps/desktop'), source, '--no-sandbox'], env, timeout: 30000});
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({width:1440,height:960});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('.circuit-component', {timeout: 60000});
    const emit = event => app.evaluate(({BrowserWindow}, event) => BrowserWindow.getAllWindows()[0].webContents.send('vibe-logisim:agent-event', event), event);
    // Source-backed task actions remain real; only assistant messages replay.
    await emit({type: 'assistant-completed', itemId: 'layout-replay', text: '界面回放验收（非模型运行）\n\n这个半加器用 XOR 计算 sum，用 AND 计算 carry。\n\n可以在左侧修改输入 a 的标签，右侧保留这段说明，然后直接启动仿真。'});
    await page.locator('#questionInput').fill('下一步我想理解进位为什么用 AND。');
    await page.locator('.circuit-component').first().click();
    assert.equal(await page.locator('#agentTab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#objectInspector').isVisible(), true);
    assert.match(await page.locator('#selectionSummary').textContent(), /a/);
    assert.equal(await page.locator('#questionInput').inputValue(), '下一步我想理解进位为什么用 AND。');
    const before = await page.evaluate(() => fetch('/api/session').then(r=>r.json()).then(s=>s.revision.id));
    await page.getByRole('textbox', {name:'标签', exact:true}).fill('输入A');
    await page.getByRole('textbox', {name:'标签', exact:true}).press('Enter');
    await waitUntil(()=>page.evaluate(()=>fetch('/api/session').then(r=>r.json())).then(s=>s.revision.id!==before));
    await page.waitForFunction(()=>document.querySelector('#appShell').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#agentTab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#questionInput').inputValue(), '下一步我想理解进位为什么用 AND。');
    assert.equal(await page.locator('[data-item-id="layout-replay"]').isVisible(), true);
    // Layout changes go through actual desktop preferences and survive reload.
    const handle = page.locator('#reviewResize');
    await handle.press('Home');
    const initialWidth = Number(await handle.getAttribute('aria-valuenow'));
    await handle.press('ArrowRight');
    const narrowed = Number(await handle.getAttribute('aria-valuenow'));
    assert.ok(narrowed < initialWidth);
    const stored = await page.evaluate(()=>window.vibeDesktop.getLayout());
    assert.ok(stored.review >= 320 && stored.review <= 640);
    const bounds = await page.locator('#railResize').boundingBox();
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+120);
    await page.mouse.down();await page.mouse.move(bounds.x+36,bounds.y+120,{steps:6});await page.mouse.up();
    const storedDrag = await page.evaluate(()=>window.vibeDesktop.getLayout());
    assert.ok(storedDrag.rail > 260);
    await simulationMenu(page,'simulationStart');
    await waitUntil(()=>page.evaluate(()=>fetch('/api/simulation').then(r=>r.json())).then(s=>!!s.session));
    await simulationMenu(page,'simulationStop');
    // Busy mode accepts a next draft, and does not send on a second shortcut.
    await emit({type:'turn-started'});
    assert.equal(await page.locator('#questionInput').isEnabled(), true);
    await page.locator('#questionInput').fill('先保留我的下一条问题。');
    await page.locator('#questionInput').press('Control+Enter');
    assert.equal(await page.locator('#questionInput').inputValue(),'先保留我的下一条问题。');
    await emit({type:'turn-completed',status:'completed'});
    await emit({type:'activity',itemId:'command-replay',kind:'command',status:'running',label:'python scripts/example.py --details'});
    assert.equal(await page.locator('.agent-work').getAttribute('open'),null);
    assert.equal(await page.locator('.agent-work summary').textContent(),'正在执行本地操作');
    await emit({type:'activity',itemId:'command-replay',kind:'command',status:'completed',label:'python scripts/example.py --details'});
    await page.locator('.agent-work summary').click();
    assert.equal(await page.locator('.agent-work .agent-activity').isVisible(),true);
    await page.locator('.agent-work summary').click();
    // Scroll intent survives incoming output; explicit jump resumes following.
    for(let i=0;i<12;i++) await emit({type:'assistant-completed',itemId:`replay-${i}`,text:`界面回放段落 ${i+1}\n\n${'这里是用于检查长回答阅读与滚动的文字。'.repeat(12)}`});
    await page.waitForTimeout(150);
    const timeline=page.locator('#agentTimeline');const tb=await timeline.boundingBox();
    await page.mouse.move(tb.x+tb.width/2,tb.y+tb.height/2);await page.mouse.wheel(0,-1200);
    await page.locator('#conversationLatest').waitFor({state:'visible'});
    const scrollBefore=await timeline.evaluate(n=>n.scrollTop);
    await emit({type:'assistant-completed',itemId:'last-replay',text:'新的回放消息，不应抢走正在阅读的位置。'});
    await page.waitForTimeout(150);
    assert.equal(await timeline.evaluate(n=>n.scrollTop),scrollBefore);
    await page.locator('#conversationLatest').click();
    await page.locator('#conversationLatest').waitFor({state:'hidden'});
    await emit({type:'history',messages:[{type:'assistant',id:'layout-replay-final',text:'界面回放验收（非模型运行）\n\n现在你可以边看说明，边选择与修改电路。\n\n- 左侧：当前元件的属性和接口\n- 中间：电路与运行观察\n- 右侧：讨论和下一条草稿'}]});
    await page.locator('.circuit-component').first().click();
    const output=process.env.VIBE_UI_EVIDENCE || root;
    fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,'03-collaboration-desktop.png')});
    // Compact window: native min width may prevent OS resize; emulate CSS
    // viewport for browser layout only, keeping the real preload and service.
    await page.setViewportSize({width:980,height:720});
    await page.waitForTimeout(100);
    const toolbar=await page.locator('.canvas-toolbar').boundingBox(),canvas=await page.locator('#canvasStage').boundingBox();
    assert.ok(toolbar.x>=canvas.x && toolbar.x+toolbar.width<=canvas.x+canvas.width+1);
    await page.screenshot({path:path.join(output,'04-collaboration-compact.png')});
    await page.reload();await page.waitForSelector('.circuit-component');
    assert.deepEqual(await page.evaluate(()=>window.vibeDesktop.getLayout()),storedDrag);
    assert.deepEqual(fs.readFileSync(source), original);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({selection:'keeps-conversation-and-draft',edit:'native-label-change',panels:'keyboard-drag-persist',draft:'editable-while-busy',scroll:'reading-position-preserved',simulation:'start-stop',modelCalls:0,evidence:output}));
  } finally {await app.close();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
