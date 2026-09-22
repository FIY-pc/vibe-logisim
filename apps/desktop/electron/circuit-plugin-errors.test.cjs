'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');
const {CircuitPlugin} = require('./circuit-plugin.cjs');

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
  assert.deepEqual(missing.toolError.context, {path: 'path', expected: '非空字符串'});

  const unknown = await rejected(value.call({tool: 'open_circuit', arguments: {path: 'main.circ', typo: true}}, scope()));
  assert.equal(unknown.toolError.code, 'INVALID_ARGUMENT');
  assert.deepEqual(unknown.toolError.context, {unknownParameters: ['typo']});
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
  assert.deepEqual(error.toolError.context, {tool: 'inspect_circuit'});
});

test('a hidden or unknown tool cannot cross the host dispatch boundary', async () => {
  const value = plugin();
  const error = await rejected(value.call({tool: 'import_candidate', arguments: {}}, scope()));
  assert.equal(error.toolError.code, 'TOOL_NOT_REGISTERED');
  assert.equal(error.toolError.context.tool, 'import_candidate');
});

