'use strict';

// Production folder -> plugin -> native runtime. No model calls or UI claims.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {LensBackend} = require('../electron/backend.cjs');
const {DesktopWorkspace} = require('../electron/desktop-workspace.cjs');
const {DirectAgentWorkspace} = require('../electron/direct-agent-workspace.cjs');
const {CircuitPlugin} = require('../electron/circuit-plugin.cjs');

async function main() {
  const repo = path.resolve(__dirname, '../../..');
  const {requireSamples} = require('./support/samples.cjs');
  requireSamples(repo, 'experiments/007-local-rerouting/results/2026-09-21-model-1.11/final.circ');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-file-vectors-'));
  const folder = path.join(root, 'folder');
  fs.mkdirSync(path.join(folder, 'circuits'), {recursive:true});
  fs.mkdirSync(path.join(folder, 'checks'));
  const source = path.join(folder, 'circuits/design.circ');
  const original = fs.readFileSync(path.join(repo,
    'experiments/007-local-rerouting/results/2026-09-21-model-1.11/final.circ'));
  fs.writeFileSync(source, original);
  const vectors = [];
  for (let a=0; a<256; a++) for (let b=0; b<256; b++) {
    const sum=(a<128?a:a-256)+(b<128?b:b-256);
    vectors.push({inputs:{A:a,B:b}, expected:{Y:Math.max(-128,Math.min(127,sum))&255,
      OVF:sum < -128 || sum > 127 ? 1 : 0}});
  }
  const file = path.join(folder, 'checks/all-inputs.json');
  const bytes = Buffer.from(JSON.stringify(vectors));
  const digest = data => crypto.createHash('sha256').update(data).digest('hex');
  fs.writeFileSync(file, bytes);
  const lens = new LensBackend({repoRoot:repo, stateDir:path.join(root,'lens')});
  const desktop = new DesktopWorkspace({stateRoot:path.join(root,'host'),backend:lens});
  try {
    await lens.start();
    await desktop.open(folder,{activeFile:source});
    const initial = await lens.session();
    const workspace = new DirectAgentWorkspace(desktop);
    const work = await workspace.prepare(initial.revision.id);
    const plugin = new CircuitPlugin({workspace,invoke:payload=>lens.circuitTool(payload)});
    plugin.configure(await lens.circuitPlugin());
    const pending = {work,projectId:initial.workspace.id,revisionId:initial.revision.id};
    const scope = {pending,assertCurrent(){},emit(){},updateBinding(session){
      pending.projectId=session.workspace.id;pending.revisionId=session.revision.id;
    }};
    const call = args => plugin.call({tool:'simulate_circuit',arguments:{circuit:'SatAdd8',...args},
      threadId:'file-input',turnId:'one',callId:'simulate'},scope);
    const start = performance.now();
    const report = await call({vectorsFile:'checks/all-inputs.json'});
    const elapsedMs = performance.now()-start;
    assert.equal(report.passed,65536);
    assert.equal(report.failed,0);
    assert.equal(report.unchecked,0);
    assert.equal(report.feedback.status,'passed');
    assert.equal(report.feedback.rowCount,65536);
    assert.equal(report.vectorsFile.sha256,digest(bytes));
    assert.equal(report.vectorsFile.path,'checks/all-inputs.json');
    assert.equal(report.execution.artifactSha256,digest(original));
    assert.ok(report.rows.length<=32);
    assert.ok(Buffer.byteLength(JSON.stringify(report))<20000);

    // A late counterexample must survive sampling; changing the file changes
    // its identity and stimulus while leaving the circuit itself untouched.
    vectors[50000].expected.Y ^= 1;
    fs.writeFileSync(file,JSON.stringify(vectors));
    const failed = await call({vectorsFile:'checks/all-inputs.json'});
    assert.equal(failed.passed,65535);
    assert.equal(failed.failed,1);
    assert.equal(failed.feedback.status,'failed');
    assert.ok(failed.rows.some(row=>row.index===50000&&row.passed===false));
    assert.notEqual(failed.vectorsFile.sha256,report.vectorsFile.sha256);
    assert.notEqual(failed.stimulusSha256,report.stimulusSha256);
    await assert.rejects(call({vectorsFile:'checks/all-inputs.json',vectors:[vectors[0]]}),/只能提供一个/);
    fs.writeFileSync(path.join(root,'outside.json'),'[]');
    await assert.rejects(call({vectorsFile:'../outside.json'}));
    fs.symlinkSync(path.join(root,'outside.json'),path.join(folder,'escape.json'));
    await assert.rejects(call({vectorsFile:'escape.json'}));
    assert.ok(fs.readFileSync(source).equals(original));
    assert.equal((await lens.session()).revision.id,initial.revision.id);
    console.log(JSON.stringify({plugin:plugin.registry.identity.version,elapsedMs,
      vectors:report.rowCount,passed:report.passed,nativeDurationMs:report.durationMs,
      outputBytes:Buffer.byteLength(JSON.stringify(report)),sampledRows:report.rows.length,
      vectorsFile:report.vectorsFile,execution:report.execution,
      lateCounterexample:failed.rows.find(row=>row.index===50000),
      sourceAndRevisionUnchanged:true,folderBoundaryChecked:true,modelCalls:0},null,2));
  } finally {
    desktop.folder.close();
    await desktop.queue.catch(()=>{});
    await lens.stop();
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
