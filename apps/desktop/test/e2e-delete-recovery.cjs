'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');

const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync('/tmp/vibe-delete-recovery-');
const source = path.join(root, 'main.circ');
fs.copyFileSync(path.join(repo, 'apps/desktop/electron/templates/blank.circ'), source);
const env = {...process.env, XDG_CONFIG_HOME:path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR:path.join(root, 'state')};
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  let app;
  const errors = [];
  try {
    app = await _electron.launch({executablePath:require('electron'), args:[path.join(repo, 'apps/desktop'), source, '--no-sandbox'], env});
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width:1500, height:960});
    await page.waitForFunction(() => document.querySelector('#currentCircuitName').textContent === 'main' && document.querySelector('#canvasStatus').hidden);
    await app.evaluate((_, projectRoot) => {
      const requireFromRepo = process.getBuiltinModule('node:module').createRequire(projectRoot + '/apps/desktop/electron/main.cjs');
      const backend = requireFromRepo('./backend.cjs');
      const original = backend.LensBackend.prototype.projectAction;
      let rejected = false;
      backend.LensBackend.prototype.projectAction = function(action, ...args) {
        if (action === 'delete' && !rejected) {
          rejected = true;
          throw new Error('测试：删除写入失败');
        }
        return original.call(this, action, ...args);
      };
    }, repo);

    await page.locator('#addComponentTool').click();
    await page.locator('#componentSearch').fill('AND Gate');
    await page.getByRole('button', {name:'与门', exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('#placementToolbar .placement-loading'));
    const canvas = await page.locator('#circuitCanvas').boundingBox();
    await page.mouse.click(canvas.x + canvas.width * .55, canvas.y + canvas.height * .45);
    await waitUntil(() => Promise.all([
      page.locator('.circuit-component').count(),
      page.evaluate(() => document.querySelector('#appShell').getAttribute('aria-busy') === 'false'),
    ]).then(([count, idle]) => count === 1 && idle), {timeout:60000, label:'placement commit'});
    const afterPlace = fs.readFileSync(source);
    const target = page.locator('.circuit-component').last();
    const targetId = await target.getAttribute('data-object-id');
    await target.focus();
    await target.press('Enter');
    await page.waitForFunction(id => document.querySelector(`.circuit-component[data-object-id="${CSS.escape(id)}"].is-selected`), targetId);
    await page.keyboard.press('Backspace');
    await waitUntil(() => page.evaluate(() => document.querySelector('#appShell').getAttribute('aria-busy') === 'false'), {timeout:60000, label:'failed delete recovery'});
    assert.equal(await page.locator(`.circuit-component[data-object-id="${targetId}"]`).count(), 1);
    assert.equal(await page.locator('#optimisticDeletionLayer .optimistic-delete-cover').count(), 0);
    assert.deepEqual(fs.readFileSync(source), afterPlace);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({root, success:true, deleteFailureRestored:true, sourcePreserved:true, errors}, null, 2));
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
