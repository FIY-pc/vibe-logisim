'use strict';

// Real Electron UI, folders, drafts, and native circuit context. Only model
// delivery is replayed, so this verifies sending, not AI circuit-building skill.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');
const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync('/tmp/vibe-conversation-starters-');
const folders = ['从零构建', '理解电路', '检查电路'].map(name => path.join(root, name));
for (const folder of folders) fs.mkdirSync(folder);
const circuit = '<?xml version="1.0"?><project source="2.16.2.2.jar" version="1.0">' +
  '<lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main">' +
  '<comp lib="0" name="Pin" loc="(100,150)"><a name="label" val="A"/><a name="tristate" val="false"/></comp>' +
  '<comp lib="0" name="Pin" loc="(300,150)"><a name="facing" val="west"/><a name="output" val="true"/><a name="label" val="Y"/></comp>' +
  '<wire from="(100,150)" to="(300,150)"/></circuit></project>';
for (const folder of folders.slice(1)) fs.writeFileSync(path.join(folder, '电路.circ'), circuit);
fs.writeFileSync(path.join(folders[1], '任务说明.md'), '# 任务说明\n\n理解输入和输出之间的连接。');
const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR: path.join(root, 'state')};
delete env.ELECTRON_RUN_AS_NODE;
let app, page, phase = 'launch';
const errors = [];
const selectionPosts = [];
const buttons = () => page.locator('#conversationStarters button');
const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
const requests = () => app.evaluate(() => global.__starterRequests);
async function picker(folder) {
  await app.evaluate(({dialog}, folder) => {
    dialog.showOpenDialog = async () => folder ? {canceled: false, filePaths: [folder]} : {canceled: true, filePaths: []};
  }, folder);
}
async function ready() {
  await waitUntil(() => page.evaluate(() => window.vibeDesktop.agent.getState()).then(s => s.status === 'ready'));
}
async function openCircuit(folder) {
  await picker(folder); await page.locator('#openButton').click();
  await waitUntil(async () => (await session()).folder?.root === folder);
  await page.locator('.file-row').filter({hasText: '电路.circ'}).click();
  await page.waitForFunction(() => document.querySelector('#canvasStatus').hidden && document.querySelector('#currentCircuitName').textContent === 'main');
  await ready();
}

(async () => {
  try {
    app = await _electron.launch({executablePath: require('electron'), args: [repo + '/apps/desktop', '--no-sandbox'], env});
    page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', e => errors.push(e.stack));
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/selection(?:\?|$)/.test(request.url())) selectionPosts.push(request.postData());
    });
    await page.setViewportSize({width: 1500, height: 960});
    await app.evaluate((_, repo) => {
      const req = process.getBuiltinModule('node:module').createRequire(repo + '/apps/desktop/electron/main.cjs');
      global.__starterRequests = []; global.__starterMode = 'success';
      req('./codex-backend.cjs').CodexBackend.prototype.ask = async function(request) {
        global.__starterRequests.push(request);
        if (global.__starterMode === 'fail') throw new Error('验收回放：发送连接失败');
        const id = 'starter-replay-' + global.__starterRequests.length;
        this.emit('event', {type: 'user-message', id, text: request.question, context: request.context});
        this.emit('event', {type: 'turn-started', turnId: id});
        if (global.__starterMode === 'delay') await new Promise(resolve => { global.__starterRelease = resolve; });
        this.emit('event', {type: 'assistant-completed', itemId: id + '-reply', text: '界面验收回放：已收到任务；未调用模型、未构建电路。'});
        this.emit('event', {type: 'turn-completed', status: 'completed', turnId: id});
        return {threadId: id, turnId: id};
      };
    }, repo);
    await ready(); await page.locator('#conversationStarters button:enabled').first().waitFor();
    assert.equal(await buttons().count(), 3);
    assert.deepEqual(await buttons().allTextContents(), ['构建一个全加器', '认识与门、或门和非门', '构建一个计数器']);
    await page.locator('#reviewPanel').screenshot({path: root + '/01-no-folder.png'});

    phase = 'cancel picker';
    await picker(null); await buttons().first().click();
    await page.waitForFunction(() => !document.querySelector('[data-starter="build"]').disabled);
    assert.equal((await requests()).length, 0);
    assert.equal((await session()).folder ?? null, null);

    phase = 'one click opens folder and sends';
    await picker(folders[0]); await buttons().first().click();
    await waitUntil(async () => (await requests()).length === 1);
    const build = (await requests())[0];
    assert.match(build.question, /全加器/);
    assert.equal(build.context.folder.root, folders[0]);
    assert.equal(build.context.revisionId, null);
    await page.locator('.agent-message[data-role="user"]').waitFor();
    assert.equal(await page.locator('#agentEmpty').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#questionInput').value === '');

    phase = 'current circuit and narrow panel';
    await openCircuit(folders[1]);
    assert.equal(selectionPosts.length, 0, 'opening a circuit must not create a whole-canvas selection');
    assert.deepEqual(await buttons().allTextContents(), ['构建一个全加器', '讲解一下当前电路', '检查电路中的问题']);
    await page.setViewportSize({width: 1100, height: 800});
    for (const button of await buttons().all()) assert.equal(await button.evaluate(e => e.scrollWidth <= e.clientWidth), true);
    await page.locator('#reviewPanel').screenshot({path: root + '/02-current-circuit.png'});

    phase = 'protect user draft and attached file';
    await page.locator('#questionInput').fill('我正在写自己的问题');
    assert.equal(await page.locator('#conversationStarters').isVisible(), false);
    await page.locator('#questionInput').fill('');
    await page.locator('.file-row').filter({hasText: '任务说明.md'}).click();
    await page.locator('.material-text').waitFor(); await page.locator('#materialQuote').click();
    assert.equal(await page.locator('#conversationStarters').isVisible(), false);
    await page.locator('.material-chip [aria-label^="取消引用"]').click();
    await page.locator('#conversationStarters').waitFor();

    phase = 'failed send preserves prompt';
    await app.evaluate(() => { global.__starterMode = 'fail'; });
    await buttons().nth(1).click();
    await waitUntil(async () => (await requests()).length === 2);
    assert.equal(selectionPosts.length, 0, 'a whole-circuit question must not post a synthetic selection');
    await page.waitForFunction(() => !document.querySelector('#askButton').disabled);
    assert.match(await page.locator('#agentNoticeDetails').textContent(), /验收回放：发送连接失败/);
    assert.match(await page.locator('#questionInput').inputValue(), /请结合实际电路讲解当前电路/);
    const explain = (await requests())[1];
    assert.equal(explain.context.folder.root, folders[1]);
    assert.equal(explain.context.circuit, 'main');
    assert.equal(explain.context.selectionId, null);
    assert.equal(explain.context.authority, 'workspace-binding');
    assert.equal(explain.context.revisionId, (await session()).revision.id);

    phase = 'double click sends once';
    await page.locator('#questionInput').fill('');
    await app.evaluate(() => { global.__starterMode = 'delay'; });
    await buttons().nth(1).click({clickCount: 2});
    await waitUntil(async () => (await requests()).length === 3);
    await page.locator('#interruptButton').waitFor();
    assert.equal(await page.locator('#agentEmpty').isVisible(), false);
    await app.evaluate(() => global.__starterRelease());
    await page.waitForFunction(() => document.querySelector('#questionInput').value === '');
    assert.equal((await requests()).length, 3);

    phase = 'keyboard starts check in another workspace';
    await app.evaluate(() => { global.__starterMode = 'success'; });
    await openCircuit(folders[2]);
    await buttons().nth(2).focus(); await page.keyboard.press('Enter');
    await waitUntil(async () => (await requests()).length === 4);
    const check = (await requests())[3];
    assert.match(check.question, /检查当前电路/);
    assert.equal(check.context.folder.root, folders[2]);
    assert.equal(check.context.circuit, 'main');
    for (const folder of folders.slice(1)) assert.equal(fs.readFileSync(path.join(folder, '电路.circ'), 'utf8'), circuit);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({root, success: true, modelTurns: 0, delivery: 'explicit replay', requests: 4}));
  } catch (error) {
    console.error({root, phase, error, errors});
    if (page) await page.screenshot({path: root + '/failure.png'}).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
