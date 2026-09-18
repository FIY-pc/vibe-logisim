'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron} = require('playwright');

const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-startup-folder-'));
const folder = path.join(root, 'course');
const activeFile = '指定电路.circ';
const circuit = '<project source="2.16.2" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(100,100)"/></circuit></project>';
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, activeFile), circuit);
fs.writeFileSync(path.join(folder, '另一个.circ'), circuit);

const folderId = `folder-${crypto.createHash('sha256').update(folder).digest('hex').slice(0, 16)}`;
const stateRoot = path.join(root, 'config', 'vibe-logisim-desktop', 'folder-workspaces');
fs.mkdirSync(path.join(stateRoot, folderId), {recursive: true});
fs.writeFileSync(path.join(stateRoot, folderId, 'workspace.json'), JSON.stringify({
  id: folderId,
  root: folder,
  name: path.basename(folder),
  activeFile,
  conversationKey: `folder:${folderId}`,
}));

const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR: path.join(root, 'state')};
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  let app;
  try {
    app = await _electron.launch({executablePath: require('electron'), args: [repo + '/apps/desktop', folder, '--no-sandbox'], env});
    const page = await app.firstWindow();
    const session = () => page.evaluate(() => fetch('/api/session').then(response => response.json()));
    await page.waitForFunction(async (expected) => {
      const response = await fetch('/api/session');
      const value = await response.json();
      return value.folder?.root === expected && value.folder?.activeFile === '指定电路.circ';
    }, folder, {timeout: 90000});
    const value = await session();
    assert.equal(value.folder.root, folder);
    assert.equal(value.folder.activeFile, activeFile);
    assert.equal(value.source.path, path.join(folder, activeFile));
    console.log(JSON.stringify({success: true, folder, activeFile}));
  } finally {
    if (app) await app.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
