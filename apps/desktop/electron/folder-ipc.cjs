'use strict';
const path = require('node:path');
const {importFiles} = require('./folder-import.cjs');
const {previewMaterial} = require('./material-preview.cjs');

function registerFolderIpc({ipcMain, dialog, shell, nativeImage, workspace, trusted, window, open, select}) {
  const handle = (name, operation) => ipcMain.handle('vibe-logisim:folder-'+name, async (event, request = {}) => {
    if(!trusted(event))throw new Error('Untrusted renderer.');
    if(name !== 'open' && name !== 'state')workspace.folder.assert(request.folderId);
    return operation(request);
  });
  handle('open', async () => {
    const result = await dialog.showOpenDialog(window(), {title:'打开工作区文件夹',properties:['openDirectory','createDirectory']});
    if(result.canceled)return {canceled:true};
    return open(result.filePaths[0]);
  });
  handle('state', () => workspace.snapshot());
  handle('list', request => ({items:workspace.folder.list(request.path||'',request.hidden === true)}));
  handle('view', request => workspace.folder.saveExplorer(request));
  handle('select', request => select(request.path));
  handle('preview', request => previewMaterial({read:(_id,file)=>workspace.folder.read(workspace.folder.current.legacyReferences?.[file]||file)}, request.folderId, request.id, request.page||1, nativeImage));
  handle('reveal', request => { if(request.path)shell.showItemInFolder(workspace.folder.resolve(request.path)); else return shell.openPath(workspace.folder.current.root); });
  handle('open-system', request => shell.openPath(workspace.folder.resolve(request.path)));
  handle('create', request => workspace.run(() => {
    workspace.folder.assert(request.folderId);
    workspace.folder.create(request.path,request.directory === true);
    return workspace.refresh({title:'新建 '+path.basename(request.path)});
  }));
  handle('import', request => workspace.run(async () => {
    workspace.folder.assert(request.folderId);
    const result = await importFiles(workspace.folder, request);
    await workspace.refresh({title:'拖入文件'});
    return result;
  }));
  handle('history', () => workspace.history.list());
  handle('diff', request => workspace.history.detail(request.id,request.path));
  handle('undo', request => workspace.run(async () => {
    if(workspace.turnActive)throw new Error('请先停止 AI 回答，再撤销文件改动');
    const session = await workspace.backend.session();
    if(session.workspace?.dirty)throw new Error('请先保存画布中的编辑，再撤销文件改动');
    workspace.history.undo(request.id); return workspace.refresh();
  }));
}
module.exports = {registerFolderIpc};
