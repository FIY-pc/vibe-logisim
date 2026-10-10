import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createController} from '../circuit-lens/web/features/simulation-controls.js';

const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};
const flush = () => new Promise(resolve => setImmediate(resolve));
function element() {
  const attributes = new Map(), children = new Map();
  return {hidden: false, disabled: false, dataset: {}, textContent: '', childElementCount: 1,
    classList: {add() {}}, append() {}, replaceChildren() {}, matches: () => false,
    setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key),
    querySelector: selector => {if (!children.has(selector)) children.set(selector, element()); return children.get(selector);}};
}
function harness({circuit = 'B', owner = 'A', running = true, visible = false} = {}) {
  globalThis.document = {createElementNS: () => element()};
  const project = {session: {workspace: {id: 'project'}}, revision: 'revision', circuitName: circuit,
    circuitRequestEpoch: 1, circuit: {}, capabilityState: 'exact'};
  const ui = new Proxy({}, {get: (target, key) => target[key] ??= element()});
  let session = owner ? {circuit: owner, running, visible} : null;
  const calls = [], ports = {shortcutHint: () => '', shortcutLabel: () => '', captureMoment: () => false,
    simulationStatus: () => ({exists: Boolean(session), current: Boolean(session && (session.visible || session.circuit === project.circuitName)),
      circuit: session?.circuit, running: session?.running || false, automatic: session?.automatic !== false,
      visible: session?.visible || false, busy: false, ticks: 7}),
    restoreCurrentSimulationView: async () => {calls.push(['restore', project.circuitName]); session.visible = true; return true;},
    simulationAction: async (action, extra) => {
      const target = action === 'start' ? project.circuitName : session?.circuit;
      calls.push([action, target, extra]);
      if (action === 'start') {
        if (ports.startGate && !await ports.startGate.promise) return false;
        session = {circuit: target, running: false, visible: project.circuitName === target, automatic: true};
      } else if (action === 'play' || action === 'pause') session.running = action === 'play';
      else if (action === 'stop') session = null;
      else if (action === 'configure') Object.assign(session, extra);
      return true;
    }};
  const controller = createController({models: {project, canvas: {mode: 'select'}}, ui, ports});
  const navigate = name => {project.circuitName = name; project.circuitRequestEpoch++; if (session) session.visible = false;};
  return {project, ui, ports, calls, controller, navigate, session: () => session};
}

test('browsing B leaves A alone, but B commands and controls target B', async () => {
  const h = harness(); h.controller.renderSimulationControls();
  assert.deepEqual(h.calls, []); assert.equal(h.session().running, true);
  assert.equal(h.ui.simulationOwner.textContent, 'B');
  assert.equal(h.ui.simulationPlay.querySelector('span').textContent, '运行时钟');
  assert.equal(h.ui.simulationStart.hidden, false); assert.equal(h.ui.simulationStop.disabled, true);
  assert.equal(h.ui.simulationTransport.hidden, true);
  await h.controller.runSimulationCommand('toggle-clock');
  assert.deepEqual(h.calls.map(c => c.slice(0, 2)), [['start', 'B'], ['play', 'B']]);
  assert.equal(h.session().running, true);
});

test('a root revisit restores its live view, while a nested instance keeps its root run', async () => {
  const h = harness({circuit: 'A', owner: 'A', running: false});
  await h.controller.runSimulationCommand('tick');
  assert.deepEqual(h.calls.map(c => c.slice(0, 2)), [['restore', 'A'], ['tick', 'A']]);
  h.project.circuitName = 'Child'; h.project.circuitRequestEpoch++;
  // Entering a live instance retains its displayed runtime binding.
  h.session().visible = true; h.calls.length = 0;
  await h.controller.runSimulationCommand('toggle-clock');
  assert.deepEqual(h.calls.map(c => c.slice(0, 2)), [['restore', 'Child'], ['play', 'A']]);
});

test('rapid K K starts the selected circuit once, then plays and pauses it', async () => {
  const h = harness(); h.ports.startGate = deferred();
  const first = h.controller.runSimulationCommand('toggle-clock');
  const second = h.controller.runSimulationCommand('toggle-clock');
  await flush(); h.ports.startGate.resolve(true); await Promise.all([first, second]);
  assert.deepEqual(h.calls.filter(c => c[0] !== 'restore').map(c => c.slice(0, 2)), [['start', 'B'], ['play', 'B'], ['pause', 'B']]);
  assert.equal(h.session().running, false);
});

test('navigation during a slow start drops old follow-up and queued commands', async () => {
  const h = harness({circuit: 'A', owner: null}); h.ports.startGate = deferred();
  const old = h.controller.runSimulationCommand('toggle-clock'); await flush();
  const queued = h.controller.runSimulationCommand('tick'); h.navigate('B');
  const current = h.controller.runSimulationCommand('toggle-clock');
  h.ports.startGate.resolve(true); await Promise.all([old, queued, current]);
  assert.deepEqual(h.calls.map(c => c.slice(0, 2)), [['start', 'A'], ['start', 'B'], ['play', 'B']]);
});

test('leaving and returning during startup does not reuse the stale key intent', async () => {
  const h = harness({circuit: 'A', owner: null}); h.ports.startGate = deferred();
  const command = h.controller.runSimulationCommand('toggle-clock'); await flush();
  h.navigate('B'); h.navigate('A'); h.ports.startGate.resolve(true); await command;
  assert.deepEqual(h.calls.map(c => c[0]), ['start']);
  assert.equal(h.session().running, false);
});

test('a failed switch never plays the old run, and a retry still targets B', async () => {
  const h = harness(); h.ports.startGate = deferred();
  const failed = h.controller.runSimulationCommand('toggle-clock'); h.ports.startGate.resolve(false);
  assert.equal(await failed, false); assert.equal(h.session().circuit, 'A');
  delete h.ports.startGate; await h.controller.runSimulationCommand('tick');
  assert.deepEqual(h.calls.map(c => c.slice(0, 2)), [['start', 'B'], ['start', 'B'], ['tick', 'B']]);
});

test('cold propagation enables B, and loading cannot enqueue operations on A', async () => {
  const h = harness(); h.project.circuitLoading = true;
  const ignored = h.controller.runSimulationCommand('toggle-clock'); h.project.circuitLoading = false;
  assert.equal(await ignored, false); assert.deepEqual(h.calls, []);
  await h.controller.runSimulationCommand('toggle-propagation');
  assert.deepEqual(h.calls.map(c => c.slice(0, 2)), [['start', 'B']]);
  assert.equal(h.session().automatic, true);
});
