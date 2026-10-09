'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {RuntimeInstaller}=require('./runtime-installer.cjs');
const {CodexBackend}=require('./codex-backend.cjs');
const {AgentRuntime}=require('./agent-runtime.cjs');
const python=process.env.VIBE_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const archive=path.join(root,'fixture.tar.gz');
 execFileSync(python,['-c',`import tarfile,io,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 for name in ['bin/codex','bin/codex-code-mode-host']:
  v=tarfile.TarInfo(name);v.size=4;v.mode=0o755;t.addfile(v,io.BytesIO(b'test'))`,archive]);
 const bytes=fs.readFileSync(archive);let mode='good',requests=0,extracts=0;
 const server=http.createServer((req,res)=>{requests++;if(mode==='fail'){res.writeHead(503);res.end();return;}
  res.writeHead(200,{'content-length':bytes.length});
  if(mode==='slow')res.write(bytes.subarray(0,8));else res.end(mode==='corrupt'?Buffer.alloc(bytes.length):bytes);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const opts={spec:{url:`http://127.0.0.1:${server.address().port}/runtime`,sha256:createHash('sha256').update(bytes).digest('hex'),version:'fixture',programs:['bin/codex','bin/codex-code-mode-host']},directory:path.join(root,'runtimes','codex'),python};
 const installer=new RuntimeInstaller(opts),extract=installer.extract;installer.extract=(...args)=>{extracts++;return extract(...args);};
 t.after(()=>installer.cancel());
 return {root,opts,installer,setMode:v=>{mode=v;},stats:()=>({requests,extracts})};
}
async function waitFor(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('state did not arrive');}
test('verified install is atomic, coalesces requests, and restarts without a download',async t=>{
 const f=await fixture(t),events=[];f.installer.on('change',s=>events.push(s.phase));
 const a=f.installer.ensure(),b=f.installer.ensure();assert.equal(a,b);await a;
 assert.equal(f.installer.ready(),true);assert.deepEqual(f.stats(),{requests:1,extracts:1});
 assert.ok(events.includes('verifying'));assert.ok(events.includes('extracting'));
 await new RuntimeInstaller({...f.opts,fetch:()=>{throw new Error('must be offline');}}).ensure();
 assert.deepEqual(fs.readdirSync(path.dirname(f.opts.directory)),['codex']);
 // Replace a damaged managed copy only after a complete, verified download.
 fs.unlinkSync(path.join(f.opts.directory,'bin/codex'));await f.installer.ensure();assert.equal(f.installer.ready(),true);
});
test('HTTP and checksum failures preserve previous files, clean staging, and allow retry',async t=>{
 const f=await fixture(t);fs.mkdirSync(f.opts.directory,{recursive:true});fs.writeFileSync(path.join(f.opts.directory,'keep'),'previous');
 for(const [mode,error]of [['fail',/HTTP 503/],['corrupt',/校验失败/]]){
  f.setMode(mode);await assert.rejects(f.installer.ensure(),error);assert.equal(f.installer.snapshot().phase,'error');
  assert.equal(fs.readFileSync(path.join(f.opts.directory,'keep'),'utf8'),'previous');assert.deepEqual(fs.readdirSync(path.dirname(f.opts.directory)),['codex']);
 }
 assert.equal(f.stats().extracts,0);f.setMode('good');await f.installer.ensure();assert.equal(f.installer.ready(),true);
});
test('cancel interrupts a stalled stream and permits retry',async t=>{
 const f=await fixture(t);f.setMode('slow');const p=f.installer.ensure();const rejected=assert.rejects(p,/已取消/);
 await waitFor(()=>f.installer.snapshot().received>0);await f.installer.cancel();await rejected;
 assert.equal(f.installer.snapshot().phase,'cancelled');assert.equal(f.installer.ready(),false);assert.deepEqual(fs.readdirSync(path.dirname(f.opts.directory)),[]);
 f.setMode('good');await f.installer.ensure();assert.equal(f.installer.ready(),true);
});
test('extraction failure does not publish a runtime or leave staging',async t=>{
 const f=await fixture(t);f.installer.extract=async()=>{throw new Error('disk full');};await assert.rejects(f.installer.ensure(),/disk full/);
 assert.equal(f.installer.ready(),false);assert.deepEqual(fs.readdirSync(path.dirname(f.opts.directory)),[]);
});
test('extractor refuses traversal and symlink entries',async t=>{
 const f=await fixture(t);
 for(const kind of ['traversal','link']){
  const archive=path.join(f.root,kind+'.tar');execFileSync(python,['-c',`import tarfile,sys
with tarfile.open(sys.argv[1],'w') as t:
 v=tarfile.TarInfo('../escaped' if sys.argv[2]=='traversal' else 'link')
 if sys.argv[2]=='link':v.type=tarfile.SYMTYPE;v.linkname='../escaped'
 t.addfile(v)`,archive,kind]);
  await assert.rejects(f.installer.extract(archive,path.join(f.root,'target'),new AbortController().signal));assert.equal(fs.existsSync(path.join(f.root,'escaped')),false);
 }
});
test('stopping during network resolution cannot spawn a late Codex process',async t=>{
 const f=await fixture(t);await f.installer.ensure();let resolve;
 const backend=new CodexBackend({workDir:f.root,runtimeRoot:f.root,profileDir:path.join(f.root,'profile'),runtimeInstaller:f.installer,codex:'must-not-spawn'});
 backend.resolveNetwork=()=>new Promise(r=>{resolve=r;});
 const start=backend.start(),rejected=assert.rejects(start,/启动已取消/);await waitFor(()=>resolve);await backend.stop();resolve({});await rejected;assert.equal(backend.child,null);
});
test('old Codex history is visible during a download and switching to built-in cancels it',async t=>{
 const f=await fixture(t);f.setMode('slow');
 const runtime=new AgentRuntime({workDir:f.root,runtimeRoot:f.root,profileDir:path.join(f.root,'profile'),sessionStorePath:path.join(f.root,'sessions.json'),runtimeInstaller:f.installer});t.after(()=>runtime.stop());
 const saved=runtime.store.ensure('workspace');runtime.store.runtimeData('workspace',{runtime:'codex'},saved.id);
 runtime.store.runtimeData('workspace',{threadId:'old-thread',messages:[{type:'user',text:'retained history'}]},saved.id);
 await runtime.resumeWorkspace({workspaceKey:'workspace'});assert.ok(runtime.snapshot().messages.some(m=>m.text==='retained history'));
 assert.equal(runtime.snapshot().busy,false);await waitFor(()=>f.installer.snapshot().received>0);
 await runtime.newRuntimeConversation('builtin');assert.equal(runtime.snapshot().runtime,'builtin');assert.equal(f.installer.snapshot().phase,'cancelled');
 assert.ok(runtime.store.state('workspace').conversations.some(c=>c.id===saved.id));
});
test('restart removes only abandoned staging for the pinned runtime',async t=>{
 const f=await fixture(t),parent=path.dirname(f.opts.directory),abandoned=path.join(parent,f.installer.stagingPrefix+'interrupted');
 fs.mkdirSync(abandoned,{recursive:true});fs.writeFileSync(path.join(abandoned,'partial'),'partial bytes');
 const other=path.join(parent,'unrelated');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'keep'),'keep');
 await f.installer.ensure();assert.equal(fs.existsSync(abandoned),false);assert.equal(fs.readFileSync(path.join(other,'keep'),'utf8'),'keep');
 fs.mkdirSync(abandoned);await new RuntimeInstaller({...f.opts,fetch:()=>{throw new Error('unexpected download');}}).ensure();assert.equal(fs.existsSync(abandoned),false);
});
