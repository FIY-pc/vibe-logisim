'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {EventEmitter} = require('node:events');
const {EpisodeLedger, digest} = require('./episode-ledger.cjs');
const {harnessResultEvent} = require('./harness-result.cjs');

test('grounded evidence requires an actual run and a revision or artifact identity', () => {
  const ledger = new EpisodeLedger();
  const at = ledger.startedAt;
  for (const [binding, run] of [
    [{projectId: 'project-only'}, {id: 'run-1'}],
    [{revisionId: null, artifactSha256: ''}, {id: 'run-1'}],
    [{revisionId: 'rev-1'}, {}],
    [{revisionId: 'rev-1'}, {id: ' '}],
  ]) {
    ledger.record('event', {type: 'harness-result', binding, run, feedback: {status: 'observed'}}, at + 10);
    assert.equal(ledger.metrics().timeToFirstGroundedEvidenceMs, null);
  }
  ledger.record('event', {type: 'harness-result', binding: {artifactSha256: 'artifact'},
    run: {id: 'run-2', kind: 'simulate'}, feedback: {status: 'unknown'}}, at + 25);
  assert.equal(ledger.metrics().timeToFirstGroundedEvidenceMs, 25);
  assert.equal(ledger.metrics().observedPassedFeedback, false);
  assert.equal(ledger.metrics().verificationCount, 0);
});

test('counts and completed calls cannot fabricate a run or a verdict', () => {
  const ledger = new EpisodeLedger();
  const legacy = {passed: 1024, failed: 0, unchecked: 0, binding: {revisionId: 'rev-1'}};
  assert.equal(harnessResultEvent(legacy), null);
  ledger.record('event', {type: 'activity', itemId: 'call-1', kind: 'tool',
    activityKey: 'circuit:simulate_circuit', status: 'completed', ...legacy});
  assert.equal(ledger.metrics().timeToFirstGroundedEvidenceMs, null);
  assert.equal(ledger.metrics().observedPassedFeedback, false);
  assert.equal(ledger.metrics().verificationCount, 0);
  const projected = harnessResultEvent({...legacy, run: {id: 'native-run', kind: 'simulate'},
    feedback: {status: 'passed'}}, {itemId: 'call-1'});
  ledger.record('event', projected, ledger.startedAt + 50);
  assert.equal(ledger.metrics().timeToFirstGroundedEvidenceMs, 50);
  assert.equal(ledger.metrics().observedPassedFeedback, true);
  assert.equal(ledger.metrics().verificationCount, 1);
  assert.equal(ledger.metrics().taskSuccess, null, 'plugin evidence does not replace the independent oracle');
});

test('a completed tool cannot mask a failed expectation or erase it after a later pass', () => {
  const ledger = new EpisodeLedger();
  const feedback = (id, status) => harnessResultEvent({
    binding: {revisionId: 'rev-1', artifactSha256: 'artifact'},
    run: {id, kind: 'simulate'}, feedback: {status},
  }, {itemId: id});
  ledger.record('event', feedback('representative', 'failed'), ledger.startedAt + 10);
  ledger.record('event', {type: 'activity', itemId: 'representative', kind: 'tool',
    activityKey: 'circuit:simulate_circuit', status: 'completed'}, ledger.startedAt + 11);
  assert.equal(ledger.metrics().nativeRunCalls, 1);
  assert.equal(ledger.metrics().observedPassedFeedback, false);
  assert.equal(ledger.metrics().verificationCount, 1);
  ledger.record('event', feedback('full-batch', 'passed'), ledger.startedAt + 20);
  assert.equal(ledger.metrics().observedPassedFeedback, true);
  assert.equal(ledger.metrics().verificationCount, 2);
  assert.equal(ledger.metrics().timeToFirstGroundedEvidenceMs, 10);
  assert.deepEqual(ledger.snapshot().events.filter(e => e.type === 'harness-result')
    .map(e => e.feedbackStatus), ['failed', 'passed']);
  assert.equal(ledger.metrics().taskSuccess, null);
});

test('counts combined native runs and external verification separately', () => {
  const ledger = new EpisodeLedger();
  ledger.record('event', {type: 'activity', itemId: 'harness', kind: 'tool',
    activityKey: 'circuit:harness_run', status: 'completed'});
  ledger.record('event', {type: 'activity', itemId: 'compare', kind: 'tool',
    activityKey: 'circuit:compare_circuit', status: 'completed'});
  ledger.record('event', {type: 'activity', itemId: 'verify', kind: 'tool',
    activityKey: 'circuit:run_verification', status: 'completed'});
  assert.equal(ledger.metrics().nativeRunCalls, 2);
  assert.equal(ledger.metrics().verificationToolCalls, 1);
});

test('summarizes a free-form episode from independent evidence', () => {
  const ledger = new EpisodeLedger({
    episodeId: 'episode-1', taskId: 'full-adder', condition: 'circuit-tools',
    model: 'test-model', effort: 'high', initialArtifactSha256: digest('before'),
    metadata: {replicate: 1, prompt: 'must not be persisted'},
  });
  ledger.record('event', {type: 'user-message', id: 'u1', text: '构建全加器', context: {revisionId: 'rev-1'}});
  ledger.record('event', {type: 'turn-started', turnId: 'turn-1'});
  ledger.record('event', {type: 'activity', itemId: 'tool-1', kind: 'tool', activityKey: 'circuit:inspect_circuit', label: '查看电路', status: 'failed', detail: '参数错误'}, 100);
  ledger.record('event', {type: 'activity', itemId: 'tool-2', kind: 'tool', activityKey: 'circuit:inspect_circuit', label: '查看电路', status: 'completed'}, 200);
  ledger.record('event', {type: 'harness-result', itemId: 'tool-3', binding: {revisionId: 'rev-1', circuit: 'main'}, run: {id: 'run-1', kind: 'evaluation'}, feedback: {status: 'passed'}});
  ledger.record('event', {type: 'assistant-completed', itemId: 'a1', text: '已完成，验证通过'});
  ledger.record('event', {type: 'turn-completed', turnId: 'turn-1', status: 'completed'});
  ledger.finalize({outcome: 'completed', artifact: {sha256: digest('after')}, oracle: {status: 'passed', authority: 'fixture-oracle'}});
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.schema, 'vibe-logisim.episode/v2');
  assert.equal(snapshot.metrics.taskSuccess, true);
  assert.equal(snapshot.metrics.toolCalls, 2);
  assert.equal(snapshot.metrics.circuitToolCalls, 2);
  assert.equal(snapshot.metrics.failedCalls, 1);
  assert.equal(snapshot.metrics.laterSuccessesOfSameActivity, 1);
  assert.equal(snapshot.metrics.verificationCount, 1);
  assert.equal(snapshot.metrics.claimEvidenceAlignment, 'not-assessed');
  assert.equal(snapshot.metrics.positiveClaimHeuristic, true);
  assert.equal(snapshot.metrics.artifactChanges, true);
  assert.equal(snapshot.events.find(item => item.type === 'user-message').text.chars, 5);
  assert.equal(snapshot.events.find(item => item.type === 'user-message').text.value, undefined);
  assert.deepEqual(snapshot.metadata, {replicate: 1});
});

test('preserves planned episode identity without persisting prompt content', () => {
  const ledger = new EpisodeLedger({metadata: {
    pairId: 'half-to-full-adder-r001', replicate: 1, seed: 47, scheduleIndex: 2,
    planSha256: 'plan', taskSha256: 'task', fixtureSha256: 'fixture',
    runtimeSha256: 'runtime', judgeBundleSha256: 'judge', runnerVersion: '005-v3',
    prompt: 'must not be persisted',
  }});
  assert.deepEqual(ledger.snapshot().metadata, {
    pairId: 'half-to-full-adder-r001', replicate: 1, seed: 47, scheduleIndex: 2,
    planSha256: 'plan', taskSha256: 'task', fixtureSha256: 'fixture',
    runtimeSha256: 'runtime', judgeBundleSha256: 'judge', runnerVersion: '005-v3',
  });
});

test('does not call an unverified model claim a task success', () => {
  const ledger = new EpisodeLedger({episodeId: 'episode-2'});
  ledger.record('event', {type: 'assistant-completed', text: '应该完成了'});
  ledger.finalize({outcome: 'completed', oracle: {status: 'unknown'}});
  assert.equal(ledger.snapshot().metrics.taskSuccess, null);
  assert.equal(ledger.snapshot().metrics.claimEvidenceAlignment, 'not-assessed');
});

test('does not judge promises, negations or stale feedback as supported claims', () => {
  const ledger = new EpisodeLedger();
  ledger.record('event', {type:'assistant-completed',phase:'commentary',text:'我会完成并验证'});
  assert.equal(ledger.metrics().positiveClaimHeuristic,false);
  ledger.record('event', {type:'assistant-completed',phase:'final_answer',text:'没有通过'});
  ledger.record('event', {type:'harness-result',binding:{revisionId:'old'},run:{id:'old'},feedback:{status:'passed'}});
  ledger.finalize({oracle:{status:'failed'}});
  assert.equal(ledger.metrics().taskSuccess,false);
  assert.equal(ledger.metrics().claimEvidenceAlignment,'not-assessed');
});

test('a success before a later failure is not counted as recovery', () => {
  const ledger = new EpisodeLedger();
  ledger.record('event',{type:'activity',itemId:'success',activityKey:'same',status:'completed'},100);
  ledger.record('event',{type:'activity',itemId:'failure',activityKey:'same',status:'failed'},200);
  assert.equal(ledger.metrics().laterSuccessesOfSameActivity,0);
});

test('reports artifact correctness, conversation completion and native observations separately', () => {
  const ledger = new EpisodeLedger();
  ledger.record('event',{type:'activity',itemId:'edit',kind:'file',status:'completed'});
  ledger.record('event',{type:'activity',itemId:'sim',kind:'tool',activityKey:'circuit:simulate_circuit',status:'completed'});
  ledger.record('event',{type:'activity',itemId:'render',kind:'tool',activityKey:'circuit:render_circuit',status:'completed'});
  ledger.record('event',{type:'harness-result',binding:{revisionId:'rev-1'},run:{id:'render-1',kind:'render'},feedback:{status:'observed'}});
  ledger.record('event',{type:'activity',itemId:'shell',kind:'command',status:'failed'});
  ledger.finalize({outcome:'timeout',oracle:{status:'passed'}});
  const metrics=ledger.metrics();
  assert.equal(metrics.taskSuccess,true);
  assert.equal(metrics.completedAndVerified,false);
  assert.equal(metrics.fileChangeEvents,1);
  assert.equal(metrics.toolCalls,3);
  assert.equal(metrics.nativeRunCalls,1);
  assert.equal(metrics.visualObservationCalls,1);
  assert.equal(metrics.visualObservationFailures,0);
  assert.equal(metrics.visualEvidenceCount,1);
  assert.equal(metrics.commandFailures,1);
  assert.equal(metrics.circuitToolFailures,0);
  assert.equal(metrics.verificationCount,0,'native observation is not an explicit verdict');
});

test('stores token counters and writes an atomic bounded artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-episode-'));
  const ledger = new EpisodeLedger({episodeId: 'episode-3'});
  ledger.record('telemetry', {method: 'thread/tokenUsage/updated', params: {
    turnId: 'turn-1', tokenUsage: {total: {inputTokens: 10, outputTokens: 2}, last: {inputTokens: 8}},
  }});
  const target = ledger.write(path.join(root, 'episode.json'));
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.metrics.tokenUsage.inputTokens, 10);
  assert.equal(parsed.metrics.peakRequestInputTokens, 8);
  assert.equal(parsed.events[0].channel, 'telemetry');
  assert.equal(parsed.events[0].usage.total.inputTokens, 10);
});

test('nonzero CLI exits are observable failures, not automatically invalid calls', () => {
  const ledger = new EpisodeLedger();
  for (const code of [255,143,1]) {
    ledger.record('telemetry',{method:'item/completed',params:{item:{id:String(code),
      type:'commandExecution',status:'failed',exitCode:code}}});
    ledger.record('event',{type:'activity',itemId:String(code),kind:'command',status:'failed'});
  }
  assert.equal(ledger.metrics().failedCalls,3);
  assert.equal(ledger.metrics().commandFailures,3);
  assert.equal(ledger.metrics().invalidCalls,undefined);
  assert.ok(ledger.snapshot().events.filter(e=>e.method==='item/completed').every(e=>e.success===false));
});

test('can passively attach to the base harness event streams', () => {
  const source = new EventEmitter();
  const ledger = new EpisodeLedger({episodeId: 'episode-4'});
  const detach = ledger.attach(source);
  source.emit('event', {type: 'turn-started', turnId: 'turn-1'});
  source.emit('telemetry', {method: 'item/completed', params: {turnId: 'turn-1', item: {id: 'item-1', type: 'dynamicToolCall', tool: 'inspect_circuit'}}});
  detach();
  source.emit('event', {type: 'turn-completed', turnId: 'turn-1', status: 'completed'});
  assert.equal(ledger.snapshot().metrics.turnCount, 1);
  assert.equal(ledger.snapshot().events.length, 2);
});
