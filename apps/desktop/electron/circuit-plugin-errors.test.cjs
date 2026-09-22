'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');
const {CircuitPlugin, modelErrorPayload, ERROR_SCHEMA} = require('./circuit-plugin.cjs');

function scope(work = {folder: '/workspace'}) {
  return {
    pending: {work, projectId: 'project-1', revisionId: 'revision-1'},
    assertCurrent() {},
    updateBinding() {},
    emit() {},
  };
}

async function rejected(promise) {
  let captured;
  await assert.rejects(promise, error => {
    captured = error;
    return true;
  });
  return captured;
}

function plugin({workspace, invoke = async () => ({})} = {}) {
  const value = new CircuitPlugin({
    invoke,
    workspace: workspace || {
      async synchronize() {
        return {workspace: {id: 'project-1'}, revision: {id: 'revision-2'}};
      },
      canvasVersion() { return 0; },
      canvasState() { return {}; },
    },
  });
  value.configure(catalog);
  return value;
}

test('host boundary failures preserve a structured recovery contract', async () => {
  let synchronizeCalls = 0;
  const value = plugin({workspace: {
    async synchronize() {
      synchronizeCalls += 1;
      return {workspace: {id: 'project-1'}, revision: {id: 'revision-2'}};
    },
    canvasVersion() { return 0; },
    canvasState() { return {}; },
  }});

  const missing = await rejected(value.call({tool: 'open_circuit', arguments: {}}, scope()));
  assert.equal(missing.toolError.code, 'INVALID_ARGUMENT');
  assert.deepEqual(missing.toolError.context.path, 'path');
  assert.deepEqual(missing.toolError.context.expected, '非空字符串');
  assert.equal(missing.toolError.context.invocation.tool, 'open_circuit');

  const unknown = await rejected(value.call({tool: 'open_circuit', arguments: {path: 'main.circ', typo: true}}, scope()));
  assert.equal(unknown.toolError.code, 'INVALID_ARGUMENT');
  assert.deepEqual(unknown.toolError.context.unknownParameters, ['typo']);
  assert.equal(unknown.toolError.context.invocation.tool, 'open_circuit');
  assert.equal(synchronizeCalls, 0, 'host validation must happen before workspace refresh');

  const absent = await rejected(plugin({workspace: {}}).call(
    {tool: 'open_circuit', arguments: {path: 'main.circ'}}, scope()));
  assert.equal(absent.toolError.code, 'WORKSPACE_NOT_OPEN');
  assert.equal(absent.toolError.retryable, false);
});

test('invalid domain results are distinguishable from domain failures', async () => {
  const value = plugin({invoke: async () => null});
  const error = await rejected(value.call({tool: 'inspect_circuit', arguments: {circuit: 'main'}}, scope()));
  assert.equal(error.toolError.code, 'TOOL_INVALID_RESULT');
  assert.equal(error.toolError.context.tool, 'inspect_circuit');
  assert.equal(error.toolError.context.invocation.tool, 'inspect_circuit');
});

test('a hidden or unknown tool cannot cross the host dispatch boundary', async () => {
  const value = plugin();
  const error = await rejected(value.call({tool: 'import_candidate', arguments: {}}, scope()));
  assert.equal(error.toolError.code, 'TOOL_NOT_REGISTERED');
  assert.equal(error.toolError.context.tool, 'import_candidate');
  assert.equal(error.toolError.context.invocation.tool, 'import_candidate');
});

test('domain failures preserve the workspace and observation binding', async () => {
  const value = plugin({invoke: async () => {
    const error = new Error('native runtime rejected the circuit');
    error.code = 'NATIVE_RUNTIME_PROTOCOL';
    error.toolError = {
      code: error.code,
      message: error.message,
      retryable: true,
      context: {service: 'simulation-worker'},
    };
    throw error;
  }});
  const callScope = scope();
  callScope.pending.observationId = 'observation-1';
  const error = await rejected(value.call({
    tool: 'simulate_circuit',
    arguments: {circuit: 'main', vectors: [{inputs: {A: 0}}]},
    threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1',
  }, callScope));
  assert.equal(error.toolError.code, 'NATIVE_RUNTIME_PROTOCOL');
  assert.deepEqual(error.toolError.context.invocation, {
    projectId: 'project-1', revisionId: 'revision-1', observationId: 'observation-1',
    threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'simulate_circuit',
  });
  assert.equal(error.toolError.context.service, 'simulation-worker');
});

test('the model-facing error envelope keeps the shared protocol schema', () => {
  const source = new Error('expired');
  source.toolError = {schema: 'untrusted-schema', code: 'STALE_REVISION', message: source.message};
  const payload = modelErrorPayload(source, {
    tool: 'inspect_circuit', callId: 'call-1', turnId: 'turn-1', threadId: 'thread-1',
  }, {pending: {projectId: 'project-1', revisionId: 'revision-1'}});
  assert.equal(payload.schema, ERROR_SCHEMA);
  assert.equal(payload.code, 'STALE_REVISION');
  assert.equal(payload.context.invocation.revisionId, 'revision-1');
});
