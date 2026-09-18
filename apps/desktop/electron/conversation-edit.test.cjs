'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CodexBackend} = require('./codex-backend.cjs');
const {revertThroughMessage} = require('./conversation-edit.cjs');

const turns = [1, 2, 3].map(n => ({id:`turn-${n}`, status:'completed', items:[
  {type:'userMessage', id:`native-user-${n}`, clientId:`user-${n}`, content:[{type:'text', text:`question ${n}`}]},
  {type:'agentMessage', id:`assistant-${n}`, text:`answer ${n}`, phase:'final_answer'},
]}));

test('editing reverts the native thread before the selected user turn', async () => {
  let reverted = false;
  const calls = [];
  const result = await revertThroughMessage({
    source: {
      threadId:'source',
      messages:[{type:'user',id:'user-1'},{type:'user',id:'user-2'},{type:'user',id:'user-3'}],
      messageContexts:{'user-1':{selectionId:'sel-1'},'user-2':{selectionId:'sel-2'},'user-3':{selectionId:'sel-3'}},
    },
    request: async (method, params) => {
      calls.push({method, params});
      if (method === 'thread/read') return {thread:{id:'source', turns:reverted ? turns.slice(0, 1) : turns}};
      if (method === 'thread/revert') {reverted = true; return {thread:{id:'source', turns:[]}};}
      throw new Error(`unexpected ${method}`);
    },
    assertCurrent: () => {},
    messageId:'user-2',
  });
  assert.deepEqual(calls.map(call => call.method), ['thread/read','thread/revert','thread/read']);
  assert.deepEqual(calls[1].params, {threadId:'source',beforeTurnId:'turn-2'});
  assert.deepEqual(result.thread.turns.map(turn => turn.id), ['turn-1']);
  assert.deepEqual(result.messageContexts, {'user-1':{selectionId:'sel-1'}});
});

test('backend edits a stored conversation through thread/revert before starting the new turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-edit-unit-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const backend = new CodexBackend({workDir:root, profileDir:root+'/profile', sessionStorePath:root+'/sessions.json'});
  const key = 'folder:one';
  const sourceId = backend.conversationState(key).activeId;
  const messages = turns.flatMap(turn => [
    {type:'user', id:turn.items[0].clientId, text:turn.items[0].content[0].text},
    {type:'assistant', id:turn.items[1].id, text:turn.items[1].text, phase:turn.items[1].phase},
  ]);
  backend.conversations.remember(key, {threadId:'source', messages});
  for (let n = 1; n <= 3; n++) backend.conversations.remember(key, {
    messageId:`user-${n}`, context:{selectionId:`sel-${n}`},
  });
  const requests = [];
  let reverted = false;
  backend.start = async () => { backend.status = 'ready'; };
  backend.model = 'test-model';
  backend.child = {stdin:{destroyed:false, write(line) {
    const request = JSON.parse(line); requests.push(request);
    if (!request.id) return;
    const pending = backend.pending.get(String(request.id));
    clearTimeout(pending.timeout); backend.pending.delete(String(request.id));
    let result;
    if (request.method === 'thread/resume') result = {thread:{id:'source', turns}};
    else if (request.method === 'thread/read') result = {thread:{id:'source', turns:reverted ? turns.slice(0, 1) : turns}};
    else if (request.method === 'thread/revert') {reverted = true; result = {thread:{id:'source', turns:[]}};}
    else if (request.method === 'turn/start') result = {turn:{id:'turn-edited'}};
    else result = {data:[]};
    pending.resolve(result);
  }}};
  const context = {folder:{id:'folder-aaaaaaaaaaaaaaaa'}, revisionId:'r1'};
  await backend.ask({question:'changed question 2', editMessageId:'native-user-2', workspaceKey:key, context});
  assert.equal(requests.find(request => request.method === 'thread/revert').params.beforeTurnId, 'turn-2');
  assert.equal(requests.some(request => request.method === 'thread/rollback'), false);
  assert.deepEqual(backend.history.map(message => message.text), ['question 1','answer 1','changed question 2']);
  const stored = backend.conversations.get(key, sourceId);
  assert.deepEqual(stored.messages.map(message => message.text), ['question 1','answer 1','changed question 2']);
  const contextIds = Object.keys(stored.messageContexts);
  assert.deepEqual(contextIds.filter(id => id.startsWith('user-')), ['user-1']);
  assert.equal(contextIds.filter(id => id.startsWith('vibe-')).length, 1);
  await backend.invalidateRevision();
});
