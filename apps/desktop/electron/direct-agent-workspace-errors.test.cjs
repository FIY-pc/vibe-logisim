'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('prepare permits folder-only turns without a circuit revision binding', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-folder-turn-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const workspace = {
    folder: {current: {id: 'folder-1', root, activeFile: null}},
    backend: {
      async session() {
        return {
          workspace: {id: 'project-1'},
          revision: {id: 'revision-current'},
          sourceStatus: {stale: false},
        };
      },
    },
    async run(operation) { return operation(); },
    async saveWorking() {},
    async refresh() {},
  };
  const agent = new DirectAgentWorkspace(workspace);
  const result = await agent.prepare(null);
  assert.equal(result.revisionId, null);
  assert.equal(result.workspaceIndex.revisionId, 'revision-current');
  assert.equal(workspace.turnActive, true);
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

test('abort releases the direct-workspace turn guard', async () => {
  const workspace = {
    turnActive: true,
    folder: {assert() {}},
  };
  const agent = new DirectAgentWorkspace(workspace);
  await agent.abort({folderId: 'folder-1'});
  assert.equal(workspace.turnActive, false);
});

test('finish returns the revision created while refreshing direct file changes', async () => {
  const workspace = {
    turnActive: true,
    folder: {assert() {}},
    backend: {
      async session() { return {workspace: {id: 'project-1'}, revision: {id: 'revision-after-write'}}; },
    },
    async run(operation) { return operation(); },
    async refresh() {},
  };
  const agent = new DirectAgentWorkspace(workspace);
  const result = await agent.finish({folderId: 'folder-1'}, {isCurrent: () => true});
  assert.deepEqual(result, {projectId: 'project-1', revisionId: 'revision-after-write'});
  assert.equal(workspace.turnActive, false);
});

test('synchronize remembers the revision loaded before the refresh for the write receipt', async () => {
  const revisions = ['revision-before-write', 'revision-after-write'];
  const workspace = {
    folder: {assert() {}, current: {id: 'folder-1', root: '/tmp', activeFile: 'main.circ'}},
    backend: {
      async session() { return {workspace: {id: 'project-1'}, revision: {id: revisions[0]}}; },
    },
    async run(operation) { return operation(); },
    async refresh() { if (revisions.length > 1) revisions.shift(); },
    async select() { throw new Error('a plain refresh must not reselect the file'); },
  };
  const agent = new DirectAgentWorkspace(workspace);
  const binding = {folderId: 'folder-1', revisionId: 'revision-before-write'};
  const session = await agent.synchronize(binding);
  assert.equal(session.revision.id, 'revision-after-write');
  assert.equal(binding.revisionId, 'revision-after-write');
  assert.equal(binding.previousRevisionId, 'revision-before-write');

  const unchanged = await agent.synchronize(binding);
  assert.equal(unchanged.revision.id, 'revision-after-write');
  assert.equal(binding.previousRevisionId, 'revision-after-write', 'no disk change means previous equals current');
});
