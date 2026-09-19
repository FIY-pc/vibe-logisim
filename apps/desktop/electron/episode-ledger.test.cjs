'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {EventEmitter} = require('node:events');
const {EpisodeLedger, digest} = require('./episode-ledger.cjs');

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
  assert.equal(snapshot.schema, 'vibe-logisim.episode/v1');
  assert.equal(snapshot.metrics.taskSuccess, true);
  assert.equal(snapshot.metrics.toolCalls, 2);
  assert.equal(snapshot.metrics.circuitToolCalls, 2);
  assert.equal(snapshot.metrics.invalidCalls, 1);
  assert.equal(snapshot.metrics.recoveryCalls, 1);
  assert.equal(snapshot.metrics.verificationCount, 1);
  assert.equal(snapshot.metrics.claimEvidenceAlignment, 'not-assessed');
  assert.equal(snapshot.metrics.positiveClaimHeuristic, true);
  assert.equal(snapshot.metrics.artifactChanges, true);
  assert.equal(snapshot.events.find(item => item.type === 'user-message').text.chars, 5);
  assert.equal(snapshot.events.find(item => item.type === 'user-message').text.value, undefined);
  assert.deepEqual(snapshot.metadata, {replicate: 1});
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
  assert.equal(ledger.metrics().recoveryCalls,0);
});

test('reports artifact correctness, conversation completion and native observations separately', () => {
  const ledger = new EpisodeLedger();
  ledger.record('event',{type:'activity',itemId:'edit',kind:'file',status:'completed'});
  ledger.record('event',{type:'activity',itemId:'sim',kind:'tool',activityKey:'circuit:simulate_circuit',status:'completed'});
  ledger.record('event',{type:'activity',itemId:'shell',kind:'command',status:'failed'});
  ledger.finalize({outcome:'timeout',oracle:{status:'passed'}});
  const metrics=ledger.metrics();
  assert.equal(metrics.taskSuccess,true);
  assert.equal(metrics.completedAndVerified,false);
  assert.equal(metrics.fileChangeEvents,1);
  assert.equal(metrics.toolCalls,2);
  assert.equal(metrics.nativeRunCalls,1);
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
