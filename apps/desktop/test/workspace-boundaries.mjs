import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose } from '../circuit-lens/web/core/composition.js';
import { createRequestScope } from '../circuit-lens/web/core/request-scope.js';

test('composition exposes declared state only and validates all action edges before mounting', () => {
  const models = { project: {}, agent: {} };
  const feature = { modelDependencies: ['project'], dependencies: ['run'], createController({ models: received, ports }) {
    assert.deepEqual(Object.keys(received), ['project']);
    assert.equal(received.project, models.project);
    assert.equal(Object.isFrozen(received), true);
    return { inspect: () => ports.run() };
  } };
  assert.throws(() => compose({ feature }, { models }), /缺少动作：run/);
  assert.throws(() => compose({ feature }, { models: {} }), /缺少状态：project/);
  const runtime = { modelDependencies: [], createController: () => ({ run: () => 'observation' }) };
  assert.equal(compose({ feature, runtime }, { models }).feature.inspect(), 'observation');
});

test('late responses cannot override a newer request, project, or revision', () => {
  const project = { session: { workspace: { id: 'a' } }, revision: 'same-content' };
  const requests = createRequestScope(project);
  const old = requests.begin();
  const current = requests.begin();
  assert.equal(old(), false);
  assert.equal(current(), true);
  project.session.workspace.id = 'b';
  assert.equal(current(), false);
  const onB = requests.begin();
  project.revision = 'edited';
  assert.equal(onB(), false);
});
