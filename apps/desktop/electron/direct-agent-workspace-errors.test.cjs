'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {DirectAgentWorkspace} = require('./direct-agent-workspace.cjs');

test('missing subcircuit returns available definitions as structured recovery context', async () => {
  const changes = [];
  const workspace = {
    folder: {assert() {}},
    emit(type, value) { changes.push({type, value}); },
    snapshot() { return {folder: 'fixture'}; },
  };
  const agent = new DirectAgentWorkspace(workspace);
  const session = {project: {circuits: [{name: 'main'}, {name: 'ALU'}]}};
  await assert.rejects(
    agent.navigate({folderId: 'folder-1'}, session, 'Missing', () => {}, 0),
    error => {
      assert.equal(error.toolError.code, 'CIRCUIT_NOT_FOUND');
      assert.deepEqual(error.toolError.context, {
        requested: 'Missing', availableCircuits: ['main', 'ALU'],
      });
      assert.match(error.toolError.hint, /circuits/);
      return true;
    },
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'changed');
});

