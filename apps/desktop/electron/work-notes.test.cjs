'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {buildWorkspaceIndex}=require('./workspace-index.cjs');
const {CircuitContextProvider}=require('./circuit-context-host.cjs');

test('resume receives current note bytes as untrusted data without inventing review status',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-work-note-'));
  try {
    assert.equal(buildWorkspaceIndex({root}).workNotes,null);
    const file=path.join(root,'CIRCUIT-WORK.md');
    fs.writeFileSync(file,'Child: behavior checked at old SHA; layout still pending.\n');
    const first=buildWorkspaceIndex({root});
    fs.writeFileSync(file,'Child: source changed; behavior and diagram need recheck.\n');
    const current=buildWorkspaceIndex({root});
    assert.notEqual(first.workNotes.sha256,current.workNotes.sha256);
    assert.equal(current.workNotes.text,fs.readFileSync(file,'utf8'));
    assert.equal(current.workNotes.sha256,createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    const provider=new CircuitContextProvider();
    const context=provider.additionalContext(provider.prepare({}),{cwd:root,workspaceIndex:current});
    const item=context['vibe-logisim.workspace-index'];
    assert.equal(item.kind,'untrusted');
    assert.deepEqual(JSON.parse(item.value).workNotes,current.workNotes);
    assert.equal(current.workNotes.completed,undefined);
    assert.equal(current.workNotes.verified,undefined);
    fs.writeFileSync(file,'x'.repeat(20000));
    const large=buildWorkspaceIndex({root}).workNotes;
    assert.equal(large.truncated,true);assert.equal(large.sha256,null);
    assert.ok(Buffer.byteLength(large.text)<=12*1024);
    fs.unlinkSync(file);fs.symlinkSync(path.join(root,'outside.txt'),file);
    fs.writeFileSync(path.join(root,'outside.txt'),'DO_NOT_INJECT');
    assert.equal(buildWorkspaceIndex({root}).workNotes.status,'unavailable');
    assert.ok(!JSON.stringify(buildWorkspaceIndex({root}).workNotes).includes('DO_NOT_INJECT'));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
