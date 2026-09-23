'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {capabilitySnapshot, DISABLED_FEATURES, FEATURE_POLICY} = require('./codex-capabilities.cjs');

test('capability report describes the generic dynamic tool host and all disabled features', () => {
  const report = capabilitySnapshot({
    plugin:{id:'example.domain', version:'1.0.0', schema:'example/v1', signature:'abc'},
    directTools:['inspect'],
    workspaceMode:'direct',
  });
  assert.equal(report.dynamicToolHost.id, 'example.domain');
  assert.equal(report.workspace.mode, 'direct');
  assert.equal('circuitPlugin' in report, false);
  assert.deepEqual(report.disabledFeatures, DISABLED_FEATURES);
  assert.ok(report.disabledFeatures.includes('memories'));
  assert.equal(new Set(report.disabledFeatures).size, report.disabledFeatures.length);
  assert.deepEqual(report.featurePolicy, undefined);

  const detailed = capabilitySnapshot({detail:true});
  assert.equal(detailed.featurePolicy.multi_agent.state, 'disabled');
  assert.equal(detailed.featurePolicy.multi_agent.boundary, 'workspace-boundary');
  assert.deepEqual(detailed.disabledFeatures, Object.keys(FEATURE_POLICY));
});
