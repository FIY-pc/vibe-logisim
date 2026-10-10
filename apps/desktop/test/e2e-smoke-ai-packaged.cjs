// AI smoke test for a packaged bundle. Configures an OpenAI-compatible endpoint
// through the in-app AI settings form (VIBE_TEST_BASE_URL / VIBE_TEST_API_KEY /
// VIBE_TEST_MODEL), then sends two REAL model turns on a fresh empty circuit:
// one read-only question, and the "构建一个全加器" starter which must edit a
// .circ in the opened folder. Consumes API quota; opt-in only.
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {_electron} = require('playwright'), {waitUntil} = require('./support/wait-until.cjs');
const {readZip} = require('../electron/diagnostics-bundle.cjs');
const executable = path.resolve(process.argv[2] || 'missing-packaged-executable');
assert.ok(fs.existsSync(executable), 'Pass the packaged vibe-logisim executable as the first argument');
const {VIBE_TEST_BASE_URL: baseUrl, VIBE_TEST_API_KEY: apiKey, VIBE_TEST_MODEL: model} = process.env;
assert.ok(baseUrl && apiKey && model, 'VIBE_TEST_BASE_URL, VIBE_TEST_API_KEY and VIBE_TEST_MODEL are required');
const windows = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(process.env.VIBE_SMOKE_ROOT || os.tmpdir(), 'vibe-ai-smoke-'));
const folder = path.join(root, '我的电路'); fs.mkdirSync(folder);
const out = process.argv[3] ? path.resolve(process.argv[3]) : root; fs.mkdirSync(out, {recursive: true});
const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), APPDATA: path.join(root, 'config'), VIBE_LOGISIM_USER_DATA_DIR: path.join(root, 'profile'), VIBE_LOGISIM_NO_UPDATE_CHECK: '1'};
for (const k of ['ELECTRON_RUN_AS_NODE', 'VIBE_LOGISIM_STATE_DIR', 'VIBE_LOGISIM_CODEX', 'VIBE_LOGISIM_PYTHON', 'VIBE_TEST_API_KEY']) delete env[k];
const budgetMs = Number(process.env.VIBE_AI_BUDGET_MINUTES || 10) * 60_000;
let app, page, phase = 'launch'; const log = [];
const note = m => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; log.push(line); console.log(line); };
const agent = () => page.evaluate(() => window.vibeDesktop.agent.getState());
const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
async function waitTurn(label) {
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < budgetMs) {
    await page.waitForTimeout(3000);
    const s = await agent();
    const msgs = s.messages || [];
    const cur = `${s.status}|${s.busy}|${msgs.length}|${s.transmission?.phase || ''}`;
    if (cur !== last) { last = cur; const m = msgs.at(-1); note(`${label}: status=${s.status} busy=${s.busy} msgs=${msgs.length} last=${m?.type}/${m?.phase || ''} ${(m?.text || '').slice(0, 80).replace(/\n/g, ' ')}`); }
    const final = msgs.filter(m => m.type === 'assistant' && ['final', 'final_answer'].includes(m.phase)).at(-1);
    if (!s.busy && final) return {final, seconds: Math.round((Date.now() - t0) / 1000), state: s};
    if (s.status === 'unavailable') throw new Error(`${label}: agent became unavailable: ${s.detail}`);
    const err = msgs.filter(m => m.type === 'error').at(-1);
    if (!s.busy && err && Date.now() - t0 > 15000) throw new Error(`${label}: turn error: ${err.text || JSON.stringify(err).slice(0, 300)}`);
  }
  throw new Error(`${label}: no final answer within ${budgetMs / 60000} minutes`);
}
(async () => { try {
  const noSandbox = windows || Boolean(process.env.VIBE_SMOKE_NO_SANDBOX);
  app = await _electron.launch({executablePath: executable, args: noSandbox ? ['--no-sandbox'] : [], chromiumSandbox: !noSandbox, cwd: root, env, timeout: 120000});
  assert.equal(await app.evaluate(({app}) => app.getPath('userData')), env.VIBE_LOGISIM_USER_DATA_DIR);
  page = await app.firstWindow(); page.setDefaultTimeout(60000); await page.setViewportSize({width: 1500, height: 960});
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(root, 'app.log'), data));
  let s = await waitUntil(() => agent().then(s => ['auth-required', 'ready', 'unavailable'].includes(s.status) && s), {timeout: 120000});
  note(`launched; agent status=${s.status} isolation=${s.isolation}`);
  phase = 'open folder + new circuit';
  await app.evaluate(({dialog}, f) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [f]}); }, folder);
  const opened = await page.evaluate(() => window.vibeDesktop.folder.open().then(r => ({ok: true})).catch(e => ({ok: false, error: String(e)})));
  assert.ok(opened.ok, 'folder open: ' + opened.error);
  // The file toolbar appears when the renderer receives the folder event.
  // Nudge it with a state read if that event raced ahead of the listener.
  const toolbar = await page.waitForFunction(() => !document.querySelector('#fileActions')?.hidden, null, {timeout: 15000}).then(() => true).catch(() => false);
  if (!toolbar) { note('file toolbar hidden after open; state=' + JSON.stringify(await page.evaluate(() => window.vibeDesktop.folder.state())).slice(0, 200)); await page.locator('#openButton').click().catch(() => {}); await page.waitForFunction(() => !document.querySelector('#fileActions')?.hidden, null, {timeout: 30000}); }
  await page.locator('#newFileMenu').click(); await page.getByRole('menuitem', {name: '新建电路', exact: true}).click();
  const nameBox = page.getByRole('textbox', {name: '文件名称', exact: true}); await nameBox.fill('全加器.circ'); await nameBox.press('Enter');
  await waitUntil(() => session().then(x => x.folder?.activeFile === '全加器.circ' && x), {timeout: 60000});
  phase = 'configure endpoint via AI settings form';
  await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') !== 'true' && document.querySelector('#canvasStatus').hidden, null, {timeout: 60000});
  await page.keyboard.press('Escape'); // close any creation menu/popover left open
  const blockers = await page.evaluate(() => [...document.querySelectorAll('dialog[open], [popover]:popover-open')].map(e => e.id));
  if (blockers.length) note('open overlays before settings: ' + blockers.join(','));
  await page.locator('#agentSettings').click({timeout: 15000}).catch(async () => { await page.locator('#agentTab').click().catch(() => {}); await page.locator('#agentSettings').click(); });
  await page.locator('#connectionDialog[open]').waitFor();
  await page.locator('#connectionTabApi').click();
  await page.locator('#providerPreset').selectOption('custom');
  await page.locator('#providerProtocol').selectOption(process.env.VIBE_TEST_API || 'openai-responses');
  await page.locator('#providerBaseUrl').fill(baseUrl); await page.locator('#providerApiKey').fill(apiKey); await page.locator('#providerModel').fill(model);
  await page.keyboard.press('Escape'); // close the model suggestion list if discovery opened it
  await page.locator('#providerSave').click();
  // Save runs a preflight (GET /models is skipped here, POST /responses is not) and closes the dialog once connected;
  // a failed preflight stays open with the reason in #providerProbe.
  await page.waitForFunction(() => !document.querySelector('#connectionDialog').open ||
    (!document.querySelector('#providerProbe').hidden && document.querySelector('#providerProbe').dataset.kind === 'error'), null, {timeout: 180000});
  const stillOpen = await page.evaluate(() => document.querySelector('#connectionDialog').open);
  const formError = stillOpen ? await page.locator('#providerProbe').innerText().catch(() => '') : '';
  s = await agent(); note(`after save: status=${s.status} model=${s.model}/${s.effort} catalog=${s.modelCatalog?.status} custom=${s.customProvider?.model} err=${formError.replace(/\n/g, ' ')}`);
  await page.screenshot({path: path.join(out, '01-provider-configured.png')});
  assert.equal(s.status, 'ready', 'agent not ready after configuring endpoint: ' + (formError || s.detail));
  assert.ok(!JSON.stringify(s).includes(apiKey), 'API key leaked into renderer state');
  if (stillOpen) await page.locator('#connectionClose').click();
  phase = 'turn 1: read-only question';
  await page.locator('#questionInput').fill('用一句话说明全加器的 Cout 如何由 A、B、Cin 得到。不要修改任何文件。');
  await page.locator('#askButton').click();
  const t1 = await waitTurn('turn1'); note(`turn1 final in ${t1.seconds}s: ${t1.final.text.slice(0, 160).replace(/\n/g, ' ')}`);
  assert.match(t1.final.text, /Cout|进位/);
  phase = 'turn 2: build a full adder (edits a .circ in the folder)';
  const before = fs.readdirSync(folder).map(n => [n, fs.statSync(path.join(folder, n)).size]);
  // Same text as the "构建一个全加器" starter; starters are hidden once a conversation has messages.
  await page.locator('#questionInput').fill('在当前打开的这个空电路里构建一个全加器，输入为 A、B、Cin，输出为 Sum、Cout。优先使用 wire_candidate 等结构化电路工具放置元件和连线，然后用 simulate_circuit 核对真值表；用清晰的连线和布局表达电路。最后简要说明原理和如何操作它。');
  await page.locator('#askButton').click();
  const t2 = await waitTurn('turn2'); note(`turn2 final in ${t2.seconds}s: ${t2.final.text.slice(0, 200).replace(/\n/g, ' ')}`);
  const after = fs.readdirSync(folder).filter(n => n.endsWith('.circ')).map(n => ({name: n, comps: (fs.readFileSync(path.join(folder, n), 'utf8').match(/<comp /g) || []).length}));
  note('circ files after turn2: ' + JSON.stringify(after));
  assert.ok(after.some(f => f.comps >= 5), 'expected a .circ with at least 5 components (pins + gates) after the build turn');
  await page.locator('#fitButton').click().catch(() => {}); await page.waitForTimeout(1500);
  await page.screenshot({path: path.join(out, '02-after-build.png')});
  for (const f of after) fs.copyFileSync(path.join(folder, f.name), path.join(out, f.name));
  phase = 'diagnostics bundle holds no key';
  // With a real key saved and two real turns logged, neither the bundle nor
  // the log files on disk may contain the key in any form.
  const bundlePath = path.join(root, 'diagnostics.zip');
  await app.evaluate(({dialog, shell}, file) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: file}); shell.showItemInFolder = () => {}; }, bundlePath);
  await page.evaluate(() => window.vibeDesktop.diagnostics.export({includeCircuit: true}));
  const entries = readZip(fs.readFileSync(bundlePath));
  const userData = await app.evaluate(({app}) => app.getPath('userData'));
  const logs = fs.readdirSync(path.join(userData, 'logs')).map(name => fs.readFileSync(path.join(userData, 'logs', name), 'utf8'));
  for (const form of new Set([apiKey, encodeURIComponent(apiKey)])) {
    for (const entry of entries) assert.equal(entry.data.toString('utf8').includes(form), false, 'API key in diagnostics entry ' + entry.name);
    assert.equal(logs.some(text => text.includes(form)), false, 'API key in a log file');
  }
  const report = JSON.parse(entries.find(entry => entry.name === 'report.json').data);
  assert.equal(report.ai.connection, 'custom');
  assert.equal(report.ai.customProvider.keyLength, apiKey.length);
  note(`diagnostics: ${entries.length} entries, no key; tool failures recorded: ${report.toolFailures}`);
  const result = {platform: process.platform, success: true, model, turn1Seconds: t1.seconds, turn2Seconds: t2.seconds, circFiles: after, diagnosticsEntries: entries.length, toolFailures: report.toolFailures, log};
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({...result, log: undefined}));
} catch (error) {
  console.error('FAILED', phase, error);
  if (page) { await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {}); const s = await agent().catch(() => null); console.error('AGENT', JSON.stringify(s).slice(0, 2000)); }
  await new Promise(r => setTimeout(r, 3000));
  try { const appLog = fs.readFileSync(path.join(root, 'app.log'), 'utf8').replace(new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***'); console.error('--- app.log ---\n' + appLog.slice(-6000)); fs.writeFileSync(path.join(out, 'app.log'), appLog); } catch {}
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({platform: process.platform, success: false, phase, error: String(error), log}, null, 2));
  process.exitCode = 1;
} finally { if (app) { await page?.evaluate(() => window.vibeDesktop.agent.interrupt()).catch(() => {}); await app.close().catch(() => {}); } } })();
