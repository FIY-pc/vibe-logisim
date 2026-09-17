'use strict';

// Reproduce a supplied full adder through real Electron mouse/keyboard input.
// The user's file is copied to a scratch folder and must remain byte-identical.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');

const repo = path.resolve(__dirname, '../../..');
const original = path.resolve(process.argv[2] || 'exports/interface-editing/full_adder.circ');
const executable = process.argv[3] && path.resolve(process.argv[3]);
const bytes = fs.readFileSync(original);
const root = fs.mkdtempSync('/tmp/vibe-simulation-inputs-');
const folder = path.join(root, '电路'); fs.mkdirSync(folder);
const file = path.join(folder, 'full_adder.circ'); fs.writeFileSync(file, bytes);
fs.writeFileSync(path.join(folder, 'controls.circ'), `<?xml version="1.0"?>
<project source="2.7.1" version="1.0">
<lib desc="#Wiring" name="0"/><lib desc="#I/O" name="1"/><main name="Controls"/>
<circuit name="Controls">
<comp lib="0" name="Pin" loc="(200,100)"><a name="label" val="BUS"/><a name="width" val="4"/><a name="tristate" val="false"/></comp>
<comp lib="0" name="Pin" loc="(450,100)"><a name="label" val="BUS.Q"/><a name="width" val="4"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
<wire from="(200,100)" to="(450,100)"/>
<comp lib="1" name="Button" loc="(200,200)"><a name="label" val="PUSH"/></comp>
<comp lib="0" name="Pin" loc="(450,200)"><a name="label" val="PUSH.Q"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
<wire from="(200,200)" to="(450,200)"/>
<comp lib="0" name="Clock" loc="(200,300)"><a name="label" val="CLK"/></comp>
<comp lib="0" name="Pin" loc="(450,300)"><a name="label" val="CLK.Q"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
<wire from="(200,300)" to="(450,300)"/>
</circuit></project>`);
const env = {...process.env, XDG_CONFIG_HOME: root + '/config', VIBE_LOGISIM_STATE_DIR: root + '/state', VIBE_LOGISIM_CODEX: root + '/no-agent'};
delete env.ELECTRON_RUN_AS_NODE;
let app, page, phase = 'launch', scene;
const errors = [], actions = [], truth = [];
const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
const simulation = () => page.evaluate(() => fetch('/api/simulation').then(r => r.json()));
const values = async () => Object.fromEntries((await simulation()).observation?.components.filter(c => c.label && c.ports.length).map(c => [c.label, c.ports[0].value]) || []);
async function idle(circuit) {
  await page.waitForFunction(() => document.querySelector('#canvasStatus').hidden && document.querySelector('#emptyState').hidden);
  scene = (await page.evaluate(name => fetch('/api/circuit?name=' + name).then(r => r.json()), circuit)).circuit;
}
async function click(label, edge = false) {
  const component = scene.components.find(c => c.label === label);
  assert.ok(component, label);
  const p = await page.locator('#circuitCanvas').evaluate((canvas, {b, edge}) => {
    const point = new DOMPoint(b.x + (edge ? b.width - 1 : b.width / 2), b.y + b.height / 2).matrixTransform(canvas.getScreenCTM());
    return {x: point.x, y: point.y};
  }, {b: component.bounds, edge});
  await page.mouse.click(p.x, p.y);
}
async function stop() {
  await page.locator('#simulationMenuButton').click();
  await page.locator('#simulationStop').click();
  await waitUntil(async () => !(await simulation()).session);
}
async function sample() {
  const v = await values();
  assert.equal(v.Sum, (v.A + v.B + v.Cin) % 2);
  assert.equal(v.Cout, Math.floor((v.A + v.B + v.Cin) / 2));
  truth.push(Object.fromEntries(['A', 'B', 'Cin', 'Sum', 'Cout'].map(k => [k, v[k]])));
}
async function delayedStart() {
  let release, arrived = false;
  const barrier = new Promise(resolve => { release = resolve; });
  await page.route('**/api/simulation', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'start') { arrived = true; await barrier; }
    await route.continue();
  });
  return {arrived: () => arrived, release};
}

(async () => {
  try {
    app = await _electron.launch({executablePath: executable || require('electron'),
      args: [...(executable ? [] : [path.join(repo, 'apps/desktop')]), file], chromiumSandbox: true, env});
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    await page.setViewportSize({width: 1500, height: 960});
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/simulation')) actions.push(request.postDataJSON());
    });
    await idle('FullAdder');
    const initial = await session();
    await click('A');
    assert.equal(await page.getByRole('textbox', {name: '输入值', exact: true}).getAttribute('placeholder'), '未运行');
    assert.equal((await simulation()).session, null, 'Selection alone does not start simulation');
    await page.locator('#simulationMenuButton').click(); await page.locator('#simulationSettings').click();
    await page.locator('#simulationFrequency').fill('8'); await page.locator('#simulationSettingsApply').click();
    await page.waitForFunction(() => !document.querySelector('#simulationOptions').open);

    phase = 'first click and further clicks during startup';
    await page.getByRole('button', {name: '操作输入', exact: true}).click();
    const held = await delayedStart();
    await click('A', true); await waitUntil(held.arrived);
    assert.equal(await page.locator('#pokeTool').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('.wire-port-hit:visible').count(), 0);
    await click('B'); await click('Cin'); held.release();
    await waitUntil(async () => { const v = await values(); return v.A === 1 && v.B === 1 && v.Cin === 1 && v.Cout === 1 && v.Sum === 1; });
    await page.unroute('**/api/simulation');
    assert.equal(actions.filter(a => a.action === 'start').length, 1);
    assert.equal((await simulation()).frequency, 8, 'Automatic start uses the chosen simulation settings');
    await sample();
    for (const label of ['Cin', 'B', 'Cin', 'A', 'Cin', 'B', 'Cin']) {
      const before = (await values())[label]; await click(label);
      await waitUntil(async () => (await values())[label] === 1 - before);
      await sample();
    }
    assert.equal(new Set(truth.map(v => `${v.A}${v.B}${v.Cin}`)).size, 8);
    await page.screenshot({path: root + '/full-adder-inputs.png'});

    phase = 'edit running value directly before starting';
    await stop(); await page.locator('#selectTool').click(); await click('A');
    const field = page.getByRole('textbox', {name: '输入值', exact: true});
    await field.fill('1'); await field.press('Enter');
    await waitUntil(async () => { const v = await values(); return v.A === 1 && v.Sum === 1 && v.Cout === 0; });

    phase = 'visible startup error and retry';
    await stop(); await page.locator('#pokeTool').click();
    await page.route('**/api/simulation', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'start') {
        await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {message: '仿真启动失败（验收注入）'}})});
      } else await route.continue();
    });
    await click('B'); await page.getByText('仿真启动失败（验收注入）', {exact: true}).waitFor();
    assert.equal((await simulation()).session, null);
    await page.unroute('**/api/simulation'); await click('B');
    await waitUntil(async () => (await values()).B === 1);
    assert.equal((await session()).revision.id, initial.revision.id);
    assert.ok(fs.readFileSync(file).equals(bytes)); assert.ok(fs.readFileSync(original).equals(bytes));

    phase = 'multi-bit input and cold button release';
    await stop(); await page.locator('#filesTab').click();
    await page.locator('.file-row').filter({hasText: 'controls.circ'}).click();
    await waitUntil(async () => (await session()).folder.activeFile === 'controls.circ'); await idle('Controls');
    await page.locator('#selectTool').click(); await click('BUS');
    await field.fill('0xa'); await field.press('Enter');
    await waitUntil(async () => (await values())['BUS.Q'] === 10);
    await stop(); await page.locator('#pokeTool').click();
    const buttonStart = await delayedStart(), offset = actions.length;
    await click('PUSH'); await waitUntil(buttonStart.arrived); buttonStart.release();
    await waitUntil(() => actions.slice(offset).filter(a => a.action === 'button').length === 2);
    await waitUntil(async () => (await values())['PUSH.Q'] === 0);
    assert.deepEqual(actions.slice(offset).filter(a => a.action === 'button').map(a => a.value), ['1', '0']);
    await page.unroute('**/api/simulation');
    const clock = (await values())['CLK.Q']; await click('CLK');
    await waitUntil(async () => (await values())['CLK.Q'] === 1 - clock);

    phase = 'navigation while the first click is waiting';
    await stop();
    const staleStart = await delayedStart(), staleOffset = actions.length;
    await click('BUS'); await waitUntil(staleStart.arrived);
    await page.locator('.file-row').filter({hasText: 'full_adder.circ'}).click();
    await waitUntil(async () => (await session()).folder.activeFile === 'full_adder.circ');
    await idle('FullAdder'); staleStart.release();
    await page.unrouteAll({behavior: 'wait'});
    await page.locator('#selectTool').click(); await click('A');
    assert.equal((await simulation()).session, null);
    assert.equal(actions.slice(staleOffset).filter(a => ['input', 'poke', 'button'].includes(a.action)).length, 0);
    assert.ok(fs.readFileSync(file).equals(bytes)); assert.ok(fs.readFileSync(original).equals(bytes));
    assert.deepEqual(errors, []);
    const result = {root, success: true, truth, sourceUnchanged: true, coldClicksPreserved: true,
      directInputBeforeStart: true, multiBitInput: true, buttonReleasedAfterColdStart: true, staleClickDiscarded: true,
      errorCase: 'startup failure injected; real retry', modelTurns: 0};
    fs.writeFileSync(root + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) {
    await page?.screenshot({path: root + '/failure.png'}).catch(() => {});
    console.error({root, phase, error, errors}); process.exitCode = 1;
  } finally { await app?.close(); }
})();
