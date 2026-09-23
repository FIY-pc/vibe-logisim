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

test('an in-progress tail is handed to native revert after restart', async () => {
  let reverted = false;
  let interrupted = false;
  const calls = [];
  const staleTurns = turns.map((turn, index) => index === 2 ? {...turn, status:'inProgress'} : turn);
  const request = async (method, params) => {
    calls.push({method, params});
    if (method === 'thread/read') return {thread:{id:'source', turns:reverted ? turns.slice(0, 2) : interrupted ? turns : staleTurns}};
    if (method === 'turn/interrupt') { interrupted = true; return {}; }
    if (method === 'thread/revert') { reverted = true; return {thread:{id:'source', turns:turns.slice(0, 2)}}; }
    throw new Error(`unexpected ${method}`);
  };
  await revertThroughMessage({
    source:{threadId:'source',messages:[{type:'user',id:'user-1'},{type:'user',id:'user-2'},{type:'user',id:'user-3'}]},
    request, assertCurrent:()=>{}, messageId:'user-3',
  });
  assert.equal(reverted, true);
  assert.deepEqual(calls.map(call => call.method), ['thread/read','turn/interrupt','thread/read','thread/revert','thread/read']);
  assert.deepEqual(calls[1].params, {threadId:'source',turnId:'turn-3'});
});

test('a paginated empty replacement thread falls back to its superseded native history', async () => {
  let reverted = false;
  const calls = [];
  const pagedTurns = turns.map((turn, index) => ({...turn, startedAt:index + 1})).reverse();
  const request = async (method, params) => {
    calls.push({method, params});
    if (method === 'thread/read' && params.threadId === 'replacement') {
      return {thread:{id:'replacement', historyMode:'paginated', turns:[]}};
    }
    if (method === 'thread/turns/list' && params.threadId === 'replacement') {
      throw new Error('missing source rollout');
    }
    if (method === 'thread/read' && params.threadId === 'source') {
      return {thread:{id:'source', turns:reverted ? turns.slice(0, 1) : []}};
    }
    if (method === 'thread/turns/list' && params.threadId === 'source') {
      return {data:reverted ? [] : pagedTurns, nextCursor:null};
    }
    if (method === 'thread/revert') { reverted = true; return {thread:{id:'source', turns:[]}}; }
    throw new Error(`unexpected ${method}`);
  };
  const result = await revertThroughMessage({
    source:{threadId:'replacement', supersededThreadIds:['source'], messages:[
      {type:'user',id:'user-1'}, {type:'user',id:'user-2'}, {type:'user',id:'user-3'},
    ]},
    request, assertCurrent:()=>{}, messageId:'user-2',
  });
  assert.equal(result.threadId, 'source');
  assert.equal(calls.some(call => call.method === 'thread/revert' && call.params.threadId === 'source'), true);
  assert.equal(calls.some(call => call.method === 'thread/revert' && call.params.threadId === 'replacement'), false);
});

test('backend edits a stored conversation through thread/revert before starting the new turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-edit-unit-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const backend = new CodexBackend({workDir:root, profileDir:root+'/profile', sessionStorePath:root+'/sessions.json'});
  const key = 'folder:one';
  const sourceId = backend.conversationState(key).activeId;
  const nativeTurns = turns.map((turn, index) => index === 2 ? {...turn, status:'inProgress'} : turn);
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
  let interrupted = false;
  backend.start = async () => { backend.status = 'ready'; };
  backend.model = 'test-model';
  backend.child = {stdin:{destroyed:false, write(line) {
    const request = JSON.parse(line); requests.push(request);
    if (!request.id) return;
    const pending = backend.pending.get(String(request.id));
    clearTimeout(pending.timeout); backend.pending.delete(String(request.id));
    let result;
    if (request.method === 'thread/resume') result = {thread:{id:'source', turns:nativeTurns}};
    else if (request.method === 'thread/read') result = {thread:{id:'source', turns:reverted ? turns.slice(0, 1) : interrupted ? turns : nativeTurns}};
    else if (request.method === 'turn/interrupt') { interrupted = true; result = {}; }
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
  const editMethods = requests.map(request => request.method).filter(method =>
    ['thread/read','turn/interrupt','thread/revert'].includes(method));
  assert.deepEqual(editMethods, ['thread/read','turn/interrupt','thread/read','thread/revert','thread/read']);
  const revertIndex = requests.findIndex(request => request.method === 'thread/revert');
  const startIndex = requests.findIndex(request => request.method === 'turn/start');
  assert.equal(startIndex > revertIndex, true, 'edited text starts a normal new turn after history reverts');
  await backend.invalidateRevision();
});

test('backend reattaches an edit to superseded native history before turn/start', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-edit-rebind-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const backend = new CodexBackend({workDir:root, profileDir:root+'/profile', sessionStorePath:root+'/sessions.json'});
  const key = 'folder:rebind';
  const sourceId = backend.conversationState(key).activeId;
  const messages = turns.flatMap(turn => [
    {type:'user', id:turn.items[0].clientId, text:turn.items[0].content[0].text},
    {type:'assistant', id:turn.items[1].id, text:turn.items[1].text, phase:turn.items[1].phase},
  ]);
  backend.conversations.remember(key, {threadId:'source', messages});
  for (let n = 1; n <= 3; n++) backend.conversations.remember(key, {
    messageId:`user-${n}`, context:{selectionId:`sel-${n}`},
  });
  backend.conversations.rebind(key, {threadId:'replacement', messages, toolContract:{signature:'current'}});

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
    if (request.method === 'thread/resume') result = {thread:{id:'replacement', turns:[]}};
    else if (request.method === 'mcpServerStatus/list') result = {data:[]};
    else if (request.method === 'thread/read' && request.params.threadId === 'replacement') result = {thread:{id:'replacement', turns:[]}};
    else if (request.method === 'thread/turns/list' && request.params.threadId === 'replacement') pending.reject(new Error('missing source rollout'));
    else if (request.method === 'thread/read' && request.params.threadId === 'source') result = {thread:{id:'source', turns:reverted ? turns.slice(0, 1) : []}};
    else if (request.method === 'thread/turns/list' && request.params.threadId === 'source') result = {data:reverted ? [] : turns.slice().reverse(), nextCursor:null};
    else if (request.method === 'thread/revert') { reverted = true; result = {thread:{id:'source', turns:[]}}; }
    else if (request.method === 'turn/start') result = {turn:{id:'turn-rebound-edit'}};
    else result = {data:[]};
    if (result) pending.resolve(result);
  }}};
  const context = {folder:{id:'folder-bbbbbbbbbbbbbbbb'}, revisionId:'r1'};
  await backend.ask({question:'changed question 2', editMessageId:'user-2', workspaceKey:key, context});
  assert.equal(requests.find(request => request.method === 'thread/revert').params.threadId, 'source');
  assert.equal(requests.find(request => request.method === 'turn/start').params.threadId, 'source');
  assert.equal(backend.conversations.get(key, sourceId).threadId, 'source');
  assert.deepEqual(backend.history.map(message => message.text), ['question 1','answer 1','changed question 2']);
  await backend.invalidateRevision();
});
