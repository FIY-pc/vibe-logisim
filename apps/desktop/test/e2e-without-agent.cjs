'use strict';

// A missing AI executable must not block real files or manual circuit editing.
// Requires the documented Logisim runtimes; no course circuit or model turn.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');

const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync('/tmp/vibe-without-agent-');
const folder = path.join(root, '我的电路');
const source = path.join(folder, '我的设计.circ');
fs.mkdirSync(folder);
const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'),
  VIBE_LOGISIM_STATE_DIR: path.join(root, 'state'),
  VIBE_LOGISIM_CODEX: path.join(root, 'missing-codex')};
delete env.ELECTRON_RUN_AS_NODE;
let app, page, phase = 'launch';
const errors = [];

async function launch() {
  app = await _electron.launch({executablePath: require('electron'),
    args: [path.join(repo, 'apps/desktop'), '--no-sandbox'], env});
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width: 1500, height: 960});
}

const session = () => page.evaluate(() => fetch('/api/session').then(r => r.json()));
const scene = () => page.evaluate(() => fetch('/api/circuit?name=main').then(r => r.json()));
async function pickFolder(file) {
  // Substitute only the OS picker result. The UI, IPC, filesystem and engine
  // remain real; no success response or circuit content is mocked.
  await app.evaluate(({dialog}, file) => {
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [file]});
  }, file);
  await page.locator('#openButton').click();
}

(async () => {
  try {
    await launch();
    phase = 'open folder without AI';
    await page.locator('#emptyOpenButton').waitFor();
    await page.waitForFunction(() => document.querySelector('#agentStatusLight').dataset.state === 'unavailable');
    assert.equal(await page.locator('#conversationStarters button').count(), 3);
    assert.equal(await page.locator('#conversationStarters button:enabled').count(), 0);
    await pickFolder(folder);
    await page.getByRole('button', {name: '新建电路', exact: true}).click();
    assert.equal((await session()).folder.root, folder);
    const filename = page.getByRole('textbox', {name: '文件名称', exact: true});
    await filename.fill('我的设计.circ');
    await filename.press('Enter');
    await waitUntil(async () => (await session()).folder?.activeFile === '我的设计.circ');
    await page.waitForFunction(() => document.querySelector('#emptyState').hidden && document.querySelector('#canvasStatus').hidden);
    assert.match(fs.readFileSync(source, 'utf8'), /<circuit name="main"/);

    phase = 'place and persist';
    await page.locator('#addComponentTool').click();
    await page.locator('#componentSearch').fill('与门');
    await page.getByRole('button', {name: '与门', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#objectInspector [data-attribute]') && !document.querySelector('#placementToolbar .placement-loading'));
    const canvas = await page.locator('#circuitCanvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.4);
    await page.locator('.placement-ghost').waitFor();
    await page.mouse.click(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.4);
    await page.keyboard.press('Escape');
    await waitUntil(async () => (await scene()).circuit?.components.length === 1);
    await waitUntil(() => fs.readFileSync(source, 'utf8').includes('name="AND Gate"'));
    const saved = fs.readFileSync(source);
    await page.screenshot({path: path.join(root, 'manual-edit-without-ai.png')});

    phase = 'invalid folder preserves current workspace';
    await pickFolder(path.join(root, 'missing-folder'));
    await page.getByText(/打开失败：/).waitFor();
    assert.equal((await session()).folder.root, folder);
    assert.ok(fs.readFileSync(source).equals(saved));

    phase = 'restart';
    await app.close(); app = null;
    await launch();
    await waitUntil(async () => (await session()).folder?.activeFile === '我的设计.circ');
    await page.waitForFunction(() => document.querySelector('#emptyState').hidden && document.querySelector('#canvasStatus').hidden);
    assert.equal((await scene()).circuit.components.length, 1);
    assert.ok(fs.readFileSync(source).equals(saved));
    assert.deepEqual(errors, []);
    const result = {root, success: true, modelTurns: 0, sourcePreserved: true, reopened: true};
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    if (page) await page.screenshot({path: path.join(root, 'failure.png')}).catch(() => {});
    console.error({root, phase, error, errors});
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
