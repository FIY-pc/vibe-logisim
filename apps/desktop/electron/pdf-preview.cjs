'use strict';
const path = require('node:path');

// PDF.js runs in an isolated Chromium renderer, not in the privileged main
// process. It has no Node, preload, remote navigation or network access.
async function renderPdf(bytes, page) {
  const {BrowserWindow} = require('electron');
  const window = new BrowserWindow({show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: 'vibe-pdf-preview', backgroundThrottling: false,
  }});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_details, callback) => callback({cancel: true}));
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await window.loadFile(path.join(__dirname, 'pdf-preview.html'));
        const result = await window.webContents.executeJavaScript(`window.renderPdf(${JSON.stringify(bytes.toString('base64'))}, ${page})`);
        if (result.error) throw Object.assign(new Error(result.error), {code: result.code});
        return result;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF 预览超时，请重试或在系统应用中打开')), 15000); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
}
module.exports = {renderPdf};
