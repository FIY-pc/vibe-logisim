'use strict';

// Fork the native context, including tool results, through the selected reply's
// turn. Never reconstruct model history from the visible message text.
async function forkThroughReply({request, assertCurrent, source, messageId, options}) {
  if (!source.threadId) throw new Error('这条对话还没有可分支的原始会话');
  if (!source.messages.some(m => m.id === messageId && m.type === 'assistant' && m.phase !== 'commentary')) {
    throw new Error('这条回复已不属于当前对话，请重新选择');
  }
  const original = (await request('thread/read', {threadId:source.threadId, includeTurns:true})).thread;
  assertCurrent();
  const turns = original?.turns || [];
  const index = turns.findIndex(t => t.items?.some(m => m.id === messageId && m.type === 'agentMessage'));
  const turn = turns[index];
  if (!turn || turn.status === 'inProgress') throw new Error('这条回复尚不能分支，请等回答结束后重试');
  const lastReply = turn.items.filter(m => m.type === 'agentMessage' && m.phase !== 'commentary').at(-1);
  if (lastReply?.id !== messageId) throw new Error('请从这一轮的最后一条回复创建分支');
  let forkedId = null;
  try {
    const result = await request('thread/fork', {...options, threadId:source.threadId, lastTurnId:turn.id});
    if (!result.thread?.id || result.thread.id === source.threadId) throw new Error('没有创建独立会话，原对话仍保留');
    forkedId = result.thread.id;
    assertCurrent();
    const child = (await request('thread/read', {threadId:forkedId, includeTurns:true})).thread;
    assertCurrent();
    // Older runtimes can ignore unknown fields. Do not publish a fork that
    // silently includes turns after the selected reply.
    if (!child || JSON.stringify(child.turns?.map(t => t.id)) !== JSON.stringify(turns.slice(0,index+1).map(t => t.id)) ||
        !child.turns.at(-1)?.items?.some(m => m.id === messageId && m.type === 'agentMessage')) {
      throw new Error('当前运行环境未能准确保留分支位置，原对话没有改变');
    }
    const ids = new Set(child.turns.flatMap(t => t.items.filter(m => m.type === 'userMessage').flatMap(m => [m.id,m.clientId])));
    const messageContexts = Object.fromEntries(Object.entries(source.messageContexts || {}).filter(([id]) => ids.has(id)));
    return {thread:child, turnId:turn.id, messageContexts};
  } finally {
    // The selected conversation is resumed on send, like every other stored
    // conversation. Do not keep an extra background thread subscribed.
    if (forkedId) await request('thread/unsubscribe', {threadId:forkedId}).catch(() => {});
  }
}

module.exports = {forkThroughReply};
