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
fs.writeFileSync(path.join(folder, '下一条问题.md'), '这份资料属于底部草稿，不应被带入旧问题的编辑。');
fs.writeFileSync(path.join(folder, 'adder.circ'), '<?xml version="1.0"?><project source="2.16.2.2.jar" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(100,150)"/><comp lib="0" name="Pin" loc="(300,150)" output="true"/></circuit></project>');
const env = {...process.env, XDG_CONFIG_HOME:path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR:path.join(root, 'state')};
delete env.ELECTRON_RUN_AS_NODE;

let app, page;
(async () => {
  try {
    app = await _electron.launch({executablePath:require('electron'), args:[repo + '/apps/desktop', folder + '/adder.circ', '--no-sandbox'], env});
    page = await app.firstWindow();
    await page.setViewportSize({width:1500,height:960});
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await app.evaluate(({app}, repoPath) => {
      const req = process.getBuiltinModule('node:module').createRequire(repoPath + '/apps/desktop/electron/main.cjs');
      global.__editRequests = [];
      req('./codex-backend.cjs').CodexBackend.prototype.ask = async function(request) {
        if (global.__rejectNextEdit && request.editMessageId) {
          global.__rejectNextEdit = false;
          throw new Error('本地回放：临时发送失败');
        }
        global.__editRequests.push(request);
        const id = 'edit-replay-' + global.__editRequests.length;
        if (request.editMessageId) this.emit('event', {type:'history', messages:[]});
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
    await input.fill('保留在底部的草稿');
    await page.locator('.file-row').filter({hasText:'下一条问题.md'}).click();
    await page.locator('.material-text').waitFor();
    await page.locator('#materialQuote').click();
    await page.locator('.material-chip').waitFor();
    await first.locator('[aria-label="编辑此问题"]').click();
    assert.equal(await input.inputValue(), '保留在底部的草稿');
    assert.equal(await first.locator('.message-edit-form').count(), 1);
    assert.equal(await first.locator('.message-edit-input').inputValue(), '先解释这个电路');
    assert.equal(await page.locator('#editingDraftBar').count(), 0);
    assert.equal(await first.evaluate(node => node.classList.contains('is-editing')), true);
    await page.locator('#reviewPanel').screenshot({path:path.join(root, 'inline-edit.png')});

    const editor = first.locator('.message-edit-input');
    await editor.fill('');
    assert.equal(await first.locator('.message-edit-submit').isEnabled(), false);
    await editor.fill('改写中的问题');
    assert.equal(await first.locator('.message-edit-submit').isEnabled(), true);
    await editor.dispatchEvent('keydown', {key:'Enter', isComposing:true, keyCode:229});
    assert.equal(await app.evaluate(() => global.__editRequests.length), 2);
    await editor.press('End');
    await editor.press('Shift+Enter');
    assert.equal(await editor.inputValue(), '改写中的问题\n');

    await first.locator('.message-edit-cancel').click();
    assert.equal(await first.locator('.message-edit-form').count(), 0);
    assert.equal(await input.inputValue(), '保留在底部的草稿');
    assert.equal(await first.locator('.agent-message-body').innerText(), '先解释这个电路');
    assert.equal(await first.locator('[aria-label="编辑此问题"]').evaluate(node => node===document.activeElement), true);

    await first.locator('[aria-label="编辑此问题"]').click();
    await editor.fill('长消息\n'.repeat(120));
    assert.equal(await editor.evaluate(node => node.scrollHeight>node.clientHeight), true);
    await editor.press('Escape');
    assert.equal(await first.locator('.message-edit-form').count(), 0);

    await first.locator('[aria-label="编辑此问题"]').click();
    await first.locator('.message-edit-input').fill('改成讲解输入输出关系');
    await app.evaluate(() => {global.__rejectNextEdit = true;});
    await first.locator('.message-edit-submit').click();
    await waitUntil(() => first.locator('.message-edit-form').count().then(count => count === 0));
    assert.equal(await input.inputValue(), '保留在底部的草稿');
    await first.locator('[aria-label="编辑此问题"]').click();
    await first.locator('.message-edit-input').fill('改成讲解输入输出关系');
    await first.locator('.message-edit-input').press('Enter');
    await waitUntil(() => app.evaluate(() => global.__editRequests.length === 3));
    const edited = await app.evaluate(() => global.__editRequests[2]);
    assert.equal(edited.editMessageId, 'edit-replay-1');
    assert.equal(edited.question, '改成讲解输入输出关系');
    assert.equal(edited.context.materials.length, 0);
    assert.equal(await page.locator('#editingDraftBar').count(), 0);
    assert.equal(await input.inputValue(), '保留在底部的草稿');
    assert.equal(await page.locator('.material-chip').count(), 1);
    assert.equal(await page.locator('.message-edit-form').count(), 0);
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
