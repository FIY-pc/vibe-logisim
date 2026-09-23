'use strict';

const INTERRUPT_SETTLE_ATTEMPTS = 20;
const INTERRUPT_SETTLE_DELAY_MS = 50;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_PAGE_LIMIT = 100;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function pageTurnsInChronologicalOrder(turns) {
  // The paginated app-server endpoint returns the newest page first and the
  // turns within each page newest-first. Reversing the concatenated pages
  // restores the order required by beforeTurnId and local history.
  return turns.slice().reverse();
}

async function readThreadTurns({request, assertCurrent, threadId}) {
  let thread = null;
  try {
    thread = (await request('thread/read', {threadId, includeTurns:true})).thread || null;
    assertCurrent();
  } catch (_) {
    // Paginated runtimes reject includeTurns=true. The metadata response is
    // still useful, and turns/list below is the durable history source.
    thread = (await request('thread/read', {threadId, includeTurns:false})).thread || null;
    assertCurrent();
  }
  if (Array.isArray(thread?.turns) && thread.turns.length) return thread;

  const pages = [];
  let cursor = null;
  for (let pageNumber = 0; pageNumber < HISTORY_PAGE_LIMIT; pageNumber += 1) {
    const params = {threadId, limit:HISTORY_PAGE_SIZE, itemsView:'full'};
    if (cursor) params.cursor = cursor;
    let page;
    try {
      page = await request('thread/turns/list', params);
    } catch (_) {
      // Older non-paginated runtimes may not expose turns/list. Preserve the
      // empty read result so a caller can try a superseded native thread.
      return {...(thread || {id:threadId}), turns:[]};
    }
    assertCurrent();
    const data = Array.isArray(page?.data) ? page.data : [];
    if (data.length) pages.push(...data);
    const nextCursor = page?.nextCursor || page?.next_cursor || null;
    if (!nextCursor || nextCursor === cursor || !data.length) break;
    cursor = nextCursor;
  }
  return {...(thread || {id:threadId}), turns:pageTurnsInChronologicalOrder(pages)};
}

function locateUserTurn(turns, messageId) {
  const index = turns.findIndex(turn => turn.items?.some(item =>
    item.type === 'userMessage' && (item.id === messageId || item.clientId === messageId)));
  return {index, target:turns[index]};
}

// Native Codex editing is a history operation, not a text replacement. Revert
// the durable thread before the selected user turn and let the caller submit
// the edited text as a fresh turn. The native operation intentionally leaves
// the user's files untouched.
async function revertThroughMessage({request, assertCurrent, source, messageId}) {
  if (!source?.threadId) throw new Error('这条对话还没有可编辑的原始会话');
  if (!source.messages?.some(message => message.type === 'user' && message.id === messageId)) {
    throw new Error('这条问题已不属于当前对话，请重新选择');
  }

  const candidateThreadIds = [source.threadId, ...(source.supersededThreadIds || []).slice().reverse()]
    .filter((id, index, all) => typeof id === 'string' && id && all.indexOf(id) === index);
  let turns = [];
  let index = -1;
  let target = null;
  let selectedThreadId = null;
  let lastReadError = null;
  for (const candidateThreadId of candidateThreadIds) {
    try {
      const candidate = await readThreadTurns({request, assertCurrent, threadId:candidateThreadId});
      const located = locateUserTurn(candidate.turns, messageId);
      if (located.target) {
        turns = candidate.turns;
        index = located.index;
        target = located.target;
        selectedThreadId = candidateThreadId;
        break;
      }
    } catch (error) {
      lastReadError = error;
      assertCurrent();
    }
  }
  if (!target && lastReadError) throw lastReadError;
  if (!target) {
    throw new Error('这条问题在原生会话中找不到可编辑回合，当前对话历史没有改变');
  }

  const firstUser = target.items?.find(item => item.type === 'userMessage');
  if (firstUser?.id !== messageId && firstUser?.clientId !== messageId) {
    throw new Error('补充意见与原问题属于同一回合；请发送新的问题，不回退整轮对话。');
  }

  const prefix = turns.slice(0, index);
  const expectedIds = prefix.map(turn => turn.id);
  const keptIds = new Set(prefix.flatMap(turn => (turn.items || [])
    .filter(item => item.type === 'userMessage')
    .flatMap(item => [item.id, item.clientId].filter(Boolean))));
  const messageContexts = Object.fromEntries(Object.entries(source.messageContexts || {})
    .filter(([id]) => keptIds.has(id)));

  // A desktop restart can leave native turns marked inProgress without a
  // local turn to interrupt. Stop every such tail from the edit point onward
  // before the history operation; thread/revert remains the final authority.
  const staleTurns = turns.slice(index).filter(turn => turn.status === 'inProgress' && turn.id);
  for (const staleTurn of staleTurns) {
    await request('turn/interrupt', {threadId:selectedThreadId, turnId:staleTurn.id}).catch(() => {});
    assertCurrent();
  }
  if (staleTurns.length) {
    // `turn/interrupt` acknowledges the request before the native history is
    // necessarily settled. Poll the same thread until the stale tail leaves
    // inProgress, then issue the history mutation. Keep the final attempt
    // bounded so an unresponsive native service cannot hang the composer.
    for (let attempt = 0; attempt < INTERRUPT_SETTLE_ATTEMPTS; attempt += 1) {
      const settled = (await request('thread/read', {threadId:selectedThreadId, includeTurns:true})).thread;
      assertCurrent();
      const stillRunning = (Array.isArray(settled?.turns) ? settled.turns : [])
        .some(turn => staleTurns.some(stale => stale.id === turn.id) && turn.status === 'inProgress');
      if (!stillRunning || attempt === INTERRUPT_SETTLE_ATTEMPTS - 1) break;
      await delay(INTERRUPT_SETTLE_DELAY_MS);
    }
  }
  await request('thread/revert', {threadId:selectedThreadId, beforeTurnId:target.id});
  assertCurrent();
  const reverted = await readThreadTurns({request, assertCurrent, threadId:selectedThreadId});
  const actualTurns = Array.isArray(reverted?.turns) ? reverted.turns : [];
  if (actualTurns.length !== expectedIds.length || actualTurns.some((turn, i) => turn.id !== expectedIds[i])) {
    throw new Error('当前运行环境未能准确回退到这条问题，原对话没有改变');
  }

  return {thread:reverted, threadId:selectedThreadId, turnId:target.id, messageContexts};
}

module.exports = {readThreadTurns, revertThroughMessage};
