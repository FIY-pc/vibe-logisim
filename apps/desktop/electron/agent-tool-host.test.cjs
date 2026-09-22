'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {AgentToolHost} = require('./agent-tool-host.cjs');

test('agent tool host keeps the Base Harness independent of plugin semantics', async () => {
  const calls = [];
  const registry = {
    tools: [{name:'inspect', inputSchema:{type:'object'}}],
    identity:{id:'example.plugin', version:'1.0.0', schema:'example/v1'},
    signature:'plugin-signature',
    get(name) { return name === 'inspect' ? {name} : null; },
    label(name) { return name === 'inspect' ? 'Inspect' : name; },
  };
  const plugin = {
    registry:null,
    configure(manifest, options) {
      calls.push({manifest, options});
      this.registry = registry;
      return registry;
    },
    call(request, scope) { return {request, scope}; },
    modelErrorPayload(error, request) { return {kind:'example', error, request}; },
  };
  const host = new AgentToolHost({plugin, manifest:async()=>({domain:'example'}), mode:'example'});
  await host.prepare({live:true});
  assert.deepEqual(calls, [{manifest:{domain:'example'}, options:{live:true}}]);
  assert.deepEqual(host.tools, registry.tools);
  assert.equal(host.get('inspect').name, 'inspect');
  assert.equal(host.label('inspect'), 'Inspect');
  assert.equal(host.signature, 'plugin-signature');
  assert.deepEqual(host.call({tool:'inspect'}, {}), {request:{tool:'inspect'}, scope:{}});
  const error = new Error('failed');
  const payload = host.errorPayload(error, {tool:'inspect'}, {});
  assert.equal(payload.kind, 'example');
  assert.equal(payload.error, error);
  assert.deepEqual(payload.request, {tool:'inspect'});
});
