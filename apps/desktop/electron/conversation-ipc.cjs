'use strict';

function registerConversationIpc({ipcMain, backend, codex, trusted, transitioning, generation, begin, end}) {
  ipcMain.handle('vibe-logisim:conversations', async (event, request) => {
    if (!trusted(event)) throw new Error('Untrusted renderer.');
    const epoch = generation(), session = await backend.session();
    if (transitioning() || epoch !== generation() || !session.folder || request?.folderId !== session.folder.id) throw new Error('文件夹已切换，请重试');
    const key = session.folder.conversationKey;
    if (request.action === 'list') return codex.conversationState(key);
    if (!['new', 'select', 'rename', 'archive', 'restore', 'fork'].includes(request.action)) throw new Error('未知的对话操作');
    if (codex.snapshot().busy) throw new Error('请先停止当前回答，再管理对话');
    if (request.activeId !== codex.conversationState(key).activeId) throw new Error('当前对话已变化，请重试');
    const transition = begin();
    try { return await codex.changeConversation(key, request.action, request); }
    finally { end(transition); }
  });
}

module.exports = {registerConversationIpc};
