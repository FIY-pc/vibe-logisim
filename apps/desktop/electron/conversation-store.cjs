'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const SCHEMA = 'vibe-logisim.codex-sessions/v1';

// Workspace-owned conversations are local records. A Codex thread is attached
// lazily; creating, finding and organizing conversations never invokes a model.
class ConversationStore {
  constructor(file) { this.file = file; this.memory = null; }
  read() {
    if (!this.file) return this.memory || {schema:SCHEMA, workspaces:{}};
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.schema === SCHEMA && data.workspaces) return data;
      if (data.schema !== 'vibe-logisim.codex-sessions/v0' || !data.workspaces) throw new Error('Unknown schema');
      const workspaces = {};
      for (const [key, value] of Object.entries(data.workspaces)) {
        workspaces[key] = {activeId:'legacy', conversations:{legacy:{...this.blank('legacy'), ...value,
          id:'legacy', title:'之前的对话', legacyDraft:true, customTitle:false}}};
      }
      return {schema:SCHEMA, workspaces, migrated:true};
    } catch (error) {
      if (error.code === 'ENOENT') return {schema:SCHEMA, workspaces:{}};
      throw new Error('无法读取对话记录，原文件仍保留。请重试');
    }
  }
  write(data) {
    if (!this.file) { this.memory = structuredClone(data); return; }
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    if (data.migrated && !fs.existsSync(this.file + '.v0-backup')) fs.copyFileSync(this.file, this.file + '.v0-backup', fs.constants.COPYFILE_EXCL);
    const next = {...data}; delete next.migrated;
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(next), {mode:0o600, flag:'wx'}); fs.renameSync(temp, this.file); }
    finally { fs.rmSync(temp, {force:true}); }
  }
  blank(id = randomUUID()) {
    const now = new Date().toISOString();
    return {id, title:'新对话', createdAt:now, updatedAt:now, archived:false, threadId:null, messageContexts:{}, messages:[]};
  }
  workspace(data, key) {
    if (typeof key !== 'string' || !key) throw new Error('请先打开文件夹');
    if (!Object.hasOwn(data.workspaces, key)) {
      const first = {...this.blank('legacy'), legacyDraft:true};
      data.workspaces[key] = {activeId:first.id, conversations:{[first.id]:first}};
    }
    return data.workspaces[key];
  }
  ensure(key) {
    const data = this.read(), exists = Object.hasOwn(data.workspaces, key), w = this.workspace(data, key);
    if (!exists || data.migrated) this.write(data);
    return structuredClone(w.conversations[w.activeId]);
  }
  active(key) { const data = this.read(), w = data.workspaces[key]; return w ? structuredClone(w.conversations[w.activeId]) : null; }
  get(key, id) {
    const w = this.read().workspaces[key];
    if (!w || !Object.hasOwn(w.conversations, id)) throw new Error('对话不属于当前文件夹');
    return structuredClone(w.conversations[id]);
  }
  state(key) {
    const data = this.read(), w = this.workspace(data, key), current = w.conversations[w.activeId];
    return {activeId:w.activeId, conversation:structuredClone(current),
      conversations:Object.values(w.conversations).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(c => ({
        id:c.id, title:c.title, updatedAt:c.updatedAt, archived:Boolean(c.archived),
        preview:(c.messages || []).find(m => m.type === 'user')?.text?.slice(0, 160) || '',
      }))};
  }
  change(key, action, request = {}) {
    const data = this.read(), w = this.workspace(data, key);
    let record;
    if (action === 'new') {
      const current = w.conversations[w.activeId];
      // Repeated clicks on an unused blank conversation should not fill history.
      if (request.reuseEmpty && !current.threadId && !current.messages?.length && !current.customTitle) return this.state(key);
      if (!current.messages?.length && !current.customTitle && typeof request.draftTitle === 'string' && request.draftTitle.trim()) current.title = request.draftTitle.trim().slice(0, 60);
      record = this.blank(); w.conversations[record.id] = record; w.activeId = record.id;
    } else {
      if (!Object.hasOwn(w.conversations, request.id)) throw new Error('对话不属于当前文件夹');
      record = w.conversations[request.id];
      if (action === 'select') {
        if (record.archived) throw new Error('请先恢复这条已归档对话');
        w.activeId = record.id;
      } else if (action === 'rename') {
        const title = typeof request.title === 'string' ? request.title.trim() : '';
        if (!title || title.length > 100) throw new Error('对话名称须为 1–100 个字');
        record.title = title; record.customTitle = true;
      } else if (action === 'archive' || action === 'restore') {
        record.archived = action === 'archive';
        if (record.archived && w.activeId === record.id) {
          const next = Object.values(w.conversations).filter(c => !c.archived).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))[0] || this.blank();
          w.conversations[next.id] = next; w.activeId = next.id;
        }
      } else throw new Error('未知的对话操作');
    }
    this.write(data); return this.state(key);
  }
  remember(key, {threadId, messages, messageId, context}) {
    const data = this.read(), w = this.workspace(data, key), record = w.conversations[w.activeId];
    if (record.threadId && threadId && record.threadId !== threadId) throw new Error('当前对话已变化，未覆盖旧记录');
    if (threadId) record.threadId = threadId;
    if (messages) record.messages = structuredClone(messages);
    if (messageId) record.messageContexts[messageId] = structuredClone(context);
    if (!record.customTitle && !record.titleGenerated) {
      const first = record.messages.find(m => m.type === 'user')?.text;
      if (first) {record.title = first.replace(/\s+/g, ' ').trim().slice(0, 60);record.titleGenerated = true;}
    }
    record.updatedAt = new Date().toISOString(); this.write(data);
  }
  replaceHistory(key, {threadId, messages, messageContexts = {}}) {
    const data = this.read(), w = this.workspace(data, key), record = w.conversations[w.activeId];
    if (record.threadId && threadId && record.threadId !== threadId) throw new Error('当前对话已变化，未覆盖旧记录');
    if (threadId) record.threadId = threadId;
    record.messages = structuredClone(messages || []);
    record.messageContexts = structuredClone(messageContexts || {});
    if (!record.customTitle && !record.titleGenerated) {
      const first = record.messages.find(m => m.type === 'user')?.text;
      if (first) {record.title = first.replace(/\s+/g, ' ').trim().slice(0, 60);record.titleGenerated = true;}
    }
    record.updatedAt = new Date().toISOString(); this.write(data);
  }
  fork(key, {sourceId, sourceThreadId, messageId, turnId, threadId, messages, messageContexts}) {
    const data = this.read(), w = this.workspace(data, key), source = w.conversations[w.activeId];
    if (source.id !== sourceId || source.threadId !== sourceThreadId || !threadId || threadId === sourceThreadId) {
      throw new Error('原对话已变化，未切换到新分支');
    }
    const base = source.title.slice(0, 80) + ' · 分支';
    const titles = new Set(Object.values(w.conversations).map(c => c.title));
    let title = base, n = 2;
    while (titles.has(title)) title = base + ' ' + n++;
    const child = {...this.blank(), title, titleGenerated:true, threadId, messages, messageContexts,
      forkedFrom:{conversationId:sourceId, threadId:sourceThreadId, messageId, turnId}};
    w.conversations[child.id] = child; w.activeId = child.id;
    this.write(data); return this.state(key);
  }
}

module.exports = {ConversationStore};
