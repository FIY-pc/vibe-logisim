'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {FolderWorkspace}=require('./folder-workspace.cjs'),{importFiles}=require('./folder-import.cjs');
test('external drops preserve sources, hierarchy and collisions; rejected drops publish nothing',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vibe-import-')),folder=new FolderWorkspace(root+'/state');
 try{
  await fs.mkdir(root+'/workspace');await fs.mkdir(root+'/outside/folder/nested',{recursive:true});await fs.writeFile(root+'/outside/folder/nested/data.txt','source');await fs.writeFile(root+'/outside/data.txt','new');await fs.writeFile(root+'/workspace/data.txt','old');await folder.open(root+'/workspace');
  const req={folderId:folder.current.id,sources:[root+'/outside/data.txt',root+'/outside/folder']};
  const result=await importFiles(folder,req);assert.equal(result.items[0].name,'data (2).txt');assert.equal(await fs.readFile(root+'/workspace/data.txt','utf8'),'old');assert.equal(await fs.readFile(root+'/workspace/folder/nested/data.txt','utf8'),'source');assert.equal(await fs.readFile(root+'/outside/data.txt','utf8'),'new');
  await importFiles(folder,req);assert.equal(await fs.readFile(root+'/workspace/folder (2)/nested/data.txt','utf8'),'source');
  await fs.symlink(root+'/outside/data.txt',root+'/outside/link');
  await assert.rejects(importFiles(folder,{...req,sources:[root+'/outside/data.txt',root+'/outside/link']}),/符号链接/);assert.equal((await fs.readdir(root+'/workspace')).includes('data (4).txt'),false);
  await assert.rejects(importFiles(folder,{...req,sources:[root+'/workspace']}),/自己/);
  await assert.rejects(importFiles(folder,{...req,path:'../outside'}),/工作区/);
  await assert.rejects(importFiles(folder,{...req,folderId:'stale'}),/切换/);
  await fs.mkdir(root+'/outside/.codex');await assert.rejects(importFiles(folder,{...req,sources:[root+'/outside/.codex']}),/认证/);
  assert.equal((await fs.readdir(root+'/workspace')).some(n=>n.startsWith('.vibe-import-')),false);
 }finally{folder.close();await fs.rm(root,{recursive:true,force:true});}
});
