// Cross-platform smoke test for a packaged bundle (Linux or Windows).
// Runs the shipped executable outside the checkout with a fresh app-data dir:
// open folder -> new circuit -> place AND + pins -> wire -> native truth table
// -> restart and reopen -> built-in runtime reaches auth-required.
// Also checks the shipped layout solver and real signal navigation UI.
// No model turn is sent and no credentials are used.
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {_electron} = require('playwright'), {waitUntil} = require('./support/wait-until.cjs');
const {readZip} = require('../electron/diagnostics-bundle.cjs');
const executable = path.resolve(process.argv[2] || 'missing-packaged-executable');
assert.ok(fs.existsSync(executable), 'Pass the packaged vibe-logisim executable as the first argument');
const windows = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(process.env.VIBE_SMOKE_ROOT || os.tmpdir(), 'vibe-smoke-'));
const folder = path.join(root, '我的电路 workspace'); fs.mkdirSync(folder);
const out = process.argv[3] ? path.resolve(process.argv[3]) : root; fs.mkdirSync(out, {recursive: true});
// Electron reads XDG_CONFIG_HOME on Linux and APPDATA on Windows for app.getPath('appData').
// No release check against GitHub from CI.
const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), APPDATA: path.join(root, 'config'), VIBE_LOGISIM_NO_UPDATE_CHECK: '1'};
delete env.ELECTRON_RUN_AS_NODE; delete env.VIBE_LOGISIM_STATE_DIR; delete env.VIBE_LOGISIM_CODEX; delete env.VIBE_LOGISIM_PYTHON;
let app, page, phase = 'launch'; const errors = [], log = [];
const note = m => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; log.push(line); console.log(line); };
const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
const scene = () => page.evaluate(() => fetch('/api/circuit?name=main').then(r => r.json()));
const agent = () => page.evaluate(() => window.vibeDesktop.agent.getState());
async function idle() { await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') !== 'true' && document.querySelector('#canvasStatus').hidden && !document.querySelector('#placementToolbar .placement-loading'), {timeout: 60000}); }
async function world(x, y) { return page.locator('#circuitCanvas').evaluate((e, p) => { const n = new DOMPoint(p.x, p.y).matrixTransform(e.getScreenCTM()); return {x: n.x, y: n.y}; }, {x, y}); }
async function choose(search, label) { await page.locator('#circuitCanvas').press('a'); await page.locator('#componentSearch').fill(search); await page.locator('#componentLibrary').getByRole('button', {name: label, exact: true}).click(); await page.waitForFunction(() => document.querySelector('#objectInspector [data-attribute]') && !document.querySelector('#placementToolbar .placement-loading')); }
async function attribute(name, value) { const field = page.locator('#objectInspector [data-attribute="' + name + '"]'); if (await field.evaluate(e => e.tagName) === 'SELECT') await field.selectOption(value); else { await field.fill(value); await field.press('Enter'); } await page.waitForFunction(() => !document.querySelector('#placementToolbar .placement-loading')); await page.locator('#circuitCanvas').focus(); }
async function place(x, y) { const old = (await session()).revision.id, p = await world(x, y); await page.mouse.move(p.x, p.y); await page.locator('.placement-ghost').waitFor(); await page.mouse.click(p.x, p.y); await waitUntil(() => session().then(s => s.revision.id !== old && s), {timeout: 60000}); await idle(); }
async function launch(file) {
  // Chromium's SUID sandbox needs a root-owned 4755 chrome-sandbox helper or user
  // namespaces; zip-extracted bundles on CI runners have neither, so allow opting out.
  const noSandbox = windows || Boolean(process.env.VIBE_SMOKE_NO_SANDBOX);
  app = await _electron.launch({executablePath: executable, args: [...(file ? [file] : []), ...(noSandbox ? ['--no-sandbox'] : [])], chromiumSandbox: !noSandbox, cwd: root, env, timeout: 120000});
  page = await app.firstWindow(); page.setDefaultTimeout(60000); page.on('pageerror', e => errors.push(e.stack));
  await page.setViewportSize({width: 1500, height: 960});
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(root, 'app.log'), data));
  assert.equal(await app.evaluate(({app}) => app.isPackaged), true);
  note('userData = ' + await app.evaluate(({app}) => app.getPath('userData')));
}

(async () => { try {
  await launch(); note('launched ' + executable);
  phase = 'layout solver with bundled Python and Electron';
  const resources = await app.evaluate(() => process.resourcesPath);
  const bundledPython = path.join(resources, 'runtime', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']));
  const lens = path.join(resources, 'product', 'apps', 'desktop', 'circuit-lens');
  const graph = {groups: [{id: 'flow', order: 0, row: 0, role: 'main', layout: 'flow', children: [
    {id: 'source', width: 80, height: 60, ports: [{id: 'out', x: 80, y: 30, width: 0, height: 0, layoutOptions: {'elk.port.side': 'EAST'}}]},
    {id: 'sink', width: 80, height: 60, ports: [{id: 'in', x: 0, y: 30, width: 0, height: 0, layoutOptions: {'elk.port.side': 'WEST'}}]},
  ], edges: [{id: 'signal', sources: ['out'], targets: ['in']}]}], attachments: [], links: [], groupGap: 100, rowGap: 100};
  // Import the shipped service, outside the checkout. Its child must use the
  // packaged executable rather than the Node installation driving Playwright.
  const probe = 'import json,sys; from studio.runtime.layout_solver import solve_groups; print(json.dumps(solve_groups(json.load(sys.stdin), sys.argv[1])))';
  const solverEnv = {...env, PYTHONPATH: lens, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', VIBE_LOGISIM_LAYOUT_NODE: executable};
  delete solverEnv.PYTHONHOME;
  const solved = JSON.parse(execFileSync(bundledPython, ['-c', probe, out], {cwd: root, env: solverEnv, input: JSON.stringify(graph), encoding: 'utf8', timeout: 90000}));
  const [source, sink] = ['source', 'sink'].map(id => solved.groups[0].children.find(n => n.id === id));
  assert.ok(sink.x >= source.x + source.width, 'bundled solver arranges signal source before sink');
  assert.equal(source.ports[0].x, 80); assert.equal(sink.ports[0].x, 0);
  note('group layout ran through bundled Python, Electron and elkjs');
  phase = 'fresh install uses built-in runtime';
  const state = await waitUntil(() => agent().then(s => (s.status === 'auth-required' || s.status === 'ready' || s.status === 'unavailable') && s), {timeout: 120000});
  note(`agent status=${state.status} isolation=${state.isolation} detail=${state.detail || ''}`);
  assert.equal(state.runtime, 'builtin');
  assert.equal(state.status, 'auth-required', 'fresh install can configure AI without a CLI or account');
  phase = 'create circuit';
  await page.waitForFunction(() => document.querySelector('#connectionClose svg') && document.querySelector('#appShell').getAttribute('aria-busy') !== 'true');
  await app.evaluate(({dialog}, folder) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]}); }, folder);
  // Use the visible first-open action so the renderer also adopts the folder.
  await page.locator('#emptyOpenButton').click();
  await page.locator('#fileActions').waitFor({state: 'visible'});
  await page.locator('#newFileMenu').click(); await page.getByRole('menuitem', {name: '新建电路', exact: true}).click();
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
  phase = 'signal navigation without circuit edits';
  const beforeTrace = await session(), sourceText = fs.readFileSync(path.join(folder, '与门验证.circ'), 'utf8');
  const cameraBefore = await page.locator('#circuitCanvas').getAttribute('viewBox');
  await page.locator('.wire-port-hit[cx="680"][cy="300"]').click({modifiers: ['Control']});
  await page.waitForFunction(() => document.querySelector('#evidenceTitle')?.textContent === '信号追踪');
  await page.locator('#connectionList .connection-port').filter({has: page.getByRole('heading', {name: '上游驱动端', exact: true})}).getByRole('button').filter({hasText: 'AND'}).waitFor();
  await page.locator('.circuit-component.is-signal-related[data-object-id="c500_300"]').waitFor();
  assert.ok(await page.locator('.wire-group.is-signal-related').count(), 'signal wires highlighted');
  await page.screenshot({path: path.join(out, '04-signal-trace.png')});
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(() => document.querySelector('#evidenceTitle')?.textContent === '连接');
  assert.equal(await page.locator('#circuitCanvas').getAttribute('viewBox'), cameraBefore, 'back restores camera');
  assert.equal((await session()).revision.id, beforeTrace.revision.id, 'trace does not create a revision');
  assert.equal(fs.readFileSync(path.join(folder, '与门验证.circ'), 'utf8'), sourceText, 'trace does not edit the circuit');
  note('Ctrl+click located AND source; Alt+Left restored view without circuit changes');
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
  phase = 'diagnostics bundle';
  const bundlePath = path.join(root, 'diagnostics.zip');
  await app.evaluate(({dialog, shell}, file) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: file}); shell.showItemInFolder = () => {}; }, bundlePath);
  // The IPC behind the dialog's 保存诊断包 button, with the circuit attached.
  const exported = await page.evaluate(() => window.vibeDesktop.diagnostics.export({includeCircuit: true}));
  const entries = readZip(fs.readFileSync(bundlePath));
  note('diagnostics: ' + entries.map(entry => `${entry.name}(${entry.data.length})`).join(', '));
  assert.equal(exported.entries.length, entries.length);
  for (const name of ['README.txt', 'summary.txt', 'report.json', 'tool-failures.json', 'logs/vibe-logisim.log', 'circuit/current.circ']) assert.ok(entries.some(entry => entry.name === name), name);
  const report = JSON.parse(entries.find(entry => entry.name === 'report.json').data);
  assert.equal(report.app.packaged, true);
  assert.ok(report.java.version, 'bundled Java answers -version: ' + JSON.stringify(report.java));
  assert.equal(report.workspace.root.nonAscii, true);
  const bundleText = entries.map(entry => entry.data.toString('utf8')).join('\n');
  for (const forbidden of [os.homedir(), folder, '我的电路', '与门验证']) assert.equal(bundleText.includes(forbidden), false, 'bundle contains ' + forbidden);
  phase = 'simulation follows the displayed circuit';
  await app.close(); app = null;
  const scopeFile = path.join(folder, 'simulation-scope.circ');
  const clockCircuit = name => `<circuit name="${name}"><comp lib="0" name="Clock" loc="(100,100)"><a name="label" val="CLK"/></comp><comp lib="0" name="Pin" loc="(300,100)"><a name="facing" val="west"/><a name="output" val="true"/><a name="label" val="Q"/></comp><wire from="(100,100)" to="(300,100)"/></circuit>`;
  const scopeSource = `<project source="2.7.1" version="1.0"><lib name="0" desc="#Wiring"/><main name="A"/>${clockCircuit('A')}${clockCircuit('B')}</project>`;
  fs.writeFileSync(scopeFile, scopeSource);
  await launch(scopeFile);
  async function openCircuit(name) {
    await page.locator('#circuitList button').filter({has: page.locator('strong', {hasText: new RegExp('^' + name + '$')})}).click();
    await page.waitForFunction(name => document.querySelector('#currentCircuitName').textContent === name && document.querySelector('#canvasStatus').hidden, name);
  }
  async function simulationKey(key) { await page.locator('#simulationMenuButton').focus(); await page.keyboard.press('Control+' + key); }
  await openCircuit('A'); const scopeRevision = (await session()).revision.id;
  await simulationKey('t');
  const firstRun = await waitUntil(() => observation().then(s => s.session?.circuit === 'A' && s.observation?.ticks === 1 && s), {timeout: 90000});
  await openCircuit('B'); assert.equal((await observation()).session.id, firstRun.session.id, 'browsing retains A');
  await simulationKey('k');
  const secondRun = await waitUntil(() => observation().then(s => s.session?.circuit === 'B' && s.running && s.observation?.ticks > 0 && s), {timeout: 90000});
  assert.notEqual(secondRun.session.id, firstRun.session.id, 'K starts B without returning to A');
  await simulationKey('k'); await waitUntil(() => observation().then(s => !s.running));
  const paused = await waitUntil(() => observation().then(s => s.observation?.commandSequence >= s.commandSequence && s));
  const output = s => s.observation.components.find(c => c.label === 'Q').ports[0].bits;
  await openCircuit('A'); await openCircuit('B');
  await page.waitForFunction(() => document.querySelector('#runtimeLayer').dataset.observationId);
  assert.equal((await observation()).session.id, paused.session.id, 'return restores B without restarting');
  await simulationKey('t');
  const stepped = await waitUntil(() => observation().then(s => s.observation?.ticks === paused.observation.ticks + 1 && s));
  assert.notEqual(output(stepped), output(paused), 'one tick changes the actual native Clock output');
  assert.equal((await session()).revision.id, scopeRevision, 'simulation does not create an edit');
  assert.equal(fs.readFileSync(scopeFile, 'utf8'), scopeSource, 'simulation does not change the source');
  await page.screenshot({path: path.join(out, '05-simulation-context.png')});
  note('browsing preserves A; K starts and pauses B; return and T preserve B identity and advance its native Clock');
  assert.deepEqual(errors, []);
  const result = {platform: process.platform, executable, success: true, modelTurns: 0, bundledLayout: true, signalNavigation: true, simulationContext: true, truthTable: truth, components: 4, wires: 5, reopened: true, agentStatus: state.status, isolation: state.isolation, diagnosticsEntries: entries.length, log};
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error('FAILED', phase, root, error);
  if (page) {
    await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
    const diag = await page.evaluate(() => ({toast: document.querySelector('#toast')?.textContent, canvasStatus: document.querySelector('#canvasStatus')?.textContent, empty: document.querySelector('#emptyState')?.hidden, alerts: [...document.querySelectorAll('[role=alert]')].filter(e => !e.hidden && e.textContent.trim()).map(e => e.textContent.trim()), body: document.body.innerText.slice(0, 1500)})).catch(e => ({diagError: String(e)}));
    const sess = await session().catch(e => ({sessionError: String(e)}));
    console.error('DIAG', JSON.stringify(diag, null, 1)); console.error('SESSION', JSON.stringify(sess).slice(0, 1500)); console.error(errors);
    fs.writeFileSync(path.join(out, 'diag.json'), JSON.stringify({diag, session: sess, errors}, null, 1));
  }
  await new Promise(r => setTimeout(r, 4000)); // let child 'exit' diagnostics reach stderr
  try { const appLog = fs.readFileSync(path.join(root, 'app.log'), 'utf8'); console.error('--- app.log (main process stderr) ---\n' + appLog.slice(-8000)); fs.writeFileSync(path.join(out, 'app.log'), appLog); } catch {}
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({platform: process.platform, success: false, phase, error: String(error), log}, null, 2));
  process.exitCode = 1;
} finally { if (app) await app.close().catch(() => {}); } })();
