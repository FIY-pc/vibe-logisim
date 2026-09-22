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

test('prepare rejects a stale UI revision before starting a model turn', async () => {
  let sessionReads = 0;
  const workspace = {
    folder: {current: {id: 'folder-1', root: '/tmp', activeFile: 'main.circ'}},
    backend: {
      async session() {
        sessionReads += 1;
        return {workspace: {id: 'project-1'}, revision: {id: sessionReads === 1 ? 'revision-old' : 'revision-current'}};
      },
    },
    async run(operation) { return operation(); },
    async saveWorking() {},
    async refresh() {},
    report() {},
  };
  const agent = new DirectAgentWorkspace(workspace);
  await assert.rejects(
    agent.prepare('revision-old'),
    error => {
      assert.equal(error.toolError.code, 'STALE_WORKSPACE_CONTEXT');
      assert.deepEqual(error.toolError.context, {
        expectedRevisionId: 'revision-old', currentRevisionId: 'revision-current',
      });
      return true;
    },
  );
});

test('prepare does not start a model turn when workspace refresh reports a conflict', async () => {
  let reported = null;
  const workspace = {
    folder: {current: {id: 'folder-1', root: '/tmp', activeFile: 'main.circ'}},
    backend: {
      async session() {
        return {workspace: {id: 'project-1'}, revision: {id: 'revision-current'}, sourceStatus: {stale: false}};
      },
    },
    async run(operation) { return operation(); },
    async saveWorking() {},
    async refresh() { throw new Error('磁盘文件已改变，画布还有未保存编辑'); },
    report(error) { reported = error; },
  };
  const agent = new DirectAgentWorkspace(workspace);
  await assert.rejects(agent.prepare('revision-current'), /磁盘文件已改变/);
  assert.equal(reported, null);
});
