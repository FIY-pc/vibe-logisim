'use strict';

// Real Electron clicks and native images. Only image delivery is held back to
// expose the handover between provisional components and the committed drawing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');

const repo = path.resolve(__dirname, '../../..');
const {requireSamples} = require('./support/samples.cjs');
const original = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'exports/interface-editing/full_adder.circ');
if (!process.argv[2]) requireSamples(repo, 'exports/interface-editing/full_adder.circ');
const bytes = fs.readFileSync(original);
const root = fs.mkdtempSync('/tmp/vibe-placement-rendering-');
const folder = root + '/电路'; fs.mkdirSync(folder);
const source = folder + '/full_adder.circ'; fs.writeFileSync(source, bytes);
fs.writeFileSync(folder + '/other.circ', '<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="Other"/><circuit name="Other"><comp lib="0" name="Pin" loc="(100,100)"/></circuit></project>');
const env = {...process.env, XDG_CONFIG_HOME:root + '/config', VIBE_LOGISIM_STATE_DIR:root + '/state', VIBE_LOGISIM_CODEX:root + '/no-agent'};
delete env.ELECTRON_RUN_AS_NODE;
let app, page, cdp, phase = 'launch';
const errors = [], frames = [], gates = [];
const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
async function idle() {
  await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') !== 'true' &&
    !document.querySelector('#placementToolbar .placement-loading') && !document.querySelector('[data-optimistic=true]'));
}
async function point(x, y) {
  const box = await page.locator('#circuitCanvas').boundingBox();
  return {x:box.x + box.width * x, y:box.y + box.height * y};
}
async function place(x, y) {
  const at = await point(x, y); await page.mouse.move(at.x, at.y); await page.mouse.click(at.x, at.y);
  await page.mouse.move(at.x + 20, at.y + 20);
}
async function holdNextDetail() {
  let release, arrived = false;
  const barrier = new Promise(resolve => {release = resolve;});
  gates.push(release);
  await page.route('**/api/render/viewport?*', async route => {
    arrived = true; await barrier; await route.continue();
  }, {times:1});
  return {arrived:() => arrived, release};
}

(async () => {
  try {
    app = await _electron.launch({executablePath:require('electron'), args:[repo + '/apps/desktop', source], chromiumSandbox:true, env});
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width:1500, height:960});
    await page.waitForFunction(() => document.querySelector('#currentCircuitName').textContent === 'FullAdder' && document.querySelector('#canvasStatus').hidden);
    const count = await page.locator('.circuit-component').count();
    for (let i = 0; i < 8; i++) await page.locator('#zoomInButton').click();
    await page.locator('#detailLayer image').first().waitFor();
    await page.locator('#circuitCanvas').press('a'); await page.locator('#componentSearch').fill('与门');
    await page.getByRole('button', {name:'与门', exact:true}).click();
    await page.waitForFunction(() => document.querySelector('#objectInspector [data-attribute]') && !document.querySelector('#placementToolbar .placement-loading'));
    await page.evaluate(() => {
      window.paintLog = []; window.recordPaint = true;
      const frame = () => {
        if (!window.recordPaint) return;
        const state = {base:document.querySelector('#runtimeLayer image')?.getAttribute('href'),
          detail:document.querySelector('#detailLayer image')?.getAttribute('href'),
          revision:document.querySelector('#detailLayer image')?.dataset.revision,
          pending:document.querySelectorAll('[data-optimistic=true]').length,
          components:document.querySelectorAll('.circuit-component').length,
          view:document.querySelector('#circuitCanvas').getAttribute('viewBox')};
        window.paintLog.push({at:performance.now(), ...state}); requestAnimationFrame(frame);
      }; frame();
    });
    cdp = await page.context().newCDPSession(page);
    cdp.on('Page.screencastFrame', async event => {
      frames.push({time:event.metadata.timestamp, data:event.data});
      await cdp.send('Page.screencastFrameAck', {sessionId:event.sessionId});
    });
    await cdp.send('Page.startScreencast', {format:'png', everyNthFrame:1});

    phase = 'two clicks while replacement images are held';
    const before = await page.locator('#detailLayer image').first().getAttribute('href');
    const first = await holdNextDetail(); await place(.77, .25); await waitUntil(first.arrived);
    assert.equal(await page.locator('#detailLayer image').first().getAttribute('href'), before);
    assert.equal(await page.locator('[data-optimistic=true]').count(), 1);
    await place(.5, .65);
    assert.equal(await page.locator('[data-optimistic=true]').count(), 2);
    const second = await holdNextDetail(); first.release(); await waitUntil(second.arrived);
    assert.equal(await page.locator('[data-optimistic=true]').count(), 1, 'The second click survives the first image commit');
    assert.equal(await page.locator('.circuit-component').count(), count + 2);
    second.release(); await idle();
    await page.waitForFunction(revision => document.querySelector('#detailLayer image')?.dataset.revision === revision, (await session()).revision.id);
    await cdp.send('Page.stopScreencast');
    const log = await page.evaluate(() => {window.recordPaint = false; return window.paintLog;});
    assert.ok(log.length > 5);
    assert.ok(log.every(frame => frame.base && frame.detail), 'No frame loses its drawing or falls back to the coarse image');
    assert.equal(new Set(log.map(frame => frame.view)).size, 1, 'The viewport stays still');
    assert.equal(new Set(log.map(frame => frame.base)).size, 3, 'Only the initial drawing and two prepared commits are displayed');
    assert.equal(await page.locator('.circuit-component').count(), count + 2);
    await page.screenshot({path:root + '/after-continuous-placement.png'});
    fs.writeFileSync(root + '/paint-log.json', JSON.stringify(log, null, 2));
    for (let i = 0; i < frames.length; i++) fs.writeFileSync(root + `/frame-${String(i).padStart(3, '0')}.png`, Buffer.from(frames[i].data, 'base64'));

    phase = 'ordinary scale and saving';
    await page.keyboard.press('Escape'); await page.locator('#fitButton').click();
    await page.locator('#circuitCanvas').press('a'); await page.locator('#componentSearch').fill('与门');
    await page.getByRole('button', {name:'与门', exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('#placementToolbar .placement-loading'));
    await place(.8, .75); await idle();
    assert.equal(await page.locator('.circuit-component').count(), count + 3);
    assert.equal((fs.readFileSync(source, 'utf8').match(/name="AND Gate"/g) || []).length, 5);

    phase = 'navigation before an image finishes';
    for (let i = 0; i < 8; i++) await page.locator('#zoomInButton').click();
    await page.locator('#detailLayer image').first().waitFor();
    const late = await holdNextDetail(); await place(.8, .4); await waitUntil(late.arrived);
    await page.locator('#filesTab').click(); await page.locator('.file-row').filter({hasText:'other.circ'}).click();
    await page.waitForFunction(() => document.querySelector('#currentCircuitName').textContent === 'Other' && document.querySelector('#canvasStatus').hidden);
    const otherImage = await page.locator('#runtimeLayer image').getAttribute('href');
    late.release(); await page.unrouteAll({behavior:'wait'}); await idle();
    assert.equal(await page.locator('#currentCircuitName').innerText(), 'Other');
    assert.equal(await page.locator('#runtimeLayer image').getAttribute('href'), otherImage);
    assert.equal(await page.locator('.circuit-component').count(), 1);
    assert.equal(await page.locator('[data-optimistic=true]').count(), 0);
    assert.ok(fs.readFileSync(original).equals(bytes)); assert.deepEqual(errors, []);
    const result = {root, success:true, sampledFrames:log.length, capturedFrames:frames.length,
      drawingAlwaysPresent:true, detailAlwaysPresent:true, viewportStable:true,
      nextClickSurvivesCommit:true, sourcePreserved:true, lateImageDiscarded:true, modelTurns:0};
    fs.writeFileSync(root + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) {
    await page?.screenshot({path:root + '/failure.png'}).catch(() => {});
    console.error({root, phase, error, errors}); process.exitCode = 1;
  } finally {
    gates.forEach(release => release());
    await page?.unrouteAll({behavior:'ignoreErrors'}).catch(() => {});
    await app?.close();
  }
})();
