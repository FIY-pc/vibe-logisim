'use strict';

// Real two-JAR / localhost Studio / production plugin / event / ledger chain.
// No Codex process, model response, account configuration or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const {LensBackend} = require('../electron/backend.cjs');
const {DesktopWorkspace} = require('../electron/desktop-workspace.cjs');
const {DirectAgentWorkspace} = require('../electron/direct-agent-workspace.cjs');
const {CircuitPlugin} = require('../electron/circuit-plugin.cjs');
const {EpisodeLedger, digest} = require('../electron/episode-ledger.cjs');

const repo = path.resolve(__dirname, '../../..');
const runtimes = [
  ['2.16.2.2', 'apps/desktop/circuit-lens/native/Logisim-ITA.jar'],
  ['2.15.0', 'workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe'],
];

function fixture(version) {
  // Enable=0 settles the feedback NAND; a later rising input oscillates,
  // while Stable remains 0. Floating stays undefined. Buffer is an unused
  // synthesis target. All expectations are explicit test inputs.
  return `<project source="${version}" version="1.0">
    <lib name="0" desc="#Wiring"/><lib name="1" desc="#Gates"/><main name="main"/>
    <options><a name="simlimit" val="32"/></options><circuit name="main">
      <comp name="Pin" lib="0" loc="(100,80)"><a name="label" val="Enable"/></comp>
      <comp name="NAND Gate" lib="1" loc="(200,100)"><a name="inputs" val="2"/><a name="size" val="50"/></comp>
      <comp name="Constant" lib="0" loc="(350,200)"><a name="value" val="0x0"/></comp>
      <comp name="Pin" lib="0" loc="(400,200)"><a name="label" val="Stable"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
      <comp name="Pin" lib="0" loc="(400,300)"><a name="label" val="Floating"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
      <wire from="(100,80)" to="(150,80)"/><wire from="(200,100)" to="(220,100)"/>
      <wire from="(220,100)" to="(220,160)"/><wire from="(220,160)" to="(120,160)"/>
      <wire from="(120,160)" to="(120,120)"/><wire from="(120,120)" to="(150,120)"/>
      <wire from="(350,200)" to="(400,200)"/>
    </circuit><circuit name="Buffer">
      <comp name="Pin" lib="0" loc="(100,100)"><a name="label" val="In"/></comp>
      <comp name="Pin" lib="0" loc="(300,100)"><a name="label" val="Out"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
    </circuit></project>`;
}

async function verifyRuntime(root, version, jar) {
  const directory = path.join(root, version);
  const folder = path.join(directory, 'folder');
  fs.mkdirSync(folder, {recursive: true});
  const source = path.join(folder, 'test.circ');
  const original = Buffer.from(fixture(version));
  fs.writeFileSync(source, original);
  const sourceSha256 = digest(original);
  const runtimeJarSha256 = createHash('sha256').update(fs.readFileSync(path.join(repo, jar))).digest('hex');
  const lens = new LensBackend({repoRoot: repo, stateDir: path.join(directory, 'lens')});
  const desktop = new DesktopWorkspace({stateRoot: path.join(directory, 'host'), backend: lens});
  const evidence = [];
  try {
    await lens.start();
    assert.equal(new URL(lens.baseUrl).hostname, '127.0.0.1');
    await desktop.open(folder, {activeFile: source});
    const initial = await lens.session();
    const workspace = new DirectAgentWorkspace(desktop);
    const work = await workspace.prepare(initial.revision.id);
    const history = structuredClone(desktop.history.list());
    const plugin = new CircuitPlugin({workspace, invoke: payload => lens.circuitTool(payload)});
    plugin.configure(await lens.circuitPlugin());
    const pending = {work, projectId: initial.workspace.id, revisionId: initial.revision.id};
    const transport = new EventEmitter();
    const scope = {pending, assertCurrent() {}, emit: event => transport.emit('event', event),
      updateBinding(session) { pending.projectId = session.workspace.id; pending.revisionId = session.revision.id; }};
    let callIndex = 0;
    const invoke = (tool, args) => {
      const id = `call-${++callIndex}`;
      return plugin.call({tool, arguments: args, threadId: 'local-replay', turnId: version,
        callId: id, itemId: id}, scope);
    };
    async function observe(name, tool, args, status, artifactSha256 = sourceSha256) {
      const ledger = new EpisodeLedger({episodeId: `${version}-${name}`, taskId: 'native-evidence'});
      const events = [];
      const capture = event => events.push({at: Date.now(), event});
      transport.on('event', capture);
      const detach = ledger.attach(transport);
      let result;
      try { result = await invoke(tool, args); }
      finally { detach(); transport.off('event', capture); }
      const entry = {name, result, events, episode: ledger.snapshot()};
      evidence.push(entry);
      const save = () => fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
      save(); // Preserve actual facts even when an acceptance assertion fails.
      const raw = result.result || result;
      assert.equal(events.length, 1, 'one execution must produce one evidence event');
      const event = events[0].event;
      assert.equal(event.type, 'harness-result');
      assert.equal(event.itemId, result.invocation.callId);
      assert.equal(event.turnId, version);
      assert.equal(result.feedback.status, status, name);
      assert.deepEqual(event.feedback, result.feedback);
      assert.deepEqual(event.binding, result.binding);
      assert.deepEqual(event.run, result.run);
      assert.equal(result.run.id, raw.runId, 'use the actual native run ID');
      assert.match(raw.runId, /^run-/);
      assert.equal(result.run.stimulusSha256, raw.stimulusSha256);
      assert.equal(result.run.runtimeProfileId, raw.runtimeProfileId);
      assert.equal(raw.execution.runtimeJarSha256, runtimeJarSha256);
      assert.equal(raw.execution.artifactSha256, artifactSha256);
      assert.equal(result.binding.projectId, initial.workspace.id);
      assert.equal(result.binding.revisionId, initial.revision.id);
      assert.equal(result.binding.candidateId, args.candidateId || null);
      assert.equal(result.binding.artifactSha256, artifactSha256);
      assert.equal(result.binding.runtimeProfile.runtimeJarSha256, runtimeJarSha256);
      assert.equal(result.binding.runtimeProfile.status, 'observed');
      // Check the retained complete observation, not just its summary or the
      // bounded rows returned over HTTP. Candidates have their own checks.
      const nativeFile = args.candidateId
        ? path.join(directory, 'lens', 'candidates', args.candidateId, 'candidate.json')
        : path.join(directory, 'lens', 'revisions', initial.revision.id, 'observations', raw.id + '.json');
      const retained = JSON.parse(fs.readFileSync(nativeFile, 'utf8'));
      const native = args.candidateId ? retained.checks.find(check => check.runId === raw.runId) : retained;
      assert.equal(native.runId, result.run.id);
      assert.deepEqual(native.execution, raw.execution);
      assert.equal(native.rows.length, result.run.rowCount);
      assert.ok(native.rows.every(row => typeof row.oscillating === 'boolean'));
      if (native.run.kind === 'simulate') {
        assert.equal(native.rows.length, args.vectors.length);
        for (const row of native.rows) {
          if (row.oscillating) assert.notEqual(row.passed, true);
          if (status === 'passed') {
            assert.equal(row.oscillating, false);
            assert.ok(row.expected && Object.keys(row.expected).length > 0);
            for (const [signal, value] of Object.entries(row.expected)) assert.equal(row.outputs[signal], value);
          }
        }
      }
      entry.nativeObservation = path.relative(directory, nativeFile);
      const metrics = ledger.metrics();
      assert.equal(metrics.observedPassedFeedback, status === 'passed');
      assert.equal(metrics.verificationCount, ['passed', 'failed'].includes(status) ? 1 : 0);
      assert.ok(metrics.timeToFirstGroundedEvidenceMs >= 0 && metrics.timeToFirstGroundedEvidenceMs !== null);
      assert.equal(metrics.taskSuccess, null, 'these observations are not a task oracle');
      assert.equal(ledger.snapshot().events[0].run.id, raw.runId);
      // Replay the actual JSON event payload, with its recorded timestamp.
      const replay = new EpisodeLedger();
      replay.startedAt = ledger.startedAt;
      const serialized = JSON.parse(JSON.stringify(events));
      for (const entry of serialized) replay.record('event', entry.event, entry.at);
      assert.equal(replay.metrics().observedPassedFeedback, metrics.observedPassedFeedback);
      assert.equal(replay.metrics().verificationCount, metrics.verificationCount);
      assert.equal(replay.metrics().timeToFirstGroundedEvidenceMs, events[0].at - ledger.startedAt);
      const stored = JSON.stringify(ledger.snapshot());
      assert.ok(!stored.includes('"outputs"') && !stored.includes('"expected"'), 'ledger stores metadata only');
      entry.replay = replay.snapshot();
      save();
      return result;
    }
    const vector = expected => ({inputs: {Enable: 0}, expected});
    const simulate = vectors => ({circuit: 'main', vectors});
    await observe('settled-match', 'simulate_circuit', simulate([vector({Stable: 0})]), 'passed');
    await observe('settled-mismatch', 'simulate_circuit', simulate([vector({Stable: 1})]), 'failed');
    const unknown = await observe('undefined', 'simulate_circuit', simulate([vector({Floating: 0})]), 'unknown');
    assert.equal(unknown.feedback.firstUnknown.reason, 'undefined-signal');
    assert.equal(unknown.rows[0].outputs.Floating, null);
    await observe('empty-expectation', 'simulate_circuit', simulate([vector({})]), 'observed');
    await observe('omitted-expectation', 'simulate_circuit', simulate([{inputs: {Enable: 0}}]), 'observed');
    const many = Array.from({length: 40}, () => vector({Stable: 0}));
    const batch = await observe('sampled-pass', 'simulate_circuit', simulate(many), 'passed');
    assert.equal(batch.rowsTruncated, true);
    assert.equal(batch.rows.length, 8);
    assert.equal(batch.feedback.checkedCount, 40);
    assert.equal(batch.run.rowCount, 40);
    await observe('sampled-incomplete', 'simulate_circuit', simulate([...many, vector({})]), 'observed');
    const batchUnknown = await observe('sampled-unknown', 'simulate_circuit', simulate([...many, vector({Floating: 0})]), 'unknown');
    assert.equal(batchUnknown.feedback.firstUnknown.rowIndex, 40);
    const batchFailed = await observe('sampled-failure', 'simulate_circuit', simulate([...many, vector({Stable: 1})]), 'failed');
    assert.equal(batchFailed.feedback.firstFailure.rowIndex, 40);
    await observe('harness-pass', 'harness_run', {...simulate([vector({Stable: 0})]), mode: 'simulate'}, 'passed');
    await observe('evaluate-pass', 'evaluate_circuit', {...simulate([vector({Stable: 0})]), mode: 'simulate'}, 'passed');
    const inspected = await invoke('inspect_circuit', {circuit: 'main'});
    const stable = inspected.components.find(component => component.label === 'Stable');
    const trace = {circuit: 'main', ticks: 2, inputs: {Enable: 0},
      watches: [{name: 'Stable', component: stable.componentId, port: 0}]};
    await observe('trace-observation', 'trace_circuit', trace, 'observed');
    const paged = await observe('paged-oscillation', 'trace_circuit', {...trace, rowLimit: 1,
      inputEvents: [{tick: 1, name: 'Enable', value: 1}]}, 'unknown');
    assert.equal(paged.rows.length, 1);
    assert.equal(paged.rows[0].oscillating, false, 'the displayed page excludes the unsettled sample');
    assert.equal(paged.feedback.firstUnknown.tick, 1);
    const oscillating = await observe('oscillating-evaluation', 'evaluate_circuit', {...trace, mode: 'trace',
      inputEvents: [{tick: 1, name: 'Enable', value: 1}],
      expectedRows: [{tick: 1, values: {Stable: 0}}]}, 'unknown');
    assert.equal(oscillating.result.rows[1].values.Stable, 0);
    assert.equal(oscillating.result.rows[1].oscillating, true);
    assert.equal(oscillating.feedback.firstUnknown.reason, 'oscillating');
    await observe('trace-evaluation', 'evaluate_circuit', {...trace, mode: 'trace',
      expectedRows: [{tick: 0, values: {Stable: 0}}]}, 'passed');
    const candidate = await invoke('build_candidate', {title: 'Generic buffer',
      modules: [{circuit: 'Buffer', expressions: {Out: 'In'}}]});
    assert.notEqual(candidate.artifactSha256, sourceSha256);
    await observe('candidate-pass', 'simulate_circuit', {circuit: 'Buffer', candidateId: candidate.id,
      vectors: [{inputs: {In: 0}, expected: {Out: 0}}, {inputs: {In: 1}, expected: {Out: 1}}]},
    'passed', candidate.artifactSha256);
    await workspace.finish(work, {isCurrent: () => true});
    const final = await lens.session();
    assert.ok(fs.readFileSync(source).equals(original));
    assert.deepEqual(final.workspace, initial.workspace, 'project, save and structural history unchanged');
    assert.equal(final.revision.id, initial.revision.id);
    assert.deepEqual(desktop.history.list(), history, 'no file history from stimuli');
    return {version, runtimeJarSha256, sourceSha256, cases: evidence.map(entry => ({
      name: entry.name, status: entry.result.feedback.status,
      runId: entry.result.run.id, metrics: entry.episode.metrics,
    })), sourceAndHistoryUnchanged: true};
  } finally {
    desktop.folder.close();
    await desktop.queue.catch(() => {});
    await lens.stop();
  }
}

async function main() {
  const persistent = process.argv[2];
  const root = persistent ? path.resolve(persistent) : fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-simulation-evidence-'));
  if (persistent) fs.mkdirSync(root); // Refuse to overwrite prior evidence.
  try {
    const results = [];
    for (const [version, jar] of runtimes) results.push(await verifyRuntime(root, version, jar));
    const summary = {modelCalls: 0, localhost: true, eventReplay: true, results};
    fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ok: true, runtimes: results.map(r => r.version),
      casesPerRuntime: results.map(r => r.cases.length), evidence: persistent ? root : 'temporary (removed)'}));
  } finally {
    if (!persistent) fs.rmSync(root, {recursive: true, force: true});
  }
}
main().catch(error => {console.error(error.stack); process.exitCode = 1;});
