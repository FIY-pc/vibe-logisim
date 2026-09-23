// Cross-platform smoke test for a packaged bundle (Linux or Windows).
// Runs the shipped executable outside the checkout with a fresh app-data dir:
// open folder -> new circuit -> place AND + pins -> wire -> native truth table
// -> restart and reopen -> bundled Codex app-server reaches auth-required.
// No model turn is sent and no credentials are used.
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {_electron} = require('playwright'), {waitUntil} = require('./support/wait-until.cjs');
const executable = path.resolve(process.argv[2] || 'missing-packaged-executable');
assert.ok(fs.existsSync(executable), 'Pass the packaged vibe-logisim executable as the first argument');
const windows = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(process.env.VIBE_SMOKE_ROOT || os.tmpdir(), 'vibe-smoke-'));
const folder = path.join(root, '我的电路 workspace'); fs.mkdirSync(folder);
const out = process.argv[3] ? path.resolve(process.argv[3]) : root; fs.mkdirSync(out, {recursive: true});
// Electron reads XDG_CONFIG_HOME on Linux and APPDATA on Windows for app.getPath('appData').
const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), APPDATA: path.join(root, 'config')};
delete env.ELECTRON_RUN_AS_NODE; delete env.VIBE_LOGISIM_STATE_DIR; delete env.VIBE_LOGISIM_CODEX; delete env.VIBE_LOGISIM_PYTHON;
let app, page, phase = 'launch'; const errors = [], log = [];
const note = m => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; log.push(line); console.log(line); };
const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
const scene = () => page.evaluate(() => fetch('/api/circuit?name=main').then(r => r.json()));
const agent = () => page.evaluate(() => window.vibeDesktop.agent.getState());
async function idle() { await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') !== 'true' && document.querySelector('#canvasStatus').hidden && !document.querySelector('#placementToolbar .placement-loading'), {timeout: 60000}); }
async function world(x, y) { return page.locator('#circuitCanvas').evaluate((e, p) => { const n = new DOMPoint(p.x, p.y).matrixTransform(e.getScreenCTM()); return {x: n.x, y: n.y}; }, {x, y}); }
async function choose(search, label) { await page.locator('#addComponentTool').click(); await page.locator('#componentSearch').fill(search); await page.locator('#componentLibrary').getByRole('button', {name: label, exact: true}).click(); await page.waitForFunction(() => document.querySelector('#objectInspector [data-attribute]') && !document.querySelector('#placementToolbar .placement-loading')); }
async function attribute(name, value) { const field = page.locator('#objectInspector [data-attribute="' + name + '"]'); if (await field.evaluate(e => e.tagName) === 'SELECT') await field.selectOption(value); else { await field.fill(value); await field.press('Enter'); } await page.waitForFunction(() => !document.querySelector('#placementToolbar .placement-loading')); await page.locator('#circuitCanvas').focus(); }
async function place(x, y) { const old = (await session()).revision.id, p = await world(x, y); await page.mouse.move(p.x, p.y); await page.locator('.placement-ghost').waitFor(); await page.mouse.click(p.x, p.y); await waitUntil(() => session().then(s => s.revision.id !== old && s), {timeout: 60000}); await idle(); }
async function launch() {
  app = await _electron.launch({executablePath: executable, args: windows ? ['--no-sandbox'] : [], chromiumSandbox: !windows, cwd: root, env, timeout: 120000});
  page = await app.firstWindow(); page.setDefaultTimeout(60000); page.on('pageerror', e => errors.push(e.stack));
  await page.setViewportSize({width: 1500, height: 960});
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(root, 'app.log'), data));
  assert.equal(await app.evaluate(({app}) => app.isPackaged), true);
  note('userData = ' + await app.evaluate(({app}) => app.getPath('userData')));
}

(async () => { try {
  await launch(); note('launched ' + executable);
  phase = 'agent reaches auth-required (bundled Codex app-server started)';
  const state = await waitUntil(() => agent().then(s => (s.status === 'auth-required' || s.status === 'ready' || s.status === 'unavailable') && s), {timeout: 120000});
  note(`agent status=${state.status} isolation=${state.isolation} detail=${state.detail || ''}`);
  assert.notEqual(state.status, 'unavailable', 'bundled Codex app-server failed to start: ' + state.detail);
  phase = 'create circuit';
  await app.evaluate(({dialog}, folder) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]}); }, folder);
  await page.locator('#openButton').click(); await page.locator('#newFileMenu').click(); await page.getByRole('menuitem', {name: '新建电路', exact: true}).click();
  const nameBox = page.getByRole('textbox', {name: '文件名称', exact: true}); await nameBox.fill('与门验证.circ'); await nameBox.press('Enter');
  await waitUntil(() => session().then(s => s.folder?.activeFile === '与门验证.circ' && s), {timeout: 60000}); await idle();
  assert.ok(fs.existsSync(path.join(folder, '与门验证.circ')), 'circuit file written to the real folder');
  note('circuit created; folder root = ' + (await session()).folder.root);
  phase = 'place AND gate';
  await choose('AND Gate', '与门'); await attribute('inputs', '2'); await attribute('label', 'AND'); await place(500, 300); await page.keyboard.press('Escape');
  phase = 'input pins'; await choose('输入引脚', '输入引脚'); await attribute('tristate', 'false'); await attribute('label', 'A'); await place(250, 220); await attribute('label', 'B'); await place(250, 380); await page.keyboard.press('Escape');
  phase = 'output pin'; await choose('输出引脚', '输出引脚'); await attribute('label', 'Y'); await place(680, 300); await page.keyboard.press('Escape');
  phase = 'wire from ports';
  for (const [a, b] of [[[250, 220], [470, 290]], [[250, 380], [470, 310]], [[500, 300], [680, 300]]]) {
    const before = (await session()).revision.id;
    await page.locator(`.wire-port-hit[cx="${a[0]}"][cy="${a[1]}"]`).click(); await page.locator(`.wire-port-hit[cx="${b[0]}"][cy="${b[1]}"]`).click();
    await waitUntil(() => session().then(s => s.revision.id !== before && s), {timeout: 60000}); await idle();
  }
  const constructed = await scene(); assert.equal(constructed.circuit.components.length, 4); assert.equal(constructed.circuit.wires.length, 5);
  await page.locator('#componentSearch').fill(''); await page.locator('#fitButton').click(); await page.screenshot({path: path.join(out, '01-built-circuit.png')});
  note('AND + 2 inputs + output wired, 5 wires');
  phase = 'native truth table';
  await page.locator('#simulationMenuButton').focus(); await page.keyboard.press('Control+t');
  const observation = () => page.evaluate(() => fetch('/api/simulation').then(r => r.json()));
  await waitUntil(() => observation().then(s => s.observation?.components?.length === 4), {timeout: 90000});
  async function bits() { const s = await observation(); return Object.fromEntries(s.observation.components.filter(c => ['A', 'B', 'Y'].includes(c.label)).map(c => [c.label, c.ports[0].bits])); }
  for (const label of ['A', 'B']) {
    await page.locator('#selectTool').click(); const c = constructed.circuit.components.find(c => c.label === label), b = c.bounds, p = await world(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.click(p.x, p.y);
    const input = page.getByRole('textbox', {name: '输入值', exact: true}); await input.fill('0'); await input.press('Enter'); await waitUntil(async () => (await bits())[label] === '0');
  }
  await page.locator('#pokeTool').click();
  async function poke(label) { const c = constructed.circuit.components.find(c => c.label === label), b = c.bounds, p = await world(b.x + b.width / 2, b.y + b.height / 2); const before = (await bits())[label]; await page.mouse.click(p.x, p.y); await waitUntil(async () => { const b = await bits(); return b[label] !== before && b; }); }
  const truth = []; let v = await bits(); assert.equal(v.Y, '0'); truth.push(v); await poke('A'); v = await bits(); assert.equal(v.Y, '0'); truth.push(v); await poke('B'); v = await bits(); assert.equal(v.Y, '1'); truth.push(v); await poke('A'); v = await bits(); assert.equal(v.Y, '0'); truth.push(v);
  await page.screenshot({path: path.join(out, '02-native-simulation.png')}); note('truth table via bundled Java + Logisim: ' + JSON.stringify(truth));
  phase = 'restart persisted circuit';
  await app.close(); app = null; await launch();
  await waitUntil(() => session().then(s => s.folder?.activeFile === '与门验证.circ' && s), {timeout: 60000}); await idle();
  assert.equal((await scene()).circuit.components.length, 4); note('reopened with 4 components');
  phase = 'AI settings dialog opens';
  await page.locator('#agentSettings').click(); await page.locator('#connectionDialog[open]').waitFor(); await page.screenshot({path: path.join(out, '03-ai-settings.png')});
  await page.locator('#connectionClose').click();
  assert.deepEqual(errors, []);
  const result = {platform: process.platform, executable, success: true, modelTurns: 0, truthTable: truth, components: 4, wires: 5, reopened: true, agentStatus: state.status, isolation: state.isolation, log};
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error('FAILED', phase, root, error);
  if (page) { await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {}); console.error(await page.locator('#canvasStatus').innerText().catch(() => '')); console.error(errors); }
  try { console.error('--- app.log ---\n' + fs.readFileSync(path.join(root, 'app.log'), 'utf8').slice(-6000)); } catch {}
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({platform: process.platform, success: false, phase, error: String(error), log}, null, 2));
  process.exitCode = 1;
} finally { if (app) await app.close().catch(() => {}); } })();
