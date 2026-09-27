'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createDiagnosticsBundle, bundleFileName} = require('./diagnostics-bundle.cjs');

const MAX_CIRCUIT_BYTES = 8 * 1024 * 1024;

// IPC for the "…" menu: feedback (diagnostics preview/export, log folder)
// and release checks. The main process supplies the raw facts; everything
// leaving here went through the shared redactor and the bundle's final check.
//
// collect(): Promise<inputs for createDiagnosticsBundle>
// activeCircuit(): absolute path of the open .circ, or null
// secrets(): plaintext keys to verify against (never returned to the renderer)
function registerFeedbackIpc({ipcMain, dialog, shell, trusted, window, app, log, redact, updates, collect, activeCircuit, secrets, homeDir}) {
  const guard = handler => async (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted renderer.');
    return handler(...args);
  };

  // A moved or deleted file only means there is nothing to attach.
  function circuitFile() {
    try { return activeCircuit(); } catch { return null; }
  }

  function circuitText() {
    const file = circuitFile();
    if (!file) throw new Error('当前没有打开的电路文件');
    if (fs.statSync(file).size > MAX_CIRCUIT_BYTES) throw new Error('当前电路文件超过 8 MB，不能附进诊断包');
    return {text: fs.readFileSync(file, 'utf8')};
  }

  async function build(options) {
    const includeCircuit = options?.includeCircuit === true;
    return createDiagnosticsBundle({inputs: await collect(), logFiles: log.files(), circuit: includeCircuit ? circuitText() : null,
      redact, secrets: secrets(), homeDir});
  }

  ipcMain.handle('vibe-logisim:diagnostics-preview', guard(async options => {
    const bundle = await build(options);
    return {summary: bundle.summary, entries: bundle.entries, issueUrl: bundle.issueUrl, bytes: bundle.buffer.length, circuitAvailable: Boolean(circuitFile())};
  }));

  ipcMain.handle('vibe-logisim:diagnostics-export', guard(async options => {
    const choice = await dialog.showSaveDialog(window(), {
      title: '保存诊断包',
      defaultPath: path.join(app.getPath('downloads'), bundleFileName(app.getVersion())),
      filters: [{name: 'Zip', extensions: ['zip']}],
    });
    if (choice.canceled || !choice.filePath) return {canceled: true};
    const bundle = await build(options);
    fs.writeFileSync(choice.filePath, bundle.buffer);
    log.write('main', `诊断包已保存：${bundle.buffer.length} 字节，${bundle.entries.length} 个条目${options?.includeCircuit ? '（含当前电路）' : ''}`);
    shell.showItemInFolder(choice.filePath);
    return {canceled: false, path: choice.filePath, bytes: bundle.buffer.length, entries: bundle.entries};
  }));

  ipcMain.handle('vibe-logisim:diagnostics-open-logs', guard(async () => {
    fs.mkdirSync(log.directory, {recursive: true});
    const error = await shell.openPath(log.directory);
    if (error) throw new Error(`无法打开日志文件夹：${error}`);
    return true;
  }));

  ipcMain.handle('vibe-logisim:update-status', guard(() => updates.status()));
  ipcMain.handle('vibe-logisim:update-preference', guard(enabled => {
    if (typeof enabled !== 'boolean') throw new Error('无效的更新设置');
    log.write('update', `自动检查更新：${enabled ? '开' : '关'}`);
    return updates.setPreference(enabled);
  }));
  ipcMain.handle('vibe-logisim:update-check-now', guard(() => updates.check({manual: true})));
  ipcMain.handle('vibe-logisim:update-dismiss', guard(version => updates.dismiss(version)));
}

module.exports = {registerFeedbackIpc};
