'use strict';
// System-proxy routing, end to end in the dev Electron shell with an isolated
// CODEX_HOME. The fake Responses server sits behind a hostname that does not
// resolve (*.invalid); only the logging HTTP proxy maps it to loopback. So
// every request that reaches the fake proves its sender used the proxy.
//
//   launch A: HTTPS_PROXY/HTTP_PROXY → proxy. The dialog footer names the
//             proxy; model discovery, the preflight and the Codex child all
//             go through it (Chromium UA for the app's probe, reqwest UA for
//             Codex); a real turn completes.
//   launch B: no proxy variables. The footer says 直连, and saving the same
//             endpoint fails before anything is written, with a hint that
//             names the missing system proxy.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');
const {startFakeResponsesServer} = require('./support/fake-responses-server.cjs');
const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-provider-proxy-'));
const folder = path.join(root, '我的电路'); fs.mkdirSync(folder);
fs.copyFileSync(path.join(repo, 'exports/interface-editing/stage6-if-id.circ'), path.join(folder, 'stage6-if-id.circ'));
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'out'); fs.mkdirSync(out, {recursive: true});
const log = [];
const note = m => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; log.push(line); console.log(line); };
const CHROMIUM_UA = /Chrome\//;

async function launch(name, extraEnv) {
  const codexHome = path.join(root, `codex-home-${name}`); fs.mkdirSync(codexHome, {recursive: true});
  const env = {...process.env, XDG_CONFIG_HOME: path.join(root, `config-${name}`), VIBE_LOGISIM_STATE_DIR: path.join(root, `state-${name}`), CODEX_HOME: codexHome};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VIBE_LOGISIM_MODEL', 'VIBE_LOGISIM_EFFORT', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) delete env[key];
  Object.assign(env, extraEnv);
  const app = await _electron.launch({executablePath: require('electron'), args: [path.join(repo, 'apps/desktop'), path.join(folder, 'stage6-if-id.circ'), '--no-sandbox'], env, timeout: 120000});
  const page = await app.firstWindow(); page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(root, `app-${name}.log`), data));
  await page.setViewportSize({width: 1440, height: 920});
  const agent = () => page.evaluate(() => window.vibeDesktop.agent.getState());
  const s = await waitUntil(() => agent().then(s => ['auth-required', 'ready', 'unavailable'].includes(s.status) && s), {timeout: 120000, label: `${name}: agent settled`});
  await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') !== 'true', null, {timeout: 60000});
  await page.locator('#agentTab').click().catch(() => {});
  return {app, page, agent, errors, state: s, shot: n => page.screenshot({path: path.join(out, `${name}-${n}.png`)})};
}

(async () => {
  const fake = await startFakeResponsesServer({viaProxy: true, reply: '收到，OK'});
  let phase = 'launch A (proxied)';
  let a = null, b = null;
  try {
    a = await launch('proxied', {HTTPS_PROXY: fake.proxy.url, HTTP_PROXY: fake.proxy.url});
    note(`A launched: status=${a.state.status} network=${JSON.stringify(a.state.network)}`);
    assert.equal(a.state.network?.source, 'env', 'child started with the env proxy');
    assert.equal(a.state.network?.hostPort, `127.0.0.1:${fake.proxy.port}`);

    phase = 'A: footer names the proxy';
    await a.page.locator('#agentSettings').click(); await a.page.locator('#connectionDialog[open]').waitFor();
    await waitUntil(() => a.page.locator('#connectionNetwork').getAttribute('data-kind').then(k => k === 'proxy' && k), {timeout: 15000, label: 'network row resolved'});
    const footer = await a.page.locator('#connectionNetworkLabel').innerText();
    note('A footer: ' + footer); assert.match(footer, new RegExp(`环境变量里的代理 127\\.0\\.0\\.1:${fake.proxy.port}`));
    assert.match(await a.page.locator('#connectionNetworkDetail').innerText(), /通过它/);
    await a.page.locator('#connectionTabChatgpt').click();
    assert.match(await a.page.locator('#chatgptNote').innerText(), /经过环境变量里的代理/);
    await a.page.locator('#connectionTabApi').click();
    await a.shot('01-footer');

    phase = 'A: discovery through the proxy';
    await a.page.locator('#providerBaseUrl').fill(fake.baseUrl); await a.page.locator('#providerApiKey').fill(fake.apiKey);
    await a.page.locator('#providerModel').click();
    await waitUntil(() => a.page.locator('#providerModelList [role=option]').count().then(n => n >= 2 && n), {timeout: 20000, label: 'models discovered via proxy'});
    const discovery = fake.proxy.log.find(e => e.kind === 'absolute' && e.url.endsWith('/v1/models'));
    assert.ok(discovery, 'GET /models went through the proxy'); assert.match(discovery.userAgent, CHROMIUM_UA, 'the probe uses the Electron session');
    note(`A discovery via proxy: ${discovery.method} ${discovery.url} UA=${discovery.userAgent.slice(0, 40)}…`);
    await a.page.locator('#providerModelList [role=option]', {hasText: 'probe-chat'}).click();

    phase = 'A: preflight + save through the proxy';
    await a.page.locator('#providerSave').click();
    await a.page.locator('#connectionDialog[open]').waitFor({state: 'hidden', timeout: 120000});
    let s = await a.agent(); note(`A after save: status=${s.status} model=${s.model} network=${s.network?.source}/${s.network?.hostPort}`);
    assert.equal(s.status, 'ready'); assert.equal(s.network?.hostPort, `127.0.0.1:${fake.proxy.port}`);
    const preflight = fake.requests.find(r => r.url === '/v1/responses' && CHROMIUM_UA.test(r.userAgent));
    assert.ok(preflight, 'preflight POST /responses arrived via the proxy with the Chromium UA');
    assert.ok(!JSON.stringify(s).includes(fake.apiKey) && !JSON.stringify(s).includes(fake.proxy.url + '/'), 'no secrets in renderer state');

    phase = 'A: a real turn from the Codex child goes through the proxy';
    const before = fake.requests.length;
    await a.page.locator('#questionInput').fill('回复 OK 即可，不要修改任何文件。');
    await a.page.locator('#askButton').click();
    await waitUntil(() => a.agent().then(st => { const m = (st.messages || []).filter(x => x.type === 'assistant'); return !st.busy && m.length ? m.at(-1) : false; }), {timeout: 120000, label: 'assistant answered'});
    const codexPost = fake.requests.slice(before).find(r => r.url === '/v1/responses' && !CHROMIUM_UA.test(r.userAgent));
    assert.ok(codexPost, 'the Codex child POSTed /responses through the proxy'); assert.equal(codexPost.body?.model, 'probe-chat');
    note(`A codex turn via proxy: UA=${codexPost.userAgent.slice(0, 40)}… stream=${codexPost.body?.stream}`);
    const codexProxyHits = fake.proxy.log.filter(e => !CHROMIUM_UA.test(e.userAgent) && e.url.includes('fake-responses.invalid'));
    assert.ok(codexProxyHits.length >= 1, 'proxy log shows the codex child');
    await a.shot('02-answered');
    assert.deepEqual(a.errors, [], 'renderer errors (A)');
    await a.app.close(); a = null;

    phase = 'launch B (no proxy)';
    b = await launch('direct', {});
    note(`B launched: status=${b.state.status} network=${JSON.stringify(b.state.network)}`);
    assert.equal(b.state.network?.proxyUrl, null);
    await b.page.locator('#agentSettings').click(); await b.page.locator('#connectionDialog[open]').waitFor();
    await waitUntil(() => b.page.locator('#connectionNetwork').getAttribute('data-kind').then(k => k === 'direct' && k), {timeout: 15000, label: 'network row direct'});
    note('B footer: ' + await b.page.locator('#connectionNetworkLabel').innerText());
    assert.match(await b.page.locator('#connectionNetworkLabel').innerText(), /直连/);
    await b.page.locator('#connectionTabChatgpt').click();
    assert.match(await b.page.locator('#chatgptNote').innerText(), /未检测到系统代理/);
    await b.page.locator('#connectionTabApi').click();

    phase = 'B: the proxied-only endpoint fails before save, with a route hint';
    await b.page.locator('#providerBaseUrl').fill(fake.baseUrl); await b.page.locator('#providerApiKey').fill(fake.apiKey);
    await b.page.locator('#providerModel').fill('probe-chat'); await b.page.keyboard.press('Escape');
    await b.page.locator('#providerSave').click();
    await waitUntil(() => b.page.locator('#providerProbe').innerText().then(t => /找不到这个域名|无法连接|没有响应/.test(t) && t), {timeout: 40000, label: 'preflight fails direct'});
    const probeText = await b.page.locator('#providerProbe').innerText(); note('B probe: ' + probeText.replace(/\n/g, ' / ').slice(0, 200));
    assert.match(probeText, /系统代理/);
    const sB = await b.agent(); assert.equal(sB.customProvider, null, 'nothing saved');
    await b.shot('03-direct-fails');
    assert.deepEqual(b.errors, [], 'renderer errors (B)');

    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({success: true, proxyLog: fake.proxy.log.map(e => `${e.method} ${e.url} ${CHROMIUM_UA.test(e.userAgent) ? 'chromium' : 'other'}`), fakeRequests: fake.requests.map(r => `${r.method} ${r.url} ${r.body?.model || ''} ${CHROMIUM_UA.test(r.userAgent) ? 'chromium' : 'other'}`), log}, null, 2));
    console.log('OK: system proxy reaches the probe and the Codex child; no-proxy launch reports 直连 and a route hint');
  } catch (error) {
    console.error('FAILED', phase, error);
    for (const [name, x] of [['A', a], ['B', b]]) if (x) { await x.shot('failure').catch(() => {}); console.error(name, 'AGENT', JSON.stringify(await x.agent().catch(() => null)).slice(0, 1200)); console.error(name, 'renderer errors:', x.errors); }
    for (const name of ['proxied', 'direct']) { try { console.error(`--- app-${name}.log ---\n` + fs.readFileSync(path.join(root, `app-${name}.log`), 'utf8').slice(-3000)); } catch {} }
    console.error('proxy log:', JSON.stringify(fake.proxy.log).slice(0, 1500));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({success: false, phase, error: String(error), log}, null, 2));
    process.exitCode = 1;
  } finally {
    for (const x of [a, b]) if (x) await x.app.close().catch(() => {});
    await fake.close();
  }
})();
