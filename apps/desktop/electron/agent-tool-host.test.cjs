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
  assert.deepEqual(await host.call({tool:'inspect'}, {}), {request:{tool:'inspect'}, scope:{}});
  const error = new Error('failed');
  const payload = host.errorPayload(error, {tool:'inspect'}, {});
  assert.equal(payload.kind, 'example');
  assert.equal(payload.error, error);
  assert.deepEqual(payload.request, {tool:'inspect'});
});

function failingHost(options) {
  const plugin = {
    registry: null,
    configure() { return this.registry; },
    async call(request) {
      if (request.tool === 'ok') return {ok:true};
      const error = new Error('要求连接的信号仍然断开: AND Gate@(120,80) bit 0');
      error.toolError = {code:'TOOL_REJECTED', message:error.message, retryable:false, hint:'先检查端口是否在布线网格上',
        context:{failingPort:'AND Gate@(120,80).in0', wiresBefore:Array.from({length:300}, (_, i) => ({from:[i, 0], to:[i, 10]})),
          environment:{os:'win32', javaVersion:'21.0.5'}, invocation:{threadId:'t1'}}};
      throw error;
    },
  };
  return new AgentToolHost({plugin, manifest:async()=>({}), failures:options});
}

test('failed calls are kept bounded and redacted; successful calls are not recorded', async () => {
  const seen = [];
  const host = failingHost({limit:3, now:() => new Date('2026-09-27T00:00:00Z'), redact:text => text.replace(/C:\\Users\\张三/g, '~'), onFailure:record => seen.push(record)});
  assert.deepEqual(await host.call({tool:'ok', arguments:{path:'C:\\Users\\张三\\a.circ'}}, {}), {ok:true});
  assert.deepEqual(host.recentFailures(), []);
  const args = {connections:[{from:'c120_80', to:'c200_80'}], note:'C:\\Users\\张三\\cpu.circ ' + 'x'.repeat(500)};
  await assert.rejects(host.call({tool:'wire_candidate', arguments:args}, {}), /仍然断开/);
  const [record] = host.recentFailures();
  assert.equal(record.at, '2026-09-27T00:00:00.000Z');
  assert.equal(record.tool, 'wire_candidate');
  assert.deepEqual({code:record.error.code, retryable:record.error.retryable}, {code:'TOOL_REJECTED', retryable:false});
  assert.equal(record.error.hint, '先检查端口是否在布线网格上');
  assert.equal(record.context.failingPort, 'AND Gate@(120,80).in0');
  assert.equal(record.context.invocation, undefined);
  assert.deepEqual(record.context.environment, {os:'win32', javaVersion:'21.0.5'});
  assert.deepEqual(record.arguments.connections, [{from:'c120_80', to:'c200_80'}]);
  assert.match(record.arguments.note, /^~\\cpu\.circ x+…\(\+\d+\)$/);
  assert.ok(record.arguments.note.length < 220);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 4096);
  assert.equal(seen.length, 1);
  for (let index = 0; index < 5; index++) await host.call({tool:'wire_candidate', arguments:{index}}, {}).catch(() => {});
  assert.deepEqual(host.recentFailures().map(entry => entry.arguments.index), [2, 3, 4]);
  // Callers get copies, not the live buffer.
  host.recentFailures()[0].tool = 'changed';
  assert.equal(host.recentFailures()[0].tool, 'wire_candidate');
});

test('the failure buffer stays under its total budget and never alters the error', async () => {
  const host = failingHost({limit:20, redact:text => text});
  const big = {blob:Array.from({length:40}, (_, i) => 'y'.repeat(190) + i)};
  let thrown;
  for (let index = 0; index < 20; index++) {
    try { await host.call({tool:'wire_candidate', arguments:{...big, index}}, {}); } catch (error) { thrown = error; }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(host.recentFailures())) <= 64 * 1024);
  assert.equal(host.recentFailures().at(-1).arguments.index, 19);
  assert.equal(thrown.toolError.code, 'TOOL_REJECTED');
  // A throwing redactor or observer must not replace the tool's own error.
  const broken = failingHost({redact:() => { throw new Error('redactor bug'); }});
  await assert.rejects(broken.call({tool:'wire_candidate', arguments:{}}, {}), /仍然断开/);
  assert.deepEqual(broken.recentFailures(), []);
});
