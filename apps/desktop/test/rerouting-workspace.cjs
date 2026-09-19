'use strict';

// Production host/plugin/Studio chain, actual files and native runtime.
// No model or simulated native response; this is not a mouse/UI acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LensBackend} = require('../electron/backend.cjs');
const {DesktopWorkspace} = require('../electron/desktop-workspace.cjs');
const {DirectAgentWorkspace} = require('../electron/direct-agent-workspace.cjs');
const {CircuitPlugin} = require('../electron/circuit-plugin.cjs');

async function main() {
  const repo = path.resolve(__dirname, '../../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rerouting-workspace-'));
  const folder = path.join(root, 'folder');
  fs.mkdirSync(folder);
  const artifact = path.join(folder, 'design.circ');
  const original = Buffer.from(`<project source="2.16.2.2" version="1.0">
    <lib desc="#Wiring" name="0"/><main name="main"/><circuit name="main">
      <comp lib="0" name="Pin" loc="(80,100)"><a name="label" val="a"/></comp>
      <comp lib="0" name="Pin" loc="(400,100)"><a name="label" val="b"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
      <wire from="(80,100)" to="(80,200)"/><wire from="(80,200)" to="(400,200)"/><wire from="(400,200)" to="(400,100)"/>
    </circuit></project>`);
  fs.writeFileSync(artifact, original);
  fs.writeFileSync(path.join(folder, 'notes.md'), 'User reference file.');
  const lens = new LensBackend({repoRoot: repo, stateDir: path.join(root, 'lens')});
  const desktop = new DesktopWorkspace({stateRoot: path.join(root, 'host'), backend: lens});
  try {
    await lens.start();
    await desktop.open(folder, {activeFile: artifact});
    const initial = await lens.session();
    const workspace = new DirectAgentWorkspace(desktop);
    const work = await workspace.prepare(initial.revision.id);
    const plugin = new CircuitPlugin({workspace, invoke: payload => lens.circuitTool(payload)});
    plugin.configure(await lens.circuitPlugin());
    const pending = {work, projectId: initial.workspace.id, revisionId: initial.revision.id};
    const events = [];
    const scope = {pending, assertCurrent() {}, emit: e => events.push(e),
      updateBinding(session) { pending.projectId = session.workspace.id; pending.revisionId = session.revision.id; }};
    const invoke = (tool, args) => plugin.call({tool, arguments: args, threadId: 'test', turnId: 'test', callId: tool}, scope);
    const read = await invoke('inspect_circuit', {circuit: 'main', includeWires: true});
    const candidate = await invoke('reroute_candidate', {circuit: 'main', artifactSha256: read.artifactSha256,
      wireIds: read.wireGeometry.wires.map(w => w.wireId)});
    assert.ok(fs.readFileSync(artifact).equals(original));
    assert.ok(events.some(e => e.type === 'candidate-ready' && e.candidateId === candidate.id));
    await invoke('checkout_candidate', {candidateId: candidate.id});
    assert.ok(!fs.readFileSync(artifact).equals(original));
    assert.equal(pending.projectId, initial.workspace.id, 'document identity remains stable');
    const result = await invoke('simulate_circuit', {circuit: 'main', vectors: [
      {inputs: {a: 0}, expected: {b: 0}}, {inputs: {a: 1}, expected: {b: 1}},
    ]});
    assert.equal(result.passed, 2);
    const rendered = await invoke('render_circuit', {circuit: 'main'});
    assert.equal(rendered.binding.artifactSha256, candidate.artifactSha256);
    assert.equal(rendered.modelContentItems.length, 1);
    await workspace.finish(work, {isCurrent: () => true});
    const entry = desktop.history.list().find(e => e.files.some(f => f.path === 'design.circ'));
    assert.ok(entry, 'applied proposal has normal file history');
    await desktop.run(async () => { desktop.history.undo(entry.id); await desktop.refresh(); });
    assert.ok(fs.readFileSync(artifact).equals(original), 'file undo restores the original circuit');
    assert.equal((await lens.session()).revision.id, initial.revision.id);
    assert.equal(fs.readFileSync(path.join(folder, 'notes.md'), 'utf8'), 'User reference file.');
    console.log(JSON.stringify({checkout: true, nativePropagation: '2/2', imageBoundToAppliedFile: true,
      sourceUntouchedUntilCheckout: true, historyUndo: true, otherFilesPreserved: true}));
  } finally {
    desktop.folder.close();
    await desktop.queue.catch(() => {});
    await lens.stop();
    fs.rmSync(root, {recursive: true, force: true});
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
