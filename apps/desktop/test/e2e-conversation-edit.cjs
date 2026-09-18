'use strict';

// Real Electron UI and IPC boundary. Model generation is replaced with a
// deterministic local replay; the request still crosses the renderer/main
// process boundary and carries the native edit target.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');

const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync('/tmp/vibe-conversation-edit-e2e-');
const folder = path.join(root, '电路工作区');
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, 'adder.circ'), '<?xml version="1.0"?><project source="2.16.2.2.jar" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(100,150)"/><comp lib="0" name="Pin" loc="(300,150)" output="true"/></circuit></project>');
const env = {...process.env, XDG_CONFIG_HOME:path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR:path.join(root, 'state')};
delete env.ELECTRON_RUN_AS_NODE;

let app, page;
(async () => {
  try {
    app = await _electron.launch({executablePath:require('electron'), args:[repo + '/apps/desktop', folder + '/adder.circ', '--no-sandbox'], env});
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await app.evaluate(({app}, repoPath) => {
      const req = process.getBuiltinModule('node:module').createRequire(repoPath + '/apps/desktop/electron/main.cjs');
      global.__editRequests = [];
      req('./codex-backend.cjs').CodexBackend.prototype.ask = async function(request) {
        global.__editRequests.push(request);
        const id = 'edit-replay-' + global.__editRequests.length;
        this.emit('event', {type:'user-message', id, text:request.question, context:request.context});
        this.emit('event', {type:'turn-started', turnId:id});
        this.emit('event', {type:'assistant-completed', itemId:id + '-reply', text:'本地回放已收到。'});
        this.emit('event', {type:'turn-completed', status:'completed', turnId:id});
        return {threadId:'edit-replay-thread', turnId:id};
      };
    }, repo);
    await page.waitForFunction(() => document.querySelector('#canvasStatus').hidden && !document.querySelector('#questionInput').disabled);
    await page.waitForFunction(() => window.vibeDesktop.agent.getState().then(state => state.status === 'ready'));

    const input = page.locator('#questionInput');
    await input.fill('先解释这个电路');
    await page.locator('#askButton').click();
    await waitUntil(() => app.evaluate(() => global.__editRequests.length === 1));
    await page.waitForFunction(() => document.querySelector('#questionInput').value === '');

    await input.fill('再补充一个例子');
    await page.locator('#askButton').click();
    await waitUntil(() => app.evaluate(() => global.__editRequests.length === 2));
    await page.waitForFunction(() => document.querySelectorAll('.agent-message[data-role="user"]').length >= 2);

    const first = page.locator('.agent-message[data-role="user"]').first();
    assert.equal(await first.locator('[aria-label="编辑此问题"]').count(), 1);
    await first.locator('[aria-label="编辑此问题"]').click();
    assert.equal(await input.inputValue(), '先解释这个电路');
    assert.equal(await page.locator('#editingDraftBar').isVisible(), true);
    assert.equal(await first.evaluate(node => node.classList.contains('is-editing')), true);

    await page.locator('#cancelEditingDraft').click();
    assert.equal(await page.locator('#editingDraftBar').isVisible(), false);
    assert.equal(await input.inputValue(), '');

    await first.locator('[aria-label="编辑此问题"]').click();
    await input.fill('改成讲解输入输出关系');
    await page.locator('#askButton').click();
    await waitUntil(() => app.evaluate(() => global.__editRequests.length === 3));
    const edited = await app.evaluate(() => global.__editRequests[2]);
    assert.equal(edited.editMessageId, 'edit-replay-1');
    assert.equal(await page.locator('#editingDraftBar').isVisible(), false);
    assert.equal(await page.locator('[aria-label="编辑此问题"]').count() > 0, true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({root, success:true, editTarget:edited.editMessageId, modelTurns:0}));
  } catch (error) {
    console.error({root, error});
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
})();
