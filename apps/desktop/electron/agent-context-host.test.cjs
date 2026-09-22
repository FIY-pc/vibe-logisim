'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {AgentContextHost} = require('./agent-context-host.cjs');

test('agent context host enforces the shared size boundary and delegates projection', () => {
  const provider = {
    prepare: context => ({context, sizeBytes:context.size}),
    additionalContext: (prepared, options) => ({prepared, options}),
  };
  const host = new AgentContextHost({provider, maxBytes:10});
  const prepared = host.prepare({size:10});
  assert.deepEqual(prepared.context, {size:10});
  assert.deepEqual(host.additionalContext(prepared, {cwd:'/workspace'}), {
    prepared, options:{cwd:'/workspace'},
  });
  assert.throws(() => host.prepare({size:11}), error => {
    assert.equal(error.code, 'CONTEXT_TOO_LARGE');
    assert.deepEqual(error.context, {sizeBytes:11, maxBytes:10});
    return true;
  });
});
