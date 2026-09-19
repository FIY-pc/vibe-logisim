'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {harnessResultEvent, previewObservation} = require('./harness-result.cjs');

test('normalizes every feedback result through binding/run even without legacy session', () => {
  const event = harnessResultEvent({
    binding: {revisionId: 'rev-1', circuit: 'main'},
    run: {id: 'verify-1', label: '项目检查', kind: 'verification'},
    result: {label: '项目检查', stdout: 'passed\n', parsed: {status: 'passed'}},
    feedback: {status: 'passed'},
  }, {itemId: 'tool-1', turnId: 'turn-1'});
  assert.deepEqual(event, {
    type: 'harness-result', itemId: 'tool-1', turnId: 'turn-1', session: null,
    binding: {revisionId: 'rev-1', circuit: 'main'},
    run: {id: 'verify-1', label: '项目检查', kind: 'verification'},
    feedback: {status: 'passed'},
    observation: {label: '项目检查', stdout: 'passed\n', parsed: {status: 'passed'}},
  });
});

test('keeps native session compatibility and bounds external output previews', () => {
  const long = 'x'.repeat(5000);
  const event = harnessResultEvent({
    session: {id: 'native-1', revisionId: 'rev-1', circuit: 'main'},
    feedback: {status: 'failed'},
    result: {stderr: long},
  });
  assert.equal(event.binding, event.session);
  assert.equal(event.observation.stderr.length, 4096 + '\n…(结果预览已截断)'.length);
  assert.equal(previewObservation(null), null);
});

test('does not emit a harness event for ordinary tool results', () => {
  assert.equal(harnessResultEvent({result: {ok: true}}), null);
});
