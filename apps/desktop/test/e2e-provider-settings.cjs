'use strict';
// AI 设置 (custom endpoint path) against a fake Responses server, in the dev
// Electron shell with an isolated CODEX_HOME so the developer's own Codex
// login/config is neither read nor touched. Proves: the dialog opens on the
// API tab when nothing is configured, model discovery fills the list, a wrong
// key is reported BEFORE anything is saved, a good key connects and the model
// list reaches the composer picker, re-saving without retyping the key works,
// and the key never reaches renderer state.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');
const {startFakeResponsesServer} = require('./support/fake-responses-server.cjs');
const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-provider-settings-'));
const folder = path.join(root, '我的电路'); fs.mkdirSync(folder);
fs.copyFileSync(path.join(repo, 'exports/interface-editing/stage6-if-id.circ'), path.join(folder, 'stage6-if-id.circ'));
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'out'); fs.mkdirSync(out, {recursive: true});
const codexHome = path.join(root, 'codex-home-empty'); fs.mkdirSync(codexHome);
const log = [];
const note = m => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; log.push(line); console.log(line); };

(async () => {
  const fake = await startFakeResponsesServer();
  // Dev mode inherits ~/.codex; point it at an empty dir so the app has no
  // login and no provider, exactly like a fresh install.
  const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR: path.join(root, 'state'), CODEX_HOME: codexHome};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VIBE_LOGISIM_MODEL', 'VIBE_LOGISIM_EFFORT']) delete env[key];
  const app = await _electron.launch({executablePath: require('electron'), args: [path.join(repo, 'apps/desktop'), path.join(folder, 'stage6-if-id.circ'), '--no-sandbox'], env, timeout: 120000});
  const page = await app.firstWindow(); page.setDefaultTimeout(60000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(root, 'app.log'), data));
  const agent = () => page.evaluate(() => window.vibeDesktop.agent.getState());
  const shot = name => page.screenshot({path: path.join(out, name + '.png')});
  let phase = 'launch';
  try {
    await page.setViewportSize({width: 1440, height: 920});
    let s = await waitUntil(() => agent().then(s => ['auth-required', 'ready', 'unavailable'].includes(s.status) && s), {timeout: 120000, label: 'agent settled'});
    note(`launched: status=${s.status} accountMode=${s.accountMode} custom=${JSON.stringify(s.customProvider)}`);
    assert.equal(s.customProvider, null);
    await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') !== 'true', null, {timeout: 60000});

    phase = 'open dialog';
    await page.locator('#agentTab').click().catch(() => {});
    if (s.status === 'auth-required') {
      // The pane banner offers both paths without hunting through settings.
      await page.locator('#agentNotice').waitFor({state: 'visible'});
      assert.equal(await page.locator('#agentConfigureApi').isVisible(), true, 'banner offers 填写 API 接口');
      await shot('00-banner');
      await page.locator('#agentConfigureApi').click();
    } else {
      await page.locator('#agentSettings').click();
    }
    await page.locator('#connectionDialog[open]').waitFor();
    assert.equal(await page.locator('#connectionTabApi').getAttribute('aria-selected'), 'true', 'API tab preselected when nothing is configured');
    assert.equal(await page.locator('#connectionPaneApi').isVisible(), true);
    await shot('01-dialog-api-tab');

    phase = 'discovery + bad key rejected before save';
    await page.locator('#providerBaseUrl').fill(fake.baseUrl);
    await page.locator('#providerApiKey').fill('sk-wrong-key-000000000');
    await page.locator('#providerModel').click();
    await waitUntil(() => page.locator('#providerModelStatus').innerText().then(t => /密钥无效/.test(t) && t), {timeout: 20000, label: 'discovery reports bad key'});
    note('discovery with wrong key: ' + await page.locator('#providerModelStatus').innerText());
    await page.locator('#providerModel').fill('probe-chat');
    await page.locator('#providerSave').click();
    await waitUntil(() => page.locator('#providerProbe').innerText().then(t => /密钥无效/.test(t) && t), {timeout: 30000, label: 'preflight reports bad key'});
    await shot('02-bad-key');
    s = await agent(); assert.equal(s.customProvider, null, 'nothing saved after a failed preflight');
    assert.equal(await page.locator('#providerForce').isVisible(), true, 'escape hatch offered');

    phase = 'good key: discovery lists models';
    await page.locator('#providerApiKey').fill(fake.apiKey);
    await page.locator('#providerModel').fill('');
    await page.locator('#providerModel').click();
    await waitUntil(() => page.locator('#providerModelList [role=option]').count().then(n => n >= 2 && n), {timeout: 20000, label: 'model list discovered'});
    const listed = await page.locator('#providerModelList [role=option]').allInnerTexts();
    note('discovered: ' + listed.join(', '));
    assert.deepEqual(listed, ['probe-chat', 'probe-mini'], 'embedding model filtered out');
    assert.match(await page.locator('#providerModelStatus').innerText(), /2 个模型/);
    await shot('03-model-list');
    await page.locator('#providerModelList [role=option]', {hasText: 'probe-mini'}).click();
    assert.equal(await page.locator('#providerModel').inputValue(), 'probe-mini');

    phase = 'save and connect';
    const requestsBefore = fake.requests.length;
    await page.locator('#providerSave').click();
    await page.locator('#connectionDialog[open]').waitFor({state: 'hidden', timeout: 120000});
    s = await agent();
    note(`after save: status=${s.status} model=${s.model}/${s.effort} custom=${s.customProvider?.model} models=${s.customProvider?.models}`);
    assert.equal(s.status, 'ready'); assert.equal(s.model, 'probe-mini'); assert.equal(s.customProvider.model, 'probe-mini');
    assert.deepEqual(s.customProvider.models, ['probe-mini', 'probe-chat']);
    assert.ok(!JSON.stringify(s).includes(fake.apiKey), 'API key leaked into renderer state');
    const preflight = fake.requests.slice(requestsBefore).find(r => r.url === '/v1/responses');
    assert.ok(preflight, 'a preflight POST /v1/responses was sent'); assert.equal(preflight.body.model, 'probe-mini'); assert.equal(preflight.body.stream, true);
    assert.equal(await page.locator('#agentNotice').isVisible(), false, 'banner gone once connected');
    await shot('04-connected');

    phase = 'catalog reaches the composer model picker';
    await page.locator('#agentModel').click();
    await waitUntil(() => page.locator('#modelChoice [role=option]').count().then(n => n >= 2 && n), {timeout: 30000, label: 'composer picker lists endpoint models'});
    const picker = await page.locator('#modelChoice [role=option]').allInnerTexts();
    note('picker: ' + picker.map(t => t.replace(/\n/g, ' / ')).join(' | '));
    assert.ok(picker.some(t => t.includes('probe-chat')) && picker.some(t => t.includes('probe-mini')));
    assert.ok(!picker.some(t => /跟随本机配置|默认模型/.test(t)), 'no inherit row for a custom endpoint');
    await shot('05-picker'); await page.locator('#modelClose').click();

    phase = 'reopen: saved state shown, re-save without retyping the key';
    await page.locator('#agentSettings').click(); await page.locator('#connectionDialog[open]').waitFor();
    assert.equal(await page.locator('#connectionTabApi').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#providerBaseUrl').inputValue(), fake.baseUrl);
    assert.equal(await page.locator('#providerApiKey').inputValue(), '');
    assert.match(await page.locator('#providerApiKey').getAttribute('placeholder'), /已保存 sk-t••••6789/);
    assert.match(await page.locator('#modelConnection').innerText(), /自定义接口/);
    assert.match(await page.locator('#modelConnectionStatus').innerText(), /已连接/);
    assert.equal(await page.locator('#providerClear').isVisible(), true);
    await shot('06-reopened');
    await page.locator('#providerModel').fill('probe-chat');
    await page.locator('#providerSave').click();
    await page.locator('#connectionDialog[open]').waitFor({state: 'hidden', timeout: 120000});
    s = await agent(); assert.equal(s.status, 'ready'); assert.equal(s.model, 'probe-chat'); assert.equal(s.customProvider.apiKeyHint, 'sk-t••••6789');

    phase = 'ChatGPT tab explains the trade-off while an endpoint is active';
    await page.locator('#agentSettings').click(); await page.locator('#connectionDialog[open]').waitFor();
    await page.locator('#connectionTabChatgpt').click();
    assert.match(await page.locator('#accountTitle').innerText(), /ChatGPT 登录未启用/);
    assert.match(await page.locator('#connectionLogin').innerText(), /停用接口并登录/);
    await shot('07-chatgpt-tab-with-endpoint');
    await page.locator('#connectionTabApi').click();

    phase = 'clear endpoint';
    await page.locator('#providerClear').click();
    await waitUntil(() => agent().then(s => s.customProvider === null && ['auth-required', 'unavailable', 'ready'].includes(s.status) && s), {timeout: 120000, label: 'endpoint cleared'});
    s = await agent(); note(`after clear: status=${s.status} detail=${(s.detail || '').slice(0, 100)}`);
    assert.equal(await page.locator('#providerBaseUrl').inputValue(), '');
    await shot('08-cleared');
    await page.locator('#connectionClose').click();

    assert.deepEqual(errors, [], 'renderer errors');
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({success: true, discovered: listed, picker, fakeRequests: fake.requests.map(r => `${r.method} ${r.url} ${r.body?.model || ''}`), log}, null, 2));
    console.log('OK: provider settings flow (discover → preflight rejects bad key → connect → picker → re-save → clear)');
  } catch (error) {
    console.error('FAILED', phase, error);
    await shot('failure').catch(() => {});
    const s = await agent().catch(() => null); console.error('AGENT', JSON.stringify(s).slice(0, 1500));
    try { console.error('--- app.log ---\n' + fs.readFileSync(path.join(root, 'app.log'), 'utf8').slice(-4000)); } catch {}
    console.error('renderer errors:', errors);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({success: false, phase, error: String(error), log}, null, 2));
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    await fake.close();
  }
})();
