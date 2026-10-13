'use strict';
// Run protocol, persistence and tool fixtures against the shipped SDK, outside
// the checkout so Node cannot fall back to the developer's node_modules.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {bundle}=require('./bundle-sdk.cjs');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vibe-bundled-sdk-')),app=path.join(root,'app'),desktop=path.resolve(__dirname,'../../apps/desktop');
 try {
  await fs.cp(path.join(desktop,'electron'),path.join(app,'electron'),{recursive:true});
  await fs.cp(path.join(desktop,'circuit-knowledge'),path.join(app,'circuit-knowledge'),{recursive:true});
  await fs.cp(path.resolve(desktop,'../../packages/agent-runtime/core'),path.join(app,'runtime/core'),{recursive:true});
  await fs.cp(path.resolve(desktop,'../../packages/agent-runtime/circuit-knowledge'),path.join(app,'runtime/circuit-knowledge'),{recursive:true});
  await fs.cp(path.join(desktop,'test/support'),path.join(app,'test/support'),{recursive:true});
  await fs.mkdir(path.join(app,'circuit-lens/studio/domain'),{recursive:true});
  await fs.copyFile(path.join(desktop,'circuit-lens/studio/domain/circuit-plugin.json'),path.join(app,'circuit-lens/studio/domain/circuit-plugin.json'));
  await bundle(app);
  // Both the shared backend's local import and the old public SDK entry must
  // reach the same bundled module, without a checkout or node_modules nearby.
  const {pathToFileURL}=require('node:url');
  const sdk=await import(pathToFileURL(path.join(app,'runtime/core/builtin-sdk.mjs')).href);
  const legacy=await import(pathToFileURL(path.join(app,'electron/builtin-sdk.mjs')).href);
  for(const name of ['Agent','createInitialSystemMessage','toToolDeclaration','responses','completions','anthropic']) {
    assert.equal(typeof sdk[name],'function',name);assert.equal(legacy[name],sdk[name],name);
  }
  const notices=JSON.parse(await fs.readFile(path.join(root,'third-party/node/packages.json'),'utf8'));
  for(const name of ['@earendil-works/pi-agent-core','@earendil-works/pi-ai'])assert.ok(notices.some(p=>p.name===name),name);
  assert.equal(await fs.stat(path.join(app,'node_modules')).catch(()=>null),null);
  const result=spawnSync(process.execPath,['--test',path.join(app,'electron/builtin-backend.test.cjs')],{stdio:'inherit'});
  if(result.error)throw result.error;process.exitCode=result.status||0;
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
