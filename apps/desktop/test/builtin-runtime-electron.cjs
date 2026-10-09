'use strict';
// Run with Electron: verifies the SDK in Electron's main process and the same
// session.fetch transport used by the desktop. No window, remote API or login.
const {app,session}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {BuiltinBackend}=require('../electron/builtin-backend.cjs');
const {startFakeResponsesServer}=require('./support/fake-responses-server.cjs');
app.whenReady().then(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-electron-runtime-')),fake=await startFakeResponsesServer();
 const backend=new BuiltinBackend({workDir:root,profileDir:path.join(root,'profile'),sessionStorePath:path.join(root,'sessions.json'),probeFetch:async()=>{const net=session.fromPartition('builtin-transport-test');await net.setProxy({mode:'direct'});return (input,options)=>net.fetch(input,options);}});
 try{
  backend.provider.save({baseUrl:fake.baseUrl,apiKey:fake.apiKey,model:'probe-chat',api:'openai-responses',effort:'none'});await backend.start();
  const catalog=await backend.listModels();assert.equal(catalog.models[0].model,'probe-chat');
  await backend.ask({question:'test',workspaceKey:'test',context:{folder:{id:'test'}}});await backend.run;
  assert.equal(backend.snapshot().transmission,null);assert.equal(backend.history.at(-1).text,'OK');console.log('Electron SDK + session.fetch stream OK');
 }finally{await backend.stop();await fake.close();fs.rmSync(root,{recursive:true,force:true});}
}).then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
