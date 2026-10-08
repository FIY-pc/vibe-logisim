'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');
const {CircuitPlugin} = require('./circuit-plugin.cjs');

// A direct file write is acknowledged by submit_circuit. The receipt must carry
// what the domain learned about the write (which definitions changed, why the
// file does not load) without turning submit into a behaviour verdict.
function session(revisionId) {
  return {
    schema: 'vibe-logisim.circuit-lens/v0',
    workspace: {id: 'project-1', currentRevisionId: revisionId, savedRevisionId: revisionId, dirty: false, canSave: true},
    revision: {id: revisionId, artifactSha256: 'a'.repeat(64)},
    folder: {id: 'folder-1', activeFile: 'design.circ'},
    project: {mainCircuit: 'main', circuits: [{name: 'main'}, {name: 'Other'}]},
    canvas: {status: 'shown', circuit: 'main'},
    sourceStatus: {stale: false},
  };
}

function harness(observed) {
  const calls = [];
  const work = {folder: '/workspace', revisionId: 'revision-1'};
  const plugin = new CircuitPlugin({
    invoke: async request => { calls.push(request); return typeof observed === 'function' ? observed(request) : observed; },
    workspace: {
      async synchronize(binding) {
        // Like DirectAgentWorkspace: remember what was loaded before the refresh.
        binding.previousRevisionId = binding.revisionId;
        binding.revisionId = 'revision-2';
        return session('revision-2');
      },
      canvasVersion() { return 0; },
      canvasState(value) { return value.canvas; },
    },
  });
  plugin.configure(catalog);
  const scope = {
    pending: {work, projectId: 'project-1', revisionId: 'revision-1'},
    assertCurrent() {},
    updateBinding(value) { scope.pending.revisionId = value?.revision?.id; },
    emit() {},
  };
  return {plugin, scope, calls};
}

test('submit forwards the pre-refresh revision and reports which definitions the write changed', async () => {
  const fileChange = {
    previousRevisionId: 'revision-1', revisionId: 'revision-2', changed: true,
    circuits: [{circuit: 'main', status: 'modified'}, {circuit: 'Other', status: 'modified'}],
    outsideTarget: ['Other'], projectSettingsChanged: false,
  };
  const {plugin, scope, calls} = harness({status: 'loadable', authority: 'native-loader', circuit: 'main', fileChange});
  const result = await plugin.call({tool: 'submit_circuit', arguments: {}, callId: 'call-1'}, scope);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'check_native_loadability');
  assert.deepEqual(calls[0].arguments, {circuit: 'main', previousRevisionId: 'revision-1'});
  assert.equal(calls[0].revisionId, 'revision-2', 'the check runs against the refreshed revision');
  assert.equal(result.nativeLoadability.status, 'loadable');
  assert.deepEqual(result.nativeLoadability.fileChange, fileChange);
  assert.match(result.nativeLoadability.note, /目标电路之外的定义：Other/);
});

test('an unchanged file is called out so the model checks what it wrote and where', async () => {
  const {plugin, scope} = harness({
    status: 'loadable', authority: 'native-loader', circuit: 'main',
    fileChange: {previousRevisionId: 'revision-1', revisionId: 'revision-2', changed: false, circuits: [], outsideTarget: []},
  });
  const result = await plugin.call({tool: 'submit_circuit', arguments: {}}, scope);
  assert.match(result.nativeLoadability.note, /没有带来任何改动/);
  assert.doesNotMatch(result.nativeLoadability.note, /目标电路之外/);
});

test('load failures keep the domain hint next to the native message', async () => {
  const {plugin, scope} = harness({
    status: 'not-loadable', authority: 'native-loader', circuit: 'main',
    error: {code: 'NATIVE_LOAD_FAILED', message: "component `Constant' not found [main.Constant((120,200))]", hint: '缺少 lib 属性'},
  });
  const result = await plugin.call({tool: 'submit_circuit', arguments: {}}, scope);
  assert.equal(result.nativeLoadability.status, 'not-loadable');
  assert.deepEqual(result.nativeLoadability.error, {
    code: 'NATIVE_LOAD_FAILED', message: "component `Constant' not found [main.Constant((120,200))]", hint: '缺少 lib 属性',
  });
  assert.equal(result.nativeLoadability.fileChange, undefined, 'no fabricated change summary without domain data');
});

test('without a previous revision the check is asked only for the circuit', async () => {
  const {plugin, scope, calls} = harness({status: 'loadable', authority: 'native-loader', circuit: 'main'});
  scope.pending.work.revisionId = null;
  await plugin.call({tool: 'submit_circuit', arguments: {}}, scope);
  assert.deepEqual(calls[0].arguments, {circuit: 'main'});
});

test('geometry evidence survives the host receipt and model projection, independently of loadability', async () => {
  for (const layoutReview of [
    {status: 'observed', overlapPairs: 7, otherChangedDefinitions: ['Child'],
      examples: [{objects: [{componentId: 'c300_180', label: 'DATA'}], viewport: {x: 200, y: 140, width: 200, height: 140, scale: 1.5}}]},
    {status: 'unavailable', message: 'native geometry unavailable'},
  ]) {
    const {plugin, scope} = harness({status: 'loadable', circuit: 'main', layoutReview});
    const result = await plugin.call({tool: 'submit_circuit', arguments: {}}, scope);
    assert.equal(result.nativeLoadability.status, 'loadable');
    assert.deepEqual(result.nativeLoadability.layoutReview, layoutReview);
  }
});

test('submit forwards the current project turn baseline and retains cumulative changes',async()=>{
  const turnChanges={previousRevisionId:'turn-start',revisionId:'revision-2',changed:true,
    circuits:[{circuit:'EarlierChild',status:'added'},{circuit:'main',status:'modified'}]};
  const {plugin,scope,calls}=harness({status:'loadable',circuit:'main',turnChanges});
  scope.pending.work.turnBaselines={'project-1':'turn-start','other-project':'foreign-baseline'};
  const result=await plugin.call({tool:'submit_circuit',arguments:{}},scope);
  assert.equal(calls[0].arguments.turnBaselineRevisionId,'turn-start');
  assert.deepEqual(result.nativeLoadability.turnChanges,turnChanges);
  assert.equal(result.nativeLoadability.completed,undefined);
});
