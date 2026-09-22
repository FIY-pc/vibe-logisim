'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {AgentWorkspaceHost} = require('./agent-workspace-host.cjs');

test('workspace host exposes an explicit mode and only forwards lifecycle operations', async () => {
  const calls = [];
  const adapter = {
    async prepare(value) { calls.push(['prepare', value]); return {binding: value}; },
    async finish(binding, options) { calls.push(['finish', binding, options]); return {revisionId: 'r1'}; },
    async abort(binding, options) { calls.push(['abort', binding, options]); return null; },
    finishEvent(outcome) { calls.push(['event', outcome]); return {type: 'domain-change'}; },
    synchronize() { throw new Error('base must not inspect or call adapter-specific methods'); },
  };
  const host = new AgentWorkspaceHost({adapter, mode: 'direct'});
  assert.equal(host.mode, 'direct');
  assert.deepEqual(await host.prepare('r0'), {binding: 'r0'});
  assert.deepEqual(await host.finish('binding', {completed: true}), {revisionId: 'r1'});
  await host.abort('binding', {reason: 'failed'});
  assert.deepEqual(host.finishEvent({revisionId: 'r1'}), {type: 'domain-change'});
  assert.deepEqual(calls, [
    ['prepare', 'r0'],
    ['finish', 'binding', {completed: true}],
    ['abort', 'binding', {reason: 'failed'}],
    ['event', {revisionId: 'r1'}],
  ]);
});

test('optional adapter hooks are safe for a minimal workspace implementation', async () => {
  const host = new AgentWorkspaceHost({
    adapter: {prepare() {}, finish() {}},
  });
  assert.equal(await host.abort('binding'), undefined);
  assert.equal(host.finishEvent({}), null);
});
