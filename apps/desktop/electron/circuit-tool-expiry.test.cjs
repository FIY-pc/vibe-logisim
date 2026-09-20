'use strict';

const assert = require('node:assert/strict');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');
const {CircuitPlugin} = require('./circuit-plugin.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return {promise, resolve};
}

function createScope(pending, name, events) {
  let current = true;
  const updates = [];
  return {
    pending,
    expire() { current = false; },
    updates,
    assertCurrent() {
      if (!current) throw new Error(`${name} tool call expired`);
    },
    updateBinding(session) {
      const projectId = session?.workspace?.id || null;
      const revisionId = session?.revision?.id || null;
      if (pending.projectId !== projectId || pending.revisionId !== revisionId) {
        pending.observationId = null;
      }
      pending.projectId = projectId;
      pending.revisionId = revisionId;
      updates.push({projectId, revisionId});
    },
    emit(event) { events.push({scope: name, event}); },
  };
}

async function main() {
  const pending = {
    work: {folder: '/virtual/workspace'},
    projectId: 'project-initial',
    revisionId: 'revision-initial',
    observationId: 'observation-initial',
  };
  const events = [];
  const calls = [];
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const staleResult = {
    binding: {projectId: 'stale-project', revisionId: 'stale-result'},
    run: {id: 'stale-run', kind: 'simulate'},
    feedback: {status: 'passed'},
  };
  const secondResult = {
    binding: {projectId: 'result-project', revisionId: 'result-revision'},
    run: {id: 'second-run', kind: 'simulate'},
    feedback: {status: 'passed'},
  };
  let synchronizeCount = 0;
  const workspace = {
    async synchronize() {
      synchronizeCount += 1;
      return {
        workspace: {id: 'project-live'},
        revision: {id: `revision-${synchronizeCount}`},
      };
    },
  };
  const plugin = new CircuitPlugin({
    workspace,
    invoke: async payload => {
      calls.push(payload);
      if (payload.callId === 'call-first') {
        firstStarted.resolve();
        await releaseFirst.promise;
        return staleResult;
      }
      return secondResult;
    },
  });
  plugin.configure(catalog);

  const firstScope = createScope(pending, 'first', events);
  const secondScope = createScope(pending, 'second', events);
  const request = (callId, scope) => plugin.call({
    tool: 'inspect_circuit',
    arguments: {circuit: 'main'},
    threadId: 'expiry-test-thread',
    turnId: 'expiry-test-turn',
    callId,
    itemId: callId,
  }, scope);

  const first = request('call-first', firstScope);
  await firstStarted.promise;
  const second = request('call-second', secondScope);

  // The first request is stale while its native/domain work is still pending.
  // Its result intentionally carries a different identity to catch accidental
  // post-expiry binding propagation.
  firstScope.expire();
  releaseFirst.resolve();

  await assert.rejects(first, /first tool call expired/);
  const result = await second;

  assert.equal(calls.length, 2, 'the queued second call must reach the domain invoke');
  assert.deepEqual(calls.map(call => call.revisionId), ['revision-1', 'revision-2'],
    'each call captures its own binding before domain work begins');
  assert.equal(firstScope.updates.length, 1,
    'an expired domain result must not call updateBinding a second time');
  assert.equal(secondScope.updates.length, 1,
    'the live queued call still updates its binding once during synchronization');
  assert.deepEqual(pending, {
    work: {folder: '/virtual/workspace'},
    projectId: 'project-live',
    revisionId: 'revision-2',
    observationId: null,
  }, 'the stale result must not advance the shared pending identity');
  assert.equal(result.invocation.revisionId, 'revision-2',
    'the live result must carry the current invocation identity');
  assert.equal(result.invocation.callId, 'call-second');
  assert.deepEqual(events.map(({scope, event}) => [scope, event.run?.id]),
    [['second', 'second-run']],
    'only the live result may reach the plugin event path');
  assert.equal(events.some(({event}) => event.run?.id === 'stale-run'), false,
    'the expired result must not be emitted to later logic');

  console.log(JSON.stringify({
    expiredCallRejected: true,
    queuedCallExecuted: true,
    domainInvocations: calls.length,
    bindingUpdates: {first: firstScope.updates.length, second: secondScope.updates.length},
    emittedRunIds: events.map(({event}) => event.run?.id),
    finalRevisionId: pending.revisionId,
  }));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
