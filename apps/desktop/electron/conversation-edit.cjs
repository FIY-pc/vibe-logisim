'use strict';

// Native Codex editing is a history operation, not a text replacement. Revert
// the durable thread before the selected user turn and let the caller submit
// the edited text as a fresh turn. The native operation intentionally leaves
// the user's files untouched.
async function revertThroughMessage({request, assertCurrent, source, messageId}) {
  if (!source?.threadId) throw new Error('这条对话还没有可编辑的原始会话');
  if (!source.messages?.some(message => message.type === 'user' && message.id === messageId)) {
    throw new Error('这条问题已不属于当前对话，请重新选择');
  }

  const original = (await request('thread/read', {threadId:source.threadId, includeTurns:true})).thread;
  assertCurrent();
  const turns = Array.isArray(original?.turns) ? original.turns : [];
  const index = turns.findIndex(turn => turn.items?.some(item =>
    item.type === 'userMessage' && (item.id === messageId || item.clientId === messageId)));
  const target = turns[index];
  if (!target || target.status === 'inProgress') {
    throw new Error('这条问题尚不能编辑，请等当前回答结束后重试');
  }

  const prefix = turns.slice(0, index);
  const expectedIds = prefix.map(turn => turn.id);
  const keptIds = new Set(prefix.flatMap(turn => (turn.items || [])
    .filter(item => item.type === 'userMessage')
    .flatMap(item => [item.id, item.clientId].filter(Boolean))));
  const messageContexts = Object.fromEntries(Object.entries(source.messageContexts || {})
    .filter(([id]) => keptIds.has(id)));

  await request('thread/revert', {threadId:source.threadId, beforeTurnId:target.id});
  assertCurrent();
  const reverted = (await request('thread/read', {threadId:source.threadId, includeTurns:true})).thread;
  assertCurrent();
  const actualTurns = Array.isArray(reverted?.turns) ? reverted.turns : [];
  if (actualTurns.length !== expectedIds.length || actualTurns.some((turn, i) => turn.id !== expectedIds[i])) {
    throw new Error('当前运行环境未能准确回退到这条问题，原对话没有改变');
  }

  return {thread:reverted, turnId:target.id, messageContexts};
}

module.exports = {revertThroughMessage};
