'use strict';
// Run protocol, persistence and tool fixtures against the shipped SDK, outside
// the checkout so Node cannot fall back to the developer's node_modules.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {bundle}=require('./bundle-sdk.cjs');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vibe-bundled-sdk-')),app=path.join(root,'app'),desktop=path.resolve(__dirname,'../../apps/desktop');
 try {
  await fs.cp(path.join(desktop,'electron'),path.join(app,'electron'),{recursive:true});
  await fs.cp(path.join(desktop,'circuit-knowledge'),path.join(app,'circuit-knowledge'),{recursive:true});
  await fs.cp(path.join(desktop,'test/support'),path.join(app,'test/support'),{recursive:true});
  await fs.mkdir(path.join(app,'circuit-lens/studio/domain'),{recursive:true});
  await fs.copyFile(path.join(desktop,'circuit-lens/studio/domain/circuit-plugin.json'),path.join(app,'circuit-lens/studio/domain/circuit-plugin.json'));
  await bundle(app);
  const result=spawnSync(process.execPath,['--test',path.join(app,'electron/builtin-backend.test.cjs')],{stdio:'inherit'});
  if(result.error)throw result.error;process.exitCode=result.status||0;
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
